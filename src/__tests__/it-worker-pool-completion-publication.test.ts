/**
 * The worker pool saves goal task failures in three places (unreadable task content, a claim that
 * fails during setup, and the end of a remote execution). Each must keep the merged #170 / #171
 * promises: the save carries the completion publication mark, the manager notification goes through
 * the shared publication and clears the mark, a failed notification stays inside the runtime with a
 * warning, and the task finish hook runs exactly once after the reply. A failed notification of a
 * normal completion stays inside the runtime too, and a stopping runtime or project host accounts for
 * a finish hook still running.
 * Design: docs/design/worker-pool-completion-publication.md, docs/design/193-worker-pool-requests.md
 * (S1-S8, S19-S21; S23 is the coordinator's decision of 11/28 awaiting its design text).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { scaledMs } from '../../scripts/test-time-factor.mjs';
import { BuiltinProjectRuntime } from '../features/workerPool/builtinProjectRuntime.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { readPendingGoalTaskCompletions } from '../infra/task/taskStateReader.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { deferred } from './helpers/controlledDaemon.js';
import { BuiltinWorkerAdapter } from '../infra/worker-pool/builtinWorkerAdapter.js';
import { BuiltinProjectHost } from '../infra/worker-pool/projectHost.js';
import { spawnManagedProcess } from '../shared/utils/spawn.js';
import { TaskDispatcher } from '../features/daemon/taskDispatcher.js';
import { prepareTaskSpecDirectory } from '../infra/task/enqueueService.js';
import { withTaskFinishHook } from '../features/tasks/execute/taskFinishHook.js';
import { executionIdentity, type RemoteExecutionIdentity } from '../core/worker-pool/remoteProtocol.js';
import type { TaskInfo } from '../infra/task/types.js';

const doubles = vi.hoisted(() => ({ execute: vi.fn(), preflight: vi.fn(), terminate: vi.fn(), cleanup: vi.fn() }));
vi.mock('../features/tasks/execute/runTaskExecution.js', () => ({ executeRunTaskAndCompleteWithDetails: doubles.execute }));
vi.mock('../features/tasks/execute/providerPreflight.js', () => ({ checkQueuedTaskProviders: doubles.preflight }));
vi.mock('../infra/goals/events.js', async (original) => {
  const actual = await original<typeof import('../infra/goals/events.js')>();
  return { ...actual, saveManagerEvent: vi.fn(actual.saveManagerEvent) };
});
vi.mock('../shared/utils/spawn.js', async (original) => {
  const actual = await original<typeof import('../shared/utils/spawn.js')>();
  return { ...actual, terminateManagedProcesses: doubles.terminate, spawnManagedProcess: vi.fn(actual.spawnManagedProcess) };
});
vi.mock('../infra/opencode/server-pool.js', async (original) => ({
  ...await original<typeof import('../infra/opencode/server-pool.js')>(), prepareSharedServerPoolForForcedShutdown: doubles.cleanup,
}));

const HOOK_WAIT_MS = scaledMs(10_000);

// Appends the task name to `out`. With a gate path it first writes `started`, then waits for the gate
// (and gives up once the test removed its directory). Arguments after the gate are ignored.
const HOOK_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const [out, started, gate] = process.argv.slice(2);
const name = process.env.TAKT_FINISH_TASK_NAME;
const finish = () => fs.appendFileSync(out, name + '\\n');
if (started === undefined) finish();
else {
  fs.appendFileSync(started, name + '\\n');
  const timer = setInterval(() => {
    if (fs.existsSync(gate)) { clearInterval(timer); finish(); }
    else if (!fs.existsSync(path.dirname(gate))) process.exit(0);
  }, 20);
}
`;

let cwd: string;
let hookDir: string;
let runtime: BuiltinProjectRuntime;
let runner: TaskRunner;
let warnings: string[];
let hosts: BuiltinProjectHost[];
const finished = vi.fn();
const fatal = vi.fn();
const diskFull = () => Object.assign(new Error('disk full'), { code: 'ENOSPC' });

function writeConfig(hook?: { gated: boolean; extraArgs?: readonly string[] }): { out: string; started: string; gate: string } {
  const files = { out: join(hookDir, 'hook-calls.txt'), started: join(hookDir, 'hook-started.txt'), gate: join(hookDir, 'hook-gate') };
  const script = join(hookDir, 'hook.cjs');
  writeFileSync(script, HOOK_SCRIPT);
  writeFileSync(join(cwd, '.takt', 'config.yaml'), stringifyYaml({ provider: 'mock', concurrency: 3,
    ...(hook === undefined ? {} : { task_finish_hook: { command: [process.execPath, script, files.out,
      ...(hook.gated ? [files.started, files.gate] : []), ...(hook.extraArgs ?? [])] } }) }));
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
  return files;
}

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0) : [];
}

function notNotifiedWarnings(taskName: string): string[] {
  return warnings.filter((line) => line.includes('[WARN]') && line.includes(taskName) && line.includes('manager was not notified'));
}

function savedRecord(taskName: string) {
  return new TaskStore(cwd).read().tasks.find((task) => task.name === taskName);
}

async function pendingCompletions() {
  return readPendingGoalTaskCompletions(cwd, { invalid: vi.fn(), valid: vi.fn() });
}

function unreadableTask(name: string): { name: string; file: string } {
  const spec = prepareTaskSpecDirectory(cwd, name);
  const task = runner.addTask(name, { goal_id: goalRecord().id, task_dir: spec.taskDirRelative, workflow: 'remote-test' });
  return { name: task.name, file: join(spec.taskDir, 'order.md') };
}

/** Makes the claim of `name` fail during setup: its content disappears while the provider is prepared. */
function failClaimOf(name: string, file: string): void {
  doubles.preflight.mockImplementation(async (_cwd: string, task: TaskInfo) => { if (task.name === name) rmSync(file); });
}

async function enableRemote(): Promise<void> {
  const origin = join(cwd, '.takt', 'origin.git');
  expect(spawnSync('git', ['init', '--bare', origin]).status).toBe(0);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'test'], ['config', 'user.email', 'test@example.test'],
    ['commit', '--allow-empty', '-m', 'fixture'], ['branch', goalRecord().branch], ['remote', 'add', 'origin', origin]]) {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }
  await runtime.close();
  runtime = new BuiltinProjectRuntime(cwd, finished, fatal, true);
}

async function claimRemotely(name: string): Promise<RemoteExecutionIdentity> {
  await enableRemote();
  const task = runner.addTask(name, { goal_id: goalRecord().id, workflow: 'remote-test' });
  await runtime.inspect();
  const reply = await runtime.remote({ kind: 'claim', taskName: task.name, workerId: 'w1', registrationGeneration: randomUUID(),
    requestId: randomUUID(), leaseExpiresAt: Date.now() + 60_000 });
  if (reply.kind !== 'claim' || reply.assignment === null) throw new Error(`Expected a remote claim of ${name}`);
  return executionIdentity(reply.assignment);
}

function remoteEnd(kind: 'finish' | 'fail', assignment: RemoteExecutionIdentity) {
  return kind === 'fail' ? { kind, assignment, reason: 'Connection to worker w1 was lost' }
    : { kind, assignment, now: Date.now(), success: false, reason: 'Provider failed' };
}

beforeEach(async () => {
  vi.clearAllMocks();
  const actualEvents = await vi.importActual<typeof import('../infra/goals/events.js')>('../infra/goals/events.js');
  vi.mocked(saveManagerEvent).mockImplementation(actualEvents.saveManagerEvent);
  doubles.preflight.mockResolvedValue(undefined);
  doubles.terminate.mockResolvedValue(undefined);
  doubles.cleanup.mockResolvedValue(undefined);
  warnings = [];
  hosts = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  cwd = mkdtempSync(join(getGlobalConfigDir(), 'builtin-publication-'));
  hookDir = mkdtempSync(join(getGlobalConfigDir(), 'builtin-publication-hook-'));
  mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
  writeFileSync(join(cwd, '.takt', 'workflows', 'remote-test.yaml'),
    'name: remote-test\nsteps:\n  - name: work\n    instruction: Complete the task\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
  writeConfig();
  await new GoalStore(cwd).create(goalRecord());
  runner = new TaskRunner(cwd, { goalTasksOnly: true });
  runtime = new BuiltinProjectRuntime(cwd, finished, fatal);
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Lets a gated hook that is still waiting end before its directory goes away.
  writeFileSync(join(hookDir, 'hook-gate'), '');
  for (const host of hosts) await host.close();
  await runtime.close();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(hookDir, { recursive: true, force: true });
  invalidateAllResolvedConfigCache();
});

it('marks an unreadable goal task failure for resend when the worker pool notification hits ENOSPC', async () => {
  const task = unreadableTask('unreadable work');
  rmSync(task.file);
  vi.mocked(saveManagerEvent).mockImplementationOnce(() => { throw diskFull(); });
  await Promise.allSettled([runtime.start(task.name, 'builtin')]);
  expect(savedRecord(task.name)).toMatchObject({ status: 'failed', run_slug: expect.stringMatching(/^setup-/),
    completion: { success: false, workflowResult: 'error' } });
  expect(savedRecord(task.name)?.completion_publication_pending).toBe(true);
  expect((await pendingCompletions()).map(({ name, status }) => ({ name, status }))).toEqual([{ name: task.name, status: 'failed' }]);
  expect(readManagerEvents(cwd)).toEqual([]);
});

it('marks a remote terminal record for resend when its manager notification fails', async () => {
  const assignment = await claimRemotely('remote work');
  vi.mocked(saveManagerEvent).mockImplementation(() => { throw diskFull(); });
  await Promise.allSettled([runtime.remote(remoteEnd('fail', assignment))]);
  expect(savedRecord(assignment.taskName)).toMatchObject({ status: 'failed', execution_id: assignment.executionId,
    completion: { success: false, interrupted: true } });
  expect(savedRecord(assignment.taskName)?.completion_publication_pending).toBe(true);
  expect((await pendingCompletions()).map(({ name, status, runSlug }) => ({ name, status, runSlug })))
    .toEqual([{ name: assignment.taskName, status: 'failed', runSlug: savedRecord(assignment.taskName)?.run_slug }]);
});

it('clears the completion mark after the worker pool notifies a failed claim', async () => {
  const task = unreadableTask('claim failure');
  failClaimOf(task.name, task.file);
  expect(await runtime.start(task.name, 'builtin')).toEqual({ kind: 'declined' });
  const saved = savedRecord(task.name);
  expect(saved).toMatchObject({ status: 'failed', run_slug: expect.stringMatching(/^setup-/) });
  expect(readManagerEvents(cwd)).toMatchObject([{ event: { kind: 'completion', taskName: task.name, runSlug: saved?.run_slug } }]);
  expect(saved?.completion_publication_pending).toBeUndefined();
  expect(await pendingCompletions()).toEqual([]);
});

it.each(['unreadable task', 'failed claim', 'remote finish', 'remote fail', 'builtin completion'] as const)(
  'calls the task finish hook exactly once for each worker pool terminal save: %s', async (path) => {
    const hook = writeConfig({ gated: false });
    let taskName: string;
    if (path === 'remote finish' || path === 'remote fail') {
      const assignment = await claimRemotely(`hook ${path}`);
      taskName = assignment.taskName;
      const end = remoteEnd(path === 'remote finish' ? 'finish' : 'fail', assignment);
      expect(await runtime.remote(end)).toMatchObject({ kind: 'updated', record: { status: 'failed' } });
      await vi.waitFor(() => expect(lines(hook.out)).toEqual([taskName]), { timeout: HOOK_WAIT_MS });
      await runtime.remote(end);
    } else if (path === 'builtin completion') {
      taskName = runner.addTask('hook builtin completion', { goal_id: goalRecord().id }).name;
      // The production execution attaches the finish hook through withTaskFinishHook (taskExecution.ts).
      doubles.execute.mockImplementation((task: TaskInfo, executingRunner: TaskRunner, projectCwd: string) =>
        withTaskFinishHook(projectCwd, executingRunner, task.name, async () => {
          const completion = { success: true, interrupted: false, workflowResult: 'completed' as const };
          executingRunner.completeTask({ task, success: true, completion, response: 'done', executionLog: [],
            startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
          return { completion, runSlug: `run-${task.name}` };
        }));
      expect(await runtime.start(taskName, 'builtin')).toEqual({ kind: 'started' });
      await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(taskName));
      await vi.waitFor(() => expect(lines(hook.out)).toEqual([taskName]), { timeout: HOOK_WAIT_MS });
    } else {
      const task = unreadableTask(`hook ${path}`);
      taskName = task.name;
      if (path === 'unreadable task') rmSync(task.file);
      else failClaimOf(task.name, task.file);
      expect(await runtime.start(task.name, 'builtin')).toEqual({ kind: 'declined' });
      expect(savedRecord(task.name)?.status).toBe('failed');
      await vi.waitFor(() => expect(lines(hook.out)).toEqual([taskName]), { timeout: HOOK_WAIT_MS });
    }
    await runtime.close();
    expect(lines(hook.out)).toEqual([taskName]);
  });

it.each(['unreadable task', 'failed claim'] as const)(
  'keeps A running when a worker pool setup failure notification hits ENOSPC: %s', async (path) => {
    const a = runner.addTask('A', { goal_id: goalRecord().id });
    const b = unreadableTask('blocked setup');
    if (path === 'unreadable task') rmSync(b.file);
    else failClaimOf(b.name, b.file);
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    doubles.execute.mockImplementation(async (task: TaskInfo, executingRunner: TaskRunner, _cwd, _options, options) => {
      if (task.name === a.name) {
        signal = options.abortSignal;
        await Promise.race([release.promise, new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))]);
      }
      const completion = { success: !options.abortSignal.aborted, interrupted: options.abortSignal.aborted, workflowResult: 'completed' as const };
      if (completion.success) executingRunner.completeTask({ task, success: true, completion, response: 'done', executionLog: [],
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
      return { completion, runSlug: `run-${task.name}` };
    });
    const actualEvents = await vi.importActual<typeof import('../infra/goals/events.js')>('../infra/goals/events.js');
    vi.mocked(saveManagerEvent).mockImplementation((projectCwd, event) => {
      if (event.kind === 'completion' && event.taskName === b.name) throw diskFull();
      return actualEvents.saveManagerEvent(projectCwd, event);
    });
    await runtime.close();
    const closes = vi.fn();
    const pool = new TaskDispatcher({ workers: [new BuiltinWorkerAdapter({ name: 'builtin', kind: 'builtin', concurrency: 2 })],
      projects: async () => [cwd], wake: vi.fn(), onError: vi.fn(), factory: { create(_cwd, done) {
        runtime = new BuiltinProjectRuntime(cwd, (name) => { finished(name); done(name); }, fatal);
        return { inspect: () => runtime.inspect(), setWaitingReasons: (reasons) => runtime.setWaitingReasons(reasons),
          start: (name, worker) => runtime.start(name, worker), close: async () => { closes(); await runtime.close(); done(); } };
      } },
    });
    try {
      await pool.dispatch();
      await vi.waitFor(() => expect(savedRecord(b.name)?.status).toBe('failed'));
      expect(signal).toBeDefined();
      expect(signal!.aborted).toBe(false);
      expect(closes).not.toHaveBeenCalled();
      expect(fatal).not.toHaveBeenCalled();
      expect(savedRecord(a.name)?.status).toBe('running');
      expect(savedRecord(b.name)?.completion_publication_pending).toBe(true);
      expect(notNotifiedWarnings(b.name)).toHaveLength(1);
      release.resolve();
      await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(a.name));
      expect(savedRecord(a.name)).toMatchObject({ status: 'completed', completion: { success: true, interrupted: false } });
    } finally { release.resolve(); await pool.close(); }
  });

it('keeps the remote request result when its manager notification fails', async () => {
  const assignment = await claimRemotely('remote reply');
  vi.mocked(saveManagerEvent).mockImplementation(() => { throw diskFull(); });
  const reply = await runtime.remote(remoteEnd('fail', assignment));
  expect(reply).toEqual({ kind: 'updated', record: expect.objectContaining({ status: 'failed',
    assignment: expect.objectContaining({ taskName: assignment.taskName, executionId: assignment.executionId }) }) });
  expect(savedRecord(assignment.taskName)?.status).toBe('failed');
  expect(notNotifiedWarnings(assignment.taskName)).toHaveLength(1);
});

async function within<T>(promise: Promise<T>, ms: number, failure: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(failure)), ms); })]);
  } finally { clearTimeout(timer); }
}

it('replies to a remote finish before its finish hook ends', async () => {
  const hook = writeConfig({ gated: true });
  const assignment = await claimRemotely('remote hook reply');
  const reply = await within(runtime.remote(remoteEnd('finish', assignment)), scaledMs(5_000),
    'The remote finish reply waited for the task finish hook');
  expect(reply).toMatchObject({ kind: 'updated', record: { status: 'failed' } });
  expect(savedRecord(assignment.taskName)?.status).toBe('failed');
  await vi.waitFor(() => expect(lines(hook.started)).toEqual([assignment.taskName]), { timeout: HOOK_WAIT_MS });
  expect(lines(hook.out)).toEqual([]);
  writeFileSync(hook.gate, '');
  await vi.waitFor(() => expect(lines(hook.out)).toEqual([assignment.taskName]), { timeout: HOOK_WAIT_MS });
});

it('waits for a scheduled finish hook when the runtime closes', async () => {
  const hook = writeConfig({ gated: true });
  const assignment = await claimRemotely('remote hook close');
  expect(await runtime.remote(remoteEnd('finish', assignment))).toMatchObject({ kind: 'updated', record: { status: 'failed' } });
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await vi.waitFor(() => expect(lines(hook.started)).toEqual([assignment.taskName]), { timeout: HOOK_WAIT_MS });
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  expect(closed).toBe(false);
  writeFileSync(hook.gate, '');
  await closing;
  expect(lines(hook.out)).toEqual([assignment.taskName]);
});

it('keeps the project open when the notification of a normal completion fails', async () => {
  const a = runner.addTask('A', { goal_id: goalRecord().id });
  const b = runner.addTask('notify failure', { goal_id: goalRecord().id });
  const release = deferred<void>();
  let signal: AbortSignal | undefined;
  doubles.execute.mockImplementation(async (task: TaskInfo, executingRunner: TaskRunner, _cwd, _options, options) => {
    if (task.name === a.name) {
      signal = options.abortSignal;
      await Promise.race([release.promise, new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))]);
    }
    const completion = { success: !options.abortSignal.aborted, interrupted: options.abortSignal.aborted, workflowResult: 'completed' as const };
    if (completion.success) executingRunner.completeTask({ task, success: true, completion, response: 'done', executionLog: [],
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    return { completion, runSlug: `run-${task.name}` };
  });
  const secret = ['Zq', String(randomInt(10_000_000, 99_999_999)), 'Zq'].join('');
  const actualEvents = await vi.importActual<typeof import('../infra/goals/events.js')>('../infra/goals/events.js');
  vi.mocked(saveManagerEvent).mockImplementation((projectCwd, event) => {
    if (event.kind === 'completion' && event.taskName === b.name) {
      throw Object.assign(new Error(`disk full api_token=${secret}`), { code: 'ENOSPC' });
    }
    return actualEvents.saveManagerEvent(projectCwd, event);
  });
  await runtime.close();
  const closes = vi.fn();
  const pool = new TaskDispatcher({ workers: [new BuiltinWorkerAdapter({ name: 'builtin', kind: 'builtin', concurrency: 2 })],
    projects: async () => [cwd], wake: vi.fn(), onError: vi.fn(), factory: { create(_cwd, done) {
      runtime = new BuiltinProjectRuntime(cwd, (name) => { finished(name); done(name); }, fatal);
      return { inspect: () => runtime.inspect(), setWaitingReasons: (reasons) => runtime.setWaitingReasons(reasons),
        start: (name, worker) => runtime.start(name, worker), close: async () => { closes(); await runtime.close(); done(); } };
    } },
  });
  try {
    await pool.dispatch();
    await vi.waitFor(() => expect(savedRecord(b.name)?.status).toBe('completed'));
    await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(b.name));
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    expect(closes).not.toHaveBeenCalled();
    expect(fatal).not.toHaveBeenCalled();
    expect(savedRecord(b.name)?.completion_publication_pending).toBeUndefined();
    expect(warnings.filter((line) => line.includes('[WARN]') && line.includes(b.name) && line.includes(goalRecord().id)
      && line.includes(`run-${b.name}`))).toHaveLength(1);
    expect(warnings.filter((line) => line.includes(secret))).toEqual([]);
    release.resolve();
    await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(a.name));
    expect(savedRecord(a.name)).toMatchObject({ status: 'completed', completion: { success: true, interrupted: false } });
  } finally { release.resolve(); await pool.close(); }
});

// S23 (the coordinator's decision of 11/28, awaiting its design text): the project host stops the builtin
// worker 5 seconds after asking it to shut down. A finish hook it cuts off is named in one warning line.
it('names the task whose finish hook the project host cuts off when it stops the builtin worker', async () => {
  const secret = ['Zq', String(randomInt(10_000_000, 99_999_999)), 'Zq'].join('');
  const hook = writeConfig({ gated: true, extraArgs: [`--api-token=${secret}`] });
  const task = unreadableTask('stopping work');
  rmSync(task.file);
  const childStderr: string[] = [];
  const hostStderr: string[] = [];
  const actualSpawn = await vi.importActual<typeof import('../shared/utils/spawn.js')>('../shared/utils/spawn.js');
  vi.mocked(spawnManagedProcess).mockImplementationOnce((...args) => {
    const managed = actualSpawn.spawnManagedProcess(...args);
    managed.child.stderr?.on('data', (chunk: Buffer) => { childStderr.push(chunk.toString('utf8')); });
    return managed;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    hostStderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write);
  await runtime.close();
  const host = new BuiltinProjectHost(cwd, getGlobalConfigDir(), vi.fn());
  hosts.push(host);
  expect(await host.start(task.name, 'builtin')).toEqual({ kind: 'declined' });
  await vi.waitFor(() => expect(lines(hook.started)).toEqual([task.name]), { timeout: HOOK_WAIT_MS });
  await host.close();
  // The host repeats the child's stderr in its own report when the child is stopped, so each outlet is
  // counted on its own: no outlet names the cut hook twice, and at least one names it.
  const outlets = { child: childStderr.join('').split('\n'), daemon: hostStderr.join('').split('\n'), warnings };
  const named = Object.values(outlets).map((lines) => lines.filter((line) => line.includes(task.name) && /hook/i.test(line)).length);
  expect(Math.max(...named), JSON.stringify(outlets)).toBe(1);
  expect(Object.values(outlets).flat().filter((line) => line.includes(secret))).toEqual([]);
}, scaledMs(60_000));

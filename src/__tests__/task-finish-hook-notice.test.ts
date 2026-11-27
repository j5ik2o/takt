/**
 * Regression tests 1-16 of docs/design/task-finish-hook-notice-loss.md (#171), written before the
 * implementation. Each test states the behaviour the design asks for; the current code fails the
 * ones that still only write `log.error`.
 *
 * `process.stderr.write` and `runBoundedCommand` are spies: the notice must reach stderr only.
 * A fake `TaskRunner` (only `listTaskStateItems`) covers the read failures and the retry; a real
 * `TaskRunner` in a temporary project covers the two execution entry points and the existing hook
 * contracts (test 16). The `takt merge` tests reach the Git boundary before any real command could
 * start (a failing `runGitCommandAbortable`, or a project directory that cannot be resolved as a
 * repository), so no Git process starts. The file is in the heavy IT slice for that reason.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { TaskInfo, TaskState } from '../infra/task/index.js';

const bounded = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../shared/utils/bounded-command-runner.js', async (original) => ({
  ...(await original<typeof import('../shared/utils/bounded-command-runner.js')>()),
  runBoundedCommand: bounded.run,
}));

// The `takt merge` paths reach Git through these functions. Each double fails before any Git
// process would start, so the merge tests stay on the hook contract.
const gitBoundary = vi.hoisted(() => ({
  runGitCommandAbortable: vi.fn(),
  cloneAndIsolateAbortable: vi.fn(),
}));
vi.mock('../infra/task/clone-exec.js', async (original) => ({
  ...(await original<typeof import('../infra/task/clone-exec.js')>()),
  runGitCommandAbortable: gitBoundary.runGitCommandAbortable,
  cloneAndIsolateAbortable: gitBoundary.cloneAndIsolateAbortable,
}));

const doubles = vi.hoisted(() => ({
  resolveTaskExecution: vi.fn(),
  postExecutionFlow: vi.fn(),
  gitProvider: vi.fn(),
  pushWorktreeToOrigin: vi.fn(),
}));
vi.mock('../features/tasks/execute/resolveTask.js', () => ({
  resolveTaskExecution: doubles.resolveTaskExecution,
  resolveTaskIssue: () => undefined,
}));
vi.mock('../features/tasks/execute/postExecution.js', () => ({
  postExecutionFlow: doubles.postExecutionFlow,
}));
vi.mock('../infra/git/index.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getGitProvider: doubles.gitProvider,
}));
// The `pr_failed` publication path pushes through this one function; the double fails before Git.
vi.mock('../features/tasks/list/taskActionTarget.js', async (original) => ({
  ...(await original<typeof import('../features/tasks/list/taskActionTarget.js')>()),
  pushWorktreeToOrigin: doubles.pushWorktreeToOrigin,
}));

import { initializeCliExecutionContext, getCliExecutionContext } from '../app/cli/initialization.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';
import { TaskRunner } from '../infra/task/runner.js';
import { setQuietMode } from '../shared/context.js';
import { setLogLevel } from '../shared/ui/LogManager.js';
import { sanitizeTerminalText } from '../shared/utils/text.js';
import { executePrWorkflow, resolveMergeSettings } from '../features/merge/index.js';
import {
  invalidatePendingGoalTasksWithFinishHook,
  runTaskFinishHooks,
  runTaskFinishHooksForStates,
  withTaskFinishHook,
} from '../features/tasks/execute/taskFinishHook.js';
import { executeTaskAndCompleteWithDetails } from '../features/tasks/execute/taskExecution.js';
import { goalId } from './helpers/goal-fixtures.js';

const HOOK_COMMAND = 'task-finish-hook-command';
const REJECTING_HOOK_COMMAND = 'rejecting-task-finish-hook-command';
const okCommandResult = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  aborted: false,
  outputLimitExceeded: false,
};

const tempDirs = new Set<string>();
let stderrChunks: string[] = [];
let stdoutChunks: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.add(dir);
  return dir;
}

function hookProjectConfig(command = HOOK_COMMAND): Record<string, unknown> {
  return {
    language: 'en',
    provider: 'mock',
    task_finish_hook: { command: [command], timeout_ms: 100 },
  };
}

/** A temporary project. `'none'` writes no `.takt/config.yaml` at all. */
function makeProject(config: Record<string, unknown> | 'invalid-yaml' | 'none' = hookProjectConfig()): string {
  const dir = makeTempDir('takt-171-');
  fs.mkdirSync(path.join(dir, '.takt'), { recursive: true });
  if (config === 'invalid-yaml') {
    fs.writeFileSync(path.join(dir, '.takt', 'config.yaml'), 'task_finish_hook: [unterminated\n', 'utf-8');
  } else if (config !== 'none') {
    fs.writeFileSync(path.join(dir, '.takt', 'config.yaml'), stringifyYaml(config), 'utf-8');
  }
  invalidateAllResolvedConfigCache();
  return dir;
}

function state(name: string, status: TaskState['status'], overrides: Partial<TaskState> = {}): TaskState {
  return {
    name,
    kind: status,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    filePath: `/project/.takt/tasks/${name}.yaml`,
    ...overrides,
  };
}

const lockTimeout = (): Error =>
  new Error('File lock: timed out waiting for lock: /project/.takt/tasks.yaml.lock');
const invalidTasksFile = (): Error => new Error('Invalid tasks.yaml: expected a map');

type ReadStep = TaskState[] | Error;

/** A `TaskRunner` stand-in for the reads. The last step repeats once the list is exhausted. */
function fakeRunner(steps: readonly ReadStep[]): { runner: TaskRunner; reads: ReturnType<typeof vi.fn> } {
  let index = 0;
  const reads = vi.fn((): TaskState[] => {
    const step = steps[Math.min(index, steps.length - 1)]!;
    index += 1;
    if (step instanceof Error) throw step;
    return step;
  });
  return { runner: { listTaskStateItems: reads } as unknown as TaskRunner, reads };
}

/** Starts a call, runs every fake timer (the retry waits one 250 ms step), then awaits it. */
async function runWithFakeTimers<T>(start: () => Promise<T>): Promise<T> {
  const promise = start();
  await vi.advanceTimersByTimeAsync(1_000);
  return promise;
}

/** The task-finish-hook notices that reached stderr. Other stderr writes are ignored. */
function warnMessages(): string[] {
  return stderrChunks.join('').split('\n').filter((line) => line.includes('Task finish hook'));
}

function onlyWarnMessage(): string {
  const messages = warnMessages();
  expect(messages).toHaveLength(1);
  return messages[0]!;
}

function expectNoNotice(): void {
  expect(warnMessages()).toHaveLength(0);
  expect(stdoutText()).not.toContain('Task finish hook');
}

function stdoutText(): string {
  return stdoutChunks.join('');
}

function hookEnvOfCall(index = 0): NodeJS.ProcessEnv {
  const call = bounded.run.mock.calls[index]?.[0] as { env: NodeJS.ProcessEnv } | undefined;
  expect(call, `hook call ${index}`).toBeDefined();
  return call!.env;
}

function claimTask(project: string, content = 'Do the work'): { runner: TaskRunner; task: TaskInfo } {
  const runner = new TaskRunner(project);
  runner.addTask(content, { workflow: 'default' });
  const task = runner.claimNextTasks(1)[0]!;
  return { runner, task };
}

function stubResolution(project: string, overrides: Record<string, unknown> = {}): void {
  doubles.resolveTaskExecution.mockResolvedValue({
    execCwd: project,
    workflowIdentifier: 'default',
    isWorktree: false,
    reportDirName: 'run-1',
    autoPr: false,
    draftPr: false,
    shouldPublishBranchToOrigin: false,
    ...overrides,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // TAKT_CONFIG_DIR and the other per-test environment are owned by src/__tests__/test-setup.ts.
  stderrChunks = [];
  stdoutChunks = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdoutChunks.push(args.map((arg) => String(arg)).join(' '));
  });
  bounded.run.mockResolvedValue(okCommandResult);
  gitBoundary.runGitCommandAbortable.mockRejectedValue(new Error('git is a test double; no process starts'));
  gitBoundary.cloneAndIsolateAbortable.mockRejectedValue(new Error('merge clone is a test double; no git is started'));
  doubles.pushWorktreeToOrigin.mockImplementation(() => {
    throw new Error('branch publication is a test double; no git is started');
  });
  setQuietMode(false);
  setLogLevel('info');
  invalidateAllResolvedConfigCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setQuietMode(false);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  invalidateAllResolvedConfigCache();
});

describe('task finish hook notices (#171)', () => {
  it('warns once with both task names when the saved-state read times out twice, and calls no hook (1)', async () => {
    const project = makeProject();
    const { runner, reads } = fakeRunner([lockTimeout()]);

    vi.useFakeTimers();
    await runWithFakeTimers(() => runTaskFinishHooks(project, runner, ['task-a', 'task-b']));

    expect(reads).toHaveBeenCalledTimes(2);
    const message = onlyWarnMessage();
    expect(message).toContain('task-a');
    expect(message).toContain('task-b');
    expect(bounded.run).not.toHaveBeenCalled();
  });

  it('retries a timed-out read once and calls the hook exactly once when the second read succeeds (2)', async () => {
    const project = makeProject();
    const completed = state('task-a', 'completed', { completedAt: '2026-01-02T00:00:00.000Z' });
    const { runner, reads } = fakeRunner([lockTimeout(), [completed]]);

    vi.useFakeTimers();
    await runWithFakeTimers(() => runTaskFinishHooks(project, runner, ['task-a']));

    expect(reads).toHaveBeenCalledTimes(2);
    expect(bounded.run).toHaveBeenCalledTimes(1);
    expect(hookEnvOfCall().TAKT_FINISH_TASK_NAME).toBe('task-a');
    expectNoNotice();
  });

  it('does not retry an invalid tasks.yaml, and warns once with no hook (3)', async () => {
    const project = makeProject();
    const { runner, reads } = fakeRunner([invalidTasksFile()]);

    await runTaskFinishHooks(project, runner, ['task-a']);

    expect(reads).toHaveBeenCalledTimes(1);
    const message = onlyWarnMessage();
    expect(message).toContain('task-a');
    expect(message).toContain('tasks.yaml');
    expect(bounded.run).not.toHaveBeenCalled();
  });

  it('names config.yaml when the project config cannot be read, and does not read tasks.yaml (4)', async () => {
    const project = makeProject('invalid-yaml');
    const { runner, reads } = fakeRunner([[state('task-a', 'completed')]]);

    await runTaskFinishHooks(project, runner, ['task-a']);

    expect(reads).not.toHaveBeenCalled();
    const message = onlyWarnMessage();
    expect(message).toContain('config.yaml');
    expect(message).not.toContain('tasks.yaml');
    expect(bounded.run).not.toHaveBeenCalled();
  });

  it('warns with the terminal task name when the config cannot be read for handed-over states (5)', async () => {
    const project = makeProject('invalid-yaml');

    await runTaskFinishHooksForStates(project, [state('saved-terminal', 'failed')]);

    const message = onlyWarnMessage();
    expect(message).toContain('saved-terminal');
    expect(message).toContain('config.yaml');
    expect(bounded.run).not.toHaveBeenCalled();
  });

  it('does not name a non-terminal state when the handed-over states include one (6)', async () => {
    const project = makeProject('invalid-yaml');

    await runTaskFinishHooksForStates(project, [
      state('saved-terminal', 'failed'),
      state('still-running', 'running'),
    ]);

    const message = onlyWarnMessage();
    expect(message).toContain('saved-terminal');
    expect(message).not.toContain('still-running');
  });

  it('runs the hooks that succeed and warns once with the task whose hook rejected (7)', async () => {
    const project = makeProject();
    bounded.run.mockImplementation(async (options: { env: NodeJS.ProcessEnv }) => {
      if (options.env.TAKT_FINISH_TASK_NAME === 'throws') throw new Error('spawn ENOENT');
      return okCommandResult;
    });

    await runTaskFinishHooksForStates(project, [
      state('throws', 'completed'),
      state('succeeds', 'completed'),
    ]);

    expect(bounded.run).toHaveBeenCalledTimes(2);
    const completedCalls = bounded.run.mock.calls.filter(
      (call) => (call[0] as { env: NodeJS.ProcessEnv }).env.TAKT_FINISH_TASK_NAME === 'succeeds',
    );
    expect(completedCalls).toHaveLength(1);
    expect(onlyWarnMessage()).toContain('throws');
  });

  it('warns once when the post-execution read times out twice, and returns the execution result unchanged (8)', async () => {
    const project = makeProject();
    const { runner, reads } = fakeRunner([[state('task-a', 'running')], lockTimeout()]);

    vi.useFakeTimers();
    const result = await runWithFakeTimers(() =>
      withTaskFinishHook(project, runner, 'task-a', async () => 'unchanged'));

    expect(result).toBe('unchanged');
    expect(reads).toHaveBeenCalledTimes(3);
    expect(onlyWarnMessage()).toContain('task-a');
    expect(bounded.run).not.toHaveBeenCalled();
  });

  it('calls the hook once when the post-execution read times out and the retry finds the terminal state (9)', async () => {
    const project = makeProject();
    const completed = state('task-a', 'completed', { completedAt: '2026-01-02T00:00:00.000Z' });
    const { runner, reads } = fakeRunner([[state('task-a', 'running')], lockTimeout(), [completed]]);

    vi.useFakeTimers();
    await runWithFakeTimers(() =>
      withTaskFinishHook(project, runner, 'task-a', async () => undefined));

    expect(reads).toHaveBeenCalledTimes(3);
    expect(bounded.run).toHaveBeenCalledTimes(1);
    expectNoNotice();
  });

  it('at-least-once: when the pre-read fails and the post-read is terminal, calls the hook once and warns once (10)', async () => {
    const project = makeProject();
    const completed = state('task-a', 'completed', { completedAt: '2026-01-02T00:00:00.000Z' });
    const { runner, reads } = fakeRunner([lockTimeout(), [completed]]);

    await withTaskFinishHook(project, runner, 'task-a', async () => undefined);

    expect(reads).toHaveBeenCalledTimes(2);
    expect(bounded.run).toHaveBeenCalledTimes(1);
    const message = onlyWarnMessage();
    expect(message).toContain('task-a');
    expect(message).toMatch(/before|previous|prior|earlier|unreadable/i);
  });

  it('keeps the unchanged-stamp behaviour: a successful pre-read and the same terminal stamp call no hook and no warn (10)', async () => {
    const project = makeProject();
    const completed = state('task-a', 'completed', { completedAt: '2026-01-02T00:00:00.000Z' });
    const { runner, reads } = fakeRunner([[completed], [completed]]);

    await withTaskFinishHook(project, runner, 'task-a', async () => undefined);

    expect(reads).toHaveBeenCalledTimes(2);
    expect(bounded.run).not.toHaveBeenCalled();
    expectNoNotice();
  });

  it('does nothing when the project has no task_finish_hook: no read, no warning, no hook (11)', async () => {
    const project = makeProject('none');
    const { runner, reads } = fakeRunner([[state('task-a', 'completed')]]);

    await runTaskFinishHooks(project, runner, ['task-a']);

    expect(reads).not.toHaveBeenCalled();
    expect(bounded.run).not.toHaveBeenCalled();
    expectNoNotice();
  });

  it('names config.yaml when the project config cannot be read, and does not read tasks.yaml (4)', async () => {
    const project = makeProject('invalid-yaml');
    const { runner, reads } = fakeRunner([[state('task-a', 'completed')]]);

    await runTaskFinishHooks(project, runner, ['task-a']);

    expect(reads).not.toHaveBeenCalled();
    const message = onlyWarnMessage();
    expect(message).toContain('config.yaml');
    expect(message).not.toContain('tasks.yaml');
    expect(bounded.run).not.toHaveBeenCalled();
  });

  it('warns once for a rejected hook in the queued execution path (12)', async () => {
    const project = makeProject(hookProjectConfig(REJECTING_HOOK_COMMAND));
    const { runner, task } = claimTask(project);
    stubResolution(project);
    bounded.run.mockImplementation(async (options: { command: string }) => {
      if (options.command === REJECTING_HOOK_COMMAND) throw new Error('hook command could not be started');
      return okCommandResult;
    });

    const result = await executeTaskAndCompleteWithDetails(
      task, runner, project, async () => ({ success: true }), undefined, { outputMode: 'silent' },
    );

    expect(result.success).toBe(true);
    expect(runner.listTaskStateItems().find((item) => item.name === task.name)!.status).toBe('completed');
    expect(bounded.run.mock.calls.some(
      (call) => (call[0] as { command: string }).command === REJECTING_HOOK_COMMAND,
    )).toBe(true);
    expect(onlyWarnMessage()).toContain(task.name);
  });

  it('warns once for a rejected hook in the direct `takt merge` path (12)', async () => {
    const project = makeProject(hookProjectConfig(REJECTING_HOOK_COMMAND));
    doubles.gitProvider.mockReturnValue({
      checkCliStatus: () => ({ available: true }),
      fetchPrStatus: vi.fn(),
      fetchPrDetails: async () => ({
        number: 7,
        headBranch: 'feature',
        baseBranch: 'main',
        headSha: 'a'.repeat(40),
        headRepositoryUrl: 'https://example.invalid/org/repo.git',
        headRepositoryPushUrls: ['https://example.invalid/org/repo.git'],
        sameRepository: true,
      }),
    });
    bounded.run.mockImplementation(async (options: { command: string }) => {
      if (options.command === REJECTING_HOOK_COMMAND) throw new Error('hook command could not be started');
      return okCommandResult;
    });

    // The clone double rejects before any Git process starts, so the merge workflow fails and saves
    // a failed task; the hook still runs and its rejection must be visible.
    await executePrWorkflow({
      projectCwd: project,
      prNumber: 7,
      workflow: 'merge-review',
      settings: resolveMergeSettings(undefined),
      display: { outputMode: 'silent' },
    }).catch(() => undefined);

    expect(bounded.run.mock.calls.some(
      (call) => (call[0] as { command: string }).command === REJECTING_HOOK_COMMAND,
    )).toBe(true);
    expect(gitBoundary.cloneAndIsolateAbortable).toHaveBeenCalledTimes(1);
    expect(onlyWarnMessage()).toContain('Task');
  });

  it('still warns in quiet mode, on stderr, once (13)', async () => {
    const project = makeProject();
    const { runner } = fakeRunner([invalidTasksFile()]);
    setQuietMode(true);

    await runTaskFinishHooks(project, runner, ['task-a']);

    expect(onlyWarnMessage()).toContain('task-a');
    expect(stdoutText()).not.toContain('Task finish hook');
  });

  it('still warns in pipeline mode, on stderr, once (13)', async () => {
    const project = makeProject();
    const { runner } = fakeRunner([invalidTasksFile()]);
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const program = { opts: () => ({ pipeline: true, quiet: true }) } as unknown as Command;

    await initializeCliExecutionContext(program, '171-test');

    expect(getCliExecutionContext().pipelineMode).toBe(true);

    await runTaskFinishHooks(project, runner, ['task-a']);

    expect(onlyWarnMessage()).toContain('task-a');
    expect(stdoutText()).not.toContain('Task finish hook');
  });

  it('writes the notice to stderr once and never to stdout (13)', async () => {
    const project = makeProject();
    const { runner } = fakeRunner([invalidTasksFile()]);

    await runTaskFinishHooks(project, runner, ['task-a']);

    expect(stderrChunks.join('')).toContain('task-a');
    expect(onlyWarnMessage()).toContain('task-a');
    expect(stdoutText()).not.toContain('Task finish hook');
  });

  it('sanitises task names and the reason; no raw control characters or secrets reach the warning (14)', async () => {
    const project = makeProject();
    const name = 'evil\u001b[31m\n"quoted" 日本語';
    const secrets = [
      'sk-Zq24Zqabcdefgh',
      'https://user:Zq24Zqpassword@example.invalid/repo.git',
      'Authorization: Bearer Zq24Zqbearertoken',
    ];
    const reason = `Invalid tasks.yaml: ${secrets.join(' ')}`;
    const { runner } = fakeRunner([new Error(reason)]);

    await runTaskFinishHooks(project, runner, [name]);

    const message = onlyWarnMessage();
    expect(message).toContain(sanitizeTerminalText(name));
    expect(message).not.toContain('\u001b');
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    for (const secret of secrets) {
      expect(message).not.toContain(secret);
    }
    // The reason is carried, masked by sanitizeSensitiveText.
    expect(message).toContain('[REDACTED]');
  });

  it('sanitises terminal controls in a hook exception reason before the warning is written (7)', async () => {
    const project = makeProject();
    // The spawn failure carries the whole error including the lock path, so a lock path with
    // terminal controls and a newline reaches `warn()` through reportLostHook('hook-call').
    const control = '\u001b[2J\nbroken\r\u0000\u001b[31m';
    const execError = Object.assign(new Error(`spawn ENOENT: /project/.takt/tasks.yaml.lock ${control}`), {
      code: 'ENOENT',
      path: `/project/.takt/tasks.yaml.lock ${control}`,
      syscall: `spawn ${control}`,
    });
    const { runner } = fakeRunner([[state('task-a', 'completed')]]);
    bounded.run.mockRejectedValue(execError);

    await runTaskFinishHooks(project, runner, ['task-a']);

    const message = onlyWarnMessage();
    expect(message).toContain('could not be started');
    expect(message).not.toContain('\u001b');
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(message).toContain('\\n');
  });

  it('does not warn when the post-execution read fails and the project has no hook (8)', async () => {
    // The pre-read fails too, so the execution reaches the post-read without a stamp. The project
    // has no task_finish_hook: no hook can have been lost, so the failed post-read stays silent.
    const project = makeProject('none');
    const { runner, reads } = fakeRunner([lockTimeout()]);

    vi.useFakeTimers();
    await runWithFakeTimers(() =>
      withTaskFinishHook(project, runner, 'task-a', async () => undefined));

    expect(reads).toHaveBeenCalledTimes(3);
    expect(bounded.run).not.toHaveBeenCalled();
    expectNoNotice();
  });

  it('sanitises terminal controls in the reason before the warning is written (14)', async () => {
    const project = makeProject();
    const reason = new Error('Invalid tasks.yaml: \u001b[2J\nbroken\r\u0000\u001b[31m');
    const { runner } = fakeRunner([reason]);

    await runTaskFinishHooks(project, runner, ['task-a']);

    const message = onlyWarnMessage();
    expect(message).toContain('Invalid tasks.yaml');
    expect(message).not.toContain('\u001b');
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(message).toContain('\\n');
  });

  it('collapses 1,000 task names to the first 10 and "and 990 more" in one warning (15)', async () => {
    const project = makeProject();
    const names = Array.from({ length: 1_000 }, (_, index) => `task-${String(index).padStart(4, '0')}`);
    const { runner } = fakeRunner([invalidTasksFile()]);

    await runTaskFinishHooks(project, runner, names);

    const message = onlyWarnMessage();
    for (const name of names.slice(0, 10)) expect(message).toContain(name);
    expect(message).toContain('and 990 more');
    expect(message).not.toContain(names[10]!);
    expect(bounded.run).not.toHaveBeenCalled();
  });

  it('regression: a completed task saved by the queue runs the hook once with the saved state (16)', async () => {
    const project = makeProject();
    const { runner, task } = claimTask(project);
    stubResolution(project);

    const result = await executeTaskAndCompleteWithDetails(
      task, runner, project, async () => ({ success: true }), undefined, { outputMode: 'silent' },
    );

    expect(result.success).toBe(true);
    const env = hookEnvOfCall();
    expect(env.TAKT_FINISH_TASK_NAME).toBe(task.name);
    expect(env.TAKT_FINISH_STATUS).toBe('completed');
    const saved = runner.listTaskStateItems().find((item) => item.name === task.name)!;
    expect(env.TAKT_FINISH_COMPLETED_AT).toBe(saved.completedAt);
  });

  it('regression: a pr_failed task saved as completed runs the hook once with the PR URL (16)', async () => {
    const project = makeProject();
    const { runner, task } = claimTask(project);
    const now = new Date().toISOString();
    runner.prFailTask({
      task,
      success: true,
      response: 'PR creation failed',
      executionLog: [],
      startedAt: now,
      completedAt: now,
    }, 'gh: not authenticated');
    runner.completePublishedTask(task.name, 'https://example.invalid/pull/1', 'b'.repeat(40));

    await runTaskFinishHooks(project, runner, [task.name], { emitStatusLog: false });

    expect(bounded.run).toHaveBeenCalledTimes(1);
    const env = hookEnvOfCall();
    expect(env.TAKT_FINISH_TASK_NAME).toBe(task.name);
    expect(env.TAKT_FINISH_STATUS).toBe('completed');
    expect(env.TAKT_FINISH_PR_URL).toBe('https://example.invalid/pull/1');
  });

  it('regression: an aborted goal runs the hook once for each pending task it saves as failed (16)', async () => {
    const project = makeProject();
    const runner = new TaskRunner(project);
    const first = runner.addTask('Goal work 1', { workflow: 'default', goal_id: goalId });
    const second = runner.addTask('Goal work 2', { workflow: 'default', goal_id: goalId });
    const unrelated = runner.addTask('Other work', { workflow: 'default' });

    await invalidatePendingGoalTasksWithFinishHook(project, runner, goalId);

    const names = bounded.run.mock.calls.map(
      (call) => (call[0] as { env: NodeJS.ProcessEnv }).env.TAKT_FINISH_TASK_NAME,
    );
    expect(names.sort()).toEqual([first.name, second.name].sort());
    for (const call of bounded.run.mock.calls) {
      const env = (call[0] as { env: NodeJS.ProcessEnv }).env;
      expect(env.TAKT_FINISH_STATUS).toBe('failed');
      expect(env.TAKT_FINISH_GOAL_ID).toBe(goalId);
    }
    expect(runner.listTaskStateItems().find((item) => item.name === unrelated.name)!.status).toBe('pending');
  });
});

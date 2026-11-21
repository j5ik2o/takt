import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../infra/task/store.js';
import { getSelfProcessIdentity } from '../infra/task/process.js';
import { TaskRunner } from '../infra/task/runner.js';
import type { TaskInfo } from '../infra/task/types.js';
import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';
import { isClaimLockTimeoutFailure } from '../features/tasks/execute/claimTasks.js';
import { TSX_ESM_LOADER } from './helpers/typescript-source.js';

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'task-store-concurrent-add.ts',
);

vi.mock('../features/tasks/execute/providerPreflight.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPendingTaskProviders: async () => undefined,
}));

class TaskExecutionDispatchError extends Error {
  constructor() {
    super('Task execution is unavailable in this test');
    this.name = 'TaskExecutionDispatchError';
  }
}

function runWorker(
  projectDir: string,
  workerId: number,
  readyFile: string,
  releaseFile: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import',
      TSX_ESM_LOADER,
      fixturePath,
      projectDir,
      String(workerId),
      readyFile,
      releaseFile,
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Worker ${workerId} exited with ${String(code)}: ${stderr}`));
      }
    });
  });
}

async function waitUntilAllWorkersReady(readyFiles: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (readyFiles.some((file) => !existsSync(file))) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for task-store workers');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runDeletionRaceWorker(projectDir: string, role: 'delete' | 'claim', taskName: string) {
  const child = spawn(process.execPath, [
    '--import',
    TSX_ESM_LOADER,
    join(dirname(fixturePath), 'task-delete-claim.ts'),
    projectDir, role, taskName,
  ], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, killSignal: 'SIGKILL',
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const completed = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on('error', (error) => { stderr += String(error); });
    child.on('close', (code) => { resolve({ code, stderr }); });
  });
  return { child, completed };
}

describe('TaskStore process lock', () => {
  const testDirs: string[] = [];

  afterEach(() => {
    for (const testDir of testDirs) {
      rmSync(testDir, { recursive: true, force: true });
    }
    testDirs.length = 0;
  });

  it.each(['delete', 'claim'] as const)('protects cleanup from concurrent claim when %s acquires first', async (first) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-delete-claim-'));
    testDirs.push(projectDir);
    const worktreePath = join(projectDir, 'worktree');
    mkdirSync(worktreePath);
    const marker = join(worktreePath, 'work.txt');
    writeFileSync(marker, 'keep work');
    const runner = new TaskRunner(projectDir);
    const target = runner.addTask('delete claim race', { branch: 'takt/race', worktree_path: worktreePath });
    const deletion = runDeletionRaceWorker(projectDir, 'delete', target.name);
    const claim = runDeletionRaceWorker(projectDir, 'claim', target.name);
    const start = (role: 'delete' | 'claim') => writeFileSync(join(projectDir, `${role}-start`), 'go');
    try {
      await waitUntilAllWorkersReady(['delete', 'claim'].map((role) => join(projectDir, `${role}-ready`)));
      start(first);
      if (first === 'delete') {
        await waitUntilAllWorkersReady([join(projectDir, 'cleanup-started')]);
        const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
        expect(existsSync(lockFile)).toBe(false);
        start('claim');
        await waitUntilAllWorkersReady([
          join(projectDir, 'claim-attempt'),
          join(projectDir, 'claim-result'),
        ]);
        expect(existsSync(lockFile)).toBe(false);
        expect(JSON.parse(readFileSync(join(projectDir, 'claim-result'), 'utf8'))).toEqual([]);
        expect(parseYaml(readFileSync(runner.getTasksFilePath(), 'utf8'))).toMatchObject({
          tasks: [{ name: target.name, status: 'pending' }],
        });
        writeFileSync(join(projectDir, 'cleanup-release'), 'go');
      } else {
        expect(await claim.completed).toMatchObject({ code: 0 });
        start('delete');
      }

      expect(await deletion.completed).toMatchObject({ code: 0 });
      expect(await claim.completed).toMatchObject({ code: 0 });
      expect(JSON.parse(readFileSync(join(projectDir, 'delete-result'), 'utf8'))).toEqual({ deleted: first === 'delete' });
      expect(JSON.parse(readFileSync(join(projectDir, 'claim-result'), 'utf8'))).toEqual(first === 'claim' ? [target.name] : []);
      expect(existsSync(marker)).toBe(first === 'claim');
      expect(existsSync(join(projectDir, 'cleanup-started'))).toBe(first === 'delete');
      expect(runner.listAllTaskItems()).toMatchObject(first === 'claim'
        ? [{ name: target.name, kind: 'running', worktreePath }] : []);
      expect(runner.listAllTaskItems()).toHaveLength(first === 'claim' ? 1 : 0);
    } finally {
      writeFileSync(join(projectDir, 'cleanup-release'), 'go');
      for (const worker of [deletion, claim]) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
      }
      await Promise.all([deletion.completed, claim.completed]);
    }
  }, 30_000);

  it('serializes simultaneous automatic same-target additions across processes without lost updates', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-process-lock-'));
    testDirs.push(projectDir);
    const releaseFile = join(projectDir, 'release');
    const readyFiles = Array.from(
      { length: 12 },
      (_, workerId) => join(projectDir, `ready-${workerId}`),
    );
    const workers = readyFiles.map((readyFile, workerId) => (
      runWorker(projectDir, workerId, readyFile, releaseFile)
    ));

    await waitUntilAllWorkersReady(readyFiles);
    writeFileSync(releaseFile, 'go', 'utf-8');
    const results = await Promise.all(workers);

    expect(results.filter((result) => result === 'created')).toHaveLength(1);
    expect(results.filter((result) => result === 'duplicate')).toHaveLength(11);
    const tasksFile = readFileSync(join(projectDir, '.takt', 'tasks.yaml'), 'utf-8');
    const parsed = parseYaml(tasksFile) as { tasks: Array<{ issue?: number }> };
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]?.issue).toBe(42);
  }, 20_000);

  it('steals a lock left by a dead process immediately', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-dead-lock-'));
    testDirs.push(projectDir);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });

    const probe = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = probe.pid;
    await new Promise((resolve) => probe.once('close', resolve));
    expect(deadPid).toBeTypeOf('number');

    const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
    writeFileSync(lockFile, JSON.stringify({ pid: deadPid, processIdentity: { startTime: 'terminated-process-start' } }), 'utf-8');

    const store = new TaskStore(projectDir);
    const startedAt = Date.now();
    const data = store.read();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(data.tasks).toEqual([]);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('ignores a leftover legacy guard directory while recovering a dead owner', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-dead-guard-'));
    testDirs.push(projectDir);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    const probe = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = probe.pid;
    await new Promise((resolve) => probe.once('close', resolve));
    expect(deadPid).toBeTypeOf('number');
    const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
    writeFileSync(lockFile, JSON.stringify({ pid: deadPid, processIdentity: { startTime: 'terminated-process-start' } }));
    mkdirSync(`${lockFile}.guard`);
    const guardOwner = join(`${lockFile}.guard`, `owner-${String(deadPid)}-00000000-0000-0000-0000-000000000000`);
    writeFileSync(guardOwner, '');

    expect(new TaskStore(projectDir).read()).toEqual({ tasks: [] });
    expect(existsSync(lockFile)).toBe(false);
    expect(existsSync(guardOwner)).toBe(true);
  });

  it('does not steal a lock held by a live process', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-live-lock-'));
    testDirs.push(projectDir);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, processIdentity: getSelfProcessIdentity() }), 'utf-8');
    const olderThanStaleThreshold = new Date(Date.now() - 60_000);
    utimesSync(lockFile, olderThanStaleThreshold, olderThanStaleThreshold);

    const store = new TaskStore(projectDir);
    expect(() => store.read()).toThrow(/timed out waiting for lock/);
    expect(existsSync(lockFile)).toBe(true);
  }, 10_000);

  it('recovers from a real tasks.yaml lock timeout and claims the pending task on the next tick', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-lock-timeout-'));
    testDirs.push(projectDir);
    const globalDirectory = mkdtempSync(join(tmpdir(), 'takt-task-store-lock-timeout-global-'));
    testDirs.push(globalDirectory);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    mkdirSync(join(globalDirectory, 'workflows', 'personas'), { recursive: true });
    const previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalDirectory;
    writeFileSync(join(globalDirectory, 'config.yaml'), 'provider: mock\nlanguage: en\n');
    writeFileSync(join(globalDirectory, 'workflows', 'personas', 'worker.md'), 'Execute the task.');
    writeFileSync(join(globalDirectory, 'workflows', 'lock-timeout.yaml'), stringifyYaml({
      name: 'lock-timeout', initial_step: 'work', max_steps: 1,
      steps: [{ name: 'work', persona: './personas/worker.md', instruction: '{task}',
        rules: [{ condition: 'when(true)', next: 'ABORT' }] }],
    }));
    writeFileSync(join(projectDir, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [{
        name: 'lock-timeout-task',
        status: 'pending',
        content: 'lock timeout recovery',
        workflow: 'lock-timeout',
        created_at: '2026-02-09T00:00:00.000Z',
        started_at: null,
        completed_at: null,
      }],
    }));
    const runner = new TaskRunner(projectDir);

    const dispatchFailure = new TaskExecutionDispatchError();
    const dispatch = vi.spyOn(TaskRunner.prototype, 'claimNextTasks').mockImplementation(function (
      this: TaskRunner, count: number,
    ): TaskInfo[] {
      throw dispatchFailure;
    });
    const scheduling = new AbortController();
    const cleanup = new AbortController();
    const warnings: string[] = [];
    const outputSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const message = String(args[0]);
      if (message.includes('[WARN]')) warnings.push(message);
    });
    let released = false;
    const timer = setInterval(() => {
      if (!released && warnings.some((message) => message.includes('Cannot claim pending tasks'))) {
        released = true;
        dispatch.mockRestore();
        if (existsSync(lockFile)) rmSync(lockFile, { force: true });
      }
    }, 10);
    const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, processIdentity: getSelfProcessIdentity() }), 'utf-8');
    const olderThanStaleThreshold = new Date(Date.now() - 60_000);
    utimesSync(lockFile, olderThanStaleThreshold, olderThanStaleThreshold);

    try {
      const result = await runWithWorkerPool(
        runner, [], 1, projectDir, undefined, undefined, 50, 'run',
        { schedulingSignal: scheduling.signal, taskAbortSignal: cleanup.signal },
      );

      expect(result.executedTaskNames).toEqual(['lock-timeout-task']);
      expect(warnings.filter((message) => message.includes('Cannot prepare pending tasks'))).toHaveLength(0);
      expect(warnings.filter((message) => message.includes('Cannot claim pending tasks'))).toHaveLength(1);
    } finally {
      clearInterval(timer);
      dispatch.mockRestore();
      outputSpy.mockRestore();
      if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
      else process.env.TAKT_CONFIG_DIR = previousConfigDir;
      if (existsSync(lockFile)) rmSync(lockFile, { force: true });
    }
  }, 30_000);

  it('treats a startup provider-preflight read timeout on the real lock as a retryable timeout', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-startup-timeout-'));
    testDirs.push(projectDir);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [{
        name: 'startup-timeout-task',
        status: 'pending',
        content: 'startup preflight timeout',
        created_at: '2026-02-09T00:00:00.000Z',
        started_at: null,
        completed_at: null,
      }],
    }));
    const runner = new TaskRunner(projectDir);

    const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, processIdentity: getSelfProcessIdentity() }), 'utf-8');
    const olderThanStaleThreshold = new Date(Date.now() - 60_000);
    utimesSync(lockFile, olderThanStaleThreshold, olderThanStaleThreshold);

    let caught: unknown;
    try {
      try {
        runner.listTasksForProviderPreflight(false);
      } catch (error) {
        caught = error;
      }
      expect(isClaimLockTimeoutFailure(caught)).toBe(true);
    } finally {
      if (existsSync(lockFile)) rmSync(lockFile, { force: true });
    }
  }, 30_000);
});

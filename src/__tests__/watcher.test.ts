import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import chalk from 'chalk';
import type { TaskInfo } from '../infra/task/types.js';
import type { ProjectExecutionLock } from '../infra/task/project-execution-lock.js';
import type { TaskExecutionParallelOptions } from '../features/tasks/execute/types.js';
import type { RunAllTasksOptions } from '../features/tasks/execute/types.js';
import type { executeRunTaskAndComplete as ExecuteRunTask } from '../features/tasks/execute/runTaskExecution.js';

const { executeRunTaskAndComplete } = vi.hoisted(() => ({
  executeRunTaskAndComplete: vi.fn<typeof ExecuteRunTask>(),
}));
vi.mock('../features/tasks/execute/runTaskExecution.js', () => ({
  executeRunTaskAndComplete,
  executeRunTaskAndCompleteWithDetails: vi.fn(async (...args: Parameters<typeof ExecuteRunTask>) => {
    const success = await executeRunTaskAndComplete(...args);
    return { success, runSlug: 'test-run', completion: { success, interrupted: false } };
  }),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync), writeFileSync: vi.fn(actual.writeFileSync) };
});
vi.mock('../infra/task/process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/task/process.js')>()),
  getSelfProcessIdentity: () => ({ startTime: '2026-10-03T14:23:40.1234567Z' }),
  getProcessIdentity: (pid: number) => pid === process.pid
    ? { startTime: '2026-10-03T14:23:40.1234567Z' }
    : undefined,
}));
import { TaskRunner } from '../infra/task/runner.js';
import { watchTasks } from '../features/tasks/watch/index.js';
import { runAllTasks } from '../features/tasks/execute/runAllTasks.js';
import { attemptAutoRequeueTask, requeueExistingFailedTasks } from '../features/tasks/execute/parallelExecution.js';
import * as providerPreflight from '../features/tasks/execute/providerPreflight.js';
import { enterInputWait, leaveInputWait } from '../features/tasks/execute/inputWait.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache, loadWorkflowByIdentifier } from '../infra/config/index.js';
import { createAutoRequeueRestartCheck } from '../features/tasks/execute/autoRequeueRestart.js';
import { buildWorkflowRestartPointEntry, buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import type { WorkflowConfig, WorkflowRestartPoint, WorkflowResumePoint } from '../core/models/index.js';
import * as privateFiles from '../shared/utils/private-file.js';
import { GoalStore } from '../infra/goals/store.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const taskNames = [
  { name: 'alpha', displayName: 'alpha' },
  { name: '\x1b[2Jalpha\r\nforged\x07\x9b0m', displayName: 'alpha\\r\\nforged\\x07\\x9b0m' },
];

interface Execution {
  task: TaskInfo;
  parallel: TaskExecutionParallelOptions | undefined;
  options: Parameters<typeof ExecuteRunTask>[3];
  runContext: Parameters<typeof ExecuteRunTask>[5];
  finish: (success: boolean, failureStep?: string) => void;
  settled: boolean;
}

describe('watch の共有 worker pool と tasks.yaml', () => {
  let projectDir: string;
  let runner: TaskRunner;
  let executions: Execution[];
  let watchPromise: Promise<void> | undefined;
  let watchSettled: boolean;
  let savedListeners: ReturnType<typeof process.rawListeners>;
  let inputWaitCount: number;
  let interrupted: boolean;
  let completionOrder: string[];

  function writeConfig(config: Record<string, unknown>): void {
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), stringifyYaml(config));
  }

  function records() {
    return (parseYaml(readFileSync(runner.getTasksFilePath(), 'utf-8')) as {
      tasks: Array<{ name: string; status: string; auto_requeue_count?: number }>;
    }).tasks;
  }

  function state(name: string) {
    return records().find((task) => task.name === name);
  }

  function executionOwner(): ProjectExecutionLock['owner'] {
    const directory = join(projectDir, '.takt', 'execution.lock');
    const files = readdirSync(directory).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    return JSON.parse(readFileSync(join(directory, files[0]!), 'utf8')) as ProjectExecutionLock['owner'];
  }

  function writeSavedTask(name: string, overrides: Record<string, unknown> = {}): void {
    writeFileSync(runner.getTasksFilePath(), stringifyYaml({ tasks: [{
      name, content: 'saved task', workflow: 'default', status: 'failed',
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:01.000Z',
      auto_requeue_count: 0,
      failure: { step: 'implement', error: 'retryable failure', retryable: true },
      ...overrides,
    }] }));
  }

  /** work reaches report_failure on failure; report_failure can only abort. */
  function writeNotifyWorkflow(): WorkflowConfig {
    mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'workflows', 'notify.yaml'), [
      'name: notify', 'max_steps: 10', 'initial_step: work', 'steps:',
      '  - name: work', '    instruction: "{task}"',
      '    rules:', '      - condition: when(true)', '        next: COMPLETE',
      '      - condition: when(false)', '        next: report_failure',
      '  - name: report_failure', '    instruction: Report the failure',
      '    rules:', '      - condition: when(true)', '        next: ABORT',
    ].join('\n'));
    invalidateAllResolvedConfigCache();
    return loadWorkflowByIdentifier('notify', projectDir)!;
  }

  function resumePointAt(workflow: WorkflowConfig, step: string): WorkflowResumePoint {
    return {
      version: 2, stack: [buildWorkflowResumePointEntry(workflow, step, 'agent', 1)], iteration: 2, elapsed_ms: 0,
      workflow_call_invocations: {}, workflow_step_participations: {},
    };
  }

  function restartPointAt(workflow: WorkflowConfig, step: string): WorkflowRestartPoint {
    return { stack: [buildWorkflowRestartPointEntry(workflow, step, 'agent')] };
  }

  function interrupt(): void {
    if (interrupted) return;
    interrupted = true;
    for (const listener of process.rawListeners('SIGINT')) {
      if (!savedListeners.includes(listener)) listener.call(process, 'SIGINT');
    }
  }

  function startWatch(options?: RunAllTasksOptions): void {
    watchPromise = watchTasks(projectDir, options);
    void watchPromise.then(() => {
      watchSettled = true;
      completionOrder.push('watch stopped');
    }, () => { watchSettled = true; });
  }

  function waitForInput(): void {
    enterInputWait();
    inputWaitCount++;
  }

  function resumeInput(): void {
    leaveInputWait();
    inputWaitCount--;
  }

  function addFailedTask(content: string): TaskInfo {
    const added = runner.addTask(content);
    const task = runner.claimNextTasks(1)[0]!;
    runner.failTask({
      task, success: false, response: 'retryable failure', failureStep: 'implement',
      executionLog: [], startedAt: task.createdAt, completedAt: task.createdAt,
    });
    return added;
  }

  async function injectClaimFailure(stage: 'create' | 'metadata' | 'persistence' | 'timeout', failures: number) {
    const nativeFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const timeoutFailure = new Error(`File lock: timed out waiting for lock: ${runner.getTasksFilePath()}.lock`);
    const claimFailure = stage === 'timeout' ? timeoutFailure : failure;
    const claimNextTasks = TaskRunner.prototype.claimNextTasks;
    let lockDescriptor: number | undefined;
    let claiming = false;
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks').mockImplementation(function (this: TaskRunner, ...args) {
      claiming = true;
      lockDescriptor = undefined;
      try {
        return claimNextTasks.apply(this, args);
      } finally {
        claiming = false;
      }
    });
    const fail = () => {
      if (failures > 0) {
        failures--;
        throw claimFailure;
      }
    };
    vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
      const claimLock = claiming && typeof path === 'string' && flags === 'wx'
        && (path === `${runner.getTasksFilePath()}.lock`
          || path.startsWith(`${runner.getTasksFilePath()}.lock.`) && path.endsWith('.tmp'));
      if (claimLock && (stage === 'create' || stage === 'timeout')) fail();
      const descriptor = nativeFs.openSync(path, flags, mode);
      if (claimLock) lockDescriptor = descriptor;
      return descriptor;
    });
    vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
      if (claiming && stage === 'metadata' && file === lockDescriptor) fail();
      return nativeFs.writeFileSync(file, data, options);
    });
    const write = privateFiles.writePrivateFileWithMode;
    vi.spyOn(privateFiles, 'writePrivateFileWithMode').mockImplementation((file, data, mode) => {
      if (claiming && stage === 'persistence' && file === runner.getTasksFilePath()) fail();
      return write(file, data, mode);
    });
    return { claim, failure };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mkdirSync(join(process.cwd(), '.takt'), { recursive: true });
    projectDir = mkdtempSync(join(process.cwd(), '.takt', 'watch-test-'));
    mkdirSync(join(projectDir, '.takt'));
    writeConfig({ concurrency: 1, task_poll_interval_ms: 500, auto_requeue_max_attempts: 0 });
    invalidateGlobalConfigCache();
    runner = new TaskRunner(projectDir);
    runner.ensureDirs();
    executions = [];
    watchPromise = undefined;
    watchSettled = false;
    inputWaitCount = 0;
    interrupted = false;
    completionOrder = [];
    savedListeners = process.rawListeners('SIGINT');
    executeRunTaskAndComplete.mockReset().mockImplementation((task, taskRunner, _cwd, options, parallel, runContext) => {
      return new Promise<boolean>((resolve) => {
        const signal = parallel?.abortSignal;
        const onAbort = () => execution.finish(false);
        const execution: Execution = {
          task, parallel, options, runContext, settled: false,
          finish: (success, failureStep = 'implement') => {
            if (execution.settled) return;
            execution.settled = true;
            signal?.removeEventListener('abort', onAbort);
            const result = {
              task, success, response: success ? 'done' : 'retryable failure', failureStep,
              executionLog: [], startedAt: task.createdAt, completedAt: task.createdAt,
            };
            if (success) taskRunner.completeTask(result);
            else taskRunner.failTask(result);
            completionOrder.push(task.name);
            resolve(success);
          },
        };
        executions.push(execution);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it.each([
    { mode: 'run', stage: 'create', goalTasksOnly: false },
    { mode: 'run', stage: 'metadata', goalTasksOnly: false },
    { mode: 'run', stage: 'create', goalTasksOnly: true },
    { mode: 'watch', stage: 'create', goalTasksOnly: false },
  ] as const)('$mode は実TaskStoreの $stage ENOSPCから同じ所有者で5秒後に回復する（goal限定=$goalTasksOnly）', async ({ mode, stage, goalTasksOnly }) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    if (goalTasksOnly) await new GoalStore(projectDir).create(goalRecord());
    const task = runner.addTask('recover claim', goalTasksOnly ? { goal_id: goalRecord().id } : undefined);
    const { claim } = await injectClaimFailure(stage, 1);
    const entry = mode === 'run' ? runAllTasks(projectDir, { goalTasksOnly }) : watchTasks(projectDir);
    const outcome = entry.then(() => undefined, (error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const owner = executionOwner();
      expect(claim).toHaveBeenCalledTimes(1);
      expect(state(task.name)?.status).toBe('pending');
      expect(existsSync(`${runner.getTasksFilePath()}.lock`)).toBe(false);
      expect(executions).toHaveLength(0);
      if (mode === 'run') {
        expect(vi.mocked(console.log).mock.calls.some(([message]) => String(message).includes('Running tasks'))).toBe(false);
      }

      await vi.advanceTimersByTimeAsync(4_999);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(executions).toHaveLength(0);
      expect(executionOwner()).toEqual(owner);
      await vi.advanceTimersByTimeAsync(1);
      expect(executions.map(({ task }) => task.name)).toEqual([task.name]);
      expect(state(task.name)?.status).toBe('running');
      expect(executionOwner()).toEqual(owner);
      executions[0]!.finish(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(state(task.name)?.status).toBe('completed');
      expect(executions).toHaveLength(1);
      if (mode === 'watch') {
        await vi.advanceTimersByTimeAsync(500);
        expect(executionOwner()).toEqual(owner);
        expect(executions).toHaveLength(1);
        interrupt();
      } else {
        const messages = vi.mocked(console.log).mock.calls.map(([message]) => String(message));
        expect(messages.filter((message) => message.includes('Running tasks'))).toHaveLength(1);
        expect(messages.some((message) => message.includes('Tasks Summary'))).toBe(true);
      }
      expect(await outcome).toBeUndefined();
      expect(existsSync(join(projectDir, '.takt', 'execution.lock'))).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      interrupt();
      for (const execution of executions) execution.finish(true);
      await outcome;
    }
  });

  it.each([
    { pending: false, goalTasksOnly: false },
    { pending: true, goalTasksOnly: true },
  ])('実取得ENOSPCでも対象pendingがなければ待たない（pending=$pending、goal限定=$goalTasksOnly）', async ({ pending, goalTasksOnly }) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    if (pending) runner.addTask('ordinary task');
    const { claim, failure } = await injectClaimFailure('create', 1);

    await expect(runAllTasks(projectDir, { goalTasksOnly })).rejects.toMatchObject({ cause: failure });

    expect(claim).toHaveBeenCalledTimes(1);
    expect(executions).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(existsSync(join(projectDir, '.takt', 'execution.lock'))).toBe(false);
  });

  it('実TaskStoreのロック取得タイムアウト後、同じ run で次の tick に pending を取り込む', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const task = runner.addTask('recover after lock timeout');
    const { claim } = await injectClaimFailure('timeout', 1);

    const entry = runAllTasks(projectDir);
    const outcome = entry.then(() => undefined, (error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(state(task.name)?.status).toBe('pending');
      expect(executions).toHaveLength(0);
      expect(vi.mocked(console.log).mock.calls.some(([message]) =>
        String(message).includes('Cannot claim pending tasks because the task store lock is held'))).toBe(true);
      expect(vi.mocked(console.log).mock.calls.some(([message]) => String(message).includes('disk is full'))).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(claim).toHaveBeenCalledTimes(2);
      expect(state(task.name)?.status).toBe('running');
      expect(executions.map(({ task: executed }) => executed.name)).toEqual([task.name]);
    } finally {
      for (const execution of executions) execution.finish(true);
      await vi.advanceTimersByTimeAsync(0);
      await outcome;
    }
    expect(state(task.name)?.status).toBe('completed');
    expect(vi.mocked(console.log).mock.calls.filter(([message]) =>
      String(message).includes('[WARN]'))).toHaveLength(1);
  });

  it('実TaskStoreの取得後永続化ENOSPCは変換せずに伝播する', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const task = runner.addTask('persistence failure');
    const { claim, failure } = await injectClaimFailure('persistence', 1);

    await expect(runAllTasks(projectDir)).rejects.toBe(failure);

    expect(claim).toHaveBeenCalledTimes(1);
    expect(state(task.name)?.status).toBe('pending');
    expect(executions).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['run', 'watch'] as const)('%s の実取得ENOSPC待機中の中断は再取得せずタイマーを解除する', async (mode) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const task = runner.addTask('interrupt claim wait');
    const { claim } = await injectClaimFailure('create', Infinity);
    const entry = mode === 'run' ? runAllTasks(projectDir) : watchTasks(projectDir);
    const outcome = entry.then(() => undefined, (error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(executionOwner()).toMatchObject({ kind: mode, state: 'running' });
      interrupt();
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcome).toBeUndefined();
      expect(claim).toHaveBeenCalledTimes(1);
      expect(state(task.name)?.status).toBe('pending');
      expect(executions).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(existsSync(join(projectDir, '.takt', 'execution.lock'))).toBe(false);
    } finally {
      interrupt();
      await outcome;
    }
  });

  it.each(taskNames)('watch 起動時に保存名 $displayName を安全に表示し、原名で再投入・完了する', async ({ name, displayName }) => {
    writeConfig({ auto_requeue_max_attempts: 1 });
    writeSavedTask(name);

    startWatch();
    await vi.advanceTimersByTimeAsync(0);

    expect(executions.map(({ task }) => task.name)).toEqual([name]);
    expect(state(name)).toMatchObject({ name, status: 'running', auto_requeue_count: 1 });
    expect(console.log).toHaveBeenCalledWith(chalk.blue(`[INFO] Task "${displayName}" auto-requeued (1/1)`));
    executions[0]!.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state(name)).toMatchObject({ name, status: 'completed', auto_requeue_count: 1 });
  });

  it.each(taskNames)('run 起動時も保存名 $displayName を原値で再投入し、安全に表示する', async ({ name, displayName }) => {
    writeConfig({ auto_requeue_max_attempts: 1 });
    writeFileSync(join(process.env.TAKT_CONFIG_DIR!, 'config.yaml'), stringifyYaml({ notification_sound: false }));
    writeSavedTask(name);
    const run = runAllTasks(projectDir);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(executions.map(({ task }) => task.name)).toEqual([name]);
      expect(console.log).toHaveBeenCalledWith(chalk.blue(`[INFO] Task "${displayName}" auto-requeued (1/1)`));
    } finally {
      for (const execution of executions) execution.finish(true);
      await run;
    }
    expect(state(name)).toMatchObject({ name, status: 'completed', auto_requeue_count: 1 });
  });

  it.each(taskNames)('watch の実行失敗後も保存名 $displayName を原値で再投入し、安全に表示する', async ({ name, displayName }) => {
    writeConfig({ auto_requeue_max_attempts: 1 });
    writeSavedTask(name, { status: 'pending', started_at: null, completed_at: null, failure: undefined });
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    executions[0]!.finish(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(executions.map(({ task }) => task.name)).toEqual([name, name]);
    expect(state(name)).toMatchObject({ name, status: 'running', auto_requeue_count: 1 });
    expect(console.log).toHaveBeenCalledWith(chalk.blue(`[INFO] Task "${displayName}" auto-requeued (1/1)`));
    executions[1]!.finish(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(state(name)).toMatchObject({ name, status: 'failed', auto_requeue_count: 1 });
    expect(console.log).toHaveBeenCalledWith(chalk.blue(`[INFO] Task "${displayName}" was not auto-requeued: max attempts reached (1/1)`));
  });

  it.each([
    { position: 'failure.step', failedStep: 'report_failure', saved: () => ({}) },
    { position: 'resume_point', failedStep: 'report_failure',
      saved: (workflow: WorkflowConfig) => ({ resume_point: resumePointAt(workflow, 'report_failure') }) },
    { position: 'restart_point', failedStep: 'work',
      saved: (workflow: WorkflowConfig) => ({ restart_point: restartPointAt(workflow, 'report_failure') }) },
  ])('再開位置（$position）が ABORT にしか進めない step の失敗タスクは自動で再投入せず、理由を表示する', ({ failedStep, saved }) => {
    const { name, displayName } = taskNames[1]!;
    const workflow = writeNotifyWorkflow();
    writeSavedTask(name, {
      workflow: 'notify', failure: { step: failedStep, error: 'reported failure', retryable: true }, ...saved(workflow),
    });
    const before = records();

    expect(runner.isAutoRequeueEligible(name, 2, createAutoRequeueRestartCheck(projectDir))).toBe(false);
    expect(attemptAutoRequeueTask(runner, projectDir, name, 2)).toBe(false);

    expect(records()).toEqual(before);
    expect(console.log).toHaveBeenCalledWith(chalk.blue(
      `[INFO] Task "${displayName}" was not auto-requeued: restart position can only abort the workflow (0/2)`,
    ));
  });

  it.each([
    { position: 'failure.step', failedStep: 'work', saved: () => ({}), expected: { start_step: 'work' } },
    { position: 'resume_point', failedStep: 'work',
      saved: (workflow: WorkflowConfig) => ({ resume_point: resumePointAt(workflow, 'work') }), expected: { start_step: 'work' } },
    { position: 'restart_point', failedStep: 'report_failure',
      saved: (workflow: WorkflowConfig) => ({ restart_point: restartPointAt(workflow, 'work') }), expected: {} },
  ])('再開位置（$position）の行き先に ABORT 以外がある失敗タスクは従来どおり自動で再投入する', ({ failedStep, saved, expected }) => {
    const { name } = taskNames[0]!;
    const workflow = writeNotifyWorkflow();
    writeSavedTask(name, {
      workflow: 'notify', failure: { step: failedStep, error: 'retryable failure', retryable: true }, ...saved(workflow),
    });

    expect(runner.isAutoRequeueEligible(name, 2, createAutoRequeueRestartCheck(projectDir))).toBe(true);
    expect(attemptAutoRequeueTask(runner, projectDir, name, 2)).toBe(true);

    expect(state(name)).toMatchObject({ status: 'pending', auto_requeue_count: 1, ...expected });
  });

  it.each([
    { position: 'failure.step', saved: () => ({}) },
    { position: 'resume_point', saved: (workflow: WorkflowConfig) => ({ resume_point: resumePointAt(workflow, 'work') }) },
  ])('ほかの step から進んでこない step（$position）は、ABORT にしか進めなくても自動で再投入する', ({ saved }) => {
    const { name } = taskNames[0]!;
    mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'workflows', 'notify.yaml'), [
      'name: notify', 'max_steps: 10', 'initial_step: work', 'steps:',
      '  - name: work', '    instruction: "{task}"',
      '    rules:', '      - condition: when(true)', '        next: ABORT',
    ].join('\n'));
    invalidateAllResolvedConfigCache();
    const workflow = loadWorkflowByIdentifier('notify', projectDir)!;
    writeSavedTask(name, {
      workflow: 'notify', failure: { step: 'work', error: 'retryable failure', retryable: true }, ...saved(workflow),
    });

    expect(attemptAutoRequeueTask(runner, projectDir, name, 1)).toBe(true);

    expect(state(name)).toMatchObject({ status: 'pending', auto_requeue_count: 1, start_step: 'work' });
  });

  it('workflow を読めない失敗タスクは従来どおり自動で再投入する', () => {
    const { name } = taskNames[0]!;
    writeSavedTask(name, { workflow: 'missing-workflow' });

    expect(attemptAutoRequeueTask(runner, projectDir, name, 1)).toBe(true);

    expect(state(name)).toMatchObject({ status: 'pending', auto_requeue_count: 1 });
  });

  it('watch は通知 step で ABORT したタスクを再実行せず、failed のまま残す', async () => {
    const name = 'notify-task';
    writeConfig({ auto_requeue_max_attempts: 2 });
    writeNotifyWorkflow();
    writeSavedTask(name, { workflow: 'notify', status: 'pending', started_at: null, completed_at: null, failure: undefined });
    const preflight = vi.spyOn(providerPreflight, 'checkQueuedTaskProviders');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    preflight.mockClear();

    executions[0]!.finish(false, 'report_failure');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(executions.map(({ task }) => task.name)).toEqual([name]);
    expect(state(name)).toMatchObject({ status: 'failed', auto_requeue_count: 0 });
    expect(preflight).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(chalk.blue(
      `[INFO] Task "${name}" was not auto-requeued: restart position can only abort the workflow (0/2)`,
    ));
  });

  it('watch は同じ workflow でも作業 step で失敗したタスクは再実行する', async () => {
    const name = 'notify-task';
    writeConfig({ auto_requeue_max_attempts: 2 });
    writeNotifyWorkflow();
    writeSavedTask(name, { workflow: 'notify', status: 'pending', started_at: null, completed_at: null, failure: undefined });
    startWatch();
    await vi.advanceTimersByTimeAsync(0);

    executions[0]!.finish(false, 'work');
    await vi.advanceTimersByTimeAsync(0);

    expect(executions.map(({ task }) => task.name)).toEqual([name, name]);
    expect(state(name)).toMatchObject({ status: 'running', auto_requeue_count: 1 });
  });

  it.each(['run', 'watch'] as const)('%s 起動時、通知 step で失敗済みのタスクは provider 確認も再投入もしない', async (mode) => {
    const name = 'notify-task';
    writeConfig({ auto_requeue_max_attempts: 2 });
    writeFileSync(join(process.env.TAKT_CONFIG_DIR!, 'config.yaml'), stringifyYaml({ notification_sound: false }));
    writeNotifyWorkflow();
    writeSavedTask(name, { workflow: 'notify', failure: { step: 'report_failure', error: 'reported failure', retryable: true } });
    const before = records();
    const preflight = vi.spyOn(providerPreflight, 'checkQueuedTaskProviders');

    if (mode === 'run') await runAllTasks(projectDir);
    else {
      startWatch();
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(executions).toHaveLength(0);
    expect(preflight).not.toHaveBeenCalled();
    expect(records()).toEqual(before);
  });

  it.each([
    { reason: 'task_not_failed', status: 'pending', overrides: { status: 'pending', started_at: null, completed_at: null, failure: undefined } },
    { reason: 'max_attempts_reached', status: 'failed', overrides: { auto_requeue_count: 1 } },
    { reason: 'failure_not_retryable', status: 'failed', overrides: { failure: { step: 'implement', error: 'retryable failure', retryable: false } } },
    { reason: 'missing_failed_step', status: 'failed', overrides: { failure: { step: ' ', error: 'retryable failure', retryable: true } } },
    { reason: 'missing_failure_detail', status: 'failed', overrides: { failure: { step: 'implement', error: ' ', retryable: true } } },
  ])('保存YAMLの $reason 判定・状態・回数を維持し、安全なスキップログを出す', ({ reason, status, overrides }) => {
    const { name, displayName } = taskNames[1]!;
    writeSavedTask(name, overrides);
    const before = records();
    const requeue = vi.spyOn(runner, 'autoRequeueFailedTask');

    expect(attemptAutoRequeueTask(runner, projectDir, name, 1)).toBe(false);

    expect(requeue.mock.results[0]?.value).toMatchObject({ requeued: false, reason });
    expect(records()).toEqual(before);
    expect(state(name)?.status).toBe(status);
    const line = vi.mocked(console.log).mock.calls[0]?.[0] as string;
    expect(line).toContain(displayName);
    expect(line).not.toContain('\x1b[2J');
    for (const control of ['\r', '\n', '\x07', '\x9b']) expect(line).not.toContain(control);
  });

  it.each([undefined, 0])('再投入上限=%s では保存状態を変えずログを出さない', (maxAttempts) => {
    writeSavedTask(taskNames[1]!.name);
    const before = records();
    expect(requeueExistingFailedTasks(runner, projectDir, maxAttempts)).toBe(0);
    expect(records()).toEqual(before);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('新しい同PR mergeが実行中なら旧失敗mergeを保持し、次のfailed taskを再投入する', () => {
    const mergeInput = {
      prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: 'a'.repeat(40),
      headRepositoryUrl: '/fork.git', headRepositoryPushUrls: ['/fork.git'],
      workflow: 'merge-review', method: 'squash' as const,
      threatCheckMaxDiffBytes: 1000,
    };
    const old = runner.startPrMergeTask({ ...mergeInput, worktreePath: join(projectDir, 'old-clone') });
    runner.forceFailRunningTask(old.name, { step: 'review', error: 'Manually marked as failed' });
    const oldRecord = state(old.name);
    const fresh = runner.startPrMergeTask({ ...mergeInput, worktreePath: join(projectDir, 'new-clone') });
    const next = addFailedTask('another failed task');

    expect(requeueExistingFailedTasks(runner, projectDir, 1)).toBe(1);

    expect(state(old.name)).toEqual(oldRecord);
    expect(state(fresh.name)?.status).toBe('running');
    expect(state(next.name)).toMatchObject({ status: 'pending', auto_requeue_count: 1 });
  });

  it('同PR mergeの競合時は旧workflowのprovider確認をせず他の失敗タスクを実行する', async () => {
    writeConfig({ auto_requeue_max_attempts: 1 });
    writeFileSync(join(process.env.TAKT_CONFIG_DIR!, 'config.yaml'), stringifyYaml({ notification_sound: false }));
    const mergeInput = {
      prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: 'a'.repeat(40),
      headRepositoryUrl: '/fork.git', headRepositoryPushUrls: ['/fork.git'],
      workflow: 'missing-old-workflow', method: 'squash' as const,
      threatCheckMaxDiffBytes: 1000,
    };
    const old = runner.startPrMergeTask({ ...mergeInput, worktreePath: join(projectDir, 'old-clone') });
    runner.forceFailRunningTask(old.name, { step: 'review', error: 'Manually marked as failed' });
    const oldRecord = state(old.name);
    const fresh = runner.startPrMergeTask({ ...mergeInput, worktreePath: join(projectDir, 'new-clone') });
    const next = addFailedTask('another failed task');
    const preflight = vi.spyOn(providerPreflight, 'checkQueuedTaskProviders');

    expect(runner.isAutoRequeueEligible(old.name, 1)).toBe(false);
    const run = runAllTasks(projectDir);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(executions.map(({ task }) => task.name)).toEqual([next.name]);
    } finally {
      for (const execution of executions) execution.finish(true);
      await run;
    }

    expect(preflight.mock.calls.map(([, task]) => task.name)).not.toContain(old.name);
    expect(state(old.name)).toEqual(oldRecord);
    expect(state(fresh.name)?.status).toBe('running');
    expect(state(next.name)).toMatchObject({ status: 'completed', auto_requeue_count: 1 });
  });

  afterEach(async () => {
    interrupt();
    for (const execution of executions) execution.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    await watchPromise;
    const nativeFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.openSync).mockImplementation(nativeFs.openSync);
    vi.mocked(fs.writeFileSync).mockImplementation(nativeFs.writeFileSync);
    while (inputWaitCount > 0) resumeInput();
    vi.restoreAllMocks();
    vi.useRealTimers();
    invalidateGlobalConfigCache();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it.each([1, 3])('concurrency=%s に達して実行し、空きができるまで上限を超えない', async (concurrency) => {
    writeConfig({ concurrency, task_poll_interval_ms: 500 });
    const tasks = Array.from({ length: 4 }, (_, index) => runner.addTask(`task ${index}`));

    startWatch();
    await vi.advanceTimersByTimeAsync(0);

    expect(executions.map(({ task }) => task.name)).toEqual(tasks.slice(0, concurrency).map(({ name }) => name));
    expect(records().filter(({ status }) => status === 'running')).toHaveLength(concurrency);
    await vi.advanceTimersByTimeAsync(500);
    expect(executions).toHaveLength(concurrency);
    executions[0]!.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(executions).toHaveLength(concurrency + 1);
    expect(executions.filter(({ settled }) => !settled)).toHaveLength(concurrency);
    expect(state(tasks[0]!.name)?.status).toBe('completed');
  });

  it.each([
    { configuredInterval: undefined, interval: 500 },
    { configuredInterval: 900, interval: 900 },
  ])('同じ watch が空→追加→消化→再追加を poll=$interval ms で処理する', async ({ configuredInterval, interval }) => {
    writeConfig(configuredInterval === undefined ? {} : { task_poll_interval_ms: configuredInterval });
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(watchSettled).toBe(false);
    const initialClaims = claim.mock.calls.length;
    const first = runner.addTask('first arrival');

    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(claim).toHaveBeenCalledTimes(initialClaims);
    expect(state(first.name)?.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(executions.map(({ task }) => task.name)).toEqual([first.name]);
    executions[0]!.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state(first.name)?.status).toBe('completed');
    expect(watchSettled).toBe(false);

    const second = runner.addTask('second arrival');
    await vi.advanceTimersByTimeAsync(interval);
    expect(executions.map(({ task }) => task.name)).toEqual([first.name, second.name]);
    executions[1]!.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state(second.name)?.status).toBe('completed');
    expect(watchSettled).toBe(false);
  });

  it('長時間タスクが実行中でも後着タスクを空きスロットへ割り当てる', async () => {
    writeConfig({ concurrency: 2, task_poll_interval_ms: 500 });
    const first = runner.addTask('long task');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    const later = runner.addTask('later task');

    await vi.advanceTimersByTimeAsync(500);

    expect(executions.map(({ task }) => task.name)).toEqual([first.name, later.name]);
    expect(executions[0]!.settled).toBe(false);
    expect(state(first.name)?.status).toBe('running');
    expect(state(later.name)?.status).toBe('running');
  });

  it.each([
    { firstSuccess: true, firstStatus: 'completed' },
    { firstSuccess: false, firstStatus: 'failed' },
  ])('SIGINT 後は2件を中断せず、自然な結果 $firstStatus の保存後も残りの完了を待つ', async ({ firstSuccess, firstStatus }) => {
    writeConfig({ concurrency: 2, task_poll_interval_ms: 500, auto_requeue_max_attempts: 1 });
    const tasks = Array.from({ length: 3 }, (_, index) => runner.addTask(`interrupt ${index}`));
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks');
    const requeue = vi.spyOn(TaskRunner.prototype, 'autoRequeueFailedTask');
    const listenersBefore = process.rawListeners('SIGINT');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(executions).toHaveLength(2);
    expect(tasks.slice(0, 2).map(({ name }) => state(name)?.status)).toEqual(['running', 'running']);
    const ownerBefore = executionOwner();
    expect(ownerBefore).toMatchObject({ kind: 'watch', state: 'running', pid: process.pid });
    const signals = executions.map(({ parallel }) => parallel?.abortSignal);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
    interrupt();
    expect(executionOwner()).toEqual({ ...ownerBefore, state: 'stopping' });
    const claimCount = claim.mock.calls.length;

    await vi.advanceTimersByTimeAsync(500);
    expect(watchSettled).toBe(false);
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
    expect(executions.every(({ settled }) => !settled)).toBe(true);
    expect(tasks.slice(0, 2).map(({ name }) => state(name)?.status)).toEqual(['running', 'running']);
    executions[0]!.finish(firstSuccess);
    await vi.advanceTimersByTimeAsync(0);
    expect(watchSettled).toBe(false);
    expect(state(tasks[0]!.name)?.status).toBe(firstStatus);
    expect(state(tasks[1]!.name)?.status).toBe('running');
    expect(completionOrder).toEqual([tasks[0]!.name]);
    expect(executionOwner()).toEqual({ ...ownerBefore, state: 'stopping' });
    executions[1]!.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    await watchPromise;

    expect(watchSettled).toBe(true);
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
    expect(tasks.slice(0, 2).map(({ name }) => state(name)?.status)).toEqual([firstStatus, 'completed']);
    expect(completionOrder).toEqual([tasks[0]!.name, tasks[1]!.name, 'watch stopped']);
    expect(executions).toHaveLength(2);
    expect(claim).toHaveBeenCalledTimes(claimCount);
    expect(requeue).not.toHaveBeenCalled();
    expect(state(tasks[2]!.name)?.status).toBe('pending');
    expect(process.rawListeners('SIGINT')).toEqual(listenersBefore);
    expect(existsSync(join(projectDir, '.takt', 'execution.lock'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each((['run', 'watch'] as const).flatMap((mode) =>
    (['completion-claim', 'requeue', 'poll-claim'] as const).flatMap((failure) =>
      (failure === 'completion-claim' ? [true, false] : [true]).map((remainingSuccess) => ({ mode, failure, remainingSuccess }))),
  ))('$mode の $failure 例外でも残存結果=$remainingSuccess の保存完了まで実行ロックを保持する', async ({ mode, failure, remainingSuccess }) => {
    writeConfig({ concurrency: 2, task_poll_interval_ms: 500, auto_requeue_max_attempts: failure === 'requeue' ? 1 : 0 });
    writeFileSync(join(process.env.TAKT_CONFIG_DIR!, 'config.yaml'), stringifyYaml({ notification_sound: false }));
    const first = runner.addTask('first task');
    if (failure !== 'poll-claim') runner.addTask('remaining task');
    const listenersBefore = process.rawListeners('SIGINT');
    const originalError = new Error(`failure at ${failure}`);
    const claimImplementation = TaskRunner.prototype.claimNextTasks;
    let failClaim = false;
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks').mockImplementation(function (this: TaskRunner, count) {
      if (failClaim) throw originalError;
      return claimImplementation.call(this, count);
    });
    const requeue = vi.spyOn(TaskRunner.prototype, 'autoRequeueFailedTask');
    if (failure === 'requeue') requeue.mockImplementation(() => { throw originalError; });
    let settled = false;
    const entry = mode === 'run' ? runAllTasks(projectDir) : watchTasks(projectDir);
    const outcome = entry.then(() => { settled = true; return undefined; }, (error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const owner = executionOwner();
      const remaining = executions[failure === 'poll-claim' ? 0 : 1]!;
      const queued = runner.addTask('must remain pending');
      if (failure === 'poll-claim') {
        failClaim = true;
        await vi.advanceTimersByTimeAsync(500);
      } else {
        failClaim = failure === 'completion-claim';
        executions[0]!.finish(failure !== 'requeue');
        await vi.advanceTimersByTimeAsync(0);
        expect(state(first.name)?.status).toBe(failure === 'requeue' ? 'failed' : 'completed');
      }
      const claimCount = claim.mock.calls.length;
      const requeueCount = requeue.mock.calls.length;
      expect(failure === 'requeue' ? requeue.mock.results.at(-1)?.type : claim.mock.results.at(-1)?.type).toBe('throw');
      expect(remaining.settled).toBe(false);
      expect(state(remaining.task.name)?.status).toBe('running');
      expect(settled).toBe(false);
      expect(executionOwner()).toEqual(owner);
      for (const next of [runAllTasks, watchTasks]) {
        await expect(next(projectDir)).rejects.toThrow(new RegExp(`${mode}.*${process.pid}|${process.pid}.*${mode}`));
      }
      if (mode === 'watch') {
        interrupt();
        expect(remaining.parallel?.abortSignal?.aborted).toBe(false);
        expect(executionOwner()).toEqual({ ...owner, state: 'stopping' });
      }
      remaining.finish(remainingSuccess);
      expect(await outcome).toBe(originalError);
      expect(state(remaining.task.name)?.status).toBe(remainingSuccess ? 'completed' : 'failed');
      expect(state(queued.name)?.status).toBe('pending');
      expect(claim).toHaveBeenCalledTimes(claimCount);
      expect(requeue).toHaveBeenCalledTimes(requeueCount);
      expect(executions).toHaveLength(failure === 'poll-claim' ? 1 : 2);
      expect(existsSync(join(projectDir, '.takt', 'execution.lock'))).toBe(false);
      expect(process.rawListeners('SIGINT')).toEqual(listenersBefore);
      claim.mockRestore();
      requeue.mockRestore();
      for (const next of [runAllTasks, watchTasks]) {
        interrupted = false;
        const restarted = next(projectDir);
        await vi.advanceTimersByTimeAsync(0);
        for (const execution of executions) execution.finish(true);
        if (next === watchTasks) interrupt();
        await restarted;
        expect(existsSync(join(projectDir, '.takt', 'execution.lock'))).toBe(false);
      }
      expect(state(queued.name)?.status).toBe('completed');
    } finally {
      for (const execution of executions) execution.finish(true);
      await outcome;
    }
  });

  it('アイドル中の SIGINT は次の poll を待たずに watch を終了する', async () => {
    writeConfig({ task_poll_interval_ms: 5000 });
    const listenersBefore = process.rawListeners('SIGINT');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(watchSettled).toBe(false);

    interrupt();
    await vi.advanceTimersByTimeAsync(0);
    await watchPromise;

    expect(watchSettled).toBe(true);
    expect(process.rawListeners('SIGINT')).toEqual(listenersBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('起動時 failed を一度だけ再投入し、常駐中に現れた failed は再投入しない', async () => {
    writeConfig({ auto_requeue_max_attempts: 1, task_poll_interval_ms: 500 });
    const failed = addFailedTask('failed before startup');
    const listFailed = vi.spyOn(TaskRunner.prototype, 'listFailedTasks');
    const requeue = vi.spyOn(TaskRunner.prototype, 'autoRequeueFailedTask');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(executions.map(({ task }) => task.name)).toEqual([failed.name]);
    executions[0]!.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state(failed.name)).toMatchObject({ status: 'completed', auto_requeue_count: 1 });
    const laterFailed = addFailedTask('failed after startup');

    await vi.advanceTimersByTimeAsync(1500);

    expect(listFailed).toHaveBeenCalledTimes(1);
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(state(laterFailed.name)?.status).toBe('failed');
    expect(executions).toHaveLength(1);
    expect(watchSettled).toBe(false);
  });

  it('failed 一覧の取得中に SIGINT を受けた場合は起動時再投入しない', async () => {
    writeConfig({ auto_requeue_max_attempts: 1 });
    const failed = addFailedTask('interrupt before requeue');
    const listFailed = TaskRunner.prototype.listFailedTasks;
    const listing = vi.spyOn(TaskRunner.prototype, 'listFailedTasks').mockImplementation(function (this: TaskRunner) {
      const tasks = listFailed.call(this);
      interrupt();
      return tasks;
    });
    const requeue = vi.spyOn(TaskRunner.prototype, 'autoRequeueFailedTask');

    startWatch();
    await vi.advanceTimersByTimeAsync(0);

    expect(listing).toHaveBeenCalledTimes(1);
    expect(requeue).not.toHaveBeenCalled();
    expect(executions).toEqual([]);
    expect(state(failed.name)?.status).toBe('failed');
    expect(watchSettled).toBe(true);
  });

  it('起動時再投入の途中で SIGINT を受けた場合は残りを再投入しない', async () => {
    writeConfig({ auto_requeue_max_attempts: 1 });
    const first = addFailedTask('first startup failure');
    const second = addFailedTask('second startup failure');
    const autoRequeue = TaskRunner.prototype.autoRequeueFailedTask;
    const requeue = vi.spyOn(TaskRunner.prototype, 'autoRequeueFailedTask').mockImplementation(function (this: TaskRunner, name, options) {
      const result = autoRequeue.call(this, name, options);
      interrupt();
      return result;
    });

    startWatch();
    await vi.advanceTimersByTimeAsync(0);

    expect(requeue).toHaveBeenCalledTimes(1);
    expect(state(first.name)).toMatchObject({ status: 'pending', auto_requeue_count: 1 });
    expect(state(second.name)?.status).toBe('failed');
    expect(executions).toEqual([]);
    expect(watchSettled).toBe(true);
  });

  it.each([0, 1])('実行中失敗は再投入上限=%s を保存し、上限到達後も常駐する', async (maxAttempts) => {
    writeConfig({ auto_requeue_max_attempts: maxAttempts, task_poll_interval_ms: 500 });
    const task = runner.addTask('runtime failure');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(executions).toHaveLength(1);
    executions[0]!.finish(false);
    await vi.advanceTimersByTimeAsync(0);
    if (maxAttempts > 0) {
      expect(executions).toHaveLength(2);
      expect(state(task.name)).toMatchObject({ status: 'running', auto_requeue_count: 1 });
      executions[1]!.finish(false);
      await vi.advanceTimersByTimeAsync(0);
    }

    await vi.advanceTimersByTimeAsync(1500);

    expect(executions).toHaveLength(maxAttempts + 1);
    expect(state(task.name)?.status).toBe('failed');
    expect(state(task.name)?.auto_requeue_count ?? 0).toBe(maxAttempts);
    expect(watchSettled).toBe(false);
  });

  it('初回の入力待ち中は claim せず、同じ watch で解除後に実行する', async () => {
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks');
    waitForInput();
    const task = runner.addTask('initial input wait');
    startWatch();
    await vi.advanceTimersByTimeAsync(1000);
    expect(claim).not.toHaveBeenCalled();
    expect(state(task.name)?.status).toBe('pending');
    expect(executions).toEqual([]);

    resumeInput();
    await vi.advanceTimersByTimeAsync(500);

    expect(executions.map(({ task }) => task.name)).toEqual([task.name]);
    expect(state(task.name)?.status).toBe('running');
  });

  it('入力待ち開始→pending 追加→解除を同じ watch で観測し、claim を再開する', async () => {
    writeConfig({ concurrency: 2, task_poll_interval_ms: 500 });
    runner.addTask('active input wait');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(executions).toHaveLength(1);
    waitForInput();
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks');
    const later = runner.addTask('queued during input wait');

    await vi.advanceTimersByTimeAsync(1000);
    expect(claim).not.toHaveBeenCalled();
    expect(state(later.name)?.status).toBe('pending');
    expect(executions).toHaveLength(1);
    resumeInput();
    await vi.advanceTimersByTimeAsync(500);

    expect(executions).toHaveLength(2);
    expect(executions[1]!.task.name).toBe(later.name);
    expect(executions[0]!.settled).toBe(false);
  });

  it.each([1, 3])('concurrency=%s で開始表示と下流の prefix・color 引数を run と揃える', async (concurrency) => {
    writeConfig({ concurrency });
    const task = runner.addTask('prefixed task', { issue: 42 });
    const write = vi.mocked(process.stdout.write);
    startWatch();
    await vi.advanceTimersByTimeAsync(0);

    expect(executions).toHaveLength(1);
    const parallel = executions[0]!.parallel;
    if (concurrency > 1) {
      expect(parallel).toMatchObject({ taskPrefix: '#42', taskDisplayLabel: '#42', taskColorIndex: expect.any(Number) });
      const startLines = write.mock.calls.map(([chunk]) => String(chunk))
        .filter((line) => line.includes(task.name));
      expect(startLines).toHaveLength(1);
      expect(startLines[0]).toContain('[#42]');
    } else {
      expect(parallel?.taskPrefix).toBeUndefined();
      expect(parallel?.taskColorIndex).toBeUndefined();
      expect(parallel?.taskDisplayLabel).toBeUndefined();
    }
  });

  it.each([
    { configIgnoreExceed: true, cliIgnoreExceed: undefined, expected: true },
    { configIgnoreExceed: false, cliIgnoreExceed: true, expected: true },
    { configIgnoreExceed: false, cliIgnoreExceed: undefined, expected: undefined },
  ])('config=$configIgnoreExceed CLI=$cliIgnoreExceed の実行設定と agentOverrides がタスク実行まで届く', async ({ configIgnoreExceed, cliIgnoreExceed, expected }) => {
    writeConfig({ ignore_exceed: configIgnoreExceed });
    const overrides = {
      provider: 'codex', providerSource: 'cli', model: 'gpt-5', modelSource: 'cli', autoStrategy: 'balanced',
    } as const;
    runner.addTask('execution options');

    startWatch({ ...overrides, ...(cliIgnoreExceed === undefined ? {} : { ignoreExceed: cliIgnoreExceed }) });
    await vi.advanceTimersByTimeAsync(0);

    expect(executions).toHaveLength(1);
    expect(executions[0]!.options).toEqual(overrides);
    expect(executions[0]!.runContext?.ignoreIterationLimit).toBe(expected);
  });
});
vi.mock('../infra/managed-providers/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/managed-providers/loader.js')>()),
  inspectProviderInstallation: vi.fn(async () => ({ state: 'ready', directory: '/test/managed' })),
}));

/**
 * PBT 1, 2 and 4 of docs/design/claim-lock-release-failure.md (#169), with a real tasks.yaml and
 * real locks; release failures are injected into `node:fs` after the write.
 *
 * 1. What a claim wrote does not depend on the release: the returned tasks, the setup failures and
 *    their states, the manager notices, and the saved tasks.yaml are the same as without a fault,
 *    and a failed release is warned exactly once.
 * 2. A failure before the write changes nothing: tasks.yaml is unchanged, nothing is reported or
 *    warned, and the error is classified as it is today.
 * 4. Run-start recovery, goal abort and daemon recovery report the same tasks whatever the
 *    release does. Only the abort and the daemon recovery throw, and only when the release failed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { parse as parseYaml } from 'yaml';
import type { LockReleaseFaultState } from './helpers/lock-release-faults.js';

const faults = vi.hoisted(() => ({ armed: [], times: 1, active: new Map(), failingReads: new Set() }) as LockReleaseFaultState);
vi.mock('node:fs', async (original) => (await import('./helpers/lock-release-faults.js'))
  .withLockReleaseFaults(await original<typeof import('node:fs')>(), faults));
const save = vi.hoisted(() => vi.fn());
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: save }));
const hook = vi.hoisted(() => vi.fn());
vi.mock('../shared/utils/bounded-command-runner.js', async (original) => ({
  ...await original<typeof import('../shared/utils/bounded-command-runner.js')>(),
  runBoundedCommand: hook,
}));
// Failures before the write, without waiting for a real lock timeout.
const before = vi.hoisted(() => ({ tasks: undefined as 'timeout' | 'ENOSPC' | undefined, goal: undefined as 'timeout' | 'ENOSPC' | undefined }));
vi.mock('../infra/fs/file-lock.js', async (original) => {
  const actual = await original<typeof import('../infra/fs/file-lock.js')>();
  return {
    ...actual,
    withFileLock: <T>(lockPath: string, action: () => T, options?: Parameters<typeof actual.withFileLock>[2]): T => {
      if (before.tasks !== undefined && lockPath.endsWith('tasks.yaml.lock')) {
        const error = before.tasks === 'timeout' ? new Error(`File lock: timed out waiting for lock: ${lockPath}`)
          : Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        options?.onAcquisitionError?.(error);
        throw error;
      }
      return actual.withFileLock(lockPath, action, options);
    },
  };
});
vi.mock('../infra/goals/execution-lock.js', async (original) => {
  const actual = await original<typeof import('../infra/goals/execution-lock.js')>();
  const locks = await import('../shared/utils/private-file-lock.js');
  return {
    ...actual,
    withGoalExecutionLock: <Result>(cwd: string, action: () => Result): Result => {
      const lock = join(cwd, '.takt', 'goal-execution.lock');
      if (before.goal === 'timeout') throw new locks.PrivateFileLockTimeoutError(lock);
      if (before.goal === 'ENOSPC') throw new locks.PrivateFileLockAcquisitionError('no space left on device', 'ENOSPC', -28, { cause: new Error('ENOSPC') });
      return actual.withGoalExecutionLock(cwd, action);
    },
  };
});

import { claimTasksWithGoalCompletions, isClaimLockTimeoutFailure } from '../features/tasks/execute/claimTasks.js';
import { createRuntimeAssignmentSetupGuard } from '../features/tasks/execute/runtimeAssignmentGuard.js';
import { invalidatePendingGoalTasksWithFinishHook } from '../features/tasks/execute/taskFinishHook.js';
import { reconcileLostRun } from '../features/daemonTurn/reconcileLostRun.js';
import { TaskRunner, type TaskState } from '../infra/task/index.js';
import { TaskStore } from '../infra/task/store.js';
import { TaskRecordSchema, type TaskRecord } from '../infra/task/schema.js';
import { TaskClaimLockAcquisitionError } from '../infra/task/taskLifecycleService.js';
import { PrivateFileLockAcquisitionError, PrivateFileLockTimeoutError } from '../shared/utils/private-file-lock.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import {
  armAfterWrite, DEAD_HOLDER_PID, healLockReleaseFaults, LOCK_RELEASE_FAULTS, TASKS_LOCK_RELEASE_FAULTS,
  type LockReleaseFault,
} from './helpers/lock-release-faults.js';

const PBT_NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return 40;
})();

const PAUSED_GOAL_ID = '550e8400-e29b-41d4-a716-4466554400aa';
const OTHER_GOAL_ID = '550e8400-e29b-41d4-a716-4466554400bb';
const RELEASE_WARNING = 'releasing a lock afterwards failed';
const dirs: string[] = [];

type TaskKind = 'plain' | 'goal' | 'broken' | 'paused' | 'other-goal' | 'running' | 'lost' | 'failed';
type FaultSet = readonly LockReleaseFault[];

const faultSetArb = (all: readonly LockReleaseFault[]): fc.Arbitrary<FaultSet> => fc.oneof(
  fc.constant([] as FaultSet),
  fc.constantFrom(...all).map((fault) => [fault] as FaultSet),
  // Both releases fail (AggregateError), where both locks are taken.
  ...(all.includes('goal-unlink-EIO') ? [fc.constant(['tasks-unlink-EIO', 'goal-unlink-EIO'] as FaultSet)] : []),
);

function record(index: number, kind: TaskKind): TaskRecord {
  const base = {
    name: `task-${index}`, content: `Work ${index}`, workflow: 'default',
    created_at: '2026-11-27T00:00:00.000Z', started_at: null, completed_at: null, owner_pid: null,
  };
  switch (kind) {
    case 'plain': return TaskRecordSchema.parse({ ...base, status: 'pending' });
    case 'goal': return TaskRecordSchema.parse({ ...base, status: 'pending', goal_id: goalId });
    case 'broken': return TaskRecordSchema.parse({ ...base, status: 'pending', goal_id: goalId, runtime_assignment: 'gone' });
    case 'paused': return TaskRecordSchema.parse({ ...base, status: 'pending', goal_id: PAUSED_GOAL_ID });
    case 'other-goal': return TaskRecordSchema.parse({ ...base, status: 'pending', goal_id: OTHER_GOAL_ID });
    case 'running': return TaskRecordSchema.parse({ ...base, status: 'running', started_at: '2026-11-27T00:00:01.000Z',
      owner_pid: process.pid, owner_start_time: null });
    case 'lost': return TaskRecordSchema.parse({ ...base, status: 'running', goal_id: goalId, started_at: '2026-11-27T00:00:01.000Z',
      owner_pid: DEAD_HOLDER_PID, owner_start_time: null, run_slug: `run-${index}`, execution_id: `execution-${index}` });
    case 'failed': return TaskRecordSchema.parse({ ...base, status: 'failed', started_at: '2026-11-27T00:00:01.000Z', completed_at: '2026-11-27T00:00:02.000Z',
      failure: { error: 'earlier failure' } });
  }
}

function project(kinds: readonly TaskKind[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'takt-claim-release-pbt-')));
  dirs.push(dir);
  for (const [id, executionStatus] of [[goalId, 'active'], [PAUSED_GOAL_ID, 'paused'], [OTHER_GOAL_ID, 'active']] as const) {
    mkdirSync(join(dir, '.takt', 'goals', id), { recursive: true });
    writeFileSync(join(dir, '.takt', 'goals', id, 'goal.json'), JSON.stringify({ ...goalRecord(), id, executionStatus }));
  }
  writeFileSync(join(dir, '.takt', 'config.yaml'), 'language: en\nprovider: mock\ntask_finish_hook:\n  command: [finish-hook]\n', 'utf-8');
  invalidateAllResolvedConfigCache();
  const tasks = kinds.map((kind, index) => record(index, kind));
  new TaskStore(dir).update(() => ({ tasks }));
  return dir;
}

/** The saved records without the values each write makes up (times, run slugs, execution ids). */
function savedTasks(dir: string): unknown[] {
  const raw = parseYaml(readFileSync(join(dir, '.takt', 'tasks.yaml'), 'utf-8')) as { tasks: Record<string, unknown>[] };
  return raw.tasks.map(({ started_at: _s, completed_at: _c, run_slug: _r, execution_id: _e, ...rest }) => rest);
}

/** The two compared projects differ only in their directory, which messages may contain. */
function normalized<T>(dir: string, value: T): T {
  return JSON.parse(JSON.stringify(value ?? null).split(dir).join('<project>')) as T;
}

function stateSummary(task: TaskState): unknown {
  return { name: task.name, status: task.status, goalId: task.goalId, failure: task.failure?.error };
}

function saveSummary(): unknown[] {
  return save.mock.calls.map(([, event]) => {
    const value = event as { kind: string; taskName: string; result: { success: boolean; interrupted: boolean } };
    return [value.kind, value.taskName, value.result.success, value.result.interrupted];
  });
}

function hookSummary(): unknown[] {
  return hook.mock.calls.map(([options]) => {
    const env = (options as { env: Record<string, string> }).env;
    return [env.TAKT_FINISH_TASK_NAME, env.TAKT_FINISH_STATUS];
  }).sort();
}

function attempt<T>(action: () => T): { value?: T; error?: unknown } {
  try {
    return { value: action() };
  } catch (error) {
    return { error };
  }
}

async function attemptAsync<T>(action: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await action() };
  } catch (error) {
    return { error };
  }
}

function resetDoubles(): void {
  healLockReleaseFaults(faults);
  before.tasks = undefined;
  before.goal = undefined;
  save.mockReset();
  hook.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
}

beforeEach(() => {
  resetDoubles();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  resetDoubles();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const claimKindArb = fc.array(fc.constantFrom<TaskKind>('plain', 'goal', 'broken', 'paused', 'running', 'failed'), { maxLength: 6 });

describe('PBT 1: a claim does not lose what it wrote when a release fails', () => {
  it('returns, reports and saves the same as without a fault, and warns exactly once on a fault', () => {
    fc.assert(fc.property(claimKindArb, fc.integer({ min: 1, max: 4 }), faultSetArb(LOCK_RELEASE_FAULTS), (kinds, count, faultSet) => {
      const claim = (dir: string, armed: FaultSet) => {
        resetDoubles();
        const warnings: string[] = [];
        const runner = new TaskRunner(dir, { onWarning: (warning) => warnings.push(warning) });
        armAfterWrite(faults, armed);
        const result = attempt(() => claimTasksWithGoalCompletions(runner, count, dir, new AbortController().signal));
        healLockReleaseFaults(faults);
        return normalized(dir, {
          error: result.error === undefined ? undefined : String(result.error),
          tasks: result.value?.tasks.map((task) => task.name),
          setupFailed: result.value?.setupFailedTasks.map(stateSummary),
          notices: saveSummary(),
          saved: savedTasks(dir),
          releaseWarnings: warnings.filter((warning) => warning.includes(RELEASE_WARNING)).length,
        });
      };
      const expected = claim(project(kinds), []);
      const actual = claim(project(kinds), faultSet);

      expect(actual.error).toBeUndefined();
      expect({ ...actual, releaseWarnings: undefined }).toEqual({ ...expected, releaseWarnings: undefined });
      expect(actual.releaseWarnings).toBe(faultSet.length === 0 ? 0 : 1);
    }), { numRuns: PBT_NUM_RUNS });
  });
});

describe('PBT 2: a failure before the write changes nothing', () => {
  const failures = ['tasks-timeout', 'tasks-ENOSPC', 'goal-timeout', 'goal-ENOSPC', 'inside-update'] as const;

  it('keeps tasks.yaml, reports and warns nothing, and classifies the error as today', () => {
    fc.assert(fc.property(claimKindArb, fc.integer({ min: 1, max: 4 }), fc.constantFrom(...failures), (kinds, count, failure) => {
      resetDoubles();
      const dir = project(kinds);
      const tasksFile = join(dir, '.takt', 'tasks.yaml');
      const saved = readFileSync(tasksFile, 'utf-8');
      const warnings: string[] = [];
      const runner = new TaskRunner(dir, { onWarning: (warning) => warnings.push(warning) });
      const onSetupFailed = vi.fn();
      const insideUpdate = new PrivateFileLockTimeoutError(join(dir, '.takt', 'goal-execution.lock'));
      if (failure === 'tasks-timeout') before.tasks = 'timeout';
      if (failure === 'tasks-ENOSPC') before.tasks = 'ENOSPC';
      if (failure === 'goal-timeout') before.goal = 'timeout';
      if (failure === 'goal-ENOSPC') before.goal = 'ENOSPC';
      const update = TaskStore.prototype.update;
      const spy = failure !== 'inside-update' ? undefined
        : vi.spyOn(TaskStore.prototype, 'update').mockImplementation(function (this: TaskStore, mutator, options) {
          return update.call(this, (current) => { mutator(current); throw insideUpdate; }, options);
        });

      const { error } = attempt(() => runner.claimNextTasks(count, createRuntimeAssignmentSetupGuard(dir), onSetupFailed));
      spy?.mockRestore();
      before.tasks = undefined;
      before.goal = undefined;

      expect(readFileSync(tasksFile, 'utf-8')).toBe(saved);
      expect(onSetupFailed).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(warnings.filter((warning) => warning.includes(RELEASE_WARNING))).toEqual([]);
      switch (failure) {
        case 'tasks-timeout':
          expect(error).toBeInstanceOf(TaskClaimLockAcquisitionError);
          expect(error).toMatchObject({ code: 'TIMEOUT', lock: 'tasks.yaml' });
          break;
        case 'tasks-ENOSPC':
          expect(error).toBeInstanceOf(TaskClaimLockAcquisitionError);
          expect(error).toMatchObject({ code: 'ENOSPC', lock: 'tasks.yaml' });
          break;
        case 'goal-timeout':
          expect(error).toBeInstanceOf(TaskClaimLockAcquisitionError);
          expect(error).toMatchObject({ code: 'TIMEOUT', lock: 'goal-execution' });
          break;
        case 'goal-ENOSPC':
          expect(error).toBeInstanceOf(PrivateFileLockAcquisitionError);
          break;
        case 'inside-update':
          expect(error).toBe(insideUpdate);
          expect(isClaimLockTimeoutFailure(error)).toBe(false);
          break;
      }
    }), { numRuns: PBT_NUM_RUNS });
  });
});

describe('PBT 4: recovery and abort report the same tasks whatever the release does', () => {
  it('run-start recovery reports every recovered task, returns the count, and does not throw', () => {
    const kindsArb = fc.array(fc.constantFrom<TaskKind>('lost', 'running', 'plain', 'failed'), { maxLength: 6 });
    fc.assert(fc.property(kindsArb, faultSetArb(TASKS_LOCK_RELEASE_FAULTS), (kinds, faultSet) => {
      const recover = (dir: string, armed: FaultSet) => {
        resetDoubles();
        const warnings: string[] = [];
        const recovered: TaskState[] = [];
        armAfterWrite(faults, armed);
        const result = attempt(() => new TaskRunner(dir, { onWarning: (warning) => warnings.push(warning) })
          .failInterruptedRunningTasks(undefined, (task) => { recovered.push(task); }));
        healLockReleaseFaults(faults);
        return normalized(dir, {
          error: result.error === undefined ? undefined : String(result.error),
          count: result.value, recovered: recovered.map(stateSummary), saved: savedTasks(dir),
          releaseWarnings: warnings.filter((warning) => warning.includes(RELEASE_WARNING)).length,
        });
      };
      const expected = recover(project(kinds), []);
      const actual = recover(project(kinds), faultSet);

      expect(actual.error).toBeUndefined();
      expect({ ...actual, releaseWarnings: undefined }).toEqual({ ...expected, releaseWarnings: undefined });
      // A release failure is warned only when the recovery wrote something.
      expect(actual.releaseWarnings).toBe(faultSet.length > 0 && (expected.count ?? 0) > 0 ? 1 : 0);
    }), { numRuns: PBT_NUM_RUNS });
  });

  it('a goal abort calls the finish hook for every task it failed, then throws only on a release failure', async () => {
    const kindsArb = fc.array(fc.constantFrom<TaskKind>('goal', 'broken', 'other-goal', 'plain', 'running'), { maxLength: 6 });
    await fc.assert(fc.asyncProperty(kindsArb, faultSetArb(LOCK_RELEASE_FAULTS), async (kinds, faultSet) => {
      const abort = async (dir: string, armed: FaultSet) => {
        resetDoubles();
        armAfterWrite(faults, armed);
        const result = await attemptAsync(() => invalidatePendingGoalTasksWithFinishHook(dir, new TaskRunner(dir), goalId));
        healLockReleaseFaults(faults);
        return normalized(dir, { threw: result.error !== undefined, hooks: hookSummary(), saved: savedTasks(dir) });
      };
      const expected = await abort(project(kinds), []);
      const actual = await abort(project(kinds), faultSet);

      expect(expected.threw).toBe(false);
      expect(actual).toEqual({ ...expected, threw: faultSet.length > 0 });
    }), { numRuns: PBT_NUM_RUNS });
  });

  it('daemon recovery saves the same manager event, then throws only on a release failure', () => {
    const kindsArb = fc.array(fc.constantFrom<TaskKind>('goal', 'running', 'plain', 'failed'), { maxLength: 4 });
    fc.assert(fc.property(kindsArb, faultSetArb(LOCK_RELEASE_FAULTS), (others, faultSet) => {
      const kinds: TaskKind[] = ['lost', ...others];
      const reconcile = (dir: string, armed: FaultSet) => {
        resetDoubles();
        armAfterWrite(faults, armed);
        const result = attempt(() => reconcileLostRun({
          kind: 'run_process_lost', targetId: 'target', generation: 'generation', observedAt: '2026-11-27T00:00:03.000Z',
          pid: DEAD_HOLDER_PID, startTime: null,
          task: { repositoryDirectory: dir, goalId, taskName: 'task-0', runSlug: 'run-0', executionId: 'execution-0' },
        }, new AbortController().signal));
        healLockReleaseFaults(faults);
        return normalized(dir, { threw: result.error !== undefined, notices: saveSummary(), saved: savedTasks(dir) });
      };
      const expected = reconcile(project(kinds), []);
      const actual = reconcile(project(kinds), faultSet);

      expect(expected.threw).toBe(false);
      expect(expected.notices).toHaveLength(1);
      expect(actual).toEqual({ ...expected, threw: faultSet.length > 0 });
    }), { numRuns: PBT_NUM_RUNS });
  });
});

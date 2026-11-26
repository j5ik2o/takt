/**
 * Claiming goal tasks with a real tasks.yaml: setup failures are reported once by the claim that
 * saved them, a claimed task is always returned, and only failures before the write are retried.
 * Design: docs/design/goal-task-claim-setup-failure.md. Model: specs/quint/goal-task-claim/.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const save = vi.hoisted(() => vi.fn());
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: save }));

// Lets a test throw before the goal-execution.lock action (an acquisition timeout) or after it
// (a failure once the tasks.yaml write is done, such as a lock release that fails).
const goalLock = vi.hoisted(() => ({
  before: undefined as (() => void) | undefined,
  after: undefined as (() => void) | undefined,
}));
vi.mock('../infra/goals/execution-lock.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/goals/execution-lock.js')>();
  return {
    ...original,
    withGoalExecutionLock: <Result>(cwd: string, action: () => Result): Result => {
      goalLock.before?.();
      const result = original.withGoalExecutionLock(cwd, action);
      goalLock.after?.();
      return result;
    },
  };
});

import { claimTasksWithGoalCompletions, isClaimLockTimeoutFailure, TaskClaimLockUnavailableError } from '../features/tasks/execute/claimTasks.js';
import { TaskClaimLockAcquisitionError } from '../infra/task/taskLifecycleService.js';
import { TaskStore } from '../infra/task/store.js';
import { TaskRunner, type TaskInfo, type TaskState } from '../infra/task/index.js';
import { PrivateFileLockAcquisitionError, PrivateFileLockTimeoutError } from '../shared/utils/private-file-lock.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';

const dirs: string[] = [];
const TASKS_LOCK_TIMEOUT = 'File lock: timed out waiting for lock: /project/.takt/tasks.yaml.lock';

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-task-claim-')));
  dirs.push(dir);
  mkdirSync(join(dir, '.takt', 'goals', goalId), { recursive: true });
  writeFileSync(join(dir, '.takt', 'config.yaml'), 'language: en\nprovider: mock\n', 'utf-8');
  writeFileSync(join(dir, '.takt', 'goals', goalId, 'goal.json'), JSON.stringify(goalRecord()));
  invalidateAllResolvedConfigCache();
  return dir;
}

/** A goal task that runs. */
function addRunnable(runner: TaskRunner, label = 'Runnable goal work'): TaskInfo {
  return runner.addTask(label, { workflow: 'default', goal_id: goalId });
}

/** A goal task whose runtime assignment is not in runtime.yaml: the claim saves it as failed. */
function addBroken(runner: TaskRunner, label = 'Broken goal work'): TaskInfo {
  return runner.addTask(label, { workflow: 'default', goal_id: goalId, runtime_assignment: 'gone' });
}

function states(dir: string): TaskState[] {
  return new TaskRunner(dir).listTaskStateItems();
}

function warnings(): string[] {
  return vi.mocked(console.log).mock.calls.map(([message]) => String(message)).filter((message) => message.includes('[WARN]'));
}

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('the action did not throw');
}

const signal = () => new AbortController().signal;

beforeEach(() => {
  save.mockReset();
  goalLock.before = undefined;
  goalLock.after = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the claim that saved a setup failure reports it', () => {
  // Critical (d2bd16a30): a second read after the claim failed with a lock timeout and dropped the
  // tasks the claim had already saved as running.
  it.each([
    ['a tasks.yaml lock timeout', () => new Error(TASKS_LOCK_TIMEOUT)],
    ['ENOSPC', () => new PrivateFileLockAcquisitionError('no space left on device', 'ENOSPC', -28, { cause: new Error('ENOSPC') })],
  ])('returns the claimed task when tasks.yaml cannot be read after the claim (%s)', (_label, failure) => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const runnable = addRunnable(runner);
    const read = runner.listTaskStateItems.bind(runner);
    let reads = 0;
    const listTaskStateItems = vi.spyOn(runner, 'listTaskStateItems').mockImplementation(() => {
      reads += 1;
      if (reads > 1) throw failure();
      return read();
    });

    const result = claimTasksWithGoalCompletions(runner, 1, dir, signal());

    expect(result.tasks.map((task) => task.name)).toEqual([runnable.name]);
    expect(listTaskStateItems).toHaveBeenCalledOnce();
    expect(states(dir).find((task) => task.name === runnable.name)?.status).toBe('running');
  });

  // High 2a (d2bd16a30): two processes read the same pending task; only the one whose claim saved
  // the setup failure reports it.
  it('reports a setup failure saved by another claim between the read and the claim only once', () => {
    const dir = project();
    const a = new TaskRunner(dir);
    const b = new TaskRunner(dir);
    const broken = addBroken(a);
    let fromB: ReturnType<typeof claimTasksWithGoalCompletions> | undefined;
    const claimA = a.claimNextTasks.bind(a);
    vi.spyOn(a, 'claimNextTasks').mockImplementation((...args) => {
      fromB = claimTasksWithGoalCompletions(b, 1, dir, signal());
      return claimA(...args);
    });

    const fromA = claimTasksWithGoalCompletions(a, 1, dir, signal());

    expect(fromB?.setupFailedTaskNames).toEqual([broken.name]);
    expect(fromA.setupFailedTaskNames).toEqual([]);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[1]).toMatchObject({ kind: 'completion', goalId, taskName: broken.name });
  });

  // High 2b (d2bd16a30): a goal task added after the first read and saved as failed by this claim
  // is reported.
  it('reports a setup failure of a goal task added between the read and the claim', () => {
    const dir = project();
    const runner = new TaskRunner(dir);
    let late: TaskInfo | undefined;
    const claim = runner.claimNextTasks.bind(runner);
    vi.spyOn(runner, 'claimNextTasks').mockImplementation((...args) => {
      late = addBroken(new TaskRunner(dir), 'Late broken goal work');
      return claim(...args);
    });

    const result = claimTasksWithGoalCompletions(runner, 1, dir, signal());

    expect(result.setupFailedTaskNames).toEqual([late!.name]);
    expect(save).toHaveBeenCalledOnce();
  });

  it('keeps the claim and warns when the manager notification cannot be written', () => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const runnable = addRunnable(runner);
    const broken = addBroken(runner);
    save.mockImplementationOnce(() => { throw new Error('ENOSPC: no space left on device, write'); });

    const result = claimTasksWithGoalCompletions(runner, 2, dir, signal());

    expect(result.tasks.map((task) => task.name)).toEqual([runnable.name]);
    expect(result.setupFailedTaskNames).toEqual([broken.name]);
    expect(states(dir).find((task) => task.name === broken.name)?.status).toBe('failed');
    const [warning, ...rest] = warnings();
    expect(rest).toEqual([]);
    expect(warning).toContain(broken.name);
    expect(warning).toContain(goalId);
    expect(warning).toContain('saved as failed in .takt/tasks.yaml');
    expect(warning).toContain('no space left on device');
  });

  it('returns the claimed task when onSetupFailed throws, and still reports every setup failure', () => {
    const dir = project();
    const onWarning = vi.fn();
    const runner = new TaskRunner(dir, { onWarning });
    const runnable = addRunnable(runner);
    const first = addBroken(runner, 'Broken goal work 1');
    const second = addBroken(runner, 'Broken goal work 2');
    const onSetupFailed = vi.fn(() => { throw new Error('stdout closed: EPIPE'); });

    const claimed = runner.claimNextTasks(3, undefined, onSetupFailed);

    expect(claimed.map((task) => task.name)).toEqual([runnable.name]);
    expect(onSetupFailed.mock.calls.map(([task]) => (task as TaskState).name)).toEqual([first.name, second.name]);
    const reportFailures = onWarning.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('EPIPE'));
    expect(reportFailures).toHaveLength(2);
    expect(reportFailures[0]).toContain(first.name);
  });

  it('returns the claimed task when both onSetupFailed and onWarning throw', () => {
    const dir = project();
    const runner = new TaskRunner(dir, { onWarning: () => { throw new Error('warning sink closed'); } });
    const runnable = addRunnable(runner);
    addBroken(runner);

    const claimed = runner.claimNextTasks(2, undefined, () => { throw new Error('stdout closed: EPIPE'); });

    expect(claimed.map((task) => task.name)).toEqual([runnable.name]);
  });
});

describe('claim lock failures', () => {
  it('turns a goal-execution.lock timeout before the write into a retryable claim failure', () => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const pending = addRunnable(runner);
    goalLock.before = () => { throw new PrivateFileLockTimeoutError(join(dir, '.takt', 'goal-execution.lock')); };

    const error = thrown(() => runner.claimNextTasks(1));
    expect(error).toBeInstanceOf(TaskClaimLockAcquisitionError);
    expect(error).toMatchObject({ code: 'TIMEOUT', lock: 'goal-execution' });

    const classified = thrown(() => claimTasksWithGoalCompletions(runner, 1, dir, signal()));
    expect(classified).toBeInstanceOf(TaskClaimLockUnavailableError);
    expect(classified).toMatchObject({ code: 'TIMEOUT', lock: 'goal-execution' });
    expect(states(dir).find((task) => task.name === pending.name)?.status).toBe('pending');
  });

  // Never retry a failure after the write: the claim is saved, and a retry would end `takt run`
  // normally with the task left running (Quint: fixedPostWriteRetried). Losing the claim on a lock
  // release failure is the separate issue; this pins that the failure is not classified.
  it.each([
    ['the tasks.yaml.lock release fails', 'store', () => new Error('EIO: i/o error, unlink \'.takt/tasks.yaml.lock\'')],
    ['the goal-execution.lock ownership changes before release', 'goal', () => new Error('Private file lock ownership changed before release: .takt/goal-execution.lock')],
    ['the goal-execution.lock release fails with EIO', 'goal', () => Object.assign(new Error('EIO: i/o error, unlink \'.takt/goal-execution.lock\''), { code: 'EIO' })],
    ['a private file lock timeout is thrown after the write', 'goal', () => new PrivateFileLockTimeoutError('.takt/goal-execution.lock')],
  ] as const)('does not classify an error after the write as retryable: %s', (_label, where, failure) => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const runnable = addRunnable(runner);
    if (where === 'goal') {
      goalLock.after = () => { throw failure(); };
    } else {
      const update = TaskStore.prototype.update;
      vi.spyOn(TaskStore.prototype, 'update').mockImplementation(function (this: TaskStore, ...args) {
        update.apply(this, args);
        throw failure();
      });
    }

    const error = thrown(() => claimTasksWithGoalCompletions(runner, 1, dir, signal()));

    expect(error).not.toBeInstanceOf(TaskClaimLockAcquisitionError);
    expect(error).not.toBeInstanceOf(TaskClaimLockUnavailableError);
    expect(isClaimLockTimeoutFailure(error)).toBe(false);
    vi.restoreAllMocks();
    expect(states(dir).find((task) => task.name === runnable.name)?.status).toBe('running');
  });
});

// Every combination that synchronous calls can drive (two processes cannot interleave their own
// steps inside each other's call, so the two crossed orders are left to the Quint model).
describe('claim combinations of two processes', () => {
  const orders = ['A then B', 'B then A', 'B inside A', 'A inside B'] as const;
  const additions = ['at start', 'in the gap', 'never'] as const;
  const faults = ['none', 'read after the claim times out', 'notification write throws', 'goal-execution.lock times out'] as const;
  const cases = orders.flatMap((order) => additions.flatMap((addition) => faults.map((fault) => ({ order, addition, fault }))));

  it.each(cases)('$order, late task $addition, fault: $fault', ({ order, addition, fault }) => {
    const dir = project();
    const a = new TaskRunner(dir);
    const b = new TaskRunner(dir);
    addRunnable(a);
    addBroken(a);
    const addLate = () => { addBroken(new TaskRunner(dir), 'Late broken goal work'); };
    if (addition === 'at start') addLate();

    type Outcome = { result?: ReturnType<typeof claimTasksWithGoalCompletions>; error?: unknown };
    const outcomes: Record<'A' | 'B', Outcome> = { A: {}, B: {} };
    const run = (name: 'A' | 'B', runner: TaskRunner) => {
      try {
        outcomes[name].result = claimTasksWithGoalCompletions(runner, 3, dir, signal());
      } catch (error) {
        outcomes[name].error = error;
      }
    };
    // Steps each runner takes right before its own claim, in order (once).
    const beforeClaim = { A: [] as (() => void)[], B: [] as (() => void)[] };
    for (const [name, runner] of [['A', a], ['B', b]] as const) {
      const claim = runner.claimNextTasks.bind(runner);
      vi.spyOn(runner, 'claimNextTasks').mockImplementation((...args) => {
        for (const step of beforeClaim[name].splice(0)) step();
        return claim(...args);
      });
    }

    if (fault === 'read after the claim times out') {
      const read = a.listTaskStateItems.bind(a);
      let reads = 0;
      vi.spyOn(a, 'listTaskStateItems').mockImplementation(() => {
        reads += 1;
        if (reads > 1) throw new Error(TASKS_LOCK_TIMEOUT);
        return read();
      });
    }
    if (fault === 'notification write throws') {
      save.mockImplementationOnce(() => { throw new Error('ENOSPC: no space left on device, write'); });
    }

    const gap = (outer: 'A' | 'B', inner: () => void) => {
      if (addition === 'in the gap') beforeClaim[outer].push(addLate);
      beforeClaim[outer].push(inner);
    };
    if (order === 'B inside A') gap('A', () => run('B', b));
    if (order === 'A inside B') gap('B', () => run('A', a));
    if (fault === 'goal-execution.lock times out') {
      // Armed last, so it hits A's own claim and not a claim nested before it.
      beforeClaim.A.push(() => {
        goalLock.before = () => {
          goalLock.before = undefined;
          throw new PrivateFileLockTimeoutError(join(dir, '.takt', 'goal-execution.lock'));
        };
      });
    }
    switch (order) {
      case 'A then B': run('A', a); if (addition === 'in the gap') addLate(); run('B', b); break;
      case 'B then A': run('B', b); if (addition === 'in the gap') addLate(); run('A', a); break;
      case 'B inside A': run('A', a); break;
      case 'A inside B': run('B', b); break;
    }
    const saved = states(dir);
    const returned = [...(outcomes.A.result?.tasks ?? []), ...(outcomes.B.result?.tasks ?? [])].map((task) => task.name);
    const reported = [...(outcomes.A.result?.setupFailedTaskNames ?? []), ...(outcomes.B.result?.setupFailedTaskNames ?? [])];
    const failed = saved.filter((task) => task.status === 'failed').map((task) => task.name);
    // (a) every task saved as running was returned by exactly one claim.
    for (const task of saved.filter((item) => item.status === 'running')) {
      expect(returned.filter((name) => name === task.name)).toHaveLength(1);
    }
    // (b) every setup failure is reported exactly once, and (d) nothing else is.
    for (const name of failed) expect(reported.filter((item) => item === name)).toHaveLength(1);
    expect(reported.every((name) => failed.includes(name))).toBe(true);
    // (c) its manager notification is attempted exactly once (a failed write is warned).
    for (const name of failed) {
      expect(save.mock.calls.filter(([, event]) => (event as { taskName: string }).taskName === name)).toHaveLength(1);
    }
    // (e) a claim that threw is a retryable failure that wrote nothing.
    for (const outcome of [outcomes.A, outcomes.B]) {
      if (outcome.error === undefined) continue;
      expect(outcome.error).toBeInstanceOf(TaskClaimLockUnavailableError);
      expect(outcome.result).toBeUndefined();
    }
    if (fault === 'goal-execution.lock times out') expect(outcomes.A.error).toBeInstanceOf(TaskClaimLockUnavailableError);
  });
});

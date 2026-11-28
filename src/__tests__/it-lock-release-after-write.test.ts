/**
 * A lock release that fails after tasks.yaml is written does not lose what was written (#169):
 * run-start recovery (`failInterruptedRunningTasks`) and daemon recovery (`reconcileLostRun`) with a
 * real tasks.yaml and real locks, with the release failure injected into `node:fs`.
 * Design: docs/design/claim-lock-release-failure.md (2節, 試験の4・6). Model: specs/quint/claim-lock-release/.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LockReleaseFaultState } from './helpers/lock-release-faults.js';

const faults = vi.hoisted(() => ({ armed: [], times: 1, active: new Map(), failingReads: new Set() }) as LockReleaseFaultState);
vi.mock('node:fs', async (original) => (await import('./helpers/lock-release-faults.js'))
  .withLockReleaseFaults(await original<typeof import('node:fs')>(), faults));
const save = vi.hoisted(() => vi.fn());
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: save }));
const lifecycleWarn = vi.hoisted(() => vi.fn());
vi.mock('../shared/utils/debug.js', async (original) => {
  const actual = await original<typeof import('../shared/utils/debug.js')>();
  return {
    ...actual,
    createLogger: (component: string) => {
      const logger = actual.createLogger(component);
      return component === 'task-lifecycle' ? { ...logger, warn: lifecycleWarn } : logger;
    },
  };
});

import { reconcileLostRun } from '../features/daemonTurn/reconcileLostRun.js';
import { TaskRunner, type TaskState } from '../infra/task/index.js';
import { TaskStore } from '../infra/task/store.js';
import { TaskRecordSchema } from '../infra/task/schema.js';
import type { WatchObservation } from '../core/daemon/events.js';
import { goalId } from './helpers/goal-fixtures.js';
import {
  armAfterWrite, DEAD_HOLDER_PID, healLockReleaseFaults, LOCK_RELEASE_FAULTS, TASKS_LOCK_RELEASE_FAULTS,
} from './helpers/lock-release-faults.js';

const dirs: string[] = [];
const RELEASE_WARNING = 'Saved .takt/tasks.yaml, but releasing a lock afterwards failed';

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'takt-lock-release-')));
  dirs.push(dir);
  mkdirSync(join(dir, '.takt'), { recursive: true });
  return dir;
}

/** A running task whose owner process is gone, as a crashed run leaves it. */
function runningTask(name: string, extra: Record<string, unknown> = {}) {
  return TaskRecordSchema.parse({
    name, status: 'running', content: `Work of ${name}`, workflow: 'default',
    created_at: '2026-11-27T00:00:00.000Z', started_at: '2026-11-27T00:00:01.000Z', completed_at: null,
    owner_pid: DEAD_HOLDER_PID, owner_start_time: null, ...extra,
  });
}

function saveTasks(dir: string, tasks: ReturnType<typeof runningTask>[]): void {
  new TaskStore(dir).update(() => ({ tasks }));
}

function status(dir: string, name: string): string | undefined {
  healLockReleaseFaults(faults);
  return new TaskRunner(dir).listTaskStateItems().find((task) => task.name === name)?.status;
}

beforeEach(() => {
  healLockReleaseFaults(faults);
  save.mockReset();
  lifecycleWarn.mockReset();
});

afterEach(() => {
  healLockReleaseFaults(faults);
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('run-start recovery after a lock release failure (試験の4)', () => {
  it.each(TASKS_LOCK_RELEASE_FAULTS)('reports each recovered task and returns the count when the release fails: %s', (fault) => {
    const dir = project();
    saveTasks(dir, [runningTask('interrupted-a'), runningTask('interrupted-b')]);
    const onWarning = vi.fn();
    const recovered: TaskState[] = [];
    armAfterWrite(faults, [fault]);

    const count = new TaskRunner(dir, { onWarning }).failInterruptedRunningTasks(undefined, (task) => { recovered.push(task); });

    expect(count).toBe(2);
    expect(recovered.map((task) => [task.name, task.status])).toEqual([['interrupted-a', 'failed'], ['interrupted-b', 'failed']]);
    expect(onWarning).toHaveBeenCalledOnce();
    expect(String(onWarning.mock.calls[0]?.[0])).toContain(RELEASE_WARNING);
    expect(status(dir, 'interrupted-a')).toBe('failed');
  });

  it('still reports the recovered task when onWarning throws', () => {
    const dir = project();
    saveTasks(dir, [runningTask('interrupted')]);
    const onRecovered = vi.fn();
    armAfterWrite(faults, ['tasks-unlink-EIO']);
    const runner = new TaskRunner(dir, { onWarning: () => { throw new Error('warning sink closed'); } });

    expect(runner.failInterruptedRunningTasks(undefined, onRecovered)).toBe(1);

    expect(onRecovered).toHaveBeenCalledOnce();
    expect(onRecovered.mock.calls[0]?.[0]).toMatchObject({ name: 'interrupted', status: 'failed' });
  });

  it('logs the warning when the runner has no onWarning (設計レビュー 低-1)', () => {
    const dir = project();
    saveTasks(dir, [runningTask('interrupted')]);
    const onRecovered = vi.fn();
    armAfterWrite(faults, ['tasks-unlink-EIO']);

    expect(new TaskRunner(dir).failInterruptedRunningTasks(undefined, onRecovered)).toBe(1);

    expect(onRecovered).toHaveBeenCalledOnce();
    expect(lifecycleWarn).toHaveBeenCalledOnce();
    expect(String(lifecycleWarn.mock.calls[0]?.[0])).toContain(RELEASE_WARNING);
  });
});

describe('daemon recovery after a lock release failure (試験の6)', () => {
  function lostRun(dir: string): Extract<WatchObservation, { kind: 'run_process_lost' }> {
    saveTasks(dir, [runningTask('lost', { goal_id: goalId, run_slug: 'run-lost', execution_id: 'execution-lost' })]);
    return {
      kind: 'run_process_lost', targetId: 'target', generation: 'generation', observedAt: '2026-11-27T00:00:02.000Z',
      pid: DEAD_HOLDER_PID, startTime: null,
      task: { repositoryDirectory: dir, goalId, taskName: 'lost', runSlug: 'run-lost', executionId: 'execution-lost' },
    };
  }

  function thrown(action: () => unknown): unknown {
    try {
      action();
    } catch (error) {
      return error;
    }
    throw new Error('the action did not throw');
  }

  it.each(LOCK_RELEASE_FAULTS)('saves the manager event, then throws the release failure: %s', (fault) => {
    const dir = project();
    const observation = lostRun(dir);
    armAfterWrite(faults, [fault]);

    const error = thrown(() => reconcileLostRun(observation, new AbortController().signal));

    expect(error).toBeInstanceOf(Error);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(dir, expect.objectContaining({
      kind: 'completion', goalId, taskName: 'lost', runSlug: 'run-lost',
      result: expect.objectContaining({ success: false, interrupted: true }),
    }));
    expect(status(dir, 'lost')).toBe('failed');
  });

  it('throws an AggregateError of the event error and the release error when both fail (設計レビュー 低-2)', () => {
    const dir = project();
    const observation = lostRun(dir);
    const saveError = new Error('ENOSPC: no space left on device, write');
    save.mockImplementationOnce(() => { throw saveError; });
    armAfterWrite(faults, ['tasks-unlink-EIO']);

    const error = thrown(() => reconcileLostRun(observation, new AbortController().signal));

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([saveError, expect.objectContaining({ code: 'EIO' })]);
    expect(save).toHaveBeenCalledOnce();
  });
});

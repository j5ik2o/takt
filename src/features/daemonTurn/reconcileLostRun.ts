import { randomUUID } from 'node:crypto';
import type { WatchObservation } from '../../core/daemon/events.js';
import { TaskStore } from '../../infra/task/store.js';
import { getTaskProcessIdentity } from '../../infra/task/taskProcessIdentity.js';
import { withGoalExecutionLock } from '../../infra/goals/execution-lock.js';
import { saveManagerEvent } from '../../infra/goals/events.js';
import type { GoalTaskResult } from '../../infra/goals/schema.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';

const log = createLogger('reconcile-lost-run');

function recordedProcessLost(pid: number, startTime: string | null): boolean {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  if (startTime === null) return false;
  const actual = getTaskProcessIdentity(pid);
  return actual !== undefined && actual.startTime !== startTime;
}

export function reconcileLostRun(observation: Extract<WatchObservation, { kind: 'run_process_lost' }>, signal: AbortSignal): boolean {
  const { task: reference } = observation;
  const failureReason = 'Execution process stopped before saving its result';
  const result: GoalTaskResult = { success: false, interrupted: true, workflowResult: 'error', failureReason,
    shaUnavailableReason: failureReason };
  let recovered = false;
  let written = false;
  let releaseError: unknown;
  let resolvedExecutionId: string | undefined;
  try {
    withGoalExecutionLock(reference.repositoryDirectory, () => {
      new TaskStore(reference.repositoryDirectory).update((current) => {
        signal.throwIfAborted();
        const task = current.tasks.find((task) => task.name === reference.taskName);
        if (task === undefined || task.status !== 'running' || task.goal_id !== reference.goalId || task.run_slug !== reference.runSlug
          || task.execution_id !== reference.executionId || task.owner_pid !== observation.pid || (task.owner_start_time ?? null) !== observation.startTime
          || !recordedProcessLost(observation.pid, observation.startTime)) return undefined;
        recovered = true;
        // A task that died before its execution was recorded has no attempt identifier yet;
        // give it one so the pending mark is valid and the daemon can resend the notice (#170).
        resolvedExecutionId = task.execution_id ?? (task.run_slug === undefined ? randomUUID() : undefined);
        return { tasks: current.tasks.map((value) => value !== task ? value : {
          ...value, status: 'failed' as const, completed_at: new Date().toISOString(), owner_pid: null, owner_start_time: null,
          failure: { error: failureReason }, completion: result,
          completion_publication_pending: true as const,
          ...(resolvedExecutionId === undefined || resolvedExecutionId === task.execution_id
            ? {} : { execution_id: resolvedExecutionId }),
        }) };
      }, { onWritten: () => { written = true; } });
    });
  } catch (error) {
    if (!written) throw error;
    // The reconciliation is saved in tasks.yaml; a lock release failure after the write must
    // not lose it (#169). The event is still saved below, and the release failure is thrown
    // only afterwards, so the caller sees the failure without losing the recovery.
    releaseError = error;
  }
  if (!recovered) return false;
  let saveError: unknown;
  try {
    saveManagerEvent(reference.repositoryDirectory, { kind: 'completion', goalId: reference.goalId,
      taskName: reference.taskName, runSlug: reference.runSlug,
      ...(reference.runSlug === undefined && resolvedExecutionId !== undefined
        ? { executionId: resolvedExecutionId } : {}), result });
  } catch (error) {
    saveError = error;
  }
  if (saveError !== undefined) {
    if (releaseError !== undefined) {
      throw new AggregateError([saveError, releaseError],
        'Lost-run completion notification and lock release both failed');
    }
    // The mark stays in tasks.yaml and the daemon resends the notice (#170).
    log.error('Lost-run completion notification failed; the daemon will resend it', {
      taskName: reference.taskName, goalId: reference.goalId, error: getErrorMessage(saveError),
    });
    return true;
  }
  try {
    new TaskStore(reference.repositoryDirectory).update((current) => {
      let changed = false;
      const tasks = current.tasks.map((task) => {
        if (task.name === reference.taskName && task.goal_id === reference.goalId && task.status === 'failed'
          && task.run_slug === reference.runSlug && task.execution_id === resolvedExecutionId
          && task.completion_publication_pending === true && task.deletion === undefined) {
          changed = true;
          return { ...task, completion_publication_pending: undefined };
        }
        return task;
      });
      return changed ? { tasks } : undefined;
    });
  } catch (error) {
    log.error('Clearing the completion publication mark after a lost-run notification failed; the daemon will resend it', {
      taskName: reference.taskName, goalId: reference.goalId, error: getErrorMessage(error),
    });
  }
  if (releaseError !== undefined) throw releaseError;
  return true;
}

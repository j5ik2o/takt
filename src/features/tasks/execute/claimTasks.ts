import type { TaskRunner, TaskInfo, TaskState } from '../../../infra/task/index.js';
import { saveManagerEvent } from '../../../infra/goals/events.js';
import { PrivateFileLockAcquisitionError } from '../../../shared/utils/private-file-lock.js';
import {
  TaskClaimLockAcquisitionError,
  type TaskClaimLock,
  type TaskClaimLockFailureCode,
} from '../../../infra/task/taskLifecycleService.js';
import { isFileLockTimeoutError } from '../../../infra/fs/file-lock.js';
import { warn } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { createRuntimeAssignmentSetupGuard } from './runtimeAssignmentGuard.js';

const log = createLogger('claim-tasks');

export const CLAIM_RETRY_INTERVAL_MS = 5_000;

export class TaskClaimLockUnavailableError extends Error {
  readonly lock: TaskClaimLock;

  constructor(
    message: string,
    readonly code: TaskClaimLockFailureCode,
    options: ErrorOptions & { lock?: TaskClaimLock },
  ) {
    super(message, options);
    this.lock = options.lock ?? 'tasks.yaml';
  }
}

export function claimTasksWithGoalCompletions(
  taskRunner: TaskRunner, count: number, cwd: string, signal: AbortSignal,
  goalTasksOnly = false,
): { tasks: TaskInfo[]; setupFailedTasks: TaskState[] } {
  if (count <= 0 || signal.aborted) return { tasks: [], setupFailedTasks: [] };
  let taskStates: TaskState[];
  try {
    taskStates = taskRunner.listTaskStateItems();
  } catch (error) {
    throw classifyClaimLockFailure(error);
  }
  const hasPending = taskStates.some((task) => task.status === 'pending'
    && (!goalTasksOnly || task.goalId !== undefined));
  try {
    // Goal tasks saved as failed while being claimed never reach an execution; the caller runs their
    // finish hook. The claim reports exactly the setup failures it saved, so tasks.yaml is not read again.
    const setupFailedTasks: TaskState[] = [];
    const tasks = taskRunner.claimNextTasks(
      count,
      createRuntimeAssignmentSetupGuard(cwd),
      (task) => {
        setupFailedTasks.push(task);
        publishSetupFailure(taskRunner, cwd, task);
      },
    );
    return { tasks, setupFailedTasks };
  } catch (error) {
    if (hasPending || isClaimLockTimeoutFailure(error)) throw classifyClaimLockFailure(error);
    throw error;
  }
}

function classifyClaimLockFailure(error: unknown): unknown {
  if (error instanceof TaskClaimLockAcquisitionError) {
    return new TaskClaimLockUnavailableError(error.message, error.code, { cause: error, lock: error.lock });
  }
  if (error instanceof PrivateFileLockAcquisitionError && error.code === 'ENOSPC') {
    return new TaskClaimLockUnavailableError(error.message, 'ENOSPC', { cause: error });
  }
  if (isFileLockTimeoutError(error)) {
    return new TaskClaimLockUnavailableError(error.message, 'TIMEOUT', { cause: error });
  }
  return error;
}

export function isClaimLockTimeoutFailure(error: unknown): boolean {
  const classified = classifyClaimLockFailure(error);
  return classified instanceof TaskClaimLockUnavailableError && classified.code === 'TIMEOUT';
}

function publishGoalCompletion(cwd: string, task: TaskState): boolean {
  if (task.goalId === undefined || task.completion === undefined) return false;
  if (task.runSlug !== undefined) {
    saveManagerEvent(cwd, { kind: 'completion', goalId: task.goalId, taskName: task.name, runSlug: task.runSlug, result: task.completion });
    return true;
  }
  if (task.executionId !== undefined) {
    saveManagerEvent(cwd, { kind: 'completion', goalId: task.goalId, taskName: task.name, executionId: task.executionId, result: task.completion });
    return true;
  }
  return false;
}

/**
 * Publishes one saved completion and then clears its pending mark (#170). A failed clear never
 * undoes the publication: the daemon resends with a deterministic eventId and clears the mark.
 */
function publishAndClearPendingMark(taskRunner: TaskRunner, cwd: string, task: TaskState): void {
  if (!publishGoalCompletion(cwd, task)) return;
  if (task.completionPublicationPending !== true) return;
  try {
    taskRunner.clearCompletionPublicationPending(task.name, {
      goalId: task.goalId, status: task.status, runSlug: task.runSlug, executionId: task.executionId,
    });
  } catch (error) {
    const detail = sanitizeSensitiveText(getErrorMessage(error));
    warn(`Goal task ${sanitizeTerminalText(task.name)} (goal ${task.goalId ?? 'unknown'}) was saved as failed in .takt/tasks.yaml and the manager was notified, but clearing its completion publication mark failed; the daemon will resend it: ${detail}`);
    log.error('Clearing the completion publication mark failed', { taskName: task.name, goalId: task.goalId, error: detail });
  }
}

/**
 * The setup failure is already saved in tasks.yaml, so a failed manager notification must not lose
 * the claim. It is shown on the terminal: a manager auto run writes it to its run log only.
 */
function publishSetupFailure(taskRunner: TaskRunner, cwd: string, task: TaskState): void {
  try {
    publishAndClearPendingMark(taskRunner, cwd, task);
  } catch (error) {
    const detail = sanitizeSensitiveText(getErrorMessage(error));
    warn(`Goal task ${sanitizeTerminalText(task.name)} (goal ${task.goalId ?? 'unknown'}) failed during setup and is saved as failed in .takt/tasks.yaml, but the manager was not notified: ${detail}`);
    log.error('Goal task setup failure notification failed', { taskName: task.name, goalId: task.goalId, error: detail });
  }
}

export function failInterruptedTasksWithGoalEvents(taskRunner: TaskRunner, cwd: string): number {
  return taskRunner.failInterruptedRunningTasks(undefined, (task) => {
    try {
      publishAndClearPendingMark(taskRunner, cwd, task);
    } catch (error) {
      const detail = sanitizeSensitiveText(getErrorMessage(error));
      warn(`Goal task ${sanitizeTerminalText(task.name)} (goal ${task.goalId ?? 'unknown'}) was recovered as failed in .takt/tasks.yaml, but the manager was not notified: ${detail}`);
      log.error('Recovered goal task completion notification failed', { taskName: task.name, goalId: task.goalId, error: detail });
    }
  });
}

import type { TaskRunner, TaskInfo, TaskState } from '../../../infra/task/index.js';
import { saveManagerEvent } from '../../../infra/goals/events.js';
import { PrivateFileLockAcquisitionError } from '../../../shared/utils/private-file-lock.js';
import { TaskClaimLockAcquisitionError, type TaskClaimLockFailureCode } from '../../../infra/task/taskLifecycleService.js';
import { isFileLockTimeoutError } from '../../../infra/fs/file-lock.js';
import { runtimeAssignmentUnavailableReason } from './runtimeAssignmentGuard.js';

export class TaskClaimLockUnavailableError extends Error {
  constructor(message: string, readonly code: TaskClaimLockFailureCode, options: ErrorOptions) {
    super(message, options);
  }
}

export function claimTasksWithGoalCompletions(
  taskRunner: TaskRunner, count: number, cwd: string, signal: AbortSignal,
  goalTasksOnly = false,
): { tasks: TaskInfo[] } {
  if (count <= 0 || signal.aborted) return { tasks: [] };
  let taskStates: TaskState[];
  try {
    taskStates = taskRunner.listTaskStateItems();
  } catch (error) {
    throw classifyClaimLockFailure(error);
  }
  const hasPending = taskStates.some((task) => task.status === 'pending'
    && (!goalTasksOnly || task.goalId !== undefined));
  try {
    const tasks = taskRunner.claimNextTasks(
      count,
      (task) => runtimeAssignmentUnavailableReason(cwd, task.data),
      (task) => publishGoalCompletion(cwd, task),
    );
    return { tasks };
  } catch (error) {
    if (hasPending || isClaimLockTimeoutFailure(error)) throw classifyClaimLockFailure(error);
    throw error;
  }
}

function classifyClaimLockFailure(error: unknown): unknown {
  if (error instanceof TaskClaimLockAcquisitionError) {
    return new TaskClaimLockUnavailableError(error.message, error.code, { cause: error });
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

function publishGoalCompletion(cwd: string, task: TaskState): void {
  if (task.goalId !== undefined && task.completion !== undefined && task.runSlug !== undefined) {
    saveManagerEvent(cwd, { kind: 'completion', goalId: task.goalId, taskName: task.name, runSlug: task.runSlug, result: task.completion });
  }
}

export function failInterruptedTasksWithGoalEvents(taskRunner: TaskRunner, cwd: string): number {
  return taskRunner.failInterruptedRunningTasks(undefined, (task) => publishGoalCompletion(cwd, task));
}

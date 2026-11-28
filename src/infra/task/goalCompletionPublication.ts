import { saveManagerEvent } from '../goals/events.js';
import type { TaskState } from './types.js';
import { warn } from '../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';

const log = createLogger('goal-completion-publication');

export type ClearCompletionPublicationPending = (
  taskName: string,
  identity: { goalId?: string; status: TaskState['status']; runSlug?: string; executionId?: string },
) => unknown;

export function publishGoalCompletion(cwd: string, task: TaskState): boolean {
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
 * The caller supplies the mark-clearing function, because the worker pool's remote path holds a
 * TaskStore rather than a TaskRunner.
 */
export function publishAndClearPendingMark(
  clearMark: ClearCompletionPublicationPending, cwd: string, task: TaskState,
): void {
  if (!publishGoalCompletion(cwd, task)) return;
  if (task.completionPublicationPending !== true) return;
  try {
    clearMark(task.name, {
      goalId: task.goalId, status: task.status, runSlug: task.runSlug, executionId: task.executionId,
    });
  } catch (error) {
    const detail = sanitizeSensitiveText(getErrorMessage(error));
    warn(`Goal task ${sanitizeTerminalText(task.name)} (goal ${task.goalId ?? 'unknown'}) was saved as failed in .takt/tasks.yaml and the manager was notified, but clearing its completion publication mark failed; the daemon will resend it: ${detail}`);
    log.error('Clearing the completion publication mark failed', { taskName: task.name, goalId: task.goalId, error: detail });
  }
}

import type { WorkflowRestartPoint } from '../../../core/models/index.js';
import { stepOnlyAborts } from '../../../core/workflow/abort-only-step.js';
import { loadWorkflowByIdentifier } from '../../../infra/config/index.js';
import {
  resolveTaskWorkflowValue,
  type AutoRequeueRestartCheck,
  type TaskRecord,
} from '../../../infra/task/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { resolveTaskRetryRestartPath, resolveTaskRetryStackPath } from '../taskRetryStartPath.js';

const log = createLogger('auto-requeue-restart');

function restartOnlyAborts(projectCwd: string, task: TaskRecord): boolean {
  const workflowName = resolveTaskWorkflowValue(task as Record<string, unknown>);
  if (!workflowName) return false;
  const context = { projectCwd, lookupCwd: task.worktree_path ?? projectCwd };
  const workflow = loadWorkflowByIdentifier(workflowName, projectCwd, { lookupCwd: context.lookupCwd });
  if (!workflow) return false;

  // Same precedence as the execution side: restart_point, then resume_point, then failure.step.
  const restartPoint = task.restart_point as WorkflowRestartPoint | undefined;
  if (restartPoint !== undefined) {
    const resolved = resolveTaskRetryRestartPath(workflow, restartPoint, context);
    return 'segments' in resolved && resolved.onlyAborts !== undefined;
  }
  if (task.resume_point !== undefined) {
    const resolved = resolveTaskRetryStackPath(workflow, task.resume_point.stack, context);
    return 'segments' in resolved && resolved.onlyAborts !== undefined;
  }
  const failedStep = task.failure?.step?.trim();
  return failedStep !== undefined && stepOnlyAborts(workflow.steps, failedStep);
}

/**
 * Builds the check that keeps an automatic requeue from restarting at a step
 * whose every exit is ABORT. A position that cannot be judged is not reported,
 * so the execution side reports the problem as before.
 */
export function createAutoRequeueRestartCheck(projectCwd: string): AutoRequeueRestartCheck {
  return (task) => {
    try {
      return restartOnlyAborts(projectCwd, task);
    } catch (error) {
      log.debug('Failed to judge the auto requeue restart position', { task: task.name, error: getErrorMessage(error) });
      return false;
    }
  };
}

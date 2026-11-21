import { join } from 'node:path';
import { appendGoalWorkLog } from '../../infra/goals/workLog.js';
import { GoalStore } from '../../infra/goals/store.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { publishPrFailedTask } from '../tasks/list/taskPullRequestActions.js';
import { goalWrite } from './goalWrite.js';
import type { McpOperationDependencies } from './operations.js';
import type { PublishPrFailedGoalTaskInput } from './goalTaskPrRetrySchemas.js';

export function publishTaktPrFailedGoalTask(
  input: PublishPrFailedGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal,
) {
  return goalWrite(input, deps, signal, async () => {
    const store = new GoalStore(input.cwd);
    const goal = await store.get(input.goalId);
    const runner = new TaskRunner(input.cwd);
    const target = runner.listTaskStateItems().find((task) => task.name === input.taskName);
    if (target === undefined) throw new Error('Task is not available for publication');
    if (target.goalId !== goal.id) throw new Error('Task does not belong to this goal');
    if (target.status !== 'pr_failed') {
      throw new Error(`Task cannot be published from status: ${target.status}`);
    }
    const task = runner.listAllTaskItems().find((item) => item.name === input.taskName);
    if (task === undefined || task.kind !== 'pr_failed') throw new Error('Task is not available for publication');

    signal.throwIfAborted();
    const published = await publishPrFailedTask(input.cwd, task);
    if (!published.success) throw new Error(published.error);

    await store.update(goal.id, (current) => appendGoalWorkLog(current, {
      summary: `Published ${input.taskName}: ${published.prUrl}`,
    }));
    return {
      taskName: input.taskName,
      tasksFile: join(input.cwd, '.takt', 'tasks.yaml'),
      status: 'completed',
      prUrl: published.prUrl,
    };
  }, 'Goal task publication failed', 'publish_pr');
}

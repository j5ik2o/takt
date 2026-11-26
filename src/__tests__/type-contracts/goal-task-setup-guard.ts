import type { GoalTaskSetupGuard, TaskInfo, TaskRunner } from '../../infra/task/index.js';
import { createRuntimeAssignmentSetupGuard } from '../../features/tasks/execute/runtimeAssignmentGuard.js';

declare const taskRunner: TaskRunner;

const guard: GoalTaskSetupGuard = createRuntimeAssignmentSetupGuard('/project');

taskRunner.claimNextTasks(1);
taskRunner.claimNextTasks(1, guard);
taskRunner.claimNextTasks(1, { setupFailureReason: (task: TaskInfo) => task.data?.runtime_assignment });

// @ts-expect-error A goal task setup check must be passed as the named guard, not as an anonymous callback.
taskRunner.claimNextTasks(1, (task: TaskInfo) => task.data?.runtime_assignment);

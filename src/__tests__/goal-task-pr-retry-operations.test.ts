import { beforeEach, expect, it, vi } from 'vitest';
import { publishTaktPrFailedGoalTask as publishFailedGoalTask } from '../features/mcp/goalTaskPrRetryOperations.js';
import type { Goal } from '../infra/goals/schema.js';
import type { TaskState } from '../infra/task/types.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  states: vi.fn(),
  tasks: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('../infra/goals/store.js', () => ({
  GoalStore: class { get = doubles.get; update = doubles.update; },
}));
vi.mock('../infra/task/runner.js', () => ({
  TaskRunner: class { listTaskStateItems = doubles.states; listAllTaskItems = doubles.tasks; },
}));
vi.mock('../features/tasks/list/taskPullRequestActions.js', () => ({
  publishPrFailedTask: doubles.publish,
}));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn() }));
vi.mock('../features/manager/notifications.js', () => ({
  resolveManagerNotificationOptions: () => ({ policy: {}, mainMerge: 'approve' }),
  sendSavedGoalNotifications: vi.fn(),
}));
vi.mock('../features/mcp/operations.js', async (original) => ({
  ...await original<typeof import('../features/mcp/operations.js')>(),
  assertCwdAllowedByMcpRoot: vi.fn(),
}));

const prUrl = 'https://example.test/pr/7';
const otherGoalId = '550e8400-e29b-41d4-a716-446655440001';
const input = { cwd: '/project', goalId: goalRecord().id, taskName: 'task-a' };
const signal = new AbortController().signal;
let goal: Goal;
let state: TaskState;

beforeEach(() => {
  vi.resetAllMocks();
  goal = goalRecord();
  state = {
    name: input.taskName,
    goalId: goal.id,
    kind: 'pr_failed',
    status: 'pr_failed',
    createdAt: '2026-10-14T00:00:00Z',
    filePath: '/project/.takt/tasks.yaml',
    branch: 'takt/task-a',
    worktreePath: '/project/.takt/worktrees/task-a',
    failure: { error: 'PR creation failed: push rejected' },
  };
  doubles.get.mockImplementation(async (id: string) => {
    if (id === goal.id) return goal;
    if (id === otherGoalId) return { ...goalRecord(), id: otherGoalId };
    throw new Error(`Goal does not exist: ${id}`);
  });
  doubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => {
    goal = transform(goal);
    return goal;
  });
  doubles.states.mockImplementation(() => [state]);
  doubles.tasks.mockImplementation(() => [{
    name: state.name,
    kind: 'pr_failed',
    status: 'pr_failed',
    goalId: state.goalId,
    content: 'Publish the reviewed work',
    createdAt: state.createdAt,
    filePath: state.filePath,
    branch: state.branch,
    worktreePath: state.worktreePath,
    data: { workflow: 'default' },
  }]);
  doubles.publish.mockResolvedValue({ success: true, prUrl });
});

it('publishes an existing pr_failed task without rerunning its workflow and records the transition', async () => {
  const result = await publishFailedGoalTask(input, {}, signal);

  expect(result.isError).toBeUndefined();
  expect(doubles.publish).toHaveBeenCalledExactlyOnceWith(input.cwd, expect.objectContaining({
    name: input.taskName, branch: state.branch, worktreePath: state.worktreePath,
    content: 'Publish the reviewed work',
    data: { workflow: 'default' },
  }));
  expect(goal.workLog).toEqual([expect.objectContaining({ summary: expect.stringContaining(input.taskName) })]);
  expect(goal.workLog[0]!.summary).toContain(prUrl);
  expect(JSON.parse(String((result as { content: Array<{ text: string }> }).content[0]!.text))).toMatchObject({
    taskName: input.taskName,
    tasksFile: '/project/.takt/tasks.yaml',
    status: 'completed',
    prUrl,
  });
});

it('returns the completed publication and the work-log error when saving the goal fails', async () => {
  doubles.update.mockRejectedValueOnce(new Error('goal write failed'));

  const result = await publishFailedGoalTask(input, {}, signal);

  expect(result.isError).toBeUndefined();
  expect(JSON.parse(String((result as { content: Array<{ text: string }> }).content[0]!.text))).toMatchObject({
    status: 'completed', prUrl, workLogError: 'goal write failed',
  });
  expect(doubles.publish).toHaveBeenCalledOnce();
  expect(doubles.get).toHaveBeenCalledTimes(2);
});

it.each(['completed', 'pending', 'running', 'failed', 'exceeded'] as const)('rejects a %s task without publishing', async (status) => {
  state = { ...state, kind: status, status };

  const result = await publishFailedGoalTask(input, {}, signal);

  expect(result.isError).toBe(true);
  expect(doubles.publish).not.toHaveBeenCalled();
  expect(doubles.update).not.toHaveBeenCalled();
});

it('rejects a task owned by another registered goal without publishing', async () => {
  state = { ...state, goalId: otherGoalId };

  const result = await publishFailedGoalTask(input, {}, signal);

  expect(result.isError).toBe(true);
  expect(doubles.get).toHaveBeenCalledWith(input.goalId);
  expect(doubles.publish).not.toHaveBeenCalled();
  expect(goal.workLog).toHaveLength(0);
});

it('rejects a task owned by another goal that is not registered', async () => {
  state = { ...state, goalId: '650e8400-e29b-41d4-a716-446655440001' };

  const result = await publishFailedGoalTask(input, {}, signal);

  expect(result.isError).toBe(true);
  expect(doubles.publish).not.toHaveBeenCalled();
  expect(goal.workLog).toHaveLength(0);
});

it('rejects a missing task without publishing', async () => {
  doubles.states.mockReturnValue([]);
  doubles.tasks.mockReturnValue([]);

  const result = await publishFailedGoalTask(input, {}, signal);

  expect(result.isError).toBe(true);
  expect(doubles.publish).not.toHaveBeenCalled();
});

it.each(['paused', 'aborted'] as const)('rejects publication while the goal is %s', async (executionStatus) => {
  goal = { ...goal, executionStatus };

  const result = await publishFailedGoalTask(input, {}, signal);

  expect(result.isError).toBe(true);
  expect(doubles.publish).not.toHaveBeenCalled();
});

it('keeps pr_failed and reports the reason when publication fails', async () => {
  doubles.publish.mockResolvedValue({ success: false, error: 'push rejected' });

  const result = await publishFailedGoalTask(input, {}, signal);

  expect(result.isError).toBe(true);
  expect(String((result as { content: Array<{ text: string }> }).content[0]!.text)).toContain('push rejected');
  expect(goal.workLog).toHaveLength(0);
});

it('keeps pr_failed and reports the reason when state persistence fails', async () => {
  doubles.publish.mockResolvedValue({ success: false, error: `PR is public but the task ${input.taskName} could not be saved as completed` });

  const result = await publishFailedGoalTask(input, {}, signal);

  expect(result.isError).toBe(true);
  expect(goal.workLog).toHaveLength(0);
});

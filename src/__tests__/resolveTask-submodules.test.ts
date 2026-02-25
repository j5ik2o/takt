import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskInfo } from '../infra/task/index.js';

const {
  mockCreateSharedClone,
} = vi.hoisted(() => ({
  mockCreateSharedClone: vi.fn(() => ({
    path: '/tmp/takt-clone',
    branch: 'takt/task-slug',
  })),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/task/index.js')>();
  return {
    ...actual,
    createSharedClone: (...args: unknown[]) => mockCreateSharedClone(...args),
    detectDefaultBranch: vi.fn(() => 'main'),
  };
});

import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';

function createTask(overrides: Partial<TaskInfo>): TaskInfo {
  return {
    filePath: '/tasks/task.yaml',
    name: 'task-name',
    slug: 'task-slug',
    content: 'Run task',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    data: { task: 'Run task' },
    ...overrides,
  };
}

describe('resolveTaskExecution submodule options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should pass with_submodules/submodules from task data to createSharedClone', async () => {
    const task = createTask({
      data: {
        task: 'Run task',
        worktree: true,
        with_submodules: true,
        submodules: ['packages/core', 'packages/ui'],
      },
    });

    const result = await resolveTaskExecution(task, '/project', 'default');

    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', {
      worktree: true,
      branch: undefined,
      taskSlug: 'task-slug',
      issueNumber: undefined,
      withSubmodules: true,
      submodules: ['packages/core', 'packages/ui'],
    });
    expect(result.execCwd).toBe('/tmp/takt-clone');
    expect(result.isWorktree).toBe(true);
  });
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { goalId } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { registerFixtureGoal } from './helpers/registered-goal.js';

const advertisedPr = 'https://example.test/pull/7';

vi.mock('../infra/git/index.js', async (original) => {
  const module = await original<typeof import('../infra/git/index.js')>();
  return {
    ...module,
    getGitProvider: () => ({
      fetchPrDetails: undefined,
      findExistingPr: (branch: string) => branch === 'takt/pr-failed-work'
        ? { number: 7, url: advertisedPr }
        : undefined,
    }),
    createPullRequestSafely: () => ({ success: true, url: advertisedPr }),
  };
});

vi.mock('../shared/prompt/index.js', async (original) => ({
  ...await original<typeof import('../shared/prompt/index.js')>(),
  confirmWithCancel: vi.fn(async () => ({ kind: 'value', value: true })),
}));

const taskName = 'pr-failed-work';
const branch = 'takt/pr-failed-work';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

describe('pr_failed goal task recovery through manager MCP', () => {
  let root: string;
  let cwd: string;
  let clone: string;
  let goalBranch: string;
  let runner: TaskRunner;
  let store: GoalStore;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-pr-failed-')));
    cwd = join(root, 'project');
    clone = join(cwd, '.takt', 'worktrees', taskName);
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'README.md'), 'fixture\n');
    initializeGitFixture(cwd, ['README.md']);
    git(cwd, ['branch', '-M', 'main']);
    git(cwd, ['config', 'user.name', 'TAKT test']);
    git(cwd, ['config', 'user.email', 'takt-test@example.invalid']);
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nauto_pr: false\nmanager:\n  workflows: []\n  auto_run: false\n');
    invalidateGlobalConfigCache();
    goalBranch = (await registerFixtureGoal(cwd)).branch;
    git(cwd, ['branch', branch, goalBranch]);
    mkdirSync(join(cwd, '.takt', 'worktrees'), { recursive: true });
    git(root, ['clone', '--quiet', cwd, clone]);
    git(clone, ['config', 'user.name', 'TAKT test']);
    git(clone, ['config', 'user.email', 'takt-test@example.invalid']);
    git(clone, ['checkout', '--quiet', branch]);
    runner = new TaskRunner(cwd);
    runner.addTask(taskName, { workflow: 'default', worktree: true,
      worktree_path: clone, branch, goal_id: goalId, goal_purpose: 'PR 公開', goal_work_key: 'publish' });
    const claimed = runner.claimNextTasks(1)[0]!;
    const running = runner.updateRunningTaskExecution(claimed.name, { runSlug: 'pr-failed-run', worktreePath: clone, branch });
    runner.prFailTask({ task: running, success: true, response: 'Result ready', executionLog: [], branch, worktreePath: clone,
      startedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T00:01:00Z',
      completion: { success: true, interrupted: false, branch, sha: git(clone, ['rev-parse', 'HEAD']), workflowResult: 'completed' } },
    'push rejected');
    const runDir = join(clone, '.takt', 'runs', 'pr-failed-run');
    for (const directory of ['logs', 'reports', 'context']) mkdirSync(join(runDir, directory), { recursive: true });
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
      task: taskName, workflow: 'default', status: 'completed', runSlug: 'pr-failed-run',
      runRoot: '.takt/runs/pr-failed-run', reportDirectory: '.takt/runs/pr-failed-run/reports',
      contextDirectory: '.takt/runs/pr-failed-run/context', logsDirectory: '.takt/runs/pr-failed-run/logs',
      startTime: '2026-10-08T00:00:00Z', endTime: '2026-10-08T00:01:00Z', currentStep: 'implement',
    }));
    store = new GoalStore(cwd);
  }, 30_000);

  afterEach(() => {
    vi.restoreAllMocks(); invalidateGlobalConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  async function withClient<T>(action: (client: Client) => Promise<T>, toolSet: 'manager' | 'read-only' = 'manager'): Promise<T> {
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd, toolSet });
    const client = new Client({ name: 'pr-failed-recovery-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      return await action(client);
    } finally { await client.close(); await server.close(); }
  }

  function publish(client: Client) {
    return client.callTool({ name: 'takt_publish_pr_failed_goal_task', arguments: { cwd, goalId, taskName } });
  }

  it('registers the recovery tool only for manager use', async () => {
    await withClient(async (client) => {
      const names = (await client.listTools()).tools.map(({ name }) => name);
      expect(names).toContain('takt_publish_pr_failed_goal_task');
      expect(names).toContain('takt_requeue_goal_task');
      expect(names).toContain('takt_retry_goal_task');
    });
    await withClient(async (client) => {
      const names = (await client.listTools()).tools.map(({ name }) => name);
      expect(names).not.toContain('takt_publish_pr_failed_goal_task');
    }, 'read-only');
  });

  it('recovers a pr_failed task through publication without rerunning the workflow', async () => {
    const originalSha = git(clone, ['rev-parse', 'HEAD']);
    expect(runner.listTaskStateItems()[0]).toMatchObject({
      name: taskName, goalId, status: 'pr_failed', completion: { sha: originalSha },
    });
    writeFileSync(join(clone, 'recovered.txt'), 'unpublished result');

    const result = await withClient(publish);

    expect(result.isError, firstTextContent(result.content)).toBeUndefined();
    expect(JSON.parse(firstTextContent(result.content))).toMatchObject({
      taskName, tasksFile: join(cwd, '.takt', 'tasks.yaml'), status: 'completed', prUrl: advertisedPr,
    });
    const publishedSha = git(clone, ['rev-parse', 'HEAD']);
    expect(publishedSha).not.toBe(originalSha);
    expect(git(cwd, ['rev-parse', branch])).toBe(publishedSha);
    expect(git(cwd, ['show', `${publishedSha}:recovered.txt`])).toBe('unpublished result');
    expect(runner.listTaskStateItems()[0]).toMatchObject({
      name: taskName, status: 'completed', prUrl: advertisedPr,
      completion: { sha: publishedSha, success: true, workflowResult: 'completed' },
    });
    expect((await store.get(goalId)).workLog.at(-1)!.summary).toContain(taskName);
    expect((await store.get(goalId)).workLog.at(-1)!.summary).toContain(advertisedPr);
    expect(runner.listPendingTaskItems()).toEqual([]);
    expect(existsSync(join(cwd, '.takt', 'tasks', taskName))).toBe(false);
  });

  it('rejects recovery of a completed task without publishing', async () => {
    runner.completePublishedTask(taskName, advertisedPr);
    const current = readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8');
    expect(runner.listTaskStateItems()[0]).toMatchObject({ name: taskName, status: 'completed' });

    const result = await withClient(publish);

    expect(result.isError).toBe(true);
    expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')).toBe(current);
    expect((await store.get(goalId)).workLog).toEqual([]);
  });

  it('rejects recovery of a failed task without publishing', async () => {
    runner.requeueTask(taskName, ['pr_failed'], { startStep: 'review' });
    const running = runner.claimNextTasks(1)[0]!;
    runner.failTask({ task: running, success: false, response: 'stop', executionLog: [], failureStep: 'review',
      branch, worktreePath: clone, startedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T00:01:00Z',
      completion: { success: false, interrupted: false, branch, workflowResult: 'error' } });
    const current = readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8');
    expect(runner.listTaskStateItems()[0]).toMatchObject({ name: taskName, status: 'failed' });

    const result = await withClient(publish);

    expect(result.isError).toBe(true);
    expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')).toBe(current);
    expect((await store.get(goalId)).workLog).toEqual([]);
  });

  it('rejects recovery of work owned by another goal', async () => {
    const otherGoalId = '650e8400-e29b-41d4-a716-446655440001';
    await registerFixtureGoal(cwd, { id: otherGoalId });
    runner.requeueTask(taskName, ['pr_failed'], { startStep: 'review' });
    const reclaimed = runner.claimNextTasks(1)[0]!;
    runner.prFailTask({ task: reclaimed, success: true, response: 'Result ready', executionLog: [], branch, worktreePath: clone,
      startedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T00:01:00Z',
      completion: { success: true, interrupted: false, branch, sha: git(clone, ['rev-parse', 'HEAD']), workflowResult: 'completed' } },
    'push rejected');
    expect(runner.listTaskStateItems()[0]).toMatchObject({ name: taskName, goalId, status: 'pr_failed' });
    const current = readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8');

    const result = await withClient((client) => client.callTool({ name: 'takt_publish_pr_failed_goal_task',
      arguments: { cwd, goalId: otherGoalId, taskName } }));

    expect(result.isError).toBe(true);
    expect(runner.listTaskStateItems()[0]).toMatchObject({ name: taskName, goalId, status: 'pr_failed' });
    expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')).toBe(current);
    expect((await store.get(otherGoalId)).workLog).toEqual([]);
  });

  it('rejects recovery while the goal is paused', async () => {
    await store.update(goalId, (goal) => ({ ...goal, executionStatus: 'paused' }));

    const result = await withClient(publish);

    expect(result.isError).toBe(true);
    expect(runner.listTaskStateItems()[0]).toMatchObject({ status: 'pr_failed' });
    expect((await store.get(goalId)).workLog).toEqual([]);
  });

  it('keeps pr_failed when the branch publication fails', async () => {
    git(clone, ['remote', 'set-url', 'origin', join(root, 'missing-remote.git')]);

    const result = await withClient(publish);

    expect(result.isError).toBe(true);
    expect(runner.listTaskStateItems()[0]).toMatchObject({ status: 'pr_failed' });
    expect((await store.get(goalId)).workLog).toEqual([]);
  });
});

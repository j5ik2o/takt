import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finishTaktAbortedGoal } from '../features/mcp/goalFinishOperations.js';
import { TAKT_MCP_MANAGER_TOOL_NAMES } from '../features/mcp/server.js';
import { GoalSchema, type Goal } from '../infra/goals/schema.js';
import { TaskRunner } from '../infra/task/runner.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

const doubles = vi.hoisted(() => ({
  boundary: vi.fn(), run: vi.fn(), notifications: vi.fn(), preparePr: vi.fn(),
  prStatus: vi.fn(),
}));
vi.mock('../features/mcp/operations.js', async (original) => ({
  ...await original<typeof import('../features/mcp/operations.js')>(),
  assertCwdAllowedByMcpRoot: doubles.boundary,
}));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.run }));
vi.mock('../features/manager/notifications.js', async (original) => ({
  ...await original<typeof import('../features/manager/notifications.js')>(),
  sendSavedGoalNotifications: doubles.notifications,
}));
vi.mock('../infra/goals/pull-request.js', async (original) => ({
  ...await original<typeof import('../infra/goals/pull-request.js')>(),
  prepareGoalPullRequest: doubles.preparePr,
}));
vi.mock('../infra/goals/git-command.js', async (original) => ({
  ...await original<typeof import('../infra/goals/git-command.js')>(),
  fetchGoalIntegrationBranchSha: doubles.prStatus,
}));

const deps = (allowedProjectRoot: string) => ({ allowedProjectRoot });
const signal = new AbortController().signal;
const reason = '成果は上流の PR で確定したため、ゴールの作業は終了する';
const goalFile = () => join(cwd, '.takt', 'goals', goalId, 'goal.json');

let cwd: string;

function git(args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** 保存済みゴールを書き、テストが必要とするフィールドだけ上書きする。 */
async function saveGoal(overrides: Partial<Goal> = {}): Promise<Goal> {
  mkdirSync(join(cwd, '.takt', 'goals', goalId), { recursive: true });
  const record = GoalSchema.parse({ ...goalRecord(), workLog: [], ...overrides });
  const tip = git(['rev-parse', 'HEAD']);
  git(['update-ref', `refs/heads/${record.branch}`, tip]);
  git(['update-ref', `refs/heads/${record.integrationBranch}`, tip]);
  writeFileSync(goalFile(), JSON.stringify(record));
  return record;
}

function storedGoal(): Goal {
  return GoalSchema.parse(JSON.parse(readFileSync(goalFile(), 'utf8')));
}

function payload(result: Awaited<ReturnType<typeof finishTaktAbortedGoal>>): Record<string, unknown> {
  return JSON.parse(firstTextContent(result.content)) as Record<string, unknown>;
}

function changeSummary() {
  return { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false };
}

function seedTask(content: string): string {
  const runner = new TaskRunner(cwd);
  runner.addTask(content, { workflow: 'default', worktree: false, goal_id: goalId,
    goal_purpose: '結果を確認する', branch: goalRecord().branch });
  return runner.listTaskStateItems().at(-1)!.name;
}

beforeEach(() => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  cwd = realpathSync(mkdtempSync(join(root, 'goal-finish-')));
  mkdirSync(join(cwd, '.takt'), { recursive: true });
  writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n');
  initializeGitFixture(cwd, []);
  vi.clearAllMocks();
  doubles.run.mockResolvedValue(undefined);
  doubles.notifications.mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('finishing an aborted goal through the manager operation', () => {
  it('saves the reason in the work log and moves an aborted created goal to completed', async () => {
    const branchTip = git(['rev-parse', 'HEAD']);
    await saveGoal({ executionStatus: 'aborted', status: 'created' });

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    const saved = storedGoal();
    expect(saved).toMatchObject({ status: 'completed', executionStatus: 'aborted' });
    expect(saved.workLog).toHaveLength(1);
    expect(saved.workLog.at(-1)).toMatchObject({ summary: reason });
    expect(payload(result)).toMatchObject({
      workLogEntryId: saved.workLog.at(-1)!.id,
      goal: { id: goalId, status: 'completed', executionStatus: 'aborted' },
    });
    expect(saved.completion).toMatchObject({ goalSha: branchTip, targetSha: branchTip });
    expect(doubles.notifications).toHaveBeenCalledOnce();
    expect(doubles.notifications.mock.calls[0]![0]).toBe(cwd);
    expect(doubles.run).not.toHaveBeenCalled();
  });

  it('saves the reason text without trimming and keeps the goal identity fields', async () => {
    const before = await saveGoal({ executionStatus: 'aborted', status: 'created' });
    const untrimmed = '  上流 PR で確定  \n';

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason: untrimmed }, deps(cwd), signal);

    expect(result.isError).not.toBe(true);
    const saved = storedGoal();
    expect(saved.workLog.at(-1)?.summary).toBe(untrimmed);
    expect(saved.createdAt).toBe(before.createdAt);
    expect(saved.objective).toBe(before.objective);
    expect(saved.acceptanceCriteria).toEqual(before.acceptanceCriteria);
    expect(saved.constraints).toEqual(before.constraints);
    expect(saved.branch).toBe(before.branch);
    expect(saved.integrationBranch).toBe(before.integrationBranch);
  });

  it('finishes an aborted awaiting_merge goal with a saved closed PR without querying the pull request', async () => {
    const pullRequest = { number: 57, url: 'https://github.com/example/project/pull/57' };
    const branchTip = git(['rev-parse', 'HEAD']);
    await saveGoal({ executionStatus: 'aborted', status: 'awaiting_merge', pullRequest,
      completion: {
        goalBranch: goalRecord().branch, goalSha: branchTip, targetBranch: 'main',
        summary: '完了根拠を保存済み', changeSummary: changeSummary(), instructions: ['以前の案内'],
      } });

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    const saved = storedGoal();
    expect(saved).toMatchObject({ status: 'completed', executionStatus: 'aborted', pullRequest });
    expect(saved.completion?.summary).toBe('完了根拠を保存済み');
    expect(saved.completion?.targetSha).toBe(branchTip);
    expect(saved.workLog.at(-1)).toMatchObject({ summary: reason });
    expect(doubles.preparePr).not.toHaveBeenCalled();
    expect(doubles.prStatus).not.toHaveBeenCalled();
  });

  it('refreshes the saved completion target SHA from the goal branch tip and keeps saved evidence', async () => {
    const before = await saveGoal({ executionStatus: 'aborted', status: 'awaiting_merge',
      completion: {
        goalBranch: goalRecord().branch, goalSha: 'b'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40),
        summary: '完了根拠', changeSummary: changeSummary(), instructions: ['以前の案内'],
      } });
    const branchTip = git(['rev-parse', before.branch]);

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    expect(storedGoal()).toMatchObject({
      status: 'completed',
      completion: { targetSha: branchTip, summary: '完了根拠', instructions: ['以前の案内'] },
    });
  });

  it.each([undefined, '', '   \n\t '])('rejects a blank reason (%j) before changing the goal', async (value) => {
    const before = await saveGoal({ executionStatus: 'aborted', status: 'created' });

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason: value as unknown as string }, deps(cwd), signal);

    expect(result.isError).toBe(true);
    expect(storedGoal()).toEqual(before);
    expect(doubles.notifications).not.toHaveBeenCalled();
    expect(doubles.run).not.toHaveBeenCalled();
  });

  it.each(['active', 'paused'] as const)('rejects a %s goal because only aborted goals can finish', async (executionStatus) => {
    const before = await saveGoal({ executionStatus, status: 'created' });

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError).toBe(true);
    expect(storedGoal()).toEqual(before);
    expect(doubles.notifications).not.toHaveBeenCalled();
    expect(doubles.run).not.toHaveBeenCalled();
  });

  it('rejects an already completed aborted goal without saving again', async () => {
    const branchTip = git(['rev-parse', 'HEAD']);
    const before = await saveGoal({ executionStatus: 'aborted', status: 'completed',
      completion: {
        goalBranch: goalRecord().branch, goalSha: branchTip, targetBranch: 'main', targetSha: branchTip,
        summary: '既存の完了根拠', changeSummary: changeSummary(), instructions: [],
      } });

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError).toBe(true);
    expect(storedGoal()).toEqual(before);
  });

  it('rejects finishing while the goal has a running task', async () => {
    await saveGoal({ executionStatus: 'active', status: 'created' });
    seedTask('実行中の作業');
    new TaskRunner(cwd).claimNextTasks(1);
    const before = await saveGoal({ executionStatus: 'aborted', status: 'created' });
    expect(before.executionStatus).toBe('aborted');

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError).toBe(true);
    expect(storedGoal()).toEqual(before);
    expect(doubles.notifications).not.toHaveBeenCalled();
  });

  it('rejects finishing while an unmerged completed result remains', async () => {
    await saveGoal({ executionStatus: 'active', status: 'created' });
    const runner = new TaskRunner(cwd);
    seedTask('未取り込みの成果');
    const task = runner.claimNextTasks(1)[0]!;
    runner.completeTask({ task, success: true, branch: 'takt/unmerged-result', response: '完了した',
      completion: { success: true, interrupted: false, branch: 'takt/unmerged-result', sha: 'a'.repeat(40) },
      executionLog: [], startedAt: '2026-11-19T00:00:00Z', completedAt: '2026-11-19T00:01:00Z' });
    const before = await saveGoal({ executionStatus: 'aborted', status: 'created' });

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError).toBe(true);
    expect(storedGoal()).toEqual(before);
  });

  it('does not block on a result task that was merged into the goal branch', async () => {
    const tip = git(['rev-parse', 'HEAD']);
    await saveGoal({ executionStatus: 'active', status: 'created' });
    const runner = new TaskRunner(cwd);
    seedTask('取り込み済みの成果');
    const task = runner.claimNextTasks(1)[0]!;
    runner.completeTask({ task, success: true, branch: goalRecord().branch, response: '完了した',
      completion: { success: true, interrupted: false, branch: goalRecord().branch, sha: tip },
      executionLog: [], startedAt: '2026-11-19T00:00:00Z', completedAt: '2026-11-19T00:01:00Z' });
    await saveGoal({ executionStatus: 'aborted', status: 'created' });

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    expect(storedGoal()).toMatchObject({ status: 'completed' });
  });

  it('rejects a second call because the first call completed the goal', async () => {
    await saveGoal({ executionStatus: 'aborted', status: 'created' });

    expect((await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal)).isError).not.toBe(true);
    const second = await finishTaktAbortedGoal({ cwd, goalId, reason: '二回目' }, deps(cwd), signal);

    expect(second.isError).toBe(true);
    const saved = storedGoal();
    expect(saved.workLog).toHaveLength(1);
    expect(saved.workLog[0]!.summary).toBe(reason);
  });

  it('does not expose the finish operation through the public manager tool list', () => {
    expect(TAKT_MCP_MANAGER_TOOL_NAMES).not.toContain('takt_finish_goal');
  });
  it.each([
    { cwd: 'relative', goalId },
    { cwd: undefined, goalId },
    { goalId: 'not-a-goal-id' },
  ])('rejects an invalid identity %j before saving', async (override) => {
    const before = await saveGoal({ executionStatus: 'aborted', status: 'created' });
    const input = { reason, ...override };

    const result = await finishTaktAbortedGoal(input as never, deps(cwd), signal);

    expect(result.isError).toBe(true);
    expect(storedGoal()).toEqual(before);
  });

  it('rejects a cwd outside the allowed project root without saving', async () => {
    const before = await saveGoal({ executionStatus: 'aborted', status: 'created' });
    doubles.boundary.mockImplementationOnce(() => { throw new Error('outside assignment'); });

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps('/elsewhere'), signal);

    expect(result.isError).toBe(true);
    expect(storedGoal()).toEqual(before);
  });

  it('rejects a goal branch whose tip cannot be resolved instead of saving a partial goal', async () => {
    const before = await saveGoal({ executionStatus: 'aborted', status: 'created' });
    git(['branch', '-D', before.branch]);

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError).toBe(true);
    expect(storedGoal()).toEqual(before);
    expect(doubles.notifications).not.toHaveBeenCalled();
  });

  it('uses the saved branch tip and leaves the goal branch and integration branch untouched', async () => {
    const branchTip = git(['rev-parse', 'HEAD']);
    const before = await saveGoal({ executionStatus: 'aborted', status: 'created' });

    await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(git(['rev-parse', before.branch])).toBe(branchTip);
    expect(storedGoal()).toMatchObject({ branch: before.branch, integrationBranch: before.integrationBranch });
    expect(storedGoal().completion?.goalSha).toBe(branchTip);
  });

  it('rejects a result reachable from the goal branch but not integrated into the integration branch', async () => {
    await saveGoal({ executionStatus: 'active', status: 'created' });
    const runner = new TaskRunner(cwd);
    seedTask('ゴールブランチにだけ取り込まれた成果');
    const task = runner.claimNextTasks(1)[0]!;
    const baseTip = git(['rev-parse', 'HEAD']);
    const startBranch = git(['symbolic-ref', '--short', 'HEAD']);
    git(['checkout', '--quiet', goalRecord().branch]);
    writeFileSync(join(cwd, 'goal-only.txt'), 'goal branch only');
    git(['add', '--', 'goal-only.txt']);
    git(['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.invalid',
      'commit', '--quiet', '-m', 'goal branch only']);
    const resultSha = git(['rev-parse', 'HEAD']);
    git(['checkout', '--quiet', startBranch]);
    git(['update-ref', `refs/heads/${goalRecord().branch}`, resultSha]);
    git(['update-ref', `refs/heads/${goalRecord().integrationBranch}`, baseTip]);
    runner.completeTask({ task, success: true, branch: goalRecord().branch, response: '完了した',
      completion: { success: true, interrupted: false, branch: goalRecord().branch, sha: resultSha },
      executionLog: [], startedAt: '2026-11-19T00:00:00Z', completedAt: '2026-11-19T00:01:00Z' });
    mkdirSync(join(cwd, '.takt', 'goals', goalId), { recursive: true });
    const before = GoalSchema.parse({ ...goalRecord(), workLog: [], executionStatus: 'aborted', status: 'created' });
    writeFileSync(goalFile(), JSON.stringify(before));

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError).toBe(true);
    expect(storedGoal()).toEqual(before);
    expect(doubles.notifications).not.toHaveBeenCalled();
  });

  it('finishes when the result content is integrated into the integration branch by an equivalent commit', async () => {
    const startBranch = git(['symbolic-ref', '--short', 'HEAD']);
    await saveGoal({ executionStatus: 'active', status: 'created' });
    const runner = new TaskRunner(cwd);
    seedTask('内容一致で取り込まれた成果');
    const task = runner.claimNextTasks(1)[0]!;
    git(['checkout', '--quiet', goalRecord().branch]);
    writeFileSync(join(cwd, 'goal-only.txt'), 'goal branch only');
    git(['add', '--', 'goal-only.txt']);
    git(['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.invalid',
      'commit', '--quiet', '-m', 'goal branch only']);
    const resultSha = git(['rev-parse', 'HEAD']);
    git(['checkout', '--quiet', startBranch]);
    runner.completeTask({ task, success: true, branch: goalRecord().branch, response: '完了した',
      completion: { success: true, interrupted: false, branch: goalRecord().branch, sha: resultSha },
      executionLog: [], startedAt: '2026-11-19T00:00:00Z', completedAt: '2026-11-19T00:01:00Z' });
    writeFileSync(join(cwd, 'goal-only.txt'), 'goal branch only');
    git(['add', '--', 'goal-only.txt']);
    git(['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.invalid',
      'commit', '--quiet', '-m', 'squash-equivalent integration']);
    const before = await saveGoal({ executionStatus: 'aborted', status: 'created' });

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    expect(storedGoal()).toMatchObject({ status: 'completed' });
    expect(storedGoal().completion?.goalSha).toBe(git(['rev-parse', before.branch]));
  });

  it('finishes an awaiting_merge goal with a result task when the remote fetch is unavailable', async () => {
    const tip = git(['rev-parse', 'HEAD']);
    await saveGoal({ executionStatus: 'active', status: 'created' });
    const runner = new TaskRunner(cwd);
    seedTask('取り込み済みの成果');
    const task = runner.claimNextTasks(1)[0]!;
    runner.completeTask({ task, success: true, branch: goalRecord().branch, response: '完了した',
      completion: { success: true, interrupted: false, branch: goalRecord().branch, sha: tip },
      executionLog: [], startedAt: '2026-11-19T00:00:00Z', completedAt: '2026-11-19T00:01:00Z' });
    doubles.prStatus.mockRejectedValueOnce(new Error('origin unreachable'));
    await saveGoal({ executionStatus: 'aborted', status: 'awaiting_merge',
      pullRequest: { number: 57, url: 'https://github.com/example/project/pull/57' },
      completion: {
        goalBranch: goalRecord().branch, goalSha: tip, targetBranch: 'main', targetSha: tip,
        summary: '完了根拠を保存済み', changeSummary: changeSummary(), instructions: ['以前の案内'],
      } });
    // ローカル統合先と remote 追跡参照を一致させ、fetch 失敗時も妥当性を確認できる状態にする。
    git(['update-ref', `refs/remotes/origin/${goalRecord().integrationBranch}`, tip]);

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    expect(storedGoal()).toMatchObject({ status: 'completed' });
    expect(storedGoal().completion?.targetSha).toBe(tip);
  });

  it('rejects finishing when the remote fetch fails and the local integration reference is stale', async () => {
    const baseTip = git(['rev-parse', 'HEAD']);
    const startBranch = git(['symbolic-ref', '--short', 'HEAD']);
    await saveGoal({ executionStatus: 'active', status: 'created' });
    const runner = new TaskRunner(cwd);
    seedTask('ゴールブランチにだけある成果');
    const task = runner.claimNextTasks(1)[0]!;
    git(['checkout', '--quiet', goalRecord().branch]);
    writeFileSync(join(cwd, 'goal-only.txt'), 'goal branch only');
    git(['add', '--', 'goal-only.txt']);
    git(['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.invalid',
      'commit', '--quiet', '-m', 'goal branch only']);
    const resultSha = git(['rev-parse', 'HEAD']);
    git(['checkout', '--quiet', startBranch]);
    runner.completeTask({ task, success: true, branch: goalRecord().branch, response: '完了した',
      completion: { success: true, interrupted: false, branch: goalRecord().branch, sha: resultSha },
      executionLog: [], startedAt: '2026-11-19T00:00:00Z', completedAt: '2026-11-19T00:01:00Z' });
    doubles.prStatus.mockRejectedValueOnce(new Error('origin unreachable'));
    const before = await saveGoal({ executionStatus: 'aborted', status: 'awaiting_merge',
      pullRequest: { number: 57, url: 'https://github.com/example/project/pull/57' },
      completion: {
        goalBranch: goalRecord().branch, goalSha: resultSha, targetBranch: 'main', targetSha: resultSha,
        summary: '完了根拠を保存済み', changeSummary: changeSummary(), instructions: ['以前の案内'],
      } });
    // ローカル統合先は結果 SHA を含むが、remote 追跡参照は baseTip のまま (stale)。
    git(['update-ref', `refs/heads/${goalRecord().integrationBranch}`, resultSha]);
    git(['update-ref', `refs/remotes/origin/${goalRecord().integrationBranch}`, baseTip]);

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError).toBe(true);
    expect(storedGoal()).toEqual(before);
    expect(doubles.notifications).not.toHaveBeenCalled();
  });

  it('finishes when the local integration reference is absent but the remote fetch succeeds with an integrated result', async () => {
    const tip = git(['rev-parse', 'HEAD']);
    await saveGoal({ executionStatus: 'active', status: 'created' });
    const runner = new TaskRunner(cwd);
    seedTask('取り込み済みの成果');
    const task = runner.claimNextTasks(1)[0]!;
    runner.completeTask({ task, success: true, branch: goalRecord().branch, response: '完了した',
      completion: { success: true, interrupted: false, branch: goalRecord().branch, sha: tip },
      executionLog: [], startedAt: '2026-11-19T00:00:00Z', completedAt: '2026-11-19T00:01:00Z' });
    doubles.prStatus.mockResolvedValueOnce(tip);
    await saveGoal({ executionStatus: 'aborted', status: 'awaiting_merge',
      pullRequest: { number: 57, url: 'https://github.com/example/project/pull/57' },
      completion: {
        goalBranch: goalRecord().branch, goalSha: tip, targetBranch: 'main', targetSha: tip,
        summary: '完了根拠を保存済み', changeSummary: changeSummary(), instructions: ['以前の案内'],
      } });
    // ローカル統合先 ref を持たない統合先（updateGoalBranches 由来）を再現する。
    git(['update-ref', '-d', `refs/heads/${goalRecord().integrationBranch}`]);

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    const saved = storedGoal();
    expect(saved).toMatchObject({ status: 'completed' });
    expect(saved.completion?.targetSha).toBe(git(['rev-parse', goalRecord().branch]));
  });

  it('rejects when the local integration reference is absent and the fetched result is unintegrated', async () => {
    const baseTip = git(['rev-parse', 'HEAD']);
    const startBranch = git(['symbolic-ref', '--short', 'HEAD']);
    await saveGoal({ executionStatus: 'active', status: 'created' });
    const runner = new TaskRunner(cwd);
    seedTask('ゴールブランチにだけある成果');
    const task = runner.claimNextTasks(1)[0]!;
    git(['checkout', '--quiet', goalRecord().branch]);
    writeFileSync(join(cwd, 'goal-only.txt'), 'goal branch only');
    git(['add', '--', 'goal-only.txt']);
    git(['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.invalid',
      'commit', '--quiet', '-m', 'goal branch only']);
    const resultSha = git(['rev-parse', 'HEAD']);
    git(['checkout', '--quiet', startBranch]);
    runner.completeTask({ task, success: true, branch: goalRecord().branch, response: '完了した',
      completion: { success: true, interrupted: false, branch: goalRecord().branch, sha: resultSha },
      executionLog: [], startedAt: '2026-11-19T00:00:00Z', completedAt: '2026-11-19T00:01:00Z' });
    // fetch は remote 最新として baseTip を返す。結果 SHA は baseTip に含まれない。
    doubles.prStatus.mockResolvedValueOnce(baseTip);
    const before = await saveGoal({ executionStatus: 'aborted', status: 'awaiting_merge',
      pullRequest: { number: 57, url: 'https://github.com/example/project/pull/57' },
      completion: {
        goalBranch: goalRecord().branch, goalSha: resultSha, targetBranch: 'main', targetSha: resultSha,
        summary: '完了根拠を保存済み', changeSummary: changeSummary(), instructions: ['以前の案内'],
      } });
    git(['update-ref', '-d', `refs/heads/${goalRecord().integrationBranch}`]);

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError).toBe(true);
    expect(storedGoal()).toEqual(before);
  });

  it('rejects finishing while the goal has a pr_failed result without a saved SHA', async () => {
    await saveGoal({ executionStatus: 'active', status: 'created' });
    const runner = new TaskRunner(cwd);
    seedTask('結果を保存できずに失敗した作業');
    const task = runner.claimNextTasks(1)[0]!;
    runner.prFailTask({ task, success: false, branch: 'takt/pr-failed',
      response: 'PR 作成に失敗', executionLog: [], startedAt: '2026-11-19T00:00:00Z', completedAt: '2026-11-19T00:01:00Z' }, 'boom');
    expect(runner.listTaskStateItems().find((item) => item.goalId === goalId)?.status).toBe('pr_failed');
    const before = await saveGoal({ executionStatus: 'aborted', status: 'created' });

    const result = await finishTaktAbortedGoal({ cwd, goalId, reason }, deps(cwd), signal);

    expect(result.isError).toBe(true);
    expect(storedGoal()).toEqual(before);
  });
});

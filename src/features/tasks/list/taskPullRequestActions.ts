import { runTaskFinishHooks } from '../execute/taskFinishHook.js';
import { execFileSync } from 'node:child_process';
import { confirmWithCancel } from '../../../shared/prompt/index.js';
import { error, info, success } from '../../../shared/ui/index.js';
import { toLocalBranchRef, toPullRequestBaseRef } from '../../../shared/utils/gitBranchValidation.js';
import {
  detectDefaultBranch,
  getCurrentBranch,
  publishTaskBranch,
  resolveAutoCommitOptions,
  stageAndCommit,
  TaskRunner,
} from '../../../infra/task/index.js';
import type { StageAndCommitOptions } from '../../../infra/task/git.js';
import type { PrDetails } from '../../../core/workflow/system/pr-execution-context.js';
import { createPullRequestSafely, getGitProvider, initGitProvider } from '../../../infra/git/index.js';
import { runGitCommandAbortable } from '../../../infra/task/clone-exec.js';
import { buildSafeGitEnvironment } from '../../../infra/task/git-environment.js';
import { createPrCloneGitOperations } from '../../../infra/workflow/system/pr-clone-git.js';
import { checkForkThreats } from '../../merge/threat-check.js';
import { assertReusableWorktreePath } from '../execute/reusedWorktree.js';
import { assertTaskStateWorktreeOwnership } from '../taskStateWorktreeOwnership.js';
import {
  assertPrMergeCloneIdentity,
  assertSavedPrMergeIdentity,
  resolvePrMergeBaseRepositoryUrl,
} from '../../merge/pr-merge-identity.js';
import { findRunForTask, loadRunSessionContext } from '../../interactive/index.js';
import { getErrorMessage, sanitizeTerminalText } from '../../../shared/utils/index.js';
import type { TaskListItem } from '../../../infra/task/index.js';
import { summarizeRunReports, formatRunReportSummary, type RunReportSummary } from './runReportSummary.js';
import { collectTaskWorktreeSummary, type TaskWorktreeSummary } from './taskWorktreeSummary.js';
import { validateWorktreeTarget } from './taskActionTarget.js';

interface TaskPullRequestBodyOptions {
  readonly taskKind: TaskListItem['kind'];
  readonly reportSummary: RunReportSummary | null;
  readonly worktreeSummary: string;
}

export type PublishTaskResult =
  | { readonly success: true; readonly prUrl: string }
  | { readonly success: false; readonly error: string };

type PrFailedPublishOutcome =
  | { readonly kind: 'existing'; readonly prUrl: string; readonly publishedSha: string }
  | { readonly kind: 'created'; readonly prUrl: string; readonly publishedSha: string }
  | { readonly kind: 'creation-failed'; readonly error: string };

function resolveReportSummary(task: TaskListItem): RunReportSummary | null {
  if (!task.worktreePath) {
    return null;
  }
  const taskContent = task.data?.task;
  if (taskContent === undefined) {
    return null;
  }
  const runSlug = task.runSlug ?? findRunForTask(task.worktreePath, taskContent);
  if (!runSlug) {
    return null;
  }
  return summarizeRunReports(loadRunSessionContext(task.worktreePath, runSlug).reports);
}

export function buildTaskPullRequestBody(options: TaskPullRequestBodyOptions): string {
  const sections: string[] = [];
  if (options.reportSummary) {
    sections.push(formatRunReportSummary(options.reportSummary));
    if (options.taskKind === 'failed' && options.reportSummary.unverifiedGates.length > 0) {
      sections.push('後続ゲートは PR CI で実行します。');
    }
  }
  if (options.worktreeSummary.length > 0) {
    sections.push('## 作業ツリー差分', options.worktreeSummary);
  }
  return sections.join('\n\n');
}

function buildPullRequestTitle(task: TaskListItem): string {
  const firstContentLine = task.content.split(/\r?\n/u, 1)[0]?.trim() ?? '';
  const title = task.summary?.trim() || firstContentLine;
  return title.length > 100 ? `${title.slice(0, 97)}...` : title;
}

function displayPreview(
  branch: string,
  worktreeSummary: TaskWorktreeSummary,
  body: string,
  existingPrNumber?: number,
): void {
  const files = worktreeSummary.files.length > 0
    ? worktreeSummary.files.map(sanitizeTerminalText).join('\n')
    : '(コミット済み変更のみ)';
  if (existingPrNumber !== undefined) {
    info(`PR #${existingPrNumber} 更新プレビュー\nブランチ: ${sanitizeTerminalText(branch)}\nコミット対象ファイル:\n${files}`);
    return;
  }
  const previewBody = body.split('\n').map(sanitizeTerminalText).join('\n');
  info(`PR 作成プレビュー\nブランチ: ${sanitizeTerminalText(branch)}\nコミット対象ファイル:\n${files}\n\n本文:\n${previewBody}`);
}

async function publishExistingPrMergeTask(
  projectDir: string,
  task: TaskListItem & { worktreePath: string; branch: string },
  expectedDetails: PrDetails,
  baseRepositoryUrl: string,
  autoCommitOptions: StageAndCommitOptions,
): Promise<boolean> {
  const data = task.data!;
  const prNumber = data.pr_number!;
  const provider = getGitProvider();
  if (!provider.fetchPrDetails) throw new Error('The VCS provider does not support PR merge task publication');
  if (!expectedDetails.sameRepository) {
    const check = await checkForkThreats({
      cwd: task.worktreePath, projectCwd: projectDir,
      baseRef: toPullRequestBaseRef(expectedDetails.baseBranch),
      maxDiffBytes: data.merge_threat_check_max_diff_bytes!,
    });
    if (!check.passed) {
      error(sanitizeTerminalText(check.comment));
      return false;
    }
  }

  const latestBeforePush = await provider.fetchPrDetails(prNumber, projectDir);
  assertSavedPrMergeIdentity(data, latestBeforePush, prNumber);
  if (latestBeforePush.headSha !== expectedDetails.headSha) throw new Error('Pull request head changed before publication');
  const cloneGit = await createPrCloneGitOperations({
    cwd: task.worktreePath,
    headRepositoryUrl: latestBeforePush.headRepositoryUrl,
    headRepositoryPushUrls: latestBeforePush.headRepositoryPushUrls,
    baseRepositoryUrl,
    ...autoCommitOptions,
  });
  const env = await buildSafeGitEnvironment(task.worktreePath, autoCommitOptions);
  const pushedHeadSha = (await runGitCommandAbortable(task.worktreePath, ['rev-parse', 'HEAD'], undefined, env)).stdout.trim();
  new TaskRunner(projectDir).recordPrMergePushedHead(task.name, pushedHeadSha, expectedDetails.headSha, 'manual');
  await cloneGit.operations.push(`${pushedHeadSha}:${toLocalBranchRef(task.branch)}`);
  const latest = await provider.fetchPrDetails(prNumber, projectDir);
  assertSavedPrMergeIdentity(data, latest, prNumber);
  if (latest.headSha !== pushedHeadSha) throw new Error('Pull request head changed during publication');

  success(`既存の PR #${prNumber} を更新しました。`);
  return true;
}

export async function publishPrFailedTask(
  projectDir: string,
  task: TaskListItem,
): Promise<PublishTaskResult> {
  if (!task.branch) {
    return { success: false, error: `Task ${task.name} has no branch to publish` };
  }
  if (!validateWorktreeTarget(task, 'PR creation')) {
    return { success: false, error: `Task ${task.name} has no worktree to publish` };
  }
  const branch = task.branch;
  const worktreePath = task.worktreePath;
  try {
    assertTaskStateWorktreeOwnership(projectDir, task);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
  const currentBranch = getCurrentBranch(worktreePath);
  if (currentBranch === 'HEAD' || currentBranch !== branch) {
    return {
      success: false,
      error: `Worktree branch (${currentBranch}) does not match the task branch (${branch})`,
    };
  }
  if (task.data?.merge_task === true) {
    return { success: false, error: 'PR merge tasks cannot be recovered through pr_failed publication' };
  }

  const outcome = await publishPrFailedPr(projectDir, { ...task, branch, worktreePath }, undefined, undefined, {
    commitMessage: `takt: ${task.name}`,
    commitError: 'Commit failed',
    branchError: 'Branch publication failed',
  });
  if (outcome.kind === 'existing' || outcome.kind === 'created') {
    const persisted = await persistPublishedPr(projectDir, task.name, outcome.prUrl, outcome.publishedSha);
    if (!persisted.success) return persisted;
    return { success: true, prUrl: outcome.prUrl };
  }
  return { success: false, error: outcome.error };
}

interface PrFailedPublishMessages {
  readonly commitMessage: string;
  readonly commitError: string;
  readonly branchError: string;
}

async function publishPrFailedPr(
  projectDir: string,
  task: TaskListItem & { branch: string; worktreePath: string },
  baseBranch: string | undefined,
  body: string | undefined,
  messages?: PrFailedPublishMessages,
  publishedSha?: string,
): Promise<PrFailedPublishOutcome> {
  const branch = task.branch;
  const worktreePath = task.worktreePath;
  let resolvedBody = body;
  const resolvedBase = baseBranch ?? task.data?.base_branch ?? detectDefaultBranch(projectDir);
  if (messages !== undefined) initGitProvider(projectDir);
  const gitProvider = getGitProvider();
  if (messages !== undefined) {
    try {
      const autoCommitOptions = resolveAutoCommitOptions(projectDir);
      await stageAndCommit(worktreePath, messages.commitMessage, autoCommitOptions);
      resolvedBody = buildTaskPullRequestBody({
        taskKind: task.kind,
        reportSummary: resolveReportSummary(task),
        worktreeSummary: collectTaskWorktreeSummary(worktreePath, resolvedBase, branch).text,
      });
    } catch (err) {
      return { kind: 'creation-failed', error: `${messages.commitError}: ${getErrorMessage(err)}` };
    }
    try {
      publishedSha = readPublicationSha(worktreePath, branch);
      publishTaskBranch(worktreePath, projectDir, branch);
    } catch (err) {
      return { kind: 'creation-failed', error: `${messages.branchError}: ${getErrorMessage(err)}` };
    }
  }
  if (resolvedBody === undefined) {
    return { kind: 'creation-failed', error: 'Pull request body is required for publication' };
  }
  if (publishedSha === undefined) {
    return { kind: 'creation-failed', error: 'Published branch head is required' };
  }

  const existingPr = gitProvider.findExistingPr(branch, projectDir);
  if (existingPr) {
    return { kind: 'existing', prUrl: existingPr.url, publishedSha };
  }
  const result = createPullRequestSafely(gitProvider, {
    branch,
    title: buildPullRequestTitle(task),
    body: resolvedBody,
    base: resolvedBase,
    draft: task.data?.draft_pr,
  }, projectDir);
  if (!result.success) {
    return { kind: 'creation-failed', error: result.error ?? 'Pull request creation failed' };
  }
  if (result.url === undefined) {
    return { kind: 'creation-failed', error: 'Pull request creation returned no URL' };
  }
  return { kind: 'created', prUrl: result.url, publishedSha };
}

function readPublicationSha(worktreePath: string, branch: string): string {
  const sha = execFileSync('git', ['rev-parse', '--verify', toLocalBranchRef(branch)], {
    cwd: worktreePath, encoding: 'utf8', stdio: 'pipe',
  }).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
    throw new Error('Git did not return a full commit SHA for the task branch');
  }
  return sha;
}

async function persistPublishedPr(projectDir: string, taskName: string, prUrl: string, publishedSha: string): Promise<PublishTaskResult> {
  try {
    const runner = new TaskRunner(projectDir);
    runner.completePublishedTask(taskName, prUrl, publishedSha);
    // pr_failed became completed without an execution, so the finish hook is called here.
    await runTaskFinishHooks(projectDir, runner, [taskName]);
    return { success: true, prUrl };
  } catch (err) {
    return {
      success: false,
      error: `PR is public but the task ${taskName} could not be saved as completed: ${getErrorMessage(err)}`,
    };
  }
}

export async function createPullRequestForTask(
  projectDir: string,
  task: TaskListItem,
): Promise<boolean> {
  if (!task.branch) {
    error(`PR 作成を中止しました: タスク ${sanitizeTerminalText(task.name)} にブランチが設定されていません。`);
    return false;
  }
  if (!validateWorktreeTarget(task, 'PR creation')) {
    return false;
  }
  const worktreePath = task.worktreePath;
  const branch = task.branch;
  const mergeTask = task.data?.merge_task === true;
  let baseBranch: string;
  let mergeDetails: PrDetails | undefined;
  let mergeBaseRepositoryUrl: string | undefined;
  let worktreeSummary: TaskWorktreeSummary;
  let body: string;

  try {
    const currentBranch = getCurrentBranch(worktreePath);
    if (currentBranch === 'HEAD' || currentBranch !== branch) {
      error(`PR 作成を中止しました: worktree の現在ブランチ (${currentBranch}) と対象ブランチ (${branch}) が一致しません。`);
      return false;
    }
    if (mergeTask) {
      assertReusableWorktreePath(projectDir, worktreePath);
      const data = task.data!;
      const prNumber = data.pr_number!;
      const provider = getGitProvider();
      if (!provider.fetchPrDetails) throw new Error('The VCS provider does not support PR merge task publication');
      const details = await provider.fetchPrDetails(prNumber, projectDir);
      assertSavedPrMergeIdentity(data, details, prNumber);
      mergeDetails = details;
      mergeBaseRepositoryUrl = await resolvePrMergeBaseRepositoryUrl(projectDir);
      const env = await buildSafeGitEnvironment(worktreePath, { allowGitHooks: false, allowGitFilters: false });
      const git = (args: string[]) => runGitCommandAbortable(worktreePath, args, undefined, env);
      const originUrl = (await git(['remote', 'get-url', 'origin'])).stdout.trim();
      const cloneBaseUrl = (await git(['remote', 'get-url', 'base'])).stdout.trim();
      assertPrMergeCloneIdentity(
        { branch: currentBranch, originUrl, baseUrl: cloneBaseUrl },
        { branch: details.headBranch, originUrl: details.headRepositoryUrl, baseUrl: mergeBaseRepositoryUrl },
      );
    }
    baseBranch = task.data?.base_branch ?? detectDefaultBranch(projectDir);
    worktreeSummary = collectTaskWorktreeSummary(worktreePath, baseBranch, branch);
    body = mergeTask ? '' : buildTaskPullRequestBody({
      taskKind: task.kind,
      reportSummary: resolveReportSummary(task),
      worktreeSummary: worktreeSummary.text,
    });
  } catch (err) {
    error(`PR 作成を中止しました: 準備に失敗しました: ${sanitizeTerminalText(getErrorMessage(err))}`);
    return false;
  }

  displayPreview(branch, worktreeSummary, body, mergeTask ? task.data!.pr_number : undefined);
  const confirmed = await confirmWithCancel(
    `${mergeTask ? '既存の PR を更新しますか' : 'PR を作成しますか'}: ${sanitizeTerminalText(task.name)}?`, false);
  if (confirmed.kind === 'cancelled' || !confirmed.value) {
    return false;
  }

  let autoCommitOptions: StageAndCommitOptions;
  try {
    autoCommitOptions = resolveAutoCommitOptions(projectDir);
    await stageAndCommit(
      worktreePath,
      `takt: ${task.name}`,
      autoCommitOptions,
    );
  } catch (err) {
    error(`PR 作成を中止しました: コミットに失敗しました: ${sanitizeTerminalText(getErrorMessage(err))}`);
    return false;
  }

  if (mergeTask) {
    try {
      return await publishExistingPrMergeTask(
        projectDir, { ...task, worktreePath, branch }, mergeDetails!, mergeBaseRepositoryUrl!, autoCommitOptions,
      );
    } catch (err) {
      error(`PR の更新に失敗しました: ${sanitizeTerminalText(getErrorMessage(err))}`);
      return false;
    }
  }

  let publishedSha: string | undefined;
  try {
    if (task.kind === 'pr_failed') publishedSha = readPublicationSha(worktreePath, branch);
    publishTaskBranch(worktreePath, projectDir, branch);
  } catch (err) {
    error(`PR 作成を中止しました: ブランチの公開に失敗しました: ${sanitizeTerminalText(getErrorMessage(err))}`);
    return false;
  }

  if (task.kind === 'pr_failed') {
    const published = await publishPrFailedPr(
      projectDir, { ...task, worktreePath, branch }, baseBranch, body, undefined, publishedSha,
    );
    if (published.kind === 'creation-failed') {
      error(`PR 作成に失敗しました: ${published.error}`);
      return false;
    }
    success(published.kind === 'existing'
      ? `既存の PR を使用します: ${published.prUrl}`
      : `PR を作成しました: ${published.prUrl}`);
    const persisted = await persistPublishedPr(projectDir, task.name, published.prUrl, published.publishedSha);
    if (!persisted.success) {
      error(`PR は公開済みですが、タスク ${sanitizeTerminalText(task.name)} を completed として保存できませんでした: ${sanitizeTerminalText(persisted.error)}\ntakt list で状態を確認し、pr_failed の場合は Create PR で再試行してください。既存の PR を再利用します。`);
      return false;
    }
    return true;
  }

  const gitProvider = getGitProvider();
  const result = createPullRequestSafely(gitProvider, {
    branch,
    title: buildPullRequestTitle(task),
    body,
    base: baseBranch,
    draft: task.data?.draft_pr,
  }, projectDir);

  if (!result.success) {
    error(`PR 作成に失敗しました: ${result.error}`);
    return false;
  }

  success(`PR を作成しました: ${result.url}`);
  return true;
}

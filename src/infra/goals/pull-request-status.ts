import { fetchPrMergeStatus, type PrMergeStatus } from '../github/pr-status.js';
import { parseGitHubPullRequestTarget } from '../github/pull-request-target.js';
import { PrMergeStatusCache } from './pull-request-status-cache.js';
import type { Goal } from './schema.js';

export type GoalPullRequestStatus =
  | { status: 'unavailable' | 'mismatch' }
  | { status: 'available'; pullRequest: PrMergeStatus };

export interface ReadGoalPullRequestStatusOptions {
  cache?: PrMergeStatusCache;
  /** Re-read an open PR instead of reusing a recent result. */
  refreshOpen?: boolean;
}

const processCache = new PrMergeStatusCache((target, cwd, options) => fetchPrMergeStatus(target, cwd, options));

/** For tests that reuse one PR URL with different states. */
export function clearGoalPullRequestStatusCache(): void {
  processCache.clear();
}

export async function readGoalPullRequestStatus(
  cwd: string, goal: Pick<Goal, 'pullRequest' | 'branch' | 'integrationBranch'>, signal: AbortSignal | undefined,
  options: ReadGoalPullRequestStatusOptions = {},
): Promise<GoalPullRequestStatus | undefined> {
  signal?.throwIfAborted();
  if (goal.pullRequest === undefined) return undefined;
  try {
    const target = parseGitHubPullRequestTarget(goal.pullRequest.url);
    if (target.number !== goal.pullRequest.number) return { status: 'mismatch' };
    const pullRequest = await (options.cache ?? processCache).read(target, cwd, { signal, refreshOpen: options.refreshOpen });
    signal?.throwIfAborted();
    if (pullRequest.headRefName !== goal.branch || pullRequest.baseRefName !== goal.integrationBranch) {
      return { status: 'mismatch' };
    }
    return { status: 'available', pullRequest };
  } catch {
    signal?.throwIfAborted();
    // PRを確認できない場合も、完成確認では従来の内容比較を使う。
    return { status: 'unavailable' };
  }
}

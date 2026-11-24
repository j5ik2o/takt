import type { PrStatusFetchOptions } from '../../core/workflow/system/pr-execution-context.js';
import type { PrMergeStatus } from '../github/pr-status.js';
import type { GitHubPullRequestTarget } from '../github/pull-request-target.js';

export type FetchPrMergeStatus = (
  target: GitHubPullRequestTarget, cwd: string, options?: PrStatusFetchOptions,
) => Promise<PrMergeStatus>;

export const OPEN_PR_STATUS_TTL_MS = 60_000;
export const PR_STATUS_FAILURE_BACKOFF_MS = 60_000;

interface Entry {
  status?: PrMergeStatus;
  fetchedAt?: number;
  failedAt?: number;
  failure?: unknown;
  inflight?: Promise<PrMergeStatus>;
}

export interface ReadPrMergeStatusOptions {
  signal?: AbortSignal;
  /** Re-read an open PR even within its TTL. Merged/closed PRs, in-flight reads and failure backoff still apply. */
  refreshOpen?: boolean;
}

/**
 * Bounds `gh pr view` calls, which share GitHub's hourly GraphQL budget:
 * a merged or closed PR is read once per process, an open PR at most once per TTL,
 * concurrent reads of the same PR share one call, and a failed read is not retried
 * until the backoff passes (the last known status is returned meanwhile).
 */
export class PrMergeStatusCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly fetch: FetchPrMergeStatus,
    private readonly now: () => number = Date.now,
    private readonly openTtlMs = OPEN_PR_STATUS_TTL_MS,
    private readonly failureBackoffMs = PR_STATUS_FAILURE_BACKOFF_MS,
  ) {}

  clear(): void {
    this.entries.clear();
  }

  async read(target: GitHubPullRequestTarget, cwd: string, options: ReadPrMergeStatusOptions = {}): Promise<PrMergeStatus> {
    const entry = this.entries.get(target.url) ?? {};
    this.entries.set(target.url, entry);
    if (entry.status !== undefined && entry.status.state !== 'OPEN') return entry.status;
    if (entry.inflight !== undefined) return entry.inflight;
    const now = this.now();
    if (!options.refreshOpen && entry.status !== undefined && now - entry.fetchedAt! < this.openTtlMs) return entry.status;
    if (entry.failedAt !== undefined && now - entry.failedAt < this.failureBackoffMs) {
      if (entry.status !== undefined) return entry.status;
      throw entry.failure;
    }
    const signal = options.signal;
    const inflight = this.fetch(target, cwd, { signal }).then((status) => {
      entry.status = status;
      entry.fetchedAt = this.now();
      entry.failedAt = undefined;
      entry.failure = undefined;
      return status;
    }, (error: unknown) => {
      if (signal?.aborted) throw error;
      entry.failedAt = this.now();
      entry.failure = error;
      if (entry.status !== undefined) return entry.status;
      throw error;
    }).finally(() => {
      if (entry.inflight === inflight) entry.inflight = undefined;
    });
    entry.inflight = inflight;
    return inflight;
  }
}

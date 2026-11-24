import type { PrStatusFetchOptions } from '../../core/workflow/system/pr-execution-context.js';
import type { PrMergeStatus } from '../github/pr-status.js';
import type { GitHubPullRequestTarget } from '../github/pull-request-target.js';

export type FetchPrMergeStatus = (
  target: GitHubPullRequestTarget, cwd: string, options?: PrStatusFetchOptions,
) => Promise<PrMergeStatus>;

export const OPEN_PR_STATUS_TTL_MS = 60_000;
/** A closed PR can be reopened, so it is re-read, but rarely. */
export const CLOSED_PR_STATUS_TTL_MS = 10 * 60_000;
export const PR_STATUS_FAILURE_BACKOFF_MS = 60_000;
/** While reads fail, an older result is no longer returned. */
export const PR_STATUS_STALE_LIMIT_MS = 15 * 60_000;

interface Entry {
  status?: PrMergeStatus;
  fetchedAt?: number;
  failedAt?: number;
  failure?: unknown;
  inflight?: Promise<PrMergeStatus>;
}

export interface ReadPrMergeStatusOptions {
  signal?: AbortSignal;
  /** Re-read an open or closed PR even within its TTL. Merged PRs, shared reads and failure backoff still apply. */
  refresh?: boolean;
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    // Attach before checking the signal so that the shared read's rejection is always handled.
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/**
 * Bounds `gh pr view` calls, which share GitHub's hourly GraphQL budget:
 * a merged PR is read once per process, a closed or open PR at most once per its TTL,
 * concurrent reads of the same PR share one call, and a failed read is not retried
 * until the backoff passes (a result younger than the stale limit is returned meanwhile).
 */
export class PrMergeStatusCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly fetch: FetchPrMergeStatus,
    private readonly now: () => number = Date.now,
  ) {}

  clear(): void {
    this.entries.clear();
  }

  async read(target: GitHubPullRequestTarget, cwd: string, options: ReadPrMergeStatusOptions = {}): Promise<PrMergeStatus> {
    options.signal?.throwIfAborted();
    const entry = this.entries.get(target.url) ?? {};
    this.entries.set(target.url, entry);
    if (entry.status?.state === 'MERGED') return entry.status;
    if (entry.inflight !== undefined) return untilAborted(entry.inflight, options.signal);
    const now = this.now();
    if (!options.refresh && entry.status !== undefined && now - entry.fetchedAt! < this.ttl(entry.status)) return entry.status;
    if (entry.failedAt !== undefined && now - entry.failedAt < PR_STATUS_FAILURE_BACKOFF_MS) return this.lastKnown(entry, now);
    // The shared read ignores each caller's signal so that one caller's cancellation does not fail the others.
    const inflight = this.fetch(target, cwd).then((status) => {
      Object.assign(entry, { status, fetchedAt: this.now(), failedAt: undefined, failure: undefined });
      return status;
    }, (error: unknown) => {
      entry.failedAt = this.now();
      entry.failure = error;
      return this.lastKnown(entry, entry.failedAt);
    }).finally(() => {
      if (entry.inflight === inflight) entry.inflight = undefined;
    });
    entry.inflight = inflight;
    return untilAborted(inflight, options.signal);
  }

  private ttl(status: PrMergeStatus): number {
    return status.state === 'CLOSED' ? CLOSED_PR_STATUS_TTL_MS : OPEN_PR_STATUS_TTL_MS;
  }

  private lastKnown(entry: Entry, now: number): PrMergeStatus {
    if (entry.status !== undefined && now - entry.fetchedAt! <= PR_STATUS_STALE_LIMIT_MS) return entry.status;
    throw entry.failure;
  }
}

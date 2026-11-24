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
  /** Start order of the read whose outcome is saved, so an older read never overwrites a newer one. */
  savedRead?: number;
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
 * until the backoff passes (a result younger than the stale limit is returned meanwhile, except to a refresh).
 */
export class PrMergeStatusCache {
  private readonly entries = new Map<string, Entry>();
  private reads = 0;

  constructor(
    private readonly fetch: FetchPrMergeStatus,
    private readonly now: () => number = () => Date.now(),
  ) {}

  clear(): void {
    this.entries.clear();
  }

  async read(target: GitHubPullRequestTarget, cwd: string, options: ReadPrMergeStatusOptions = {}): Promise<PrMergeStatus> {
    options.signal?.throwIfAborted();
    const entry = this.entries.get(target.url) ?? {};
    this.entries.set(target.url, entry);
    if (entry.status?.state === 'MERGED') return entry.status;
    // A refresh must see a state newer than its own call, so it does not join a read that started earlier.
    if (!options.refresh && entry.inflight !== undefined) return this.settle(entry, entry.inflight, options);
    const now = this.now();
    if (!options.refresh && entry.status !== undefined && now - entry.fetchedAt! < this.ttl(entry.status)) return entry.status;
    if (entry.failedAt !== undefined && now - entry.failedAt < PR_STATUS_FAILURE_BACKOFF_MS) {
      if (options.refresh) throw entry.failure;
      return this.lastKnown(entry, now);
    }
    // The shared read ignores each caller's signal so that one caller's cancellation does not fail the others.
    const read = ++this.reads;
    const isLatest = () => {
      if (entry.savedRead !== undefined && entry.savedRead > read) return false;
      entry.savedRead = read;
      return true;
    };
    const inflight: Promise<PrMergeStatus> = this.fetch(target, cwd).then((status) => {
      if (isLatest()) Object.assign(entry, { status, fetchedAt: this.now(), failedAt: undefined, failure: undefined });
      return status;
    }, (error: unknown) => {
      if (isLatest()) Object.assign(entry, { failedAt: this.now(), failure: error });
      throw error;
    }).finally(() => {
      if (entry.inflight === inflight) entry.inflight = undefined;
    });
    entry.inflight = inflight;
    return this.settle(entry, inflight, options);
  }

  /** A failed read falls back to a recent result for display, but never for a refresh. */
  private settle(entry: Entry, inflight: Promise<PrMergeStatus>, options: ReadPrMergeStatusOptions): Promise<PrMergeStatus> {
    return untilAborted(inflight.catch((error: unknown) => {
      if (options.refresh) throw error;
      return this.lastKnown(entry, this.now());
    }), options.signal);
  }

  private ttl(status: PrMergeStatus): number {
    return status.state === 'CLOSED' ? CLOSED_PR_STATUS_TTL_MS : OPEN_PR_STATUS_TTL_MS;
  }

  private lastKnown(entry: Entry, now: number): PrMergeStatus {
    if (entry.status !== undefined && now - entry.fetchedAt! <= PR_STATUS_STALE_LIMIT_MS) return entry.status;
    throw entry.failure;
  }
}

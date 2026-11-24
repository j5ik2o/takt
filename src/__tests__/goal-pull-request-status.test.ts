import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readGoalPullRequestStatus as readStatus, type ReadGoalPullRequestStatusOptions } from '../infra/goals/pull-request-status.js';
import { PrMergeStatusCache } from '../infra/goals/pull-request-status-cache.js';
import type { PrMergeStatus } from '../infra/github/pr-status.js';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('../infra/github/pr-status.js', () => ({ fetchPrMergeStatus: fetch }));
let goal: Goal;
let now = 0;
let cache: PrMergeStatusCache;
const readGoalPullRequestStatus = (cwd: string, target: Goal, signal: AbortSignal | undefined, options: ReadGoalPullRequestStatusOptions = {}) =>
  readStatus(cwd, target, signal, { cache, ...options });
const response = () => ({ number: 1950, url: goal.pullRequest!.url, headRefName: goal.branch,
  baseRefName: goal.integrationBranch, baseRefOid: 'b'.repeat(40), mergeCommit: { oid: 'c'.repeat(40) }, state: 'MERGED' as const });
beforeEach(() => {
  goal = { ...goalRecord(), pullRequest: { number: 1950, url: 'https://github.com/example/project/pull/1950' } };
  fetch.mockReset().mockResolvedValue(response());
  now = 0;
  cache = new PrMergeStatusCache(fetch, () => now);
});

it.each(['OPEN', 'CLOSED', 'MERGED'])('returns matching PR evidence with state %s', async (state) => {
  fetch.mockResolvedValue({ ...response(), state });
  expect(await readGoalPullRequestStatus('/project', goal, undefined)).toEqual({ status: 'available',
    pullRequest: { ...response(), state } });
});

it('reads the saved PR identity without tying the shared read to one caller', async () => {
  await readGoalPullRequestStatus('/project', goal, new AbortController().signal);
  expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ number: 1950, url: goal.pullRequest!.url }), '/project');
});

it.each([{ headRefName: 'other' }, { baseRefName: 'develop' }])('marks different goal branches as mismatched: %j', async (overrides) => {
  fetch.mockResolvedValue({ ...response(), ...overrides });
  expect(await readGoalPullRequestStatus('/project', goal, undefined)).toEqual({ status: 'mismatch' });
});

it('does not query GitHub when no PR is saved', async () => {
  delete goal.pullRequest;
  expect(await readGoalPullRequestStatus('/project', goal, undefined)).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

it('does not query a URL whose PR number differs from the saved number', async () => {
  goal = { ...goal, pullRequest: { ...goal.pullRequest!, number: 1951 } };
  expect(await readGoalPullRequestStatus('/project', goal, undefined)).toEqual({ status: 'mismatch' });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['invalid URL', 'gh failure'])('reports unavailable PR evidence after %s', async (condition) => {
  if (condition === 'invalid URL') goal = { ...goal, pullRequest: { number: 1950, url: 'invalid' } };
  else fetch.mockRejectedValue(new Error('not authenticated'));
  expect(await readGoalPullRequestStatus('/project', goal, undefined)).toEqual({ status: 'unavailable' });
});

it.each([false, true])('propagates cancellation during lookup when the fetch rejects=%s', async (reject) => {
  const controller = new AbortController();
  fetch.mockImplementation(async () => {
    controller.abort();
    if (reject) throw controller.signal.reason;
    return response();
  });
  await expect(readGoalPullRequestStatus('/project', goal, controller.signal)).rejects.toBe(controller.signal.reason);
});

it('does not start a lookup after cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(readGoalPullRequestStatus('/project', goal, controller.signal)).rejects.toBe(controller.signal.reason);
  expect(fetch).not.toHaveBeenCalled();
});

describe('gh pr view call budget', () => {
  const read = () => readGoalPullRequestStatus('/project', goal, undefined);
  const refresh = () => readGoalPullRequestStatus('/project', goal, undefined, { refresh: true });
  const rateLimited = () => new Error('GraphQL: API rate limit exceeded');
  const at = async (elapsed: number) => {
    now = elapsed;
    return read();
  };

  it('reads a merged PR once per process, even when asked to refresh', async () => {
    for (const elapsed of [0, 1, 60_000, 3_600_000]) expect(await at(elapsed)).toMatchObject({ pullRequest: { state: 'MERGED' } });
    expect(await refresh()).toMatchObject({ pullRequest: { state: 'MERGED' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reuses a closed PR for 10 minutes, then re-reads it because it can be reopened', async () => {
    fetch.mockResolvedValueOnce({ ...response(), state: 'CLOSED' }).mockResolvedValueOnce({ ...response(), state: 'OPEN' });
    await at(0);
    expect(await at(599_999)).toMatchObject({ pullRequest: { state: 'CLOSED' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await at(600_000)).toMatchObject({ pullRequest: { state: 'OPEN' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reuses an open PR within 60 seconds and re-reads it after', async () => {
    fetch.mockResolvedValue({ ...response(), state: 'OPEN' });
    await at(0);
    await at(59_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await at(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['OPEN', 'CLOSED'] as const)('re-reads a %s PR when the caller asks for a fresh state', async (state) => {
    fetch.mockResolvedValueOnce({ ...response(), state }).mockResolvedValueOnce(response());
    await read();
    expect(await refresh()).toMatchObject({ pullRequest: { state: 'MERGED' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reads each PR once when one request lists it several times concurrently', async () => {
    let resolve!: (value: PrMergeStatus) => void;
    fetch.mockReturnValue(new Promise((r) => { resolve = r; }));
    const other = { ...goal, pullRequest: { number: 1951, url: 'https://github.com/example/project/pull/1951' } };
    const reads = [read(), read(), read(), readGoalPullRequestStatus('/project', other, undefined)];
    resolve({ ...response(), state: 'OPEN' });
    await Promise.all(reads);
    expect(fetch.mock.calls.map(([target]) => target.number)).toEqual([1950, 1951]);
  });

  it('cancels only the caller that aborts a shared read', async () => {
    let resolve!: (value: PrMergeStatus) => void;
    fetch.mockReturnValue(new Promise((r) => { resolve = r; }));
    const first = new AbortController();
    const joiner = new AbortController();
    const firstRead = readGoalPullRequestStatus('/project', goal, first.signal);
    const joinerRead = readGoalPullRequestStatus('/project', goal, joiner.signal);
    const otherRead = read();
    first.abort();
    await expect(firstRead).rejects.toBe(first.signal.reason);
    joiner.abort();
    await expect(joinerRead).rejects.toBe(joiner.signal.reason);
    resolve({ ...response(), state: 'OPEN' });
    expect(await otherRead).toMatchObject({ status: 'available', pullRequest: { state: 'OPEN' } });
    expect(await read()).toMatchObject({ status: 'available' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns the last status without retrying while gh is rate limited', async () => {
    fetch.mockResolvedValueOnce({ ...response(), state: 'OPEN' }).mockRejectedValue(rateLimited());
    await at(0);
    expect(await at(60_000)).toMatchObject({ status: 'available', pullRequest: { state: 'OPEN' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const elapsed of [60_001, 90_000, 119_999]) {
      expect(await at(elapsed)).toMatchObject({ status: 'available', pullRequest: { state: 'OPEN' } });
    }
    expect(await refresh()).toEqual({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(2);
    await at(120_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('stops returning a status older than 15 minutes while reads keep failing', async () => {
    fetch.mockResolvedValueOnce({ ...response(), state: 'OPEN' }).mockRejectedValue(rateLimited());
    await at(0);
    expect(await at(900_000)).toMatchObject({ status: 'available' });
    expect(await at(900_001)).toEqual({ status: 'unavailable' });
    expect(await at(1_000_000)).toEqual({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not give a refresh an old closed state while gh is failing', async () => {
    fetch.mockResolvedValueOnce({ ...response(), state: 'CLOSED' }).mockRejectedValue(rateLimited());
    await at(0);
    now = 300_000;
    expect(await refresh()).toEqual({ status: 'unavailable' });
    now = 330_000;
    expect(await refresh()).toEqual({ status: 'unavailable' });
    expect(await read()).toMatchObject({ status: 'available', pullRequest: { state: 'CLOSED' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('starts a new read for a refresh instead of joining an earlier one, and keeps the newer result', async () => {
    let resolveOlder!: (value: PrMergeStatus) => void;
    fetch.mockReturnValueOnce(new Promise((r) => { resolveOlder = r; })).mockResolvedValueOnce(response());
    const older = read();
    expect(await refresh()).toMatchObject({ pullRequest: { state: 'MERGED' } });
    resolveOlder({ ...response(), state: 'OPEN' });
    expect(await older).toMatchObject({ pullRequest: { state: 'OPEN' } });
    now = 3_600_000;
    expect(await read()).toMatchObject({ pullRequest: { state: 'MERGED' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reads the current Date.now when no clock is injected', async () => {
    // Built before the spy, like the process-wide cache that tests cannot rebuild.
    cache = new PrMergeStatusCache(fetch);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      fetch.mockResolvedValue({ ...response(), state: 'OPEN' });
      await read();
      clock.mockReturnValue(1_060_000);
      await read();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('does not retry a failed first read until the backoff passes', async () => {
    fetch.mockRejectedValue(rateLimited());
    expect(await at(0)).toEqual({ status: 'unavailable' });
    expect(await at(59_999)).toEqual({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

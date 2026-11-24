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

it('reads the saved PR identity with the supplied cancellation signal', async () => {
  const signal = new AbortController().signal;
  await readGoalPullRequestStatus('/project', goal, signal);
  expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ number: 1950, url: goal.pullRequest!.url }),
    '/project', { signal });
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
  const rateLimited = () => new Error('GraphQL: API rate limit exceeded');

  it.each(['MERGED', 'CLOSED'] as const)('reads a %s PR once per process', async (state) => {
    fetch.mockResolvedValue({ ...response(), state });
    for (const elapsed of [0, 1, 60_000, 3_600_000]) {
      now = elapsed;
      expect(await read()).toMatchObject({ status: 'available', pullRequest: { state } });
    }
    expect(await readGoalPullRequestStatus('/project', goal, undefined, { refreshOpen: true }))
      .toMatchObject({ pullRequest: { state } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reuses an open PR within 60 seconds and re-reads it after', async () => {
    fetch.mockResolvedValue({ ...response(), state: 'OPEN' });
    await read();
    now = 59_999;
    await read();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 60_000;
    await read();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('re-reads an open PR when the caller asks for a fresh state', async () => {
    fetch.mockResolvedValueOnce({ ...response(), state: 'OPEN' }).mockResolvedValueOnce(response());
    await read();
    expect(await readGoalPullRequestStatus('/project', goal, undefined, { refreshOpen: true }))
      .toMatchObject({ pullRequest: { state: 'MERGED' } });
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

  it('returns the last status without retrying while gh is rate limited', async () => {
    fetch.mockResolvedValueOnce({ ...response(), state: 'OPEN' }).mockRejectedValue(rateLimited());
    await read();
    now = 60_000;
    expect(await read()).toMatchObject({ status: 'available', pullRequest: { state: 'OPEN' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const elapsed of [60_001, 90_000, 119_999]) {
      now = elapsed;
      expect(await read()).toMatchObject({ status: 'available', pullRequest: { state: 'OPEN' } });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    now = 120_000;
    await read();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry a failed first read until the backoff passes', async () => {
    fetch.mockRejectedValue(rateLimited());
    expect(await read()).toEqual({ status: 'unavailable' });
    now = 59_999;
    expect(await read()).toEqual({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not treat a cancelled read as a gh failure', async () => {
    const controller = new AbortController();
    fetch.mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(readGoalPullRequestStatus('/project', goal, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(await read()).toMatchObject({ status: 'available' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

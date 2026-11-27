/**
 * `inspectDeletionOwner` must tell three cases apart (#170, Devin review of #191):
 *
 * - A live PID whose recorded start time differs from the current process is a reused PID, so
 *   the recorded owner is gone and the reservation must not stay `alive`.
 * - A live PID without a recorded start time stays `unknown`: PID reuse cannot be ruled out.
 * - A PID that no longer exists is `dead`.
 */

import { describe, expect, it } from 'vitest';
import { inspectDeletionOwner } from '../infra/daemon/persistedFiles.js';
import { getSelfProcessIdentity } from '../infra/task/process.js';

const self = getSelfProcessIdentity();

/** A valid identity of the same format whose start time differs from `startTime`. */
function differentStartTime(startTime: string): string {
  const darwin = /^darwin-start-v2:([1-9]\d*)$/.exec(startTime);
  if (darwin !== null) return `darwin-start-v2:${BigInt(darwin[1]!) + 1n}`;
  const linux = /^linux-start-v3:([0-9a-f-]{36}):(0|[1-9]\d*)$/.exec(startTime);
  if (linux !== null) return `linux-start-v3:${linux[1]!}:${BigInt(linux[2]!) + 1n}`;
  // A well-formed Windows start time from a different second.
  return '2000-01-01T00:00:00.0000001Z';
}

describe('inspectDeletionOwner does not trust a reused PID', () => {
  it('does not report a live PID as alive when its recorded start time differs', async () => {
    expect(self).toBeDefined();
    const owner = await inspectDeletionOwner({
      owner_pid: process.pid,
      owner_start_time: differentStartTime(self!.startTime),
    });

    expect(owner).toBe('dead');
  });

  it('keeps a live PID without a recorded start time unknown', async () => {
    expect(await inspectDeletionOwner({ owner_pid: process.pid })).toBe('unknown');
  });

  it('reports a missing PID as dead', async () => {
    expect(await inspectDeletionOwner({ owner_pid: 999_999 })).toBe('dead');
  });
});

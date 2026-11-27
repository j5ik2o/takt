/**
 * PBT 3 (file-lock.ts side) of docs/design/claim-lock-release-failure.md: any sequence of lock
 * operations against `withFileLock`, compared with a model of the design (3-1, 3-3).
 *
 * - A live owner's file and a file this process did not record are never removed.
 * - After a release failure, the next acquisition removes the recorded file without waiting
 *   (even with `timeoutMs: 0`). While the recorded file cannot be read, the record is kept and the
 *   acquisition waits; the first readable round removes it.
 * - While `unlink` keeps failing, the next acquisition throws that error, without the action and
 *   without a timeout. While reads keep failing, it waits (times out) until `STALE_MS`, after which
 *   the current stale rule removes the file.
 * - A failed release always throws.
 */

import * as fs from 'node:fs';
import { resolve } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  openSync: vi.fn(), closeSync: vi.fn(), fstatSync: vi.fn(), readFileSync: vi.fn(),
  statSync: vi.fn(), unlinkSync: vi.fn(), writeFileSync: vi.fn(), linkSync: vi.fn(),
}));
vi.mock('../infra/task/process.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/task/process.js')>(),
  getSelfProcessIdentity: vi.fn(), getProcessIdentity: vi.fn(), isProcessAlive: vi.fn(),
}));

import { isFileLockTimeoutError, withFileLock } from '../infra/fs/file-lock.js';
import { getProcessIdentity, getSelfProcessIdentity, isProcessAlive } from '../infra/task/process.js';

const PBT_NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return process.env.CI ? 100 : 300;
})();

const STALE_MS = 30_000;
const RETRY_MS = 25;
const LIVE_PID = 4101;
const DEAD_PID = 4102;
const identity = { startTime: 'darwin-start-v2:1791244800' };
const selfContent = JSON.stringify({ pid: process.pid, processIdentity: identity });
const liveContent = JSON.stringify({ pid: LIVE_PID, processIdentity: identity });
const deadContent = JSON.stringify({ pid: DEAD_PID, processIdentity: identity });

type FaultKind = 'unlink' | 'open' | 'read';
type Who = 'own' | 'self' | 'live' | 'dead';
type Op =
  | { kind: 'cycle'; timeoutMs: number }
  | { kind: 'releaseFails'; fault: FaultKind; times: number; timeoutMs: number }
  | { kind: 'releaseFailsForever'; fault: FaultKind; timeoutMs: number }
  | { kind: 'place'; who: Exclude<Who, 'own'> }
  | { kind: 'replace' }
  | { kind: 'delete' }
  | { kind: 'age' };
type Outcome = 'ok' | 'timeout' | 'unlinkError' | 'readError';

// --- the mocked file system ---------------------------------------------------------------------

let lockPath = resolve('orphan-pbt.lock');
let disk: { content: string; stat: fs.Stats } | undefined;
let temporary: { content: string; stat: fs.Stats } | undefined;
let nextIno = 1;
const whoByIno = new Map<number, Who>();
let fault: { kind: FaultKind; remaining: number } | undefined;
let pendingReadFailure = false;

function fileStat(ino: number, mtimeMs = Date.now()): fs.Stats {
  return { dev: 1, ino, mtimeMs } as fs.Stats;
}

function consume(kind: FaultKind): boolean {
  if (fault?.kind !== kind || fault.remaining <= 0) return false;
  fault.remaining -= 1;
  return true;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.mocked(getSelfProcessIdentity).mockReturnValue(identity);
  vi.mocked(getProcessIdentity).mockReturnValue(identity);
  vi.mocked(isProcessAlive).mockImplementation((pid) => pid !== DEAD_PID);
  vi.mocked(fs.openSync).mockImplementation((path, flags) => {
    if (flags === 'wx') {
      temporary = { content: '', stat: fileStat(nextIno++) };
      return 43;
    }
    if (path !== lockPath || disk === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (consume('open')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    pendingReadFailure = consume('read');
    return 42;
  });
  vi.mocked(fs.statSync).mockImplementation(() => disk?.stat);
  vi.mocked(fs.fstatSync).mockImplementation((fd) => (fd === 43 ? temporary!.stat : disk!.stat));
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    if (pendingReadFailure) {
      pendingReadFailure = false;
      throw Object.assign(new Error('i/o error'), { code: 'EIO' });
    }
    return disk!.content;
  });
  vi.mocked(fs.writeFileSync).mockImplementation((_fd, value) => { temporary!.content = String(value); });
  vi.mocked(fs.linkSync).mockImplementation(() => {
    if (disk !== undefined) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    disk = { content: temporary!.content, stat: temporary!.stat };
    whoByIno.set(disk.stat.ino, 'own');
  });
  vi.mocked(fs.unlinkSync).mockImplementation((path) => {
    if (path !== lockPath) { temporary = undefined; return; }
    if (consume('unlink')) throw Object.assign(new Error('EACCES: unlink'), { code: 'EACCES' });
    disk = undefined;
  });
  vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
    vi.advanceTimersByTime(timeout!);
    return 'timed-out';
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- the model of the design ---------------------------------------------------------------------

interface Model {
  disk: { who: Who; aged: boolean; recorded: boolean } | undefined;
  fault: { kind: FaultKind; remaining: number } | undefined;
}

function modelConsume(model: Model, kind: FaultKind): boolean {
  if (model.fault?.kind !== kind || model.fault.remaining <= 0) return false;
  model.fault.remaining -= 1;
  return true;
}

function modelReadFails(model: Model): boolean {
  return modelConsume(model, 'open') || modelConsume(model, 'read');
}

/** One acquisition, the action, and the release, as the design defines them. */
function modelAcquire(model: Model, timeoutMs: number, armRelease?: { kind: FaultKind; remaining: number }): { outcome: Outcome; action: boolean } {
  let now = 0;
  while (true) {
    if (model.disk === undefined) {
      model.disk = { who: 'own', aged: false, recorded: false };
      break;
    }
    let removedOwn = false;
    const current = model.disk;
    if (current.who === 'own' && current.recorded) {
      if (modelReadFails(model)) {
        // The record is kept and the unreadable lock follows the current rule.
        if (current.aged) {
          // unlinkSnapshot reads again and removes the file only while it still cannot be read.
          if (modelReadFails(model)) model.disk = undefined;
        }
      } else {
        if (modelConsume(model, 'unlink')) return { outcome: 'unlinkError', action: false };
        model.disk = undefined;
        removedOwn = true;
      }
    } else if (current.who === 'dead') {
      model.disk = undefined;
    }
    if (removedOwn) continue;
    if (now >= timeoutMs) return { outcome: 'timeout', action: false };
    now += Math.min(RETRY_MS, timeoutMs - now);
  }
  if (armRelease !== undefined) model.fault = { ...armRelease };
  if (modelReadFails(model)) {
    model.disk!.recorded = true;
    return { outcome: 'readError', action: true };
  }
  if (modelConsume(model, 'unlink')) {
    model.disk!.recorded = true;
    return { outcome: 'unlinkError', action: true };
  }
  model.disk = undefined;
  return { outcome: 'ok', action: true };
}

// --- running one operation against both ----------------------------------------------------------

function classify(error: unknown): Outcome {
  if (isFileLockTimeoutError(error)) return 'timeout';
  if (error instanceof Error && error.message.includes('unlink')) return 'unlinkError';
  const code = (error as { code?: string }).code;
  if (code === 'EIO' || code === 'EACCES') return 'readError';
  throw error;
}

function place(who: Exclude<Who, 'own'>): void {
  const content = who === 'self' ? selfContent : who === 'live' ? liveContent : deadContent;
  disk = { content, stat: fileStat(nextIno++) };
  whoByIno.set(disk.stat.ino, who);
}

function runOp(op: Op, model: Model): void {
  // Files that are not aged stay fresh: fake time moves on with every wait.
  if (disk !== undefined && model.disk !== undefined && !model.disk.aged) {
    disk = { ...disk, stat: { ...disk.stat, mtimeMs: Date.now() } as fs.Stats };
  }
  switch (op.kind) {
    case 'place':
      place(op.who);
      model.disk = { who: op.who, aged: false, recorded: false };
      fault = undefined; model.fault = undefined;
      return;
    case 'replace':
      if (disk === undefined) return;
      place('self');
      model.disk = { who: 'self', aged: false, recorded: false };
      fault = undefined; model.fault = undefined;
      return;
    case 'delete':
      disk = undefined;
      model.disk = undefined;
      fault = undefined; model.fault = undefined;
      return;
    case 'age':
      if (disk === undefined || model.disk === undefined) return;
      disk = { ...disk, stat: { ...disk.stat, mtimeMs: Date.now() - STALE_MS - 1 } as fs.Stats };
      model.disk.aged = true;
      return;
  }
  const arm = op.kind === 'cycle' ? undefined
    : { kind: op.fault, remaining: op.kind === 'releaseFails' ? op.times : Number.POSITIVE_INFINITY };
  const expected = modelAcquire(model, op.timeoutMs, arm);
  const before = disk === undefined ? undefined : { ino: disk.stat.ino, who: whoByIno.get(disk.stat.ino)! };
  const action = vi.fn(() => { if (arm !== undefined) fault = { ...arm }; });
  let outcome: Outcome = 'ok';
  try {
    withFileLock(lockPath, action, { timeoutMs: op.timeoutMs });
  } catch (error) {
    outcome = classify(error);
  }
  expect({ op, outcome, action: action.mock.calls.length === 1 }).toEqual({ op, outcome: expected.outcome, action: expected.action });
  const after = disk === undefined ? undefined : whoByIno.get(disk.stat.ino);
  expect({ op, disk: after }).toEqual({ op, disk: model.disk?.who });
  // A live owner's file and an unrecorded file are never removed, whatever the operation was.
  if (before !== undefined && (before.who === 'live' || before.who === 'self')) {
    expect(disk?.stat.ino).toBe(before.ino);
  }
}

const timeoutArb = fc.constantFrom(0, 25, 5_000);
const faultArb = fc.constantFrom<FaultKind>('unlink', 'open', 'read');
const opArb: fc.Arbitrary<Op> = fc.oneof(
  timeoutArb.map((timeoutMs) => ({ kind: 'cycle' as const, timeoutMs })),
  fc.record({ fault: faultArb, times: fc.integer({ min: 1, max: 3 }), timeoutMs: timeoutArb })
    .map((value) => ({ kind: 'releaseFails' as const, ...value })),
  fc.record({ fault: faultArb, timeoutMs: timeoutArb }).map((value) => ({ kind: 'releaseFailsForever' as const, ...value })),
  fc.constantFrom<Exclude<Who, 'own'>>('self', 'live', 'dead').map((who) => ({ kind: 'place' as const, who })),
  fc.constant({ kind: 'replace' as const }),
  fc.constant({ kind: 'delete' as const }),
  fc.constant({ kind: 'age' as const }),
);

describe('withFileLock with any sequence of lock operations (#169 PBT 3)', () => {
  it('matches the design model: exclusion is kept, its own failed lock is removed, and a failed release throws', () => {
    let run = 0;
    fc.assert(fc.property(fc.array(opArb, { minLength: 1, maxLength: 12 }), (ops) => {
      // A fresh path per run, so a record left by an earlier run cannot match.
      lockPath = resolve(`orphan-pbt-${run++}.lock`);
      disk = undefined;
      temporary = undefined;
      fault = undefined;
      pendingReadFailure = false;
      const model: Model = { disk: undefined, fault: undefined };
      for (const op of ops) runOp(op, model);
    }), { numRuns: PBT_NUM_RUNS });
  });
});

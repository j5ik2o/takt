/**
 * PBT 3 (private-file-lock.ts side) of docs/design/claim-lock-release-failure.md: any sequence of
 * lock operations against `runPrivateFileExclusive` and `runPrivateFileExclusiveAsync` on a real
 * file system, compared with a model of the design (3-2, 3-3).
 *
 * - A live owner's lock and a lock this process did not record are never removed.
 * - After a release failure, the next acquisition removes the recorded lock without waiting
 *   (even with `timeoutMs: 0`), and the action runs.
 * - While `unlink` keeps failing, the next acquisition throws that error, without the action and
 *   without a timeout. A failed read of the recorded lock is thrown, as it is today (3-3), and the
 *   record is kept until a later acquisition can read and remove it.
 * - A failed release always throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';

const hooks = vi.hoisted(() => ({
  lock: '',
  fault: undefined as { kind: 'unlink' | 'read'; remaining: number } | undefined,
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const take = (kind: 'unlink' | 'read'): boolean => {
    if (hooks.fault?.kind !== kind || hooks.fault.remaining <= 0) return false;
    hooks.fault.remaining -= 1;
    return true;
  };
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (args[0] === hooks.lock && take('read')) throw Object.assign(new Error('EIO: injected read failure'), { code: 'EIO' });
      return actual.openSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (args[0] === hooks.lock && take('unlink')) throw Object.assign(new Error('EIO: injected unlink failure'), { code: 'EIO' });
      return actual.unlinkSync(...args);
    },
  };
});

import { PrivateFileLockTimeoutError, runPrivateFileExclusive, runPrivateFileExclusiveAsync } from '../shared/utils/private-file-lock.js';

const PBT_NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return 60;
})();

const DEAD_PID = 99_999_999;
type FaultKind = 'unlink' | 'read';
type Who = 'own' | 'self' | 'live' | 'dead';
type Mode = { sync: true } | { sync: false; timeoutMs: number };
type Op =
  | { kind: 'cycle'; mode: Mode }
  | { kind: 'releaseFails'; fault: FaultKind; times: number; mode: Mode }
  | { kind: 'releaseFailsForever'; fault: FaultKind; mode: Mode }
  | { kind: 'place'; who: Exclude<Who, 'own'> }
  | { kind: 'replace' }
  | { kind: 'delete' };
type Outcome = 'ok' | 'timeout' | 'unlinkError' | 'readError';

interface Model {
  disk: { who: Who; recorded: boolean } | undefined;
  fault: { kind: FaultKind; remaining: number } | undefined;
}

const directories: string[] = [];
const placedTokens = new Map<string, Exclude<Who, 'own'>>();
let clock = 0;

beforeEach(() => {
  clock = 0;
  const realNow = Date.now.bind(Date);
  // The synchronous lock waits 10 s with Atomics.wait: move a fake clock instead of blocking, in
  // steps of a second so that a wait for a live holder takes ten rounds, not a thousand.
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clock);
  vi.spyOn(Atomics, 'wait').mockImplementation(() => {
    clock += 1_000;
    return 'timed-out';
  });
});

afterEach(() => {
  hooks.fault = undefined;
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function consume(model: Model, kind: FaultKind): boolean {
  if (model.fault?.kind !== kind || model.fault.remaining <= 0) return false;
  model.fault.remaining -= 1;
  return true;
}

/** One acquisition, the action, and the release, as the design defines them. */
function modelAcquire(model: Model, mode: Mode, arm?: { kind: FaultKind; remaining: number }): { outcome: Outcome; action: boolean } {
  let rounds = 0;
  while (true) {
    if (model.disk === undefined) {
      model.disk = { who: 'own', recorded: false };
      break;
    }
    const current = model.disk;
    let removedOwn = false;
    if (current.who === 'own' && current.recorded) {
      if (consume(model, 'read')) return { outcome: 'readError', action: false };
      if (consume(model, 'unlink')) return { outcome: 'unlinkError', action: false };
      model.disk = undefined;
      removedOwn = true;
    } else if (current.who === 'dead') {
      model.disk = undefined;
    }
    if (removedOwn) continue;
    // The asynchronous lock checks its deadline before it waits; the synchronous one waits 10 s.
    if (!mode.sync && mode.timeoutMs === 0) return { outcome: 'timeout', action: false };
    rounds += 1;
    if (current.who === 'live' || current.who === 'self') return { outcome: 'timeout', action: false };
    if (rounds > 2) throw new Error('model did not settle');
  }
  if (arm !== undefined) model.fault = { ...arm };
  if (consume(model, 'read')) {
    model.disk!.recorded = true;
    return { outcome: 'readError', action: true };
  }
  if (consume(model, 'unlink')) {
    model.disk!.recorded = true;
    return { outcome: 'unlinkError', action: true };
  }
  model.disk = undefined;
  return { outcome: 'ok', action: true };
}

function who(lock: string): Who | undefined {
  if (!existsSync(lock)) return undefined;
  const token = (JSON.parse(readFileSync(lock, 'utf8')) as { token: string }).token;
  return placedTokens.get(token) ?? 'own';
}

function place(lock: string, holder: Exclude<Who, 'own'>): void {
  const token = `${holder}-${placedTokens.size}`;
  placedTokens.set(token, holder);
  const pid = holder === 'self' ? process.pid : holder === 'live' ? process.ppid : DEAD_PID;
  if (existsSync(lock)) unlinkSync(lock);
  writeFileSync(lock, JSON.stringify({ pid, token }), { mode: 0o600 });
}

function classify(error: unknown): Outcome {
  if (error instanceof PrivateFileLockTimeoutError) return 'timeout';
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('injected unlink failure')) return 'unlinkError';
  if (message.includes('injected read failure')) return 'readError';
  throw error;
}

async function runOp(lock: string, op: Op, model: Model): Promise<void> {
  // Changing the file from outside heals the faults first, so the change itself is not failed.
  if (op.kind === 'place' || op.kind === 'replace' || op.kind === 'delete') {
    hooks.fault = undefined;
    model.fault = undefined;
  }
  switch (op.kind) {
    case 'place':
      place(lock, op.who);
      model.disk = { who: op.who, recorded: false };
      return;
    case 'replace':
      if (!existsSync(lock)) return;
      place(lock, 'self');
      model.disk = { who: 'self', recorded: false };
      return;
    case 'delete':
      if (existsSync(lock)) unlinkSync(lock);
      model.disk = undefined;
      return;
  }
  const arm = op.kind === 'cycle' ? undefined
    : { kind: op.fault, remaining: op.kind === 'releaseFails' ? op.times : Number.POSITIVE_INFINITY };
  const expected = modelAcquire(model, op.mode, arm);
  const before = who(lock);
  const beforeContent = existsSync(lock) ? readFileSync(lock, 'utf8') : undefined;
  const action = vi.fn(() => { if (arm !== undefined) hooks.fault = { ...arm }; return 1; });
  let outcome: Outcome = 'ok';
  try {
    if (op.mode.sync) runPrivateFileExclusive(lock, action);
    else await runPrivateFileExclusiveAsync(lock, action, { timeoutMs: op.mode.timeoutMs });
  } catch (error) {
    outcome = classify(error);
  }
  expect({ op, outcome, action: action.mock.calls.length === 1 }).toEqual({ op, outcome: expected.outcome, action: expected.action });
  // Read the lock with the faults off, then put them back.
  const fault = hooks.fault;
  hooks.fault = undefined;
  expect({ op, disk: who(lock) }).toEqual({ op, disk: model.disk?.who });
  if (before === 'live' || before === 'self') expect(readFileSync(lock, 'utf8')).toBe(beforeContent);
  hooks.fault = fault;
}

const modeArb: fc.Arbitrary<Mode> = fc.oneof(
  fc.constant({ sync: true as const }),
  fc.constantFrom(0, 30).map((timeoutMs) => ({ sync: false as const, timeoutMs })),
);
const faultArb = fc.constantFrom<FaultKind>('unlink', 'read');
const opArb: fc.Arbitrary<Op> = fc.oneof(
  modeArb.map((mode) => ({ kind: 'cycle' as const, mode })),
  fc.record({ fault: faultArb, times: fc.integer({ min: 1, max: 3 }), mode: modeArb })
    .map((value) => ({ kind: 'releaseFails' as const, ...value })),
  fc.record({ fault: faultArb, mode: modeArb }).map((value) => ({ kind: 'releaseFailsForever' as const, ...value })),
  fc.constantFrom<Exclude<Who, 'own'>>('self', 'live', 'dead').map((holder) => ({ kind: 'place' as const, who: holder })),
  fc.constant({ kind: 'replace' as const }),
  fc.constant({ kind: 'delete' as const }),
);

describe('private file locks with any sequence of lock operations (#169 PBT 3)', () => {
  it('matches the design model: exclusion is kept, its own failed lock is removed, and a failed release throws', async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 10 }), async (ops) => {
      const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-pbt-'));
      directories.push(directory);
      const lock = join(directory, 'lock');
      hooks.lock = lock;
      hooks.fault = undefined;
      const model: Model = { disk: undefined, fault: undefined };
      for (const op of ops) await runOp(lock, op, model);
    }), { numRuns: PBT_NUM_RUNS });
  });
});

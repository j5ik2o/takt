import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { resolve } from 'node:path';
import {
  getProcessIdentity, getSelfProcessIdentity, hasProcessIdentityMismatch, isProcessAlive,
  type ProcessIdentity,
} from '../task/process.js';

const RETRY_MS = 25;
const TIMEOUT_MS = 5_000;
const STALE_MS = 30_000;
const LOCK_TIMEOUT_MESSAGE_PREFIX = 'File lock: timed out waiting for lock';
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const heldLocks = new Set<string>();

export function isFileLockTimeoutError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith(LOCK_TIMEOUT_MESSAGE_PREFIX);
}

interface LockOwner {
  readonly pid: number;
  readonly processIdentity: ProcessIdentity | undefined;
}

interface LockSnapshot {
  readonly stat: Stats;
  readonly content: string | undefined;
  readonly readError?: unknown;
}

const orphanedLocks = new Map<string, LockSnapshot>();

export type FileLockAcquisitionErrorHandler = (error: unknown) => never;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function parseOwner(content: string | undefined): LockOwner | undefined {
  if (content === undefined) return undefined;
  const trimmed = content.trim();
  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, processIdentity: undefined } : undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0) return undefined;
  const identity = raw.processIdentity;
  if (identity === undefined) {
    // FileAsyncLock records the same start time at the top level ({ pid, startTime, token });
    // it proves PID reuse exactly as the nested form does.
    if (typeof raw.startTime === 'string' && raw.startTime.trim().length > 0) {
      return { pid: raw.pid as number, processIdentity: { startTime: raw.startTime } };
    }
    // An unavailable OS inspector leaves identity unknown, just as for execution locks.
    return { pid: raw.pid as number, processIdentity: undefined };
  }
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)
    || !('startTime' in identity) || typeof identity.startTime !== 'string'
    || identity.startTime.trim().length === 0) return undefined;
  return { pid: raw.pid as number, processIdentity: { startTime: identity.startTime } };
}

function readSnapshot(lockPath: string): LockSnapshot | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'r');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    if (!hasCode(error, 'EACCES') && !hasCode(error, 'EPERM') && !hasCode(error, 'EIO')) throw error;
    const stat = statSync(lockPath, { throwIfNoEntry: false });
    return stat === undefined ? undefined : { stat, content: undefined, readError: error };
  }
  try {
    const stat = fstatSync(descriptor);
    let content: string | undefined;
    let readError: unknown;
    try {
      content = readFileSync(descriptor, 'utf8');
    } catch (error) {
      // An unreadable record is recoverable only after the stale threshold.
      content = undefined;
      readError = error;
    }
    return readError === undefined ? { stat, content } : { stat, content, readError };
  } finally {
    closeSync(descriptor);
  }
}

function unlinkSnapshot(lockPath: string, expected: LockSnapshot): void {
  const current = readSnapshot(lockPath);
  if (current === undefined || current.stat.dev !== expected.stat.dev
    || current.stat.ino !== expected.stat.ino || current.content !== expected.content) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

function releaseLock(lockPath: string, acquired: LockSnapshot): void {
  const current = readSnapshot(lockPath);
  if (current === undefined) return;
  if (current.stat.dev !== acquired.stat.dev || current.stat.ino !== acquired.stat.ino) return;
  if (current.readError !== undefined) throw current.readError;
  if (current.content !== acquired.content) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

type RecordedLockRemoval = 'removed' | 'wait' | 'different';

function removeRecordedLock(lockPath: string, record: LockSnapshot): RecordedLockRemoval {
  const key = resolve(lockPath);
  const current = readSnapshot(lockPath);
  if (current === undefined) {
    orphanedLocks.delete(key);
    return 'removed';
  }
  if (current.stat.dev !== record.stat.dev || current.stat.ino !== record.stat.ino) {
    orphanedLocks.delete(key);
    return 'different';
  }
  if (current.readError !== undefined) return 'wait';
  if (current.content !== record.content) {
    orphanedLocks.delete(key);
    return 'different';
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  orphanedLocks.delete(key);
  return 'removed';
}

function recoverStaleLock(lockPath: string): boolean {
  const snapshot = readSnapshot(lockPath);
  const key = resolve(lockPath);
  const record = orphanedLocks.get(key);
  if (snapshot === undefined) {
    if (record !== undefined) {
      orphanedLocks.delete(key);
      return true;
    }
    return false;
  }
  if (record !== undefined) {
    if (snapshot.stat.dev !== record.stat.dev || snapshot.stat.ino !== record.stat.ino
      || (snapshot.readError === undefined && snapshot.content !== record.content)) {
      orphanedLocks.delete(key);
    } else if (snapshot.readError === undefined) {
      // The first read matches the record; removeRecordedLock re-reads once, just before unlink.
      const removal = removeRecordedLock(lockPath, record);
      if (removal === 'removed') return true;
      if (removal === 'wait') return false;
      // 'different': the record is already dropped; fall through with the first snapshot.
    }
    // An unreadable recorded file keeps its record and follows the normal rule below
    // with the snapshot already read (no re-read in the same round).
  }
  const owner = parseOwner(snapshot.content);
  if (owner !== undefined) {
    if (isRecordedProcessAlive(owner.pid, owner.processIdentity)) return false;
  } else if (Date.now() - snapshot.stat.mtimeMs <= STALE_MS) {
    return false;
  }
  // 死んだ持ち主の回収と新しい取得が、再確認と削除の間で重なる窓は残る。
  // ローカルのツールとしてこの窓を受け入れ、保護を保証するテストは削除した。
  unlinkSnapshot(lockPath, snapshot);
  return false;
}

function acquireLock(lockPath: string, content: string, timeoutMs: number): LockSnapshot {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const temporaryPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      try {
        writeFileSync(descriptor, content, 'utf8');
        const snapshot = { stat: fstatSync(descriptor), content };
        // A killed writer must never publish a lock without its owner record.
        // link is exclusive like 'wx'; rename would replace an existing holder.
        linkSync(temporaryPath, lockPath);
        orphanedLocks.delete(resolve(lockPath));
        return snapshot;
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      if (recoverStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`${LOCK_TIMEOUT_MESSAGE_PREFIX}: ${lockPath}`);
      }
      Atomics.wait(waitBuffer, 0, 0, Math.min(RETRY_MS, deadline - Date.now()));
    } finally {
      try { unlinkSync(temporaryPath); } catch {
        // An unpublished temporary file must not hide an acquisition error.
      }
    }
  }
}

export function isRecordedProcessAlive(pid: number, processIdentity: ProcessIdentity | undefined): boolean {
  return isProcessAlive(pid)
    && !hasProcessIdentityMismatch(processIdentity, getProcessIdentity(pid));
}

export function withFileLock<T>(
  lockPath: string, action: () => T,
  options?: { timeoutMs?: number; onAcquisitionError?: FileLockAcquisitionErrorHandler },
): T {
  const resolvedPath = resolve(lockPath);
  if (heldLocks.has(resolvedPath)) throw new Error(`File lock: reentrant lock detected: ${lockPath}`);
  heldLocks.add(resolvedPath);
  try {
    const content = JSON.stringify({ pid: process.pid, processIdentity: getSelfProcessIdentity() });
    let acquired: LockSnapshot;
    try {
      acquired = acquireLock(resolvedPath, content, options?.timeoutMs ?? TIMEOUT_MS);
    } catch (error) {
      if (options?.onAcquisitionError) options.onAcquisitionError(error);
      throw error;
    }
    let result!: T;
    let actionFailed = false;
    let actionError: unknown;
    try {
      result = action();
    } catch (error) {
      actionFailed = true;
      actionError = error;
    }
    try {
      releaseLock(resolvedPath, acquired);
    } catch (releaseError) {
      orphanedLocks.set(resolvedPath, acquired);
      if (actionFailed) {
        throw new AggregateError([actionError, releaseError], 'File lock action and release both failed');
      }
      throw releaseError;
    }
    if (actionFailed) throw actionError;
    return result;
  } finally {
    heldLocks.delete(resolvedPath);
  }
}

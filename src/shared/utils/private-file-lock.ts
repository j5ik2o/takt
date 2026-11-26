import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ensurePrivateDirectory,
  PrivateArtifactContentWriteFailedError,
  PrivateArtifactPublicationConflictError,
  readPrivateFileState,
  writeNewPrivateFileWithMode,
  type PrivateFileState,
} from './private-file.js';

const LOCK_MODE = 0o600;
const LOCK_RETRY_DELAY_MS = 10;
const LOCK_TIMEOUT_MS = 10_000;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
const orphanedLocks = new Map<string, AcquiredPrivateFileLock>();

export class PrivateFileLockAcquisitionError extends Error {
  constructor(message: string, readonly code: string, readonly errno: number | undefined, options: ErrorOptions) {
    super(message, options);
  }
}

export interface PrivateFileExclusiveAsyncOptions {
  timeoutMs?: number;
  onWait?: () => void;
}

interface LockHolder {
  pid: number;
  token: string;
}

interface AcquiredPrivateFileLock {
  state: Extract<PrivateFileState, { exists: true }>;
  content: string;
}

function waitForLock(): void {
  Atomics.wait(lockWaitBuffer, 0, 0, LOCK_RETRY_DELAY_MS);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function parseLockHolder(content: string): LockHolder | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null
      || typeof parsed !== 'object'
      || !Number.isSafeInteger((parsed as Record<string, unknown>).pid)
      || typeof (parsed as Record<string, unknown>).token !== 'string') {
      return undefined;
    }
    return parsed as LockHolder;
  } catch {
    return undefined;
  }
}

function sameState(
  left: Extract<PrivateFileState, { exists: true }>,
  right: Extract<PrivateFileState, { exists: true }>,
): boolean {
  return left.stat.dev === right.stat.dev
    && left.stat.ino === right.stat.ino
    && left.contentSha256 === right.contentSha256;
}

function removeLockIfUnchanged(
  lockPath: string,
  expected: AcquiredPrivateFileLock,
): boolean {
  let observed: AcquiredPrivateFileLock | undefined;
  for (let verification = 0; verification < 2; verification += 1) {
    const current = readPrivateFileState(lockPath);
    if (!current.state.exists
      || !('content' in current)) {
      return false;
    }
    const snapshot: AcquiredPrivateFileLock = {
      state: current.state,
      content: current.content.toString('utf-8'),
    };
    // #169: the two verification reads disagreeing with each other means the lock
    // was replaced while release was reading it, which is a publication conflict.
    // A lock that already differed before release started reads back consistently,
    // so it still takes the plain ownership-changed path below.
    if (observed !== undefined
      && (!sameState(observed.state, snapshot.state) || observed.content !== snapshot.content)) {
      throw new PrivateArtifactPublicationConflictError(
        `Private file lock changed while it was being released: ${lockPath}`,
      );
    }
    observed = snapshot;
    if (!sameState(expected.state, snapshot.state)
      || snapshot.content !== expected.content) {
      if (verification === 1) return false;
    }
  }
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function recoverUnchangedDeadHolder(lockPath: string): boolean {
  const key = resolve(lockPath);
  const record = orphanedLocks.get(key);
  const current = readPrivateFileState(lockPath);
  if (!current.state.exists) {
    if (record !== undefined) orphanedLocks.delete(key);
    return false;
  }
  if (!('content' in current)) {
    throw new Error(`Private file lock content is missing: ${lockPath}`);
  }
  const content = current.content.toString('utf-8');
  if (record !== undefined) {
    if (sameState(record.state, current.state) && content === record.content) {
      if (removeLockIfUnchanged(lockPath, record)) {
        orphanedLocks.delete(key);
        return true;
      }
      orphanedLocks.delete(key);
      return false;
    }
    orphanedLocks.delete(key);
  }
  const holder = parseLockHolder(content);
  if (holder === undefined || isProcessAlive(holder.pid)) {
    return false;
  }
  removeLockIfUnchanged(lockPath, { state: current.state, content });
  return false;
}

interface TryAcquireResult {
  acquired?: AcquiredPrivateFileLock;
  removedOwn?: boolean;
}

function tryAcquirePrivateFileLock(lockPath: string): TryAcquireResult {
  const holder: LockHolder = { pid: process.pid, token: randomUUID() };
  const content = JSON.stringify(holder);
  try {
    try {
      writeNewPrivateFileWithMode(lockPath, content, LOCK_MODE);
    } catch (error) {
      // Only a failed unpublished temporary artifact is safe to retry.
      if (((error as NodeJS.ErrnoException).code === 'ENOSPC')
        || error instanceof PrivateArtifactContentWriteFailedError) {
        throw new PrivateFileLockAcquisitionError(error instanceof Error ? error.message : String(error), 'ENOSPC', (error as NodeJS.ErrnoException).errno, { cause: error });
      }
      throw error;
    }
    const acquired = readPrivateFileState(lockPath);
    if (!acquired.state.exists
      || !('content' in acquired)
      || acquired.content.toString('utf-8') !== content) {
      throw new Error(`Private file lock identity changed after acquisition: ${lockPath}`);
    }
    orphanedLocks.delete(resolve(lockPath));
    return { acquired: { state: acquired.state, content } };
  } catch (error) {
    if (!(error instanceof PrivateArtifactPublicationConflictError)
      && !String(error).includes('already exists')) {
      throw error;
    }
  }
  let removedOwn = false;
  try { removedOwn = recoverUnchangedDeadHolder(lockPath); } catch (error) {
    // A holder can release the lock between the recovery snapshot's stat and open.
    if (!(error instanceof PrivateArtifactPublicationConflictError)
      && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { removedOwn };
}

/** The lock was not acquired before its deadline; nothing ran under it. */
export class PrivateFileLockTimeoutError extends Error {
  constructor(readonly lockPath: string) {
    super(`Timed out waiting for private file lock: ${lockPath}`);
  }
}

function assertLockDeadline(lockPath: string, deadline: number): void {
  if (Date.now() >= deadline) {
    throw new PrivateFileLockTimeoutError(lockPath);
  }
}

function acquirePrivateFileLock(lockPath: string): AcquiredPrivateFileLock {
  ensurePrivateDirectory(dirname(lockPath));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    const result = tryAcquirePrivateFileLock(lockPath);
    if (result.acquired !== undefined) return result.acquired;
    if (result.removedOwn) continue;
    assertLockDeadline(lockPath, deadline);
    waitForLock();
  }
}

/** Wait without blocking other users of the same file in this process. */
export async function runPrivateFileExclusiveAsync<Result>(
  lockPath: string,
  action: () => Result | PromiseLike<Result>,
  options: PrivateFileExclusiveAsyncOptions = {},
): Promise<Result> {
  ensurePrivateDirectory(dirname(lockPath));
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  while (true) {
    const result = tryAcquirePrivateFileLock(lockPath);
    if (result.acquired !== undefined) return runWithAcquiredLockAsync(lockPath, result.acquired, action);
    if (result.removedOwn) continue;
    assertLockDeadline(lockPath, deadline);
    options.onWait?.();
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_DELAY_MS));
  }
}

export function runPrivateFileExclusive<Result>(
  lockPath: string,
  action: () => Result,
): Result {
  const acquired = acquirePrivateFileLock(lockPath);
  return runWithAcquiredLock(lockPath, acquired, action);
}

function releasePrivateFileLock(
  lockPath: string,
  acquired: AcquiredPrivateFileLock,
): unknown {
  let removed: boolean;
  try {
    removed = removeLockIfUnchanged(lockPath, acquired);
  } catch (error) {
    if (!(error instanceof PrivateArtifactPublicationConflictError)) {
      orphanedLocks.set(resolve(lockPath), acquired);
    }
    return error;
  }
  if (!removed) {
    return new Error(`Private file lock ownership changed before release: ${lockPath}`);
  }
  return undefined;
}

function combineLockActionErrors(
  lockPath: string,
  actionFailed: boolean,
  actionError: unknown,
  releaseError: unknown,
): never | undefined {
  const releaseFailed = releaseError !== undefined;
  if (actionFailed && releaseFailed) {
    throw new AggregateError(
      [actionError, releaseError],
      `Private file action and lock release both failed: ${lockPath}`,
    );
  }
  if (actionFailed) {
    throw actionError;
  }
  if (releaseFailed) {
    throw releaseError;
  }
  return undefined;
}

function runWithAcquiredLock<Result>(
  lockPath: string,
  acquired: AcquiredPrivateFileLock,
  action: () => Result,
): Result {
  let result!: Result;
  let actionFailed = false;
  let actionError: unknown;
  try {
    result = action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }
  const releaseError = releasePrivateFileLock(lockPath, acquired);
  combineLockActionErrors(lockPath, actionFailed, actionError, releaseError);
  return result;
}

async function runWithAcquiredLockAsync<Result>(
  lockPath: string,
  acquired: AcquiredPrivateFileLock,
  action: () => Result | PromiseLike<Result>,
): Promise<Result> {
  let result!: Result;
  let actionFailed = false;
  let actionError: unknown;
  try {
    result = await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }
  const releaseError = releasePrivateFileLock(lockPath, acquired);
  combineLockActionErrors(lockPath, actionFailed, actionError, releaseError);
  return result;
}

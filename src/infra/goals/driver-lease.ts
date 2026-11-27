import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isRecordedProcessAlive } from '../fs/file-lock.js';
import { getSelfProcessIdentity, type ProcessIdentity } from '../task/process.js';
import {
  ensurePrivateDirectory, PrivateArtifactPublicationConflictError, writeNewPrivateFileWithMode,
} from '../../shared/utils/private-file.js';
import { createLogger } from '../../shared/utils/debug.js';

const log = createLogger('goal-driver-lease');

export type GoalDriver = 'manager' | 'external';
export type GoalDriverOperation = 'pause' | 'resume' | 'abort' | 'finish';

interface DriverLeaseRecord {
  readonly driver: GoalDriver;
  readonly operation: GoalDriverOperation;
  readonly pid: number;
  readonly processStartTime?: string;
  readonly startedAt: string;
  readonly token: string;
}

const orphanedLeases = new Map<string, string>();

function leasePath(cwd: string, goalId: string): string {
  return join(cwd, '.takt', 'goals', goalId, 'driver.json');
}

function parseLease(content: string): DriverLeaseRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if ((raw.driver !== 'manager' && raw.driver !== 'external')
    || (raw.operation !== 'pause' && raw.operation !== 'resume' && raw.operation !== 'abort' && raw.operation !== 'finish')
    || !Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0
    || typeof raw.startedAt !== 'string' || raw.startedAt.length === 0
    || typeof raw.token !== 'string' || raw.token.length === 0) return undefined;
  if (raw.processStartTime !== undefined && typeof raw.processStartTime !== 'string') return undefined;
  return {
    driver: raw.driver, operation: raw.operation, pid: raw.pid as number,
    ...(typeof raw.processStartTime === 'string' ? { processStartTime: raw.processStartTime } : {}),
    startedAt: raw.startedAt, token: raw.token,
  };
}

function unreadableError(cwd: string, goalId: string): Error {
  return new Error(`Goal ${goalId} has an unreadable driver lease (.takt/goals/${goalId}/driver.json). Another TAKT process may be changing it; retry after it finishes.`);
}

function conflictError(goalId: string, lease: DriverLeaseRecord): Error {
  const holder = lease.driver === 'manager'
    ? 'the manager connection'
    : lease.pid === process.pid
      ? 'this takt-mcp server'
      : 'another takt-mcp process';
  return new Error(`Goal ${goalId} is already being changed by ${holder} (PID ${lease.pid}, ${lease.operation}, started ${lease.startedAt}). Retry after it finishes.`);
}

function readLease(path: string): { content: string; lease: DriverLeaseRecord } | undefined {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const lease = parseLease(content);
  if (lease === undefined) return undefined;
  return { content, lease };
}

function isAlive(lease: DriverLeaseRecord): boolean {
  const identity: ProcessIdentity | undefined = lease.processStartTime === undefined
    ? undefined : { startTime: lease.processStartTime };
  return isRecordedProcessAlive(lease.pid, identity);
}

function removeIfUnchanged(path: string, expectedContent: string): boolean {
  let current: string;
  try {
    current = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
  if (current !== expectedContent) return false;
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return true;
}

function acquire(cwd: string, goalId: string, driver: GoalDriver, operation: GoalDriverOperation): DriverLeaseRecord {
  const path = leasePath(cwd, goalId);
  // Recover a lease this same process failed to release earlier.
  const orphan = orphanedLeases.get(path);
  if (orphan !== undefined) {
    try {
      if (removeIfUnchanged(path, orphan)) orphanedLeases.delete(path);
    } catch {
      // Keep the orphan recorded; the normal conflict path below stays fail-closed.
    }
  }
  const identity = getSelfProcessIdentity();
  const record: DriverLeaseRecord = {
    driver, operation, pid: process.pid,
    ...(identity === undefined ? {} : { processStartTime: identity.startTime }),
    startedAt: new Date().toISOString(), token: randomUUID(),
  };
  const content = JSON.stringify(record);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ensurePrivateDirectory(join(cwd, '.takt', 'goals', goalId));
      writeNewPrivateFileWithMode(path, content, 0o600);
      return record;
    } catch (error) {
      if (!(error instanceof PrivateArtifactPublicationConflictError)) throw error;
      // A lease file exists. Distinguish live, dead, and unreadable holders.
      let existingContent: string;
      try {
        existingContent = readFileSync(path, 'utf8');
      } catch (readError) {
        if (readError instanceof Error && 'code' in readError && readError.code === 'ENOENT') continue;
        throw unreadableError(cwd, goalId);
      }
      const existing = parseLease(existingContent);
      if (existing === undefined) throw unreadableError(cwd, goalId);
      if (isAlive(existing)) throw conflictError(goalId, existing);
      // Dead holder: remove only if unchanged on re-read, then retry once.
      if (attempt === 0 && removeIfUnchanged(path, existingContent)) continue;
      if (attempt === 0) {
        // Content changed while checking; re-evaluate once against the new holder.
        const fresh = readLease(path);
        if (fresh === undefined) continue;
        if (isAlive(fresh.lease)) throw conflictError(goalId, fresh.lease);
        throw conflictError(goalId, fresh.lease);
      }
      throw conflictError(goalId, existing);
    }
  }
  throw new Error(`Goal ${goalId} driver lease could not be acquired.`);
}

function release(cwd: string, goalId: string, record: DriverLeaseRecord): void {
  const path = leasePath(cwd, goalId);
  const content = JSON.stringify(record);
  let current: string;
  try {
    current = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (current !== content) {
    // Only the recorded content may differ in formatting for our own token.
    const parsed = parseLease(current);
    if (parsed === undefined || parsed.token !== record.token) return;
  }
  unlinkSync(path);
}

export async function withGoalDriverLease<T>(
  cwd: string, goalId: string, driver: GoalDriver, operation: GoalDriverOperation,
  signal: AbortSignal, action: () => Promise<T> | T,
): Promise<T> {
  signal.throwIfAborted();
  const record = acquire(cwd, goalId, driver, operation);
  const path = leasePath(cwd, goalId);
  let result!: T;
  let actionFailed = false;
  let actionError: unknown;
  try {
    result = await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }
  try {
    release(cwd, goalId, record);
  } catch (releaseError) {
    orphanedLeases.set(path, JSON.stringify(record));
    log.warn('Failed to release goal driver lease', { path, error: String(releaseError) });
    if (actionFailed) throw actionError;
    return result;
  }
  if (actionFailed) throw actionError;
  return result;
}

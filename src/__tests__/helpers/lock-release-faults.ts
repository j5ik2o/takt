/**
 * Lock release faults after a tasks.yaml write (#169), injected through a `node:fs` mock.
 *
 * A test arms faults with `armAfterWrite`. They start when tasks.yaml is next published (its rename),
 * that is, after the write and before the two locks around it are released. Each armed fault then
 * fails its operation `times` times (`Infinity` keeps failing until `heal`).
 *
 * Use it from a `vi.mock('node:fs', ...)` factory, with the state made by `vi.hoisted`:
 *
 *   const faults = vi.hoisted(() => ({ armed: [], times: 1, active: new Map(), failingReads: new Set() }) as LockReleaseFaultState);
 *   vi.mock('node:fs', async (original) => (await import('./helpers/lock-release-faults.js'))
 *     .withLockReleaseFaults(await original<typeof import('node:fs')>(), faults));
 *
 * This module imports `node:fs` only as a type, so the factory can load it.
 */

import type * as Fs from 'node:fs';
import { dirname, join, sep } from 'node:path';

export type LockReleaseFault =
  | 'tasks-unlink-EIO'
  | 'tasks-unlink-EACCES'
  | 'tasks-open-EACCES'
  | 'tasks-read-EIO'
  | 'goal-unlink-EIO'
  | 'goal-ownership';

/** Every way a release can fail after the write, as listed in PBT 1 of the design. */
export const LOCK_RELEASE_FAULTS: readonly LockReleaseFault[] = [
  'tasks-unlink-EIO', 'tasks-unlink-EACCES', 'tasks-open-EACCES', 'tasks-read-EIO', 'goal-unlink-EIO', 'goal-ownership',
];

/** The faults of `tasks.yaml.lock` alone (`failInterruptedRunningTasks` does not take goal-execution.lock). */
export const TASKS_LOCK_RELEASE_FAULTS: readonly LockReleaseFault[] = [
  'tasks-unlink-EIO', 'tasks-unlink-EACCES', 'tasks-open-EACCES', 'tasks-read-EIO',
];

export interface LockReleaseFaultState {
  armed: LockReleaseFault[];
  times: number;
  active: Map<LockReleaseFault, number>;
  failingReads: Set<number>;
  /** Fails taking tasks.yaml.lock itself (EACCES on its temporary file): a failure before the write. */
  failAcquisition?: boolean;
}

/** A PID no process has: the goal-execution.lock that replaces this process's lock is recovered as dead. */
export const DEAD_HOLDER_PID = 99_999_999;

export function emptyLockReleaseFaults(): LockReleaseFaultState {
  return { armed: [], times: 1, active: new Map(), failingReads: new Set() };
}

export function armAfterWrite(state: LockReleaseFaultState, faults: readonly LockReleaseFault[], times = 1): void {
  state.armed = [...faults];
  state.times = times;
}

export function healLockReleaseFaults(state: LockReleaseFaultState): void {
  state.armed = [];
  state.active.clear();
  state.failingReads.clear();
  state.failAcquisition = false;
}

function fsError(code: string, syscall: string, path: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected failure, ${syscall} '${String(path)}'`), { code, syscall });
}

function lockOf(path: unknown): 'tasks' | 'goal' | undefined {
  const value = String(path);
  if (value.endsWith(`${sep}.takt${sep}tasks.yaml.lock`)) return 'tasks';
  if (value.endsWith(`${sep}.takt${sep}goal-execution.lock`)) return 'goal';
  return undefined;
}

export function withLockReleaseFaults(actual: typeof Fs, state: LockReleaseFaultState): typeof Fs {
  const take = (fault: LockReleaseFault): boolean => {
    const remaining = state.active.get(fault) ?? 0;
    if (remaining <= 0) return false;
    state.active.set(fault, remaining - 1);
    return true;
  };
  const renameSync = (...args: Parameters<typeof Fs.renameSync>): void => {
    actual.renameSync(...args);
    const [, to] = args;
    if (!String(to).endsWith(`${sep}.takt${sep}tasks.yaml`) || state.armed.length === 0) return;
    for (const fault of state.armed.splice(0)) {
      if (fault === 'goal-ownership') {
        // Another holder replaced goal-execution.lock: release finds its ownership changed.
        const lock = join(dirname(String(to)), 'goal-execution.lock');
        actual.unlinkSync(lock);
        actual.writeFileSync(lock, JSON.stringify({ pid: DEAD_HOLDER_PID, token: 'replacement-holder' }), { mode: 0o600 });
      } else {
        state.active.set(fault, state.times);
      }
    }
  };
  const unlinkSync = (...args: Parameters<typeof Fs.unlinkSync>): void => {
    const [path] = args;
    const lock = lockOf(path);
    if (lock === 'tasks') {
      if (take('tasks-unlink-EIO')) throw fsError('EIO', 'unlink', path);
      if (take('tasks-unlink-EACCES')) throw fsError('EACCES', 'unlink', path);
    }
    if (lock === 'goal' && take('goal-unlink-EIO')) throw fsError('EIO', 'unlink', path);
    actual.unlinkSync(...args);
  };
  const openSync = (...args: Parameters<typeof Fs.openSync>): number => {
    const [path, flags] = args;
    if (state.failAcquisition === true && flags === 'wx' && /tasks\.yaml\.lock\..+\.tmp$/.test(String(path))) {
      throw fsError('EACCES', 'open', path);
    }
    if (lockOf(path) !== 'tasks' || flags !== 'r') return actual.openSync(...args);
    if (take('tasks-open-EACCES')) throw fsError('EACCES', 'open', path);
    const descriptor = actual.openSync(...args);
    if (take('tasks-read-EIO')) state.failingReads.add(descriptor);
    return descriptor;
  };
  const readFileSync = ((...args: unknown[]): unknown => {
    const [source] = args;
    if (typeof source === 'number' && state.failingReads.delete(source)) throw fsError('EIO', 'read', source);
    return (actual.readFileSync as (...values: unknown[]) => unknown)(...args);
  }) as typeof Fs.readFileSync;
  return { ...actual, renameSync, unlinkSync, openSync, readFileSync };
}

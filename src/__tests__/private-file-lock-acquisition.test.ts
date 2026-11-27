import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
const write = vi.hoisted(() => vi.fn());
const beforeOpen = vi.hoisted(() => vi.fn<(path: unknown) => void>());
const beforeUnlink = vi.hoisted(() => vi.fn<(path: unknown) => void>());
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    beforeOpen(args[0]);
    return actual.openSync(...args);
  }, unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
    beforeUnlink(args[0]);
    return actual.unlinkSync(...args);
  } };
});
vi.mock('../shared/utils/private-file.js', async (original) => ({
  ...await original<typeof import('../shared/utils/private-file.js')>(),
  writeNewPrivateFileWithMode: write,
}));
import { PrivateFileLockAcquisitionError, PrivateFileLockTimeoutError, runPrivateFileExclusive, runPrivateFileExclusiveAsync } from '../shared/utils/private-file-lock.js';
import { PrivateArtifactContentWriteFailedError, PrivateArtifactPublicationConflictError } from '../shared/utils/private-file.js';
const directories: string[] = [];
afterEach(() => {
  write.mockReset();
  beforeOpen.mockReset();
  beforeUnlink.mockReset();
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe('private lock acquisition failures', () => {
  it.each(['creation', 'content'] as const)('classifies unpublished ENOSPC at %s and does not run the action', (stage) => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
    directories.push(directory);
    const source = stage === 'content' ? new PrivateArtifactContentWriteFailedError('disk full', -28, {})
      : Object.assign(new Error('disk full'), { code: 'ENOSPC', errno: -28 });
    write.mockImplementation(() => { throw source; });
    const action = vi.fn();
    expect(() => runPrivateFileExclusive(join(directory, 'lock'), action)).toThrow(PrivateFileLockAcquisitionError);
    expect(action).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual([]);
  });
  it('preserves unrelated acquisition failures', () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
    directories.push(directory);
    const source = Object.assign(new Error('denied'), { code: 'EACCES' });
    write.mockImplementation(() => { throw source; });
    expect(() => runPrivateFileExclusive(join(directory, 'lock'), () => 42)).toThrow(source);
  });

  it.each((['sync', 'async'] as const).flatMap((mode) => [1, 2, 3].map((read) => ({ mode, read }))))(
    'acquires the $mode lock when it disappears between stat and open on recovery read $read', async ({ mode, read }) => {
      const actual = await vi.importActual<typeof import('../shared/utils/private-file.js')>('../shared/utils/private-file.js');
      write.mockImplementation(actual.writeNewPrivateFileWithMode);
      const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
      directories.push(directory);
      const lock = join(directory, 'lock');
      const previous = JSON.stringify({ pid: process.pid, token: 'previous-holder' });
      writeFileSync(lock, previous);
      if (read > 1) vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('dead holder'), { code: 'ESRCH' });
      });
      let released = false;
      let reads = 0;
      beforeOpen.mockImplementation((path) => {
        if (path === lock && ++reads === read) {
          released = true;
          unlinkSync(lock);
        }
      });
      const action = vi.fn(() => {
        expect(released).toBe(true);
        expect(readFileSync(lock, 'utf8')).not.toBe(previous);
        return 42;
      });
      const result = mode === 'sync' ? runPrivateFileExclusive(lock, action) : await runPrivateFileExclusiveAsync(lock, action);
      expect(result).toBe(42);
      expect(action).toHaveBeenCalledOnce();
      expect(readdirSync(directory)).toEqual([]);
    },
  );

  it('keeps a replacement lock and does not enter the action during dead-holder recovery', async () => {
    const actual = await vi.importActual<typeof import('../shared/utils/private-file.js')>('../shared/utils/private-file.js');
    write.mockImplementation(actual.writeNewPrivateFileWithMode);
    const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
    directories.push(directory);
    const lock = join(directory, 'lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'dead-holder' }));
    const replacement = JSON.stringify({ pid: process.pid, token: 'replacement-holder' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      unlinkSync(lock);
      writeFileSync(lock, replacement);
      throw Object.assign(new Error('dead holder'), { code: 'ESRCH' });
    });
    const action = vi.fn();
    await expect(runPrivateFileExclusiveAsync(lock, action, { timeoutMs: 0 })).rejects.toThrow('Timed out');
    expect(readFileSync(lock, 'utf8')).toBe(replacement);
    expect(action).not.toHaveBeenCalled();
  });

  it('propagates permission failures while inspecting a contended lock', async () => {
    const actual = await vi.importActual<typeof import('../shared/utils/private-file.js')>('../shared/utils/private-file.js');
    write.mockImplementation(actual.writeNewPrivateFileWithMode);
    const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
    directories.push(directory);
    const lock = join(directory, 'lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'holder' }));
    const source = Object.assign(new Error('denied'), { code: 'EACCES' });
    beforeOpen.mockImplementation((path) => { if (path === lock) throw source; });
    const action = vi.fn();
    await expect(runPrivateFileExclusiveAsync(lock, action, { timeoutMs: 0 })).rejects.toBe(source);
    expect(action).not.toHaveBeenCalled();
  });
});

// #169 3-2: a goal-execution.lock (or any private file lock) this process failed to release is
// recorded and removed the next time it is taken, instead of waiting for this live process.
describe('a private file lock this process failed to release (#169)', () => {
  const ioError = () => Object.assign(new Error('EIO: i/o error, unlink'), { code: 'EIO' });
  const readError = () => Object.assign(new Error('EIO: i/o error, open'), { code: 'EIO' });
  let clock = 0;

  async function lockDirectory(): Promise<string> {
    const actual = await vi.importActual<typeof import('../shared/utils/private-file.js')>('../shared/utils/private-file.js');
    write.mockImplementation(actual.writeNewPrivateFileWithMode);
    const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
    directories.push(directory);
    // The synchronous lock waits with Atomics.wait for up to 10 s: wait on a fake clock instead.
    clock = 0;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + clock);
    vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
      clock += timeout ?? 0;
      return 'timed-out';
    });
    return join(directory, 'lock');
  }

  /** Fails the next `count` unlinks of the lock file. */
  function failUnlinks(lock: string, count: number): void {
    let remaining = count;
    beforeUnlink.mockImplementation((path) => {
      if (resolve(String(path)) === lock && remaining > 0) { remaining -= 1; throw ioError(); }
    });
  }

  /** Fails the next `count` opens of the lock file for reading. */
  function failReads(lock: string, count: number): void {
    let remaining = count;
    beforeOpen.mockImplementation((path) => {
      if (resolve(String(path)) === lock && remaining > 0) { remaining -= 1; throw readError(); }
    });
  }

  function heal(): void {
    beforeUnlink.mockReset();
    beforeOpen.mockReset();
  }

  async function run(mode: 'sync' | 'async', lock: string, action: () => number, onWait?: () => void): Promise<number> {
    return mode === 'sync' ? runPrivateFileExclusive(lock, action) : runPrivateFileExclusiveAsync(lock, action, { timeoutMs: 0, onWait });
  }

  async function failure(operation: () => Promise<unknown>): Promise<unknown> {
    try {
      await operation();
    } catch (error) {
      return error;
    }
    throw new Error('the operation did not fail');
  }

  /** The next acquisition takes the lock without waiting and runs the action once. */
  async function expectTakenWithoutWaiting(mode: 'sync' | 'async', lock: string): Promise<void> {
    const onWait = vi.fn();
    const action = vi.fn(() => 42);
    const waitsBefore = vi.mocked(Atomics.wait).mock.calls.length;
    expect(await run(mode, lock, action, onWait)).toBe(42);
    expect(action).toHaveBeenCalledOnce();
    expect(onWait).not.toHaveBeenCalled();
    expect(vi.mocked(Atomics.wait).mock.calls.length).toBe(waitsBefore);
    expect(existsSync(lock)).toBe(false);
  }

  const modes = ['sync', 'async'] as const;

  it.each(modes)('%s: throws when unlink fails on release, then removes its own lock on the next acquisition without waiting', async (mode) => {
    const lock = await lockDirectory();
    const saved = vi.fn(() => { failUnlinks(lock, 1); return 1; });
    expect(await failure(() => run(mode, lock, saved))).toMatchObject({ code: 'EIO' });
    expect(saved).toHaveBeenCalledOnce();
    expect(existsSync(lock)).toBe(true);

    await expectTakenWithoutWaiting(mode, lock);
  });

  it.each(modes)('%s: throws when its own lock cannot be read on release, then removes it once readable', async (mode) => {
    const lock = await lockDirectory();
    expect(await failure(() => run(mode, lock, () => { failReads(lock, 1); return 1; }))).toMatchObject({ code: 'EIO' });
    expect(existsSync(lock)).toBe(true);

    await expectTakenWithoutWaiting(mode, lock);
  });

  it.each(modes)('%s: throws the unlink error on the next acquisition while its own lock cannot be removed', async (mode) => {
    const lock = await lockDirectory();
    await failure(() => run(mode, lock, () => { failUnlinks(lock, Number.POSITIVE_INFINITY); return 1; }));
    const action = vi.fn(() => 2);

    const error = await failure(() => run(mode, lock, action));

    expect(error).toMatchObject({ code: 'EIO' });
    expect(error).not.toBeInstanceOf(PrivateFileLockTimeoutError);
    expect(action).not.toHaveBeenCalled();
    expect(existsSync(lock)).toBe(true);
    heal();
    await expectTakenWithoutWaiting(mode, lock);
  });

  // 3-3 (再々レビュー 低-a): a failed read of goal-execution.lock still throws, as it does today.
  it.each(modes)('%s: throws a read error of its recorded lock at recovery as today, and removes the lock once readable', async (mode) => {
    const lock = await lockDirectory();
    await failure(() => run(mode, lock, () => { failUnlinks(lock, 1); return 1; }));
    failReads(lock, 1);
    const action = vi.fn(() => 2);

    expect(await failure(() => run(mode, lock, action))).toMatchObject({ code: 'EIO' });
    expect(action).not.toHaveBeenCalled();

    await expectTakenWithoutWaiting(mode, lock);
  });

  /**
   * Puts the original lock back from `aside` with its inode and token, then tries to take it. A record
   * of the original would let this acquisition remove it and run the action; without one it times out.
   */
  async function expectOriginalNotRecorded(mode: 'sync' | 'async', lock: string, aside: string): Promise<void> {
    renameSync(aside, lock);
    const original = readFileSync(lock, 'utf8');
    const action = vi.fn(() => 2);
    const next = await failure(() => mode === 'sync' ? Promise.resolve(runPrivateFileExclusive(lock, action)) : runPrivateFileExclusiveAsync(lock, action, { timeoutMs: 0 }));
    expect(next).toBeInstanceOf(PrivateFileLockTimeoutError);
    expect(action).not.toHaveBeenCalled();
    expect(readFileSync(lock, 'utf8')).toBe(original);
  }

  // CodeRabbit (PR #182): taking the lock against the replacement drops any record, because the
  // replacement never matches it, so the replacement is checked by its content and the absence of a
  // record against the original put back. The original is moved aside rather than unlinked, so the
  // replacement cannot reuse its inode.
  it.each(modes)('%s: does not record a lock whose ownership changed before release', async (mode) => {
    const lock = await lockDirectory();
    const aside = `${lock}.aside`;
    const replacement = JSON.stringify({ pid: process.pid, token: 'replacement-holder' });
    const error = await failure(() => run(mode, lock, () => { renameSync(lock, aside); writeFileSync(lock, replacement); return 1; }));
    expect(String(error)).toContain('ownership changed before release');
    expect(readFileSync(lock, 'utf8')).toBe(replacement);

    await expectOriginalNotRecorded(mode, lock, aside);
  });

  // CodeRabbit (PR #182): unlinking the original and writing the replacement let Linux reuse the
  // inode, so the release read passed its identity check and reported "ownership changed" instead of
  // the conflict. Keeping the original under another path gives the replacement a new inode.
  it.each(modes)('%s: does not record a lock that was replaced while release read it', async (mode) => {
    const lock = await lockDirectory();
    const aside = `${lock}.aside`;
    const replacement = JSON.stringify({ pid: process.pid, token: 'replacement-holder' });
    const error = await failure(() => run(mode, lock, () => {
      let replaced = false;
      beforeOpen.mockImplementation((path) => {
        if (path !== lock || replaced) return;
        replaced = true;
        renameSync(lock, aside);
        writeFileSync(lock, replacement);
      });
      return 1;
    }));
    expect(error).toBeInstanceOf(PrivateArtifactPublicationConflictError);
    heal();
    expect(readFileSync(lock, 'utf8')).toBe(replacement);

    await expectOriginalNotRecorded(mode, lock, aside);
  });

  it.each(modes)('%s: matches the record through a relative and an absolute lock path', async (mode) => {
    const lock = await lockDirectory();
    await failure(() => run(mode, relative(process.cwd(), lock), () => { failUnlinks(lock, 1); return 1; }));
    expect(existsSync(lock)).toBe(true);

    await expectTakenWithoutWaiting(mode, lock);
  });

  it.each(modes)('%s: does not remove an unrecorded lock that names this process', async (mode) => {
    const lock = await lockDirectory();
    const holder = JSON.stringify({ pid: process.pid, token: 'unrecorded-holder' });
    writeFileSync(lock, holder);
    const action = vi.fn(() => 2);

    const error = await failure(() => mode === 'sync' ? Promise.resolve(runPrivateFileExclusive(lock, action)) : runPrivateFileExclusiveAsync(lock, action, { timeoutMs: 0 }));

    expect(error).toBeInstanceOf(PrivateFileLockTimeoutError);
    expect(action).not.toHaveBeenCalled();
    expect(readFileSync(lock, 'utf8')).toBe(holder);
  });
});

import * as fs from 'node:fs';
import { resolve } from 'node:path';
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

const lockPath = resolve('test.lock');
const identity = { startTime: 'darwin-start-v2:1791244800' };
const selfContent = JSON.stringify({ pid: process.pid, processIdentity: identity });
const otherContent = JSON.stringify({ pid: 4101, processIdentity: identity });
let content: string | undefined;
let stat: fs.Stats;
let temporaryContent: string | undefined;
let temporaryStat: fs.Stats;
// Faults on the lock file itself (#169). `reads` is consumed one entry per read of the lock file
// (an open for reading, then the read): 'open' fails the open with EACCES, 'openEIO' fails the open
// with EIO, 'read' fails the read with EIO, 'ok' lets it through. Once `reads` is empty, `readForever` applies to every read.
const faults = {
  unlink: 0,
  unlinkCode: 'EIO',
  reads: [] as ('open' | 'openEIO' | 'read' | 'ok')[],
  readForever: undefined as 'open' | 'read' | undefined,
  pendingRead: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  content = undefined;
  temporaryContent = undefined;
  faults.unlink = 0;
  faults.unlinkCode = 'EIO';
  faults.reads = [];
  faults.readForever = undefined;
  faults.pendingRead = false;
  stat = { dev: 1, ino: 1, mtimeMs: Date.now() } as fs.Stats;
  vi.mocked(getSelfProcessIdentity).mockReturnValue(identity);
  vi.mocked(getProcessIdentity).mockReturnValue(identity);
  vi.mocked(isProcessAlive).mockReturnValue(true);
  vi.mocked(fs.openSync).mockImplementation((_path, flags) => {
    if (flags === 'wx') {
      temporaryContent = '';
      temporaryStat = { ...stat, ino: stat.ino + 1, mtimeMs: Date.now() } as fs.Stats;
      return 43;
    } else if (content === undefined) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    const read = faults.reads.shift() ?? faults.readForever ?? 'ok';
    if (read === 'open') throw Object.assign(new Error('denied'), { code: 'EACCES' });
    if (read === 'openEIO') throw Object.assign(new Error('i/o error, open'), { code: 'EIO' });
    faults.pendingRead = read === 'read';
    return 42;
  });
  vi.mocked(fs.statSync).mockImplementation(() => content === undefined ? undefined : stat);
  vi.mocked(fs.fstatSync).mockImplementation((fd) => fd === 43 ? temporaryStat : stat);
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    if (faults.pendingRead) {
      faults.pendingRead = false;
      throw Object.assign(new Error('i/o error'), { code: 'EIO' });
    }
    return content!;
  });
  vi.mocked(fs.writeFileSync).mockImplementation((_fd, value) => { temporaryContent = String(value); });
  vi.mocked(fs.linkSync).mockImplementation(() => {
    if (content !== undefined) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    content = temporaryContent;
    stat = temporaryStat;
  });
  vi.mocked(fs.unlinkSync).mockImplementation((path) => {
    if (path === lockPath && faults.unlink > 0) {
      faults.unlink -= 1;
      throw Object.assign(new Error(`${faults.unlinkCode}: unlink`), { code: faults.unlinkCode });
    }
    if (path === lockPath) content = undefined;
    else temporaryContent = undefined;
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

describe('withFileLock', () => {
  it.each(['create', 'metadata'] as const)('notifies only acquisition errors at %s and permits reacquisition', (stage) => {
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const converted = new Error('acquisition failed', { cause: failure });
    const onAcquisitionError = vi.fn((error: unknown): never => {
      expect(error).toBe(failure);
      throw converted;
    });
    if (stage === 'create') {
      vi.mocked(fs.openSync).mockImplementationOnce(() => { throw failure; });
    } else {
      vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { temporaryContent = '{'; throw failure; });
    }
    const action = vi.fn();

    expect(() => withFileLock(lockPath, action, { onAcquisitionError })).toThrow(converted);

    expect(onAcquisitionError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(action).not.toHaveBeenCalled();
    expect(content).toBeUndefined();
    expect(withFileLock(lockPath, () => 'recovered')).toBe('recovered');
  });

  it.each(['owner', 'action', 'release'] as const)('does not notify acquisition failure for %s errors', (stage) => {
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const onAcquisitionError = vi.fn((_error: unknown): never => { throw new Error('unexpected conversion'); });
    if (stage === 'owner') {
      vi.mocked(getSelfProcessIdentity).mockImplementationOnce(() => { throw failure; });
    } else if (stage === 'release') {
      vi.mocked(fs.unlinkSync).mockImplementation((path) => { if (path === lockPath) throw failure; });
    }
    const action = vi.fn(() => {
      if (stage === 'action') throw failure;
    });

    expect(() => withFileLock(lockPath, action, { onAcquisitionError })).toThrow(failure);

    expect(onAcquisitionError).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledTimes(stage === 'owner' ? 0 : 1);
  });

  it('preserves native acquisition ENOSPC when no handler is supplied', () => {
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    vi.mocked(fs.openSync).mockImplementationOnce(() => { throw failure; });
    expect(() => withFileLock(lockPath, vi.fn())).toThrow(failure);
  });

  it('writes the process identity with exclusive creation, returns the result, and releases', () => {
    expect(withFileLock(lockPath, () => {
      expect(content).toBe(selfContent);
      expect(fs.closeSync).toHaveBeenCalledWith(43);
      return 123;
    })).toBe(123);
    const temporaryPath = vi.mocked(fs.openSync).mock.calls[0]![0];
    expect(temporaryPath).not.toBe(lockPath);
    expect(fs.openSync).toHaveBeenCalledWith(temporaryPath, 'wx', 0o600);
    expect(fs.linkSync).toHaveBeenCalledWith(temporaryPath, lockPath);
    expect(vi.mocked(fs.writeFileSync).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fs.linkSync).mock.invocationCallOrder[0]!);
    expect(content).toBeUndefined();
  });

  it('releases its own lock when closing the write handle changes the mtime', () => {
    vi.mocked(fs.closeSync).mockImplementationOnce(() => {
      stat = { ...stat, mtimeMs: stat.mtimeMs + 1_000 } as fs.Stats;
    });

    withFileLock(lockPath, () => {
      expect(fs.closeSync).toHaveBeenCalledWith(43);
      expect(stat.mtimeMs).toBe(101_000);
      expect(content).toBe(selfContent);
    });

    expect(content).toBeUndefined();
    expect(withFileLock(lockPath, () => 'next')).toBe('next');
  });

  it('waits for another holder to release before running the action', () => {
    content = otherContent;
    vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      content = undefined;
      vi.advanceTimersByTime(25);
      return 'timed-out';
    });
    const action = vi.fn(() => {
      expect(content).toBe(selfContent);
      return 'acquired';
    });
    expect(withFileLock(lockPath, action)).toBe('acquired');
    expect(isProcessAlive).toHaveBeenCalledWith(4101);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('recovers a dead owner without waiting for the mtime threshold', () => {
    content = otherContent;
    vi.mocked(isProcessAlive).mockReturnValue(false);
    expect(withFileLock(lockPath, () => content)).toBe(selfContent);
    expect(vi.mocked(fs.unlinkSync).mock.calls.filter(([path]) => path === lockPath)).toHaveLength(2);
  });

  it('recovers a live same-PID lock whose recorded top-level start time differs', () => {
    // FileAsyncLock writes { pid, startTime, token } at the top level, while this synchronous
    // lock reads processIdentity.startTime. The recorded start time proves the PID was reused.
    content = JSON.stringify({ pid: 4101, startTime: 'darwin-start-v2:1', token: 'token-1' });
    stat = { ...stat, mtimeMs: 0 } as fs.Stats;
    vi.mocked(isProcessAlive).mockReturnValue(true);
    vi.mocked(getProcessIdentity).mockReturnValue(identity);
    const action = vi.fn(() => content);

    expect(withFileLock(lockPath, action)).toBe(selfContent);

    expect(action).toHaveBeenCalledOnce();
    expect(content).toBe(selfContent);
    expect(fs.unlinkSync).toHaveBeenCalledWith(lockPath);
  });

  it('times out after five seconds without deleting even an old live owner', () => {
    content = otherContent;
    stat = { ...stat, mtimeMs: 0 } as fs.Stats;
    const action = vi.fn();
    expect(() => withFileLock(lockPath, action)).toThrow(/timed out waiting for lock/);
    expect(Date.now()).toBe(105_000);
    expect(content).toBe(otherContent);
    expect(action).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(lockPath);
  });

  it('waits for an old live PID-only owner and recovers it once the owner dies', () => {
    const legacyContent = ' \t4101\n';
    content = legacyContent;
    stat = { ...stat, mtimeMs: 0 } as fs.Stats;
    const action = vi.fn();

    expect(() => withFileLock(lockPath, action, { timeoutMs: 25 })).toThrow(/timed out/);
    expect(content).toBe(legacyContent);
    expect(isProcessAlive).toHaveBeenCalledWith(4101);
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(lockPath);
    expect(action).not.toHaveBeenCalled();

    vi.mocked(isProcessAlive).mockReturnValue(false);
    expect(withFileLock(lockPath, () => content)).toBe(selfContent);
    expect(content).toBeUndefined();
    expect(vi.mocked(fs.unlinkSync).mock.calls.filter(([path]) => path === lockPath)).toHaveLength(2);
  });

  it.each(['{', '0\n', JSON.stringify({ pid: 0 }), JSON.stringify({ pid: 4101, processIdentity: [] })])(
    'keeps a fresh invalid record and recovers it only after the stale threshold: %s', (invalid) => {
      content = invalid;
      const action = vi.fn();
      expect(() => withFileLock(lockPath, action, { timeoutMs: 50 })).toThrow(/timed out/);
      expect(content).toBe(invalid);
      expect(action).not.toHaveBeenCalled();
      expect(isProcessAlive).not.toHaveBeenCalled();
      stat = { ...stat, mtimeMs: Date.now() - 30_001 } as fs.Stats;
      expect(withFileLock(lockPath, () => content)).toBe(selfContent);
      expect(content).toBeUndefined();
    },
  );

  it('does not remove a new holder after checking a stale snapshot', () => {
    content = otherContent;
    vi.mocked(isProcessAlive).mockImplementationOnce(() => {
      stat = { ...stat, ino: stat.ino + 1 } as fs.Stats;
      content = JSON.stringify({ pid: 4102, processIdentity: identity });
      return false;
    });
    const action = vi.fn();
    expect(() => withFileLock(lockPath, action, { timeoutMs: 25 })).toThrow(/timed out/);
    expect(JSON.parse(content!).pid).toBe(4102);
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(lockPath);
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps an unreadable fresh record and recovers it only after the stale threshold', () => {
    content = otherContent;
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('unreadable'), { code: 'EIO' });
    });
    const action = vi.fn();
    expect(() => withFileLock(lockPath, action, { timeoutMs: 25 })).toThrow(/timed out/);
    expect(content).toBe(otherContent);
    expect(action).not.toHaveBeenCalled();
    stat = { ...stat, mtimeMs: Date.now() - 30_001 } as fs.Stats;
    const recovered = vi.fn(() => 'recovered');
    // #169 3-1 (設計レビュー 高-2): 解放で読めない自分のファイルは、黙って残さずに読みの例外を投げる。
    expect(() => withFileLock(lockPath, recovered)).toThrow(expect.objectContaining({ code: 'EIO' }));
    expect(recovered).toHaveBeenCalledOnce();
    // The new owner's readable content must be confirmed before release.
    expect(content).toBe(selfContent);
    expect(vi.mocked(fs.unlinkSync).mock.calls.filter(([path]) => path === lockPath)).toHaveLength(1);
  });

  it('releases after an action throws and permits the next acquisition', () => {
    const failure = new Error('update failed');
    expect(() => withFileLock(lockPath, () => { throw failure; })).toThrow(failure);
    expect(content).toBeUndefined();
    expect(withFileLock(lockPath, () => 'next')).toBe('next');
  });

  it('leaves a different owner untouched during release', () => {
    withFileLock(lockPath, () => { content = otherContent; });
    expect(content).toBe(otherContent);
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(lockPath);
  });

  it('rejects nested acquisition of the same path without releasing the outer lock', () => {
    withFileLock(lockPath, () => {
      expect(() => withFileLock(lockPath, vi.fn())).toThrow(/reentrant lock detected/);
      expect(content).toBe(selfContent);
    });
    expect(content).toBeUndefined();
  });

  it('propagates creation errors without running the action', () => {
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.mocked(fs.openSync).mockImplementationOnce(() => { throw failure; });
    const action = vi.fn();
    expect(() => withFileLock(lockPath, action)).toThrow(failure);
    expect(action).not.toHaveBeenCalled();
  });

  it('closes and removes a partial record if writing fails', () => {
    const failure = new Error('write failed');
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { temporaryContent = '{'; throw failure; });
    const action = vi.fn();
    expect(() => withFileLock(lockPath, action)).toThrow(failure);
    expect(content).toBeUndefined();
    expect(temporaryContent).toBeUndefined();
    expect(fs.linkSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledWith(43);
    expect(action).not.toHaveBeenCalled();
  });

  it.each(['write', 'fstat', 'link'])(
    'preserves the acquisition error when temporary cleanup fails after %s', (operation) => {
      const failure = new Error('acquisition failed');
      const cleanupFailure = new Error('cleanup failed');
      if (operation === 'write') vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw failure; });
      else if (operation === 'fstat') vi.mocked(fs.fstatSync).mockImplementationOnce(() => { throw failure; });
      else vi.mocked(fs.linkSync).mockImplementationOnce(() => { throw failure; });
      vi.mocked(fs.unlinkSync).mockImplementationOnce(() => { throw cleanupFailure; });
      const action = vi.fn();

      expect(() => withFileLock(lockPath, action)).toThrow(failure);
      expect(fs.closeSync).toHaveBeenCalledWith(43);
      expect(content).toBeUndefined();
      expect(action).not.toHaveBeenCalled();
    },
  );
});

// #169: a lock file this process failed to release names a live owner (this process). The process
// records it and removes it the next time it takes the same lock, instead of waiting for itself.
// Design: docs/design/claim-lock-release-failure.md (3-1). Model: specs/quint/claim-lock-release/.
describe('a lock this process failed to release (#169)', () => {
  const releaseFailures = [
    ['unlink fails with EIO', () => { faults.unlink = 1; faults.unlinkCode = 'EIO'; }, 'EIO'],
    ['unlink fails with EACCES', () => { faults.unlink = 1; faults.unlinkCode = 'EACCES'; }, 'EACCES'],
    ['the lock file cannot be opened (EACCES)', () => { faults.reads = ['open']; }, 'EACCES'],
    ['the lock file cannot be read (EIO)', () => { faults.reads = ['read']; }, 'EIO'],
  ] as const;

  function lockUnlinks(): number {
    return vi.mocked(fs.unlinkSync).mock.calls.filter(([path]) => path === lockPath).length;
  }

  function waits(): number {
    return vi.mocked(Atomics.wait).mock.calls.length;
  }

  /** Takes the lock and fails its release once, leaving this process's lock file on disk. */
  function failRelease(): void {
    expect(() => withFileLock(lockPath, () => { faults.unlink = 1; faults.unlinkCode = 'EIO'; }))
      .toThrow(expect.objectContaining({ code: 'EIO' }));
    expect(content).toBe(selfContent);
  }

  it.each(releaseFailures)('throws when %s, then removes the file on the next acquisition without waiting', (_label, arm, code) => {
    const saved = vi.fn(() => { arm(); return 'saved'; });
    expect(() => withFileLock(lockPath, saved)).toThrow(expect.objectContaining({ code }));
    expect(saved).toHaveBeenCalledOnce();
    expect(content).toBe(selfContent);

    const before = waits();
    const next = vi.fn(() => content);
    expect(withFileLock(lockPath, next, { timeoutMs: 0 })).toBe(selfContent);
    expect(next).toHaveBeenCalledOnce();
    expect(waits()).toBe(before);
    expect(content).toBeUndefined();
  });

  it.each([
    [['open']], [['read']], [['open', 'open']], [['read', 'read', 'read']],
    // The read right after a matching read fails: the file is not taken as removed (再レビュー 中-A).
    [['ok', 'read']], [['ok', 'open']],
  ] as const)('keeps waiting while its recorded file cannot be read (%j), then removes it on the first readable round', (reads) => {
    failRelease();
    faults.reads = [...reads];
    const started = Date.now();
    const next = vi.fn(() => { faults.reads = []; return 'next'; });

    expect(withFileLock(lockPath, next, { timeoutMs: 1_000 })).toBe('next');

    expect(next).toHaveBeenCalledOnce();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(content).toBeUndefined();
  });

  // CodeRabbit (PR #182): an EIO on opening the recorded file is a failed read like EACCES, so one
  // failed open must not throw out of the acquisition (再レビュー 中-B, design 3-1).
  it('keeps waiting when opening its recorded file fails once with EIO, then removes it and runs the action once', () => {
    failRelease();
    faults.reads = ['openEIO'];
    const before = waits();
    const next = vi.fn(() => 'next');

    expect(withFileLock(lockPath, next, { timeoutMs: 1_000 })).toBe('next');

    expect(next).toHaveBeenCalledOnce();
    expect(waits()).toBeGreaterThan(before);
    expect(content).toBeUndefined();
  });

  it.each(['open', 'read'] as const)('times out without removing its recorded file while it cannot be read (%s), and keeps the record', (kind) => {
    failRelease();
    faults.readForever = kind;
    const action = vi.fn();

    for (const timeoutMs of [0, 5_000]) {
      const error = (() => { try { withFileLock(lockPath, action, { timeoutMs }); } catch (caught) { return caught; } return undefined; })();
      expect(isFileLockTimeoutError(error)).toBe(true);
    }
    expect(action).not.toHaveBeenCalled();
    expect(content).toBe(selfContent);

    faults.readForever = undefined;
    expect(withFileLock(lockPath, () => 'next', { timeoutMs: 0 })).toBe('next');
    expect(content).toBeUndefined();
  });

  it('throws the unlink error on the next acquisition while its file cannot be removed, without running the action or timing out', () => {
    failRelease();
    faults.unlink = Number.POSITIVE_INFINITY;
    faults.unlinkCode = 'EACCES';
    const action = vi.fn();
    const started = Date.now();

    const error = (() => { try { withFileLock(lockPath, action); } catch (caught) { return caught; } return undefined; })();

    expect(error).toMatchObject({ code: 'EACCES' });
    expect(isFileLockTimeoutError(error)).toBe(false);
    expect(Date.now()).toBe(started);
    expect(action).not.toHaveBeenCalled();
    expect(content).toBe(selfContent);

    faults.unlink = 0;
    expect(withFileLock(lockPath, () => 'next', { timeoutMs: 0 })).toBe('next');
  });

  it('throws an AggregateError of the action error and the release error', () => {
    const actionError = new Error('update failed');
    let thrown: unknown;
    try {
      withFileLock(lockPath, () => { faults.unlink = 1; throw actionError; });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([actionError, expect.objectContaining({ code: 'EIO' })]);
  });

  it('does not remove an unrecorded lock file that names this process', () => {
    // A direct acquisition first, so no record from an earlier test is left for this path.
    withFileLock(lockPath, vi.fn());
    content = selfContent;
    stat = { ...stat, ino: 900 } as fs.Stats;
    const unlinks = lockUnlinks();
    const action = vi.fn();

    expect(() => withFileLock(lockPath, action, { timeoutMs: 25 })).toThrow(/timed out/);

    expect(action).not.toHaveBeenCalled();
    expect(content).toBe(selfContent);
    expect(lockUnlinks()).toBe(unlinks);
  });

  it.each([
    ['a lock that names this process', () => selfContent],
    ['a live owner', () => otherContent],
  ])('does not remove a file that replaced its failed lock: %s', (_label, replacement) => {
    failRelease();
    const unlinks = lockUnlinks();
    content = replacement();
    stat = { ...stat, ino: stat.ino + 100 } as fs.Stats;
    const action = vi.fn();

    expect(() => withFileLock(lockPath, action, { timeoutMs: 25 })).toThrow(/timed out/);

    expect(action).not.toHaveBeenCalled();
    expect(content).toBe(replacement());
    expect(lockUnlinks()).toBe(unlinks);
  });

  it('forgets the record once the path is taken directly after the file was deleted', () => {
    failRelease();
    const recordedIno = stat.ino;
    content = undefined;
    expect(withFileLock(lockPath, () => 'direct')).toBe('direct');

    // A later file with the same inode and this process's content is not the one it failed to release.
    content = selfContent;
    stat = { ...stat, ino: recordedIno } as fs.Stats;
    const unlinks = lockUnlinks();
    const action = vi.fn();
    expect(() => withFileLock(lockPath, action, { timeoutMs: 25 })).toThrow(/timed out/);
    expect(action).not.toHaveBeenCalled();
    expect(content).toBe(selfContent);
    expect(lockUnlinks()).toBe(unlinks);
  });
});

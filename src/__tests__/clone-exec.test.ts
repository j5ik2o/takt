import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  fetchBaseBranchIntoIsolatedCloneAbortable,
  isShallowReferenceError,
  runGitCommandAbortable,
} from '../infra/task/clone-exec.js';
import { registerCacciaCloneGit, trackCacciaCloneGit } from '../infra/task/caccia-git-processes.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(), execFileSync: vi.fn(actual.execFileSync) };
});

class FakeChildProcess extends EventEmitter {
  readonly pid = 4321;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('runs isolated Git commands with the C locale so that stderr stays in English', async () => {
  vi.stubEnv('LC_ALL', 'de_DE.UTF-8');
  const child = new FakeChildProcess();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const pending = fetchBaseBranchIntoIsolatedCloneAbortable('/project', '/clone', 'main');
  child.emit('close', 0);
  await pending;
  expect(spawn).toHaveBeenCalledWith(
    'git',
    expect.any(Array),
    expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C' }) }),
  );
});

it('terminates a Git process group when its command timeout expires', async () => {
  vi.useFakeTimers();
  const child = new FakeChildProcess();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const killProcessGroup = vi.spyOn(process, 'kill').mockReturnValue(true);
  const timeoutMs = 25;
  const pending = runGitCommandAbortable('/project', ['ls-remote'], undefined, {}, timeoutMs);
  const rejection = expect(pending).rejects.toThrow(`git ls-remote timed out after ${timeoutMs} ms`);

  await vi.advanceTimersByTimeAsync(timeoutMs);
  await rejection;
  expect(killProcessGroup).toHaveBeenCalledWith(-child.pid, 'SIGTERM');

  await vi.advanceTimersByTimeAsync(500);
  expect(killProcessGroup).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  child.emit('close', null, 'SIGKILL');
});

it('preserves the exit status of a failed Git command', async () => {
  const child = new FakeChildProcess();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const pending = runGitCommandAbortable('/project', ['merge-base', '--is-ancestor', 'a', 'b']);
  child.emit('close', 1);
  await expect(pending).rejects.toMatchObject({ status: 1 });
});

it('rejects on abort even when signalling Git fails', async () => {
  const child = new FakeChildProcess();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('group signal failed'); });
  child.kill.mockImplementation(() => { throw new Error('child signal failed'); });
  const controller = new AbortController();
  const pending = expect(runGitCommandAbortable('/project', ['fetch'], controller.signal))
    .rejects.toThrow(/abort/iu);

  controller.abort();
  await pending;
});

it.skipIf(process.platform === 'win32')('does not signal a reused Git process group after its owned members leave', () => {
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
  const snapshot = vi.mocked(execFileSync);
  snapshot.mockReturnValue('4001 4001 S Mon Nov 23 12:01:00 2026\n')
    .mockReturnValueOnce('5001 4001 S Mon Nov 23 12:00:00 2026\n');
  const release = registerCacciaCloneGit('/fixture/caccia-group');
  let leaderExited: (() => void) | undefined;
  const terminate = trackCacciaCloneGit('/fixture/caccia-group', 4001, vi.fn(), (callback) => {
    leaderExited = callback;
  })!;
  try {
    leaderExited!();
    terminate('SIGINT');
    expect(signal.mock.calls).toEqual([[-4001, 0]]);
  } finally {
    release();
    snapshot.mockReset();
  }
  expect(signal.mock.calls).toEqual([[-4001, 0]]);
});

it.skipIf(process.platform === 'win32')('signals the owned group when ps is missing from PATH', () => {
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
  const snapshot = vi.mocked(execFileSync);
  snapshot.mockImplementation((file) => {
    if (file === 'ps') throw Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' });
    return signal.mock.calls.some(([, name]) => name === 'SIGKILL') ? '' : '4001 4001 S Mon Nov 23 12:00:00 2026\n';
  });
  const release = registerCacciaCloneGit('/fixture/caccia-missing-ps');
  const terminate = trackCacciaCloneGit('/fixture/caccia-missing-ps', 4001, vi.fn(), () => undefined)!;
  try {
    terminate('SIGINT');
    release();
    expect(signal.mock.calls).toEqual([[-4001, 'SIGINT'], [-4001, 'SIGKILL']]);
  } finally {
    snapshot.mockReset();
  }
});

it.skipIf(process.platform === 'win32')('finishes cleanup when a terminal Git group exits during signalling', () => {
  const signal = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  });
  const snapshot = vi.mocked(execFileSync);
  snapshot.mockReturnValue('').mockReturnValueOnce('4001 4001 S Mon Nov 23 12:00:00 2026\n');
  const release = registerCacciaCloneGit('/fixture/caccia-exiting-terminal');
  trackCacciaCloneGit('/fixture/caccia-exiting-terminal', 4001, vi.fn(), () => undefined);
  try {
    expect(release).not.toThrow();
    expect(signal.mock.calls).toEqual([[-4001, 'SIGKILL']]);
  } finally {
    signal.mockReturnValue(true);
    release();
    snapshot.mockReset();
  }
});

it.skipIf(process.platform === 'win32')('signals the live owned Git group when process inspection is unavailable', () => {
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
  const snapshot = vi.mocked(execFileSync);
  snapshot.mockImplementation(() => { throw Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }); });
  const release = registerCacciaCloneGit('/fixture/caccia-no-process-table');
  const terminate = trackCacciaCloneGit('/fixture/caccia-no-process-table', 4001, vi.fn(), () => undefined)!;
  try {
    terminate('SIGINT');
    expect(signal.mock.calls).toEqual([[-4001, 'SIGINT']]);
  } finally {
    snapshot.mockReturnValue('');
    release();
    snapshot.mockReset();
  }
});

it.skipIf(process.platform === 'win32')('retains the clone registration if only unverified group members survive', () => {
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
  const snapshot = vi.mocked(execFileSync);
  snapshot.mockReturnValue('5002 4001 S Mon Nov 23 12:01:00 2026\n')
    .mockReturnValueOnce('5001 4001 S Mon Nov 23 12:00:00 2026\n');
  const release = registerCacciaCloneGit('/fixture/caccia-replacement');
  let leaderExited: (() => void) | undefined;
  trackCacciaCloneGit('/fixture/caccia-replacement', 4001, vi.fn(), (callback) => { leaderExited = callback; });
  try {
    leaderExited!();
    expect(release).toThrow(/identify Caccia Git process group/u);
    expect(signal.mock.calls).toEqual([[-4001, 0]]);
  } finally {
    snapshot.mockReturnValue('');
    release();
    snapshot.mockReset();
  }
});

it.each([
  ['the unquoted wording', 'fatal: reference repository is shallow'],
  ['the quoted path wording', "fatal: reference repository '/work/project' is shallow"],
  ['a path with spaces and quotes', `fatal: reference repository '/work/my "project's" dir' is shallow\n`],
  ['a reference path that contains a newline', "fatal: reference repository '/work/my\nproject' is shallow\n"],
])('detects a shallow reference repository from %s', (_label, stderr) => {
  expect(isShallowReferenceError(stderr)).toBe(true);
});

it.each([
  ['an unrelated clone failure', "fatal: repository '/work/project' does not exist"],
  ['an empty message', ''],
  ['a shallow source repository', 'fatal: source repository is shallow, reject to clone.'],
  ['a path that merely mentions shallow', "fatal: reference repository '/work/project' is missing; is shallow"],
  ['a destination path that embeds the shallow wording', "fatal: destination path '/work/reference repository 'p' is shallow' already exists and is not an empty directory."],
  ['a destination path with a newline before the shallow wording', "fatal: destination path '/tmp/before\nreference repository 'p' is shallow\nafter' already exists and is not an empty directory."],
  ['the shallow wording without the fatal prefix', "reference repository '/work/project' is shallow"],
])('does not treat %s as a shallow reference error', (_label, stderr) => {
  expect(isShallowReferenceError(stderr)).toBe(false);
});

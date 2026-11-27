import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { spawnManagedProcess, terminateManagedProcesses, terminatePosixProcessTree } from '../shared/utils/spawn.js';
import { scaledMs } from '../../scripts/test-time-factor.mjs';

const temporaryDirectories: string[] = [];

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('spawnManagedProcess', () => {
  it.runIf(process.platform !== 'win32')(
    'should terminate a process group after its leader exits normally',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'takt-managed-spawn-natural-leader-exit-'));
      temporaryDirectories.push(directory);
      const readyPath = join(directory, 'ready.json');
      const script = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const grandchild = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'grandchild.unref();',
        'writeFileSync(process.argv[1], JSON.stringify({ leader: process.pid, grandchild: grandchild.pid }));',
        'process.exit(0);',
      ].join('\n');
      const managed = spawnManagedProcess(
        process.execPath,
        ['-e', script, readyPath],
        { stdio: 'ignore' },
        undefined,
      );
      await vi.waitFor(() => expect(existsSync(readyPath)).toBe(true));
      const pids = JSON.parse(readFileSync(readyPath, 'utf-8')) as {
        leader: number;
        grandchild: number;
      };

      try {
        await expect(managed.wait()).resolves.toEqual({ code: 0, signal: null });
        expect(isProcessRunning(pids.leader)).toBe(false);
        expect(isProcessRunning(pids.grandchild)).toBe(true);

        // #177: macOS で孫が SIGKILL のあと未回収ゾンビだけになったグループに当たっても、EPERM を漏らさない。
        await expect(managed.terminate()).resolves.toBeUndefined();

        await vi.waitFor(() => expect(isProcessRunning(pids.grandchild)).toBe(false));
      } finally {
        if (isProcessRunning(pids.grandchild)) {
          process.kill(pids.grandchild, 'SIGKILL');
          await vi.waitFor(() => expect(isProcessRunning(pids.grandchild)).toBe(false));
        }
      }
    },
    5_000,
  );

  it('should force-terminate a SIGTERM-resistant process tree after abort', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-managed-spawn-'));
    temporaryDirectories.push(directory);
    const readyPath = join(directory, 'ready.json');
    const controller = new AbortController();
    const script = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const grandchild = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'process.on("SIGTERM", () => {});',
      'writeFileSync(process.argv[1], JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const managed = spawnManagedProcess(
      process.execPath,
      ['-e', script, readyPath],
      { stdio: 'ignore' },
      controller.signal,
    );
    await vi.waitFor(() => expect(existsSync(readyPath)).toBe(true));
    const pids = JSON.parse(readFileSync(readyPath, 'utf-8')) as {
      child: number;
      grandchild: number;
    };

    controller.abort(new Error('managed process aborted'));

    await expect(managed.wait()).rejects.toThrow('managed process aborted');
    expect(isProcessRunning(pids.child)).toBe(false);
    expect(isProcessRunning(pids.grandchild)).toBe(false);
  });

  it('should finish process-group escalation when the leader exits on SIGTERM first', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-managed-spawn-leader-exit-'));
    temporaryDirectories.push(directory);
    const readyPath = join(directory, 'ready.json');
    const controller = new AbortController();
    const script = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const grandchild = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'writeFileSync(process.argv[1], JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const managed = spawnManagedProcess(
      process.execPath,
      ['-e', script, readyPath],
      { stdio: 'ignore' },
      controller.signal,
    );
    await vi.waitFor(() => expect(existsSync(readyPath)).toBe(true));
    const pids = JSON.parse(readFileSync(readyPath, 'utf-8')) as {
      child: number;
      grandchild: number;
    };

    controller.abort(new Error('leader exited first'));

    await expect(managed.wait()).rejects.toThrow('leader exited first');
    expect(isProcessRunning(pids.child)).toBe(false);
    await vi.waitFor(() => expect(isProcessRunning(pids.grandchild)).toBe(false));
  });

  it.runIf(process.platform !== 'win32')(
    'should settle wait and terminate when process-group signals fail',
    async () => {
      const controller = new AbortController();
      const managed = spawnManagedProcess(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { stdio: 'ignore' },
        controller.signal,
      );
      const pid = managed.child.pid;
      if (pid === undefined) {
        throw new Error('Managed test process has no PID');
      }
      const originalKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (target === -pid && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
          const error = new Error('process-group signal denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return originalKill(target, signal);
      });

      try {
        const wait = managed.wait();
        controller.abort(new Error('termination requested'));
        const results = await Promise.allSettled([wait, managed.terminate()]);

        expect(results).toEqual([
          expect.objectContaining({
            status: 'rejected',
            reason: expect.objectContaining({ message: 'termination requested' }),
          }),
          expect.objectContaining({
            status: 'rejected',
            reason: expect.objectContaining({ code: 'EACCES' }),
          }),
        ]);
      } finally {
        killSpy.mockRestore();
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
        }
        await vi.waitFor(() => expect(isProcessRunning(pid)).toBe(false));
      }
    },
    5_000,
  );

  it.runIf(process.platform !== 'win32')('should wait for Windows taskkill tree completion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-managed-spawn-taskkill-'));
    temporaryDirectories.push(directory);
    const system32 = join(directory, 'System32');
    const taskkillPath = join(system32, 'taskkill.exe');
    const taskkillStatePath = join(directory, 'taskkill.json');
    const originalSystemRoot = process.env.SystemRoot;
    const originalPlatform = process.platform;
    mkdirSync(system32);
    writeFileSync(taskkillPath, [
      `#!${process.execPath}`,
      'const { writeFileSync } = require("node:fs");',
      'const pidIndex = process.argv.indexOf("/pid");',
      'const targetPid = Number(process.argv[pidIndex + 1]);',
      'writeFileSync(process.env.TAKT_TASKKILL_STATE, JSON.stringify({ killerPid: process.pid }));',
      'process.on("SIGUSR1", () => {',
      '  try { process.kill(targetPid, "SIGKILL"); } catch (error) {',
      '    if (error.code !== "ESRCH") throw error;',
      '  }',
      '  process.exit(0);',
      '});',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'));
    chmodSync(taskkillPath, 0o755);
    process.env.SystemRoot = directory;
    process.env.TAKT_TASKKILL_STATE = taskkillStatePath;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    const controller = new AbortController();
    const managed = spawnManagedProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
      controller.signal,
    );
    let waitSettled = false;
    try {
      controller.abort(new Error('windows tree aborted'));
      const wait = managed.wait();
      void wait.then(
        () => { waitSettled = true; },
        () => { waitSettled = true; },
      );
      await vi.waitFor(() => expect(existsSync(taskkillStatePath)).toBe(true));
      expect(waitSettled).toBe(false);
      const { killerPid } = JSON.parse(readFileSync(taskkillStatePath, 'utf-8')) as {
        killerPid: number;
      };

      process.kill(killerPid, 'SIGUSR1');

      await expect(wait).rejects.toThrow('windows tree aborted');
      expect(waitSettled).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
      delete process.env.TAKT_TASKKILL_STATE;
      await managed.terminate();
    }
  });

  it.runIf(process.platform !== 'win32')(
    'should tolerate failed Windows taskkill after the leader has already exited',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'takt-managed-spawn-taskkill-after-exit-'));
      temporaryDirectories.push(directory);
      const system32 = join(directory, 'System32');
      const taskkillPath = join(system32, 'taskkill.exe');
      const taskkillStatePath = join(directory, 'taskkill.json');
      const originalSystemRoot = process.env.SystemRoot;
      const originalPlatform = process.platform;
      mkdirSync(system32);
      writeFileSync(taskkillPath, [
        `#!${process.execPath}`,
        'const { writeFileSync } = require("node:fs");',
        'const pidIndex = process.argv.indexOf("/pid");',
        'writeFileSync(process.env.TAKT_TASKKILL_STATE, JSON.stringify({ targetPid: Number(process.argv[pidIndex + 1]) }));',
        'process.exit(128);',
        '',
      ].join('\n'));
      chmodSync(taskkillPath, 0o755);
      process.env.SystemRoot = directory;
      process.env.TAKT_TASKKILL_STATE = taskkillStatePath;
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
      const managed = spawnManagedProcess(
        process.execPath,
        ['-e', 'process.exit(0)'],
        { stdio: 'ignore' },
        undefined,
      );
      const targetPid = managed.child.pid;
      if (targetPid === undefined) {
        throw new Error('Managed test process has no PID');
      }
      try {
        await expect(managed.wait()).resolves.toEqual({ code: 0, signal: null });

        await managed.terminate();

        expect(JSON.parse(readFileSync(taskkillStatePath, 'utf-8'))).toEqual({ targetPid });
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
        if (originalSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = originalSystemRoot;
        delete process.env.TAKT_TASKKILL_STATE;
      }
    },
  );

  it.runIf(process.platform !== 'win32').each([
    ['code 7', 'process.exit(7);'],
    ['signal SIGTERM', 'process.kill(process.pid, "SIGTERM");'],
  ])('should report Windows taskkill termination by %s with the target PID', async (expectedExit, exitScript) => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-managed-spawn-taskkill-error-'));
    temporaryDirectories.push(directory);
    const system32 = join(directory, 'System32');
    const taskkillPath = join(system32, 'taskkill.exe');
    const originalSystemRoot = process.env.SystemRoot;
    const originalPlatform = process.platform;
    mkdirSync(system32);
    writeFileSync(taskkillPath, [
      `#!${process.execPath}`,
      'const pidIndex = process.argv.indexOf("/pid");',
      'const targetPid = Number(process.argv[pidIndex + 1]);',
      exitScript,
      '',
    ].join('\n'));
    chmodSync(taskkillPath, 0o755);
    process.env.SystemRoot = directory;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    const managed = spawnManagedProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
      undefined,
    );
    const targetPid = managed.child.pid;
    if (targetPid === undefined) {
      throw new Error('Managed test process has no PID');
    }
    try {
      await expect(managed.terminate())
        .rejects.toThrow(`taskkill for process ${targetPid} exited with ${expectedExit}`);
    } finally {
      process.kill(targetPid, 'SIGKILL');
      await managed.waitForExit();
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
    }
  });
});

it('cleans up managed providers while leaving independently spawned runs alive', async () => {
  const provider = spawnManagedProcess(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] }, undefined);
  const run = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await once(provider.child.stdout!, 'data');
    await terminateManagedProcesses();
    expect(isProcessRunning(provider.child.pid!)).toBe(false);
    expect(isProcessRunning(run.pid!)).toBe(true);
  } finally { run.kill('SIGKILL'); await once(run, 'exit'); await provider.terminate(); }
});

// #177: macOS（XNU）では、残るメンバーがすべて未回収ゾンビのグループへの kill(-pgid, sig)（sig=0 を含む）が ESRCH ではなく EPERM を返す。
// Linux では同じ状況で送信が成功する。どちらも回収されたあとは ESRCH になる。
describe('terminatePosixProcessTree on a group whose members are unreaped zombies (#177)', () => {
  const holders: { holder: ChildProcess; pgid?: number }[] = [];
  afterEach(() => {
    // 子は別のグループにいる（setpgrp）。準備の途中で失敗しても子が残らないよう、
    // グループごと終わらせてから親（perl）を落とす。
    for (const { holder, pgid } of holders.splice(0)) {
      if (pgid !== undefined) {
        try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
      }
      holder.kill('SIGKILL');
    }
  });

  function processState(pid: number): { pgid: number; stat: string } | undefined {
    try {
      const [pgid, stat] = execFileSync('ps', ['-o', 'pgid=,stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
      return { pgid: Number(pgid), stat: stat ?? '' };
    } catch {
      return undefined;
    }
  }

  /**
   * perl の親は子を回収しない（SIGCHLD の既定の動作）。子は自分のグループを作って率いる。
   * `exit`: 子はすぐ終わり、グループには未回収ゾンビだけが残る。
   * `wait-for-term`: 子は SIGTERM の既定の動作で終わるまで待ち、終わると未回収ゾンビになる。
   * 親は SIGUSR1 を受けると子を回収して `reaped` を出す。
   */
  async function startUnreapedGroupLeader(behavior: 'exit' | 'wait-for-term'): Promise<{ pgid: number; requestReap(): void; reaped: Promise<void> }> {
    const script = [
      '$| = 1;',
      'my $pid = fork();',
      'die "fork failed" unless defined $pid;',
      'if ($pid == 0) { setpgrp(0, 0); exit 0 if $ARGV[0] eq "exit"; sleep 1 while 1; }',
      '$SIG{USR1} = sub { waitpid($pid, 0); print "reaped\\n"; };',
      'print "$pid\\n";',
      'sleep 1 while 1;',
    ].join('\n');
    const holder = spawn('perl', ['-e', script, behavior], { stdio: ['ignore', 'pipe', 'inherit'] });
    const entry: { holder: ChildProcess; pgid?: number } = { holder };
    holders.push(entry);
    let output = '';
    const reaped = new Promise<void>((resolve) => {
      holder.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('reaped\n')) resolve();
      });
    });
    await vi.waitFor(() => expect(output).toMatch(/^\d+\n/));
    const pgid = Number(output.split('\n')[0]);
    entry.pgid = pgid;
    await vi.waitFor(() => {
      const state = processState(pgid);
      expect(state?.pgid).toBe(pgid);
      if (behavior === 'exit') expect(state?.stat).toMatch(/^Z/);
    });
    return { pgid, requestReap: () => { holder.kill('SIGUSR1'); }, reaped };
  }

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
    'settles once the zombies are reaped, returning false on macOS (EPERM, nothing sent) and true on Linux (the send succeeds)',
    async () => {
      const group = await startUnreapedGroupLeader('exit');
      const originalKill = process.kill.bind(process);
      let reapScheduled = false;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        try {
          return originalKill(target, signal);
        } finally {
          if (target === -group.pgid && signal === 'SIGTERM' && !reapScheduled) {
            reapScheduled = true;
            setTimeout(group.requestReap, 50);
          }
        }
      });
      try {
        await expect(terminatePosixProcessTree(group.pgid)).resolves.toBe(process.platform === 'linux');
        await group.reaped;
        if (process.platform === 'darwin') expect(killSpy).not.toHaveBeenCalledWith(-group.pgid, 'SIGKILL');
      } finally {
        killSpy.mockRestore();
      }
    },
    scaledMs(10_000),
  );

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
    'returns true when the SIGKILL after the grace hits a group whose last member exited on SIGTERM and awaits reaping (parent deadline race)',
    async () => {
      const group = await startUnreapedGroupLeader('wait-for-term');
      const originalKill = process.kill.bind(process);
      let reapScheduled = false;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        try {
          return originalKill(target, signal);
        } finally {
          if (target === -group.pgid && signal === 'SIGKILL' && !reapScheduled) {
            reapScheduled = true;
            setTimeout(group.requestReap, 50);
          }
        }
      });
      try {
        await expect(terminatePosixProcessTree(group.pgid)).resolves.toBe(true);
        expect(killSpy).toHaveBeenCalledWith(-group.pgid, 'SIGKILL');
        await group.reaped;
      } finally {
        killSpy.mockRestore();
      }
    },
    scaledMs(10_000),
  );
});

// #177: kill(-pgid, ...) の結果を差し替えて、OS ごとの EPERM の扱いを確かめる。差し替えた番号には本物のシグナルを送らない。
describe('terminatePosixProcessTree EPERM handling by platform (#177)', () => {
  const fakeGroup = 4_193_987;
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    vi.restoreAllMocks();
  });

  function errno(code: string): NodeJS.ErrnoException {
    const error = new Error(`kill ${code}`) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  }

  function simulateGroup(platform: NodeJS.Platform, answer: (signal: string | number | undefined) => 'ok' | 'EPERM' | 'ESRCH') {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    const originalKill = process.kill.bind(process);
    const calls: (string | number | undefined)[] = [];
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (Math.abs(target) !== fakeGroup) return originalKill(target, signal);
      if (target > 0) throw errno('ESRCH');
      calls.push(signal);
      const result = answer(signal);
      if (result !== 'ok') throw errno(result);
      return true;
    });
    return calls;
  }

  it.runIf(process.platform !== 'win32')('on macOS, waits through EPERM on SIGTERM until ESRCH and returns false without sending SIGKILL', async () => {
    let probes = 0;
    const calls = simulateGroup('darwin', (signal) => {
      if (signal === 'SIGTERM') return 'EPERM';
      if (signal === 0) return ++probes <= 3 ? 'EPERM' : 'ESRCH';
      return 'ok';
    });

    await expect(terminatePosixProcessTree(fakeGroup)).resolves.toBe(false);
    expect(calls).not.toContain('SIGKILL');
    expect(probes).toBe(4);
  });

  it.runIf(process.platform !== 'win32')('on macOS, drops an EPERM from the SIGKILL after the grace once the group reaches ESRCH and returns true', async () => {
    let probes = 0;
    const calls = simulateGroup('darwin', (signal) => {
      if (signal === 'SIGTERM') return 'ok';
      if (signal === 'SIGKILL') return 'EPERM';
      return ++probes <= 3 ? 'EPERM' : 'ESRCH';
    });

    await expect(terminatePosixProcessTree(fakeGroup)).resolves.toBe(true);
    expect(calls.slice(0, 2)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(probes).toBe(4);
  });

  it.runIf(process.platform !== 'win32')('on macOS, rethrows EPERM only after it persists for the settle timeout (a real permission error)', async () => {
    const calls = simulateGroup('darwin', () => 'EPERM');
    const startedAt = Date.now();

    await expect(terminatePosixProcessTree(fakeGroup)).rejects.toMatchObject({ code: 'EPERM' });

    // TERMINATION_SETTLE_TIMEOUT_MS（2 秒）まで ESRCH への遷移を待つ。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
    expect(calls.filter((signal) => signal === 0).length).toBeGreaterThan(1);
  }, scaledMs(10_000));

  it.runIf(process.platform !== 'win32')('on Linux, rethrows EPERM without waiting for the settle timeout', async () => {
    simulateGroup('linux', () => 'EPERM');
    const startedAt = Date.now();

    await expect(terminatePosixProcessTree(fakeGroup)).rejects.toMatchObject({ code: 'EPERM' });

    expect(Date.now() - startedAt).toBeLessThan(1_500);
  }, scaledMs(10_000));
});

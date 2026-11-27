import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { findLeftoverTurnProcesses, terminateLeftoverTurnProcesses } from '../../scripts/leftover-turn-processes.mjs';

const started: ChildProcess[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const child of started.splice(0)) child.kill('SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// 実物の入口と同じ相対パスに、SIGTERM を無視して動き続ける代役を置く。
async function startTurnProcess(repository: string, cwd: string): Promise<ChildProcess> {
  const entry = join(repository, 'dist/app/daemon-turn/index.js');
  mkdirSync(join(repository, 'dist/app/daemon-turn'), { recursive: true });
  writeFileSync(entry, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');");
  mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, [entry], { cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  started.push(child);
  await once(child.stdout!, 'data');
  return child;
}

function fixtureRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-leftover-')));
  roots.push(root);
  return root;
}

it.skipIf(process.platform === 'win32')('reports and terminates a turn process left in an isolated test config root', async () => {
  const root = fixtureRoot();
  const repository = join(root, 'repository');
  const cwd = join(root, 'takt-test-global-abc123', '.takt');
  const child = await startTurnProcess(repository, cwd);
  const exited = once(child, 'exit');

  const leftovers = await terminateLeftoverTurnProcesses(repository, { settleMs: 200, terminationGraceMs: 200 });

  expect(leftovers).toEqual([{ pid: child.pid, cwd }]);
  expect((await exited)[1]).toBe('SIGKILL');
  expect(findLeftoverTurnProcesses(repository)).toEqual([]);
});

it.skipIf(process.platform === 'win32')('ignores a turn process that runs outside the test config roots', async () => {
  const root = fixtureRoot();
  const repository = join(root, 'repository');
  const child = await startTurnProcess(repository, join(root, 'real-config', '.takt'));

  expect(await terminateLeftoverTurnProcesses(repository, { settleMs: 200, terminationGraceMs: 200 })).toEqual([]);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
});

it.skipIf(process.platform === 'win32')('does not report a turn process that finishes during the settle window', async () => {
  const root = fixtureRoot();
  const repository = join(root, 'repository');
  const child = await startTurnProcess(repository, join(root, 'takt-test-global-def456', '.takt'));
  setTimeout(() => child.kill('SIGKILL'), 150);

  expect(await terminateLeftoverTurnProcesses(repository, { settleMs: 5_000 })).toEqual([]);
});

// #177: ターン用プロセスのグループに残った子孫も、実行単位の隔離ルート（isolationRoot）の範囲で見つけて止める。
// 各テストは自分の fixtureRoot() を isolationRoot として渡す。実行全体のルートを渡すと、同時に動く別のテストのプロセスまで止めてしまう。
interface LeftoverScope { isolationRoot?: string; settleMs?: number; terminationGraceMs?: number }
interface LeftoverProcess { pid: number; cwd: string; kind?: string; pgid?: number }
const findInScope = findLeftoverTurnProcesses as (repositoryRoot: string, scope?: LeftoverScope) => LeftoverProcess[];
const terminateInScope = terminateLeftoverTurnProcesses as (repositoryRoot: string, scope?: LeftoverScope) => Promise<LeftoverProcess[]>;

const descendantPids: number[] = [];
const holders: ChildProcess[] = [];
afterEach(() => {
  for (const pid of descendantPids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* もういない */ }
  }
  for (const holder of holders.splice(0)) holder.kill('SIGKILL');
});

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * 実物の入口と同じ相対パスに、子孫を 1 つ（detached なし、同じグループ）起こす代役を置く。
 * argv: <mode> <descendantCwd> <descendantIgnoresTerm>
 * - mode `exit`: 子孫を起こしたら主が終わる（グループの主が抜ける）。
 * - mode `ignore-term`: 主も SIGTERM を無視して動き続ける。
 */
function writeGroupTurnEntry(repository: string): string {
  const entry = join(repository, 'dist/app/daemon-turn/index.js');
  mkdirSync(join(repository, 'dist/app/daemon-turn'), { recursive: true });
  writeFileSync(entry, [
    "const { spawn } = require('node:child_process');",
    'const [mode, descendantCwd, descendantIgnoresTerm] = process.argv.slice(2);',
    "const body = (descendantIgnoresTerm === '1' ? \"process.on('SIGTERM', () => {});\" : '') + \"setInterval(() => {}, 1000); process.stdout.write('ready');\";",
    "const descendant = spawn(process.execPath, ['-e', body], { cwd: descendantCwd, stdio: ['ignore', 'pipe', 'ignore'] });",
    "if (mode === 'ignore-term') process.on('SIGTERM', () => {});",
    "descendant.stdout.once('data', () => {",
    "  process.stdout.write(JSON.stringify({ leader: process.pid, descendant: descendant.pid }) + '\\n');",
    "  if (mode === 'exit') { descendant.unref(); descendant.stdout.destroy(); process.exit(0); }",
    '});',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  return entry;
}

async function readPids(stream: NodeJS.ReadableStream): Promise<{ leader: number; descendant: number }> {
  let output = '';
  for await (const chunk of stream) {
    output += String(chunk);
    const line = output.split('\n').find((candidate) => candidate.startsWith('{'));
    if (line !== undefined && output.includes('}\n')) {
      const pids = JSON.parse(line) as { leader: number; descendant: number };
      descendantPids.push(pids.descendant);
      return pids;
    }
  }
  throw new Error(`Group stand-in exited before reporting its PIDs: ${output}`);
}

/** 主がグループを率いる（実物の spawnManagedProcess と同じ detached: true）。 */
async function startTurnGroup(repository: string, cwd: string, mode: 'exit' | 'ignore-term', descendant: { cwd: string; ignoresTerm: boolean }) {
  const entry = writeGroupTurnEntry(repository);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(descendant.cwd, { recursive: true });
  const child = spawn(process.execPath, [entry, mode, descendant.cwd, descendant.ignoresTerm ? '1' : '0'],
    { cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  started.push(child);
  const pids = await readPids(child.stdout!);
  if (mode === 'exit') await vi.waitFor(() => expect(isRunning(pids.leader)).toBe(false));
  return { child, ...pids };
}

/** 主が終わっても親（perl）が回収しないので、主は未回収ゾンビとしてグループ ID を持ち続ける。 */
async function startTurnGroupWithZombieLeader(repository: string, cwd: string, descendantCwd: string) {
  const entry = writeGroupTurnEntry(repository);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(descendantCwd, { recursive: true });
  const script = [
    'my $pid = fork();',
    'die "fork failed" unless defined $pid;',
    'if ($pid == 0) { setpgrp(0, 0); chdir($ARGV[0]) or die; exec($ARGV[1], $ARGV[2], "exit", $ARGV[3], "0"); }',
    'sleep 1 while 1;',
  ].join('\n');
  const holder = spawn('perl', ['-e', script, cwd, process.execPath, entry, descendantCwd], { stdio: ['ignore', 'pipe', 'ignore'] });
  holders.push(holder);
  const pids = await readPids(holder.stdout!);
  await vi.waitFor(() => {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pids.leader)], { encoding: 'utf8' }).trim();
    expect(stat).toMatch(/^Z/);
  });
  return pids;
}

it.skipIf(process.platform === 'win32')('reports and terminates a descendant left in a group whose leader already exited (#177)', async () => {
  const root = fixtureRoot();
  const repository = join(root, 'repository');
  const cwd = join(root, 'takt-test-global-ghi789', '.takt');
  const { leader, descendant } = await startTurnGroup(repository, cwd, 'exit', { cwd, ignoresTerm: false });

  const leftovers = await terminateInScope(repository, { isolationRoot: root, settleMs: 200, terminationGraceMs: 200 });

  expect(leftovers).toEqual([expect.objectContaining({ pid: descendant, cwd, kind: 'descendant', pgid: leader })]);
  await vi.waitFor(() => expect(isRunning(descendant)).toBe(false));
  expect(findInScope(repository, { isolationRoot: root })).toEqual([]);
});

it.skipIf(process.platform === 'win32')('reports and terminates a descendant whose group leader is an unreaped zombie (#177)', async () => {
  const root = fixtureRoot();
  const repository = join(root, 'repository');
  const cwd = join(root, 'takt-test-global-jkl012', '.takt');
  const { leader, descendant } = await startTurnGroupWithZombieLeader(repository, cwd, cwd);

  const leftovers = await terminateInScope(repository, { isolationRoot: root, settleMs: 200, terminationGraceMs: 200 });

  expect(leftovers).toEqual([expect.objectContaining({ pid: descendant, kind: 'descendant', pgid: leader })]);
  await vi.waitFor(() => expect(isRunning(descendant)).toBe(false));
});

it.skipIf(process.platform === 'win32')('finds a descendant under the isolation root even when its cwd is not a takt-test-global-* directory (#177)', async () => {
  // プロバイダーの子は作業ディレクトリをプロジェクト側にすることが多い。隔離ルートで範囲を絞れば、印を重ねる必要はない。
  const root = fixtureRoot();
  const repository = join(root, 'repository');
  const cwd = join(root, 'takt-test-global-mno345', '.takt');
  const project = join(root, 'project');
  const { leader, descendant } = await startTurnGroup(repository, cwd, 'exit', { cwd: project, ignoresTerm: false });

  const leftovers = await terminateInScope(repository, { isolationRoot: root, settleMs: 200, terminationGraceMs: 200 });

  expect(leftovers).toEqual([expect.objectContaining({ pid: descendant, cwd: project, kind: 'descendant', pgid: leader })]);
  await vi.waitFor(() => expect(isRunning(descendant)).toBe(false));
});

it.skipIf(process.platform === 'win32')('leaves alone a descendant that belongs to another isolation root (another worktree or a concurrent run) (#177)', async () => {
  const root = fixtureRoot();
  const otherRoot = fixtureRoot();
  const repository = join(root, 'repository');
  const otherCwd = join(otherRoot, 'takt-test-global-pqr678', '.takt');
  const { descendant } = await startTurnGroup(repository, otherCwd, 'exit', { cwd: otherCwd, ignoresTerm: false });

  expect(findInScope(repository, { isolationRoot: root })).toEqual([]);
  expect(await terminateInScope(repository, { isolationRoot: root, settleMs: 200, terminationGraceMs: 200 })).toEqual([]);
  expect(isRunning(descendant)).toBe(true);
});

it.skipIf(process.platform === 'win32')('kills the whole group when a SIGTERM-ignoring leader has to be SIGKILLed (#177)', async () => {
  const root = fixtureRoot();
  const repository = join(root, 'repository');
  const cwd = join(root, 'takt-test-global-stu901', '.takt');
  const { child, leader, descendant } = await startTurnGroup(repository, cwd, 'ignore-term', { cwd, ignoresTerm: true });
  const exited = once(child, 'exit');

  const leftovers = await terminateInScope(repository, { isolationRoot: root, settleMs: 200, terminationGraceMs: 200 });

  expect((await exited)[1]).toBe('SIGKILL');
  await vi.waitFor(() => expect(isRunning(descendant)).toBe(false));
  expect(leftovers).toContainEqual(expect.objectContaining({ pid: leader, cwd, kind: 'turn', pgid: leader }));
  expect(findInScope(repository, { isolationRoot: root })).toEqual([]);
});

it.skipIf(process.platform === 'win32')('does not signal a process that no longer matches the scope when the signal is due (PID reuse guard, #177)', async () => {
  // 検出から送信までの数秒の間に、同じ PID が別のプロセスのものになりうる。送る直前に pid・pgid・cwd を確かめ直す。
  // ここでは、検出したプロセスが待ちの間に隔離ルートの外へ移ることで「もう同じものではない」状況を作る。
  const root = fixtureRoot();
  const elsewhere = join(fixtureRoot(), 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  const repository = join(root, 'repository');
  const cwd = join(root, 'takt-test-global-vwx234', '.takt');
  const entry = join(repository, 'dist/app/daemon-turn/index.js');
  mkdirSync(join(repository, 'dist/app/daemon-turn'), { recursive: true });
  writeFileSync(entry, [
    "process.on('SIGTERM', () => {});",
    `process.on('SIGUSR2', () => { process.chdir(${JSON.stringify(elsewhere)}); process.stdout.write('moved'); });`,
    'setInterval(() => {}, 1000);',
    "process.stdout.write('ready');",
  ].join('\n'));
  mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, [entry], { cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  started.push(child);
  await once(child.stdout!, 'data');
  expect(findInScope(repository, { isolationRoot: root })).toContainEqual(expect.objectContaining({ pid: child.pid, cwd }));

  const pending = terminateInScope(repository, { isolationRoot: root, settleMs: 500, terminationGraceMs: 200 });
  const moved = once(child.stdout!, 'data');
  child.kill('SIGUSR2');
  await moved;

  expect(await pending).toEqual([]);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
});

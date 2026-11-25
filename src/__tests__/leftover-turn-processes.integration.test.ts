import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
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

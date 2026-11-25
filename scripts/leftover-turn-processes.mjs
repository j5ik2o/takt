import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// src/__tests__/test-setup.ts creates every isolated config root under this prefix.
const TEST_ROOT_MARKER = '/takt-test-global-';
const SETTLE_INTERVAL_MS = 100;

function workingDirectory(pid) {
  try {
    if (process.platform === 'linux') return readlinkSync(`/proc/${pid}/cwd`);
    const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return output.split('\n').find((line) => line.startsWith('n'))?.slice(1);
  } catch {
    // The process exited between the listing and this lookup.
    return undefined;
  }
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function signal(pid, name) {
  try { process.kill(pid, name); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function waitUntilGone(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = pids.filter(isRunning);
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(SETTLE_INTERVAL_MS);
    remaining = remaining.filter(isRunning);
  }
  return remaining;
}

/**
 * Turn processes of this checkout that still run inside a test's isolated config root.
 * A turn process started by a real daemon runs elsewhere and is never listed.
 * @param {string} repositoryRoot
 * @returns {{ pid: number, cwd: string }[]}
 */
export function findLeftoverTurnProcesses(repositoryRoot) {
  if (process.platform === 'win32') return [];
  const entries = [join(repositoryRoot, 'dist/app/daemon-turn/index.js'), join(repositoryRoot, 'src/app/daemon-turn/index.ts')];
  return execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').flatMap((row) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(row);
    if (match === null || !entries.some((entry) => match[2].includes(entry))) return [];
    const pid = Number(match[1]);
    const cwd = workingDirectory(pid);
    return cwd?.includes(TEST_ROOT_MARKER) ? [{ pid, cwd }] : [];
  });
}

/**
 * Reports the turn processes that tests left running and terminates them.
 * A process whose daemon was just killed gets `settleMs` to finish its own cleanup first.
 * @param {string} repositoryRoot
 * @param {{ settleMs?: number, terminationGraceMs?: number }} [options]
 * @returns {Promise<{ pid: number, cwd: string }[]>} the processes that had to be terminated
 */
export async function terminateLeftoverTurnProcesses(repositoryRoot, options = {}) {
  const found = findLeftoverTurnProcesses(repositoryRoot);
  if (found.length === 0) return [];
  const stuck = new Set(await waitUntilGone(found.map(({ pid }) => pid), options.settleMs ?? 5_000));
  const leftovers = found.filter(({ pid }) => stuck.has(pid));
  for (const { pid } of leftovers) signal(pid, 'SIGTERM');
  for (const pid of await waitUntilGone([...stuck], options.terminationGraceMs ?? 2_000)) signal(pid, 'SIGKILL');
  const survivors = await waitUntilGone([...stuck], 2_000);
  if (survivors.length > 0) throw new Error(`Turn processes did not terminate: ${survivors.join(', ')}`);
  return leftovers;
}

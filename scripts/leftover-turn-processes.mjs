import { execFileSync } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const TEST_ROOT_MARKER = '/takt-test-global-';
const SETTLE_INTERVAL_MS = 100;

function listProcesses() {
  return execFileSync('ps', ['-axww', '-o', 'pid=,pgid=,uid=,stat=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').flatMap((row) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(row);
    return m === null ? [] : [{ pid: Number(m[1]), pgid: Number(m[2]), uid: Number(m[3]), stat: m[4], command: m[5] }];
  });
}

function workingDirectories(pids) {
  const result = new Map();
  if (pids.length === 0) return result;
  if (process.platform === 'linux') {
    for (const pid of pids) { try { result.set(pid, readlinkSync(`/proc/${pid}/cwd`)); } catch { /* gone */ } }
    return result;
  }
  let output = '';
  try { output = execFileSync('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (error) { output = error.stdout ?? ''; }
  let current;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) current = Number(line.slice(1));
    else if (line.startsWith('n') && current !== undefined) result.set(current, line.slice(1));
  }
  return result;
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function signal(pid, name) {
  try { process.kill(pid, name); }
  catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; }
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

export function findLeftoverTurnProcesses(repositoryRoot, options = {}) {
  if (process.platform === 'win32') return [];
  const entries = [join(repositoryRoot, 'dist/app/daemon-turn/index.js'), join(repositoryRoot, 'src/app/daemon-turn/index.ts')];
  const root = options.isolationRoot === undefined ? undefined : realpathSync.native(options.isolationRoot) + sep;
  const rows = listProcesses();
  const live = new Set(rows.filter((r) => !r.stat.startsWith('Z')).map((r) => r.pid));
  const uid = process.getuid();
  const candidates = rows.filter((r) => r.uid === uid && !r.stat.startsWith('Z') && r.pid !== process.pid).flatMap((r) => {
    if (entries.some((e) => r.command.includes(e))) return [{ ...r, kind: 'turn' }];
    if (root !== undefined && r.pid !== r.pgid && r.pgid > 1 && !live.has(r.pgid)) return [{ ...r, kind: 'descendant' }];
    return [];
  });
  const cwds = workingDirectories(candidates.map((c) => c.pid));
  return candidates.flatMap((c) => {
    const cwd = cwds.get(c.pid);
    if (cwd === undefined) return [];
    if (root === undefined) return cwd.includes(TEST_ROOT_MARKER) ? [{ pid: c.pid, cwd }] : [];
    if (!cwd.startsWith(root)) return [];
    if (c.kind === 'turn' && !cwd.includes(TEST_ROOT_MARKER)) return [];
    return [{ pid: c.pid, cwd, kind: c.kind, pgid: c.pgid }];
  });
}

function stillMatches(repositoryRoot, options, found) {
  const now = findLeftoverTurnProcesses(repositoryRoot, options);
  return found.filter((f) => now.some((n) => n.pid === f.pid && n.pgid === f.pgid && n.cwd === f.cwd));
}

export async function terminateLeftoverTurnProcesses(repositoryRoot, options = {}) {
  const all = [];
  for (let pass = 0; pass < 2; pass += 1) {
    const found = findLeftoverTurnProcesses(repositoryRoot, options);
    if (found.length === 0) break;
    const stuck = new Set(await waitUntilGone(found.map(({ pid }) => pid), pass === 0 ? options.settleMs ?? 5_000 : 0));
    const leftovers = stillMatches(repositoryRoot, options, found.filter(({ pid }) => stuck.has(pid)));
    const target = (f) => (f.kind === 'turn' && f.pid === f.pgid ? -f.pid : f.pid);
    for (const f of leftovers) signal(target(f), 'SIGTERM');
    const remaining = await waitUntilGone(leftovers.map((f) => f.pid), options.terminationGraceMs ?? 2_000);
    for (const f of stillMatches(repositoryRoot, options, leftovers.filter((f) => remaining.includes(f.pid)))) signal(target(f), 'SIGKILL');
    const survivors = await waitUntilGone(leftovers.map((f) => f.pid), 2_000);
    if (survivors.length > 0) throw new Error(`Turn processes did not terminate: ${survivors.join(', ')}`);
    all.push(...leftovers);
  }
  return all;
}

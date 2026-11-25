import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { isProcessAlive } from '../infra/task/process.js';
import { captureOwnedChild, terminateOwnedProcess, terminateOwnedProcessTree } from './helpers/owned-process.js';

// 親は SIGTERM で終わり、別グループの子は SIGTERM を無視して残る。daemon とターン用プロセスの関係と同じ。
const parentScript = `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');"],
  { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => { process.stdout.write(String(child.pid)); });
setInterval(() => {}, 1000);
`;

it.skipIf(process.platform === 'win32')('terminates a child that outlives its parent and ignores SIGTERM', async () => {
  const parent = spawn(process.execPath, ['--input-type=module', '-e', parentScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  const owned = (await captureOwnedChild(parent))!;
  const [chunk] = await once(parent.stdout, 'data') as [Buffer];
  const childPid = Number(chunk.toString());
  try {
    expect(isProcessAlive(childPid)).toBe(true);
    await terminateOwnedProcessTree(owned, () => parent.exitCode !== null || parent.signalCode !== null);
    expect(parent.signalCode).toBe('SIGTERM');
    expect(isProcessAlive(childPid)).toBe(false);
  } finally {
    await terminateOwnedProcess(owned, () => parent.exitCode !== null || parent.signalCode !== null);
    try { process.kill(childPid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
});

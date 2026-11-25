import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { spawnManagedProcess } from '../shared/utils/spawn.js';
import { parseTurnProcessMessage, type DaemonProcessMessage, type TurnProcessMessage } from '../core/daemon/processProtocol.js';
import { conversationId } from '../infra/conversations/identity.js';
import { deferred, turnStart } from './helpers/daemon-turn.js';

it('executes the real IPC entry without a provider and exits after shutdown cleanup', async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'takt-turn-child-'));
  const managed = spawnManagedProcess(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../app/daemon-turn/index.ts', import.meta.url))], {
    cwd: process.cwd(), shell: false, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, TAKT_CONFIG_DIR: configDirectory, TAKT_SLACK_APP_TOKEN: undefined, TAKT_SLACK_BOT_TOKEN: undefined },
  }, undefined);
  const envelope = { protocolVersion: 1 as const, launchId: 'real-child' };
  const messages: TurnProcessMessage[] = [];
  const pending = new Map<string, ReturnType<typeof deferred<TurnProcessMessage>>>();
  let stderr = '';
  managed.child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString(); });
  managed.child.on('message', (value: unknown) => {
    const message = parseTurnProcessMessage(value, envelope.launchId);
    messages.push(message); pending.get(message.kind)?.resolve(message);
  });
  const exit = managed.wait();
  const wait = (kind: string) => {
    const response = deferred<TurnProcessMessage>(); pending.set(kind, response);
    return Promise.race([response.promise, exit.then(() => { throw new Error(`Child exited before ${kind}: ${stderr}`); })]);
  };
  const send = (message: DaemonProcessMessage) => new Promise<void>((resolve, reject) => {
    managed.child.send(message, (error: Error | null) => { if (error !== null) reject(error); else resolve(); });
  });
  try {
    const start = turnStart(); start.state.assignment = { kind: 'daemon' };
    start.turn.conversationId = conversationId(start.state.assignment); start.event.conversationId = start.turn.conversationId;
    // A non-message is rejected before runtime/provider preparation, exercising the actual business boundary.
    start.event.event = { kind: 'human_command', command: { kind: 'dismiss_summary', revision: 1, conversationId: start.turn.conversationId }, speaker: { namespace: 'human', id: 'test' } };
    const ready = wait('ready');
    await send({ ...envelope, kind: 'initialize', conversationId: start.turn.conversationId,
      assignment: start.state.assignment, configDirectory });
    await ready;
    expect(messages.map((message) => message.kind)).toEqual(['ready']);
    const finished = wait('turn_finished');
    await send({ ...envelope, kind: 'start_turn', input: start });
    expect(await finished).toMatchObject({ turn: start.turn, outcome: { kind: 'completed', result: { kind: 'error', code: 'invalid_input' } } });
    await send({ ...envelope, kind: 'result_committed', turn: start.turn });
    const stopped = wait('shutdown_complete');
    await send({ ...envelope, kind: 'shutdown' });
    await stopped;
    expect(await exit).toEqual({ code: 0, signal: null });
  } finally {
    await managed.terminate();
    await rm(configDirectory, { recursive: true, force: true });
  }
});

// SDK などが閉じ忘れたハンドルの代わり。これだけでイベントループは空にならない。
const strayHandle = 'data:text/javascript,import{createServer}from"node:http";createServer(()=>{}).listen(0,"127.0.0.1");';

it.each(['SIGTERM', 'disconnect'] as const)('exits after %s even while a stray handle keeps the event loop alive', async (trigger) => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'takt-turn-child-'));
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', strayHandle,
    fileURLToPath(new URL('../app/daemon-turn/index.ts', import.meta.url))], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, TAKT_CONFIG_DIR: configDirectory, TAKT_SLACK_APP_TOKEN: undefined, TAKT_SLACK_BOT_TOKEN: undefined },
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => { resolve({ code, signal }); });
  });
  try {
    const ready = deferred<void>();
    child.on('message', (value: unknown) => { if (parseTurnProcessMessage(value, 'stray-child').kind === 'ready') ready.resolve(); });
    const assignment = { kind: 'daemon' as const };
    child.send({ protocolVersion: 1, launchId: 'stray-child', kind: 'initialize', conversationId: conversationId(assignment),
      assignment, configDirectory } satisfies DaemonProcessMessage);
    await Promise.race([ready.promise, exit.then(() => { throw new Error('Child exited before ready'); })]);
    if (trigger === 'SIGTERM') child.kill('SIGTERM');
    else child.disconnect();
    const result = await Promise.race([exit, delay(10_000).then(() => 'still running' as const)]);
    // 切断では完了通知を送れないため、終了コードは 1 になる。
    expect(result).toEqual({ code: trigger === 'SIGTERM' ? 0 : 1, signal: null });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    await rm(configDirectory, { recursive: true, force: true });
  }
}, 30_000);

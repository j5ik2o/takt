import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { scaledMs } from '../../scripts/test-time-factor.mjs';
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

// 本物の入口（daemon-turn/index.ts）を起動し、turnBusiness.js だけを中断に応じない業務に差し替える。
const abortIgnoringBusiness = new URL('./fixtures/abort-ignoring-turn-business.ts', import.meta.url).href;
const replaceTurnBusiness = `data:text/javascript,${encodeURIComponent(`import{register}from"node:module";register("data:text/javascript,"+encodeURIComponent(${JSON.stringify(
  `export async function resolve(specifier,context,next){if(/\\/daemonTurn\\/turnBusiness\\.[jt]s$/.test(specifier))return{url:${JSON.stringify(abortIgnoringBusiness)},shortCircuit:true};return next(specifier,context);}`,
)}));`)}`;

it.each([
  { trigger: 'SIGTERM', holdsHandle: true },
  { trigger: 'disconnect', holdsHandle: true },
  // ハンドルが残らないとイベントループが空になる。後片付けは済んでいないので、0 で終わってはいけない。
  { trigger: 'disconnect', holdsHandle: false },
] as const)('exits with failure after $trigger within the shutdown grace while the running turn ignores abort (holds handle: $holdsHandle, #141)', async ({ trigger, holdsHandle }) => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'takt-turn-child-'));
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', replaceTurnBusiness,
    fileURLToPath(new URL('../app/daemon-turn/index.ts', import.meta.url))], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, HOME: configDirectory, TAKT_CONFIG_DIR: configDirectory, TAKT_SLACK_APP_TOKEN: undefined, TAKT_SLACK_BOT_TOKEN: undefined,
      TAKT_TEST_TURN_HOLDS_HANDLE: holdsHandle ? '1' : '0' },
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString(); });
  const stderrEnd = child.stderr === null
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      child.stderr!.once('end', resolve);
      child.stderr!.once('close', resolve);
    });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => { resolve({ code, signal }); });
  });
  // Node では child.disconnect() 後に child の close が発火しないことがあるため、exit と stderr の end を両方待つ。
  const exitedWithStderr = Promise.all([exit, stderrEnd]).then(([result]) => result);
  const envelope = { protocolVersion: 1 as const, launchId: 'abort-ignoring-child' };
  const seen = new Map<string, ReturnType<typeof deferred<void>>>([['ready', deferred<void>()], ['turn_progress', deferred<void>()]]);
  child.on('message', (value: unknown) => { seen.get(parseTurnProcessMessage(value, envelope.launchId).kind)?.resolve(); });
  const reach = (kind: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      seen.get(kind)!.promise,
      exitedWithStderr.then(() => { throw new Error(`Child exited before ${kind}: ${stderr}`); }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`Timed out waiting for ${kind}: ${stderr}`)); }, scaledMs(10_000));
      }),
    ]).finally(() => { clearTimeout(timer); });
  };
  try {
    const start = turnStart();
    child.send({ ...envelope, kind: 'initialize', conversationId: start.turn.conversationId,
      assignment: start.state.assignment, configDirectory } satisfies DaemonProcessMessage);
    await reach('ready');
    child.send({ ...envelope, kind: 'start_turn', input: start } satisfies DaemonProcessMessage);
    await reach('turn_progress');
    // 親の daemon が先に落ちた後の状況（IPC 切断、その後の SIGTERM）: 誰も SIGKILL しない。親と同じ 5 秒の猶予に 3 秒の余裕を足して待つ。
    if (trigger === 'SIGTERM') child.kill('SIGTERM');
    else child.disconnect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      exitedWithStderr,
      new Promise<'still running'>((resolve) => { timer = setTimeout(() => { resolve('still running'); }, scaledMs(8_000)); }),
    ]).finally(() => { clearTimeout(timer); });
    expect(result).toEqual({ code: 1, signal: null });
    expect(stderr).toContain('Turn process cleanup timed out');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    await rm(configDirectory, { recursive: true, force: true });
  }
}, scaledMs(30_000));

// #177: 親が落ちたあと、ターン用プロセスのグループに残った子孫（detached なしで起こされた子）を、ターン用プロセスが終わる前に止める。
// 実物と同じく detached: true で起動してグループを率いさせ、cwd と設定ディレクトリは隔離済み tmpdir() 配下の takt-test-global-* にする
// （万一子孫を漏らしても scripts/leftover-turn-processes.mjs の守りに掛かる）。cwd が変わるので tsx は絶対 URL で読み込む。
const tsxLoader = new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
const descendantSpawningBusiness = new URL('./fixtures/descendant-spawning-turn-business.ts', import.meta.url).href;
const replaceWithDescendantSpawningBusiness = `data:text/javascript,${encodeURIComponent(`import{register}from"node:module";register("data:text/javascript,"+encodeURIComponent(${JSON.stringify(
  `export async function resolve(specifier,context,next){if(/\\/daemonTurn\\/turnBusiness\\.[jt]s$/.test(specifier))return{url:${JSON.stringify(descendantSpawningBusiness)},shortCircuit:true};return next(specifier,context);}`,
)}));`)}`;

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function killQuietly(target: number): void {
  try { process.kill(target, 'SIGKILL'); } catch (error) {
    // ESRCH: もういない。EPERM: macOS で未回収ゾンビだけのグループ。
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

it.skipIf(process.platform === 'win32').each([
  // 期限切れの exit(1) の直前にグループへ SIGTERM を送る。直す前は子が残る。
  { name: 'the turn ignores abort and the deadline fires', abort: 'ignore', dropsSigtermListeners: false, timesOut: true },
  // 後片付けが shutdown_complete を送れずに期限より前に exit(1) する。期限切れのときだけ送る形では子が残る。
  { name: 'the turn honors abort but cleanup fails before the deadline', abort: 'honor', dropsSigtermListeners: false, timesOut: false },
  // 低2: SDK が SIGTERM のリスナーを外していても、自分に届く SIGTERM でシグナル終了にならない（終了コード 1 のまま）。
  { name: 'the turn ignores abort after its SIGTERM listeners were removed', abort: 'ignore', dropsSigtermListeners: true, timesOut: true },
] as const)('signals its own process group before exiting when the parent is gone and $name (#177)', async ({ abort, dropsSigtermListeners, timesOut }) => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'takt-test-global-'));
  const child = spawn(process.execPath, ['--import', tsxLoader, '--import', replaceWithDescendantSpawningBusiness,
    fileURLToPath(new URL('../app/daemon-turn/index.ts', import.meta.url))], {
    cwd: configDirectory, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, HOME: configDirectory, TAKT_CONFIG_DIR: configDirectory, TAKT_SLACK_APP_TOKEN: undefined, TAKT_SLACK_BOT_TOKEN: undefined,
      TAKT_TEST_TURN_ABORT: abort, TAKT_TEST_TURN_DROPS_SIGTERM_LISTENERS: dropsSigtermListeners ? '1' : '0' },
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString(); });
  const stderrEnd = child.stderr === null
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      child.stderr!.once('end', resolve);
      child.stderr!.once('close', resolve);
    });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => { resolve({ code, signal }); });
  });
  const exitedWithStderr = Promise.all([exit, stderrEnd]).then(([result]) => result);
  const envelope = { protocolVersion: 1 as const, launchId: 'descendant-spawning-child' };
  const ready = deferred<void>();
  const descendantReported = deferred<number>();
  child.on('message', (value: unknown) => {
    const message = parseTurnProcessMessage(value, envelope.launchId);
    if (message.kind === 'ready') ready.resolve();
    if (message.kind === 'turn_progress' && typeof message.message === 'string' && message.message.startsWith('descendant:')) {
      descendantReported.resolve(Number(message.message.slice('descendant:'.length)));
    }
  });
  const reach = <T>(kind: string, promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      promise,
      exitedWithStderr.then(() => { throw new Error(`Child exited before ${kind}: ${stderr}`); }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`Timed out waiting for ${kind}: ${stderr}`)); }, scaledMs(10_000));
      }),
    ]).finally(() => { clearTimeout(timer); });
  };
  let descendant: number | undefined;
  try {
    const start = turnStart();
    child.send({ ...envelope, kind: 'initialize', conversationId: start.turn.conversationId,
      assignment: start.state.assignment, configDirectory } satisfies DaemonProcessMessage);
    await reach('ready', ready.promise);
    child.send({ ...envelope, kind: 'start_turn', input: start } satisfies DaemonProcessMessage);
    descendant = await reach('descendant', descendantReported.promise);
    expect(isProcessRunning(descendant)).toBe(true);
    // 親の daemon が落ちた状況: IPC が切れ、誰もグループを掃除しない。
    child.disconnect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      exitedWithStderr,
      new Promise<'still running'>((resolve) => { timer = setTimeout(() => { resolve('still running'); }, scaledMs(8_000)); }),
    ]).finally(() => { clearTimeout(timer); });
    expect(result).toEqual({ code: 1, signal: null });
    if (timesOut) expect(stderr).toContain('Turn process cleanup timed out');
    else expect(stderr).not.toContain('Turn process cleanup timed out');
    const reportedDescendant = descendant;
    await vi.waitFor(() => { expect(isProcessRunning(reportedDescendant)).toBe(false); }, { timeout: 3_000, interval: 50 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    if (child.pid !== undefined) killQuietly(-child.pid);
    if (descendant !== undefined) killQuietly(descendant);
    await rm(configDirectory, { recursive: true, force: true });
  }
}, scaledMs(30_000));

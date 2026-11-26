import '../environment.js';
import { createTurnProcessRuntime } from '../../features/daemonTurn/processRuntime.js';
import { createTurnBusiness } from '../../features/daemonTurn/turnBusiness.js';
import { TURN_SHUTDOWN_GRACE_MS } from '../../core/daemon/processProtocol.js';

if (process.send === undefined) throw new Error('Turn process requires Node IPC');
let failing = false;
const fatal = (error: unknown): void => {
  if (failing) return;
  failing = true;
  process.stderr.write(`Turn process failed: ${error instanceof Error ? error.name : 'Error'}\n`);
  process.exitCode = 1;
  void runtime.disconnect().finally(() => { if (process.connected) process.disconnect(); }).catch(() => { process.exitCode = 1; });
};
const runtime = createTurnProcessRuntime({ createBusiness: createTurnBusiness, onFatal: fatal,
  transport: { send: (message) => new Promise<void>((resolve, reject) => {
    if (!process.connected || process.send === undefined) { reject(new Error('Turn IPC disconnected')); return; }
    process.send(message, (error: Error | null) => { if (error !== null) reject(error); else resolve(); });
  }) },
});
process.on('message', (message: unknown) => {
  void runtime.receive(message).then(() => {
    if (typeof message === 'object' && message !== null && 'kind' in message && message.kind === 'shutdown' && process.connected) process.disconnect();
  }).catch(fatal);
});
// 後片付けが済んだら、閉じ忘れたハンドルが残っていても終了する。イベントループが空になるのを待つと、SIGTERM でも終わらないプロセスが残る。
// 中断に応じないターンでは後片付けが終わらないので、親と同じ猶予で打ち切って失敗として終わる。親が先に落ちていると、誰も SIGKILL しない。
const exitAfter = (cleanup: Promise<void>): void => {
  setTimeout(() => { process.stderr.write('Turn process cleanup timed out\n'); process.exit(1); }, TURN_SHUTDOWN_GRACE_MS);
  void cleanup.catch(fatal).finally(() => { process.exit(); });
};
process.on('disconnect', () => { exitAfter(runtime.transportClosed()); });
process.on('SIGTERM', () => { exitAfter(runtime.disconnect().finally(() => { if (process.connected) process.disconnect(); })); });

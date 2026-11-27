import { spawn } from 'node:child_process';
import type { TurnBusiness } from '../../features/daemonTurn/processRuntime.js';

/**
 * プロバイダーの SDK が `spawnManagedProcess` を通らずに起こした子（`detached` なし）の代わり（#177）。
 * 子はターン用プロセスのグループに入り、SIGTERM の既定の動作で終わる。PID は `descendant:<pid>` の進捗で知らせる。
 *
 * - TAKT_TEST_TURN_ABORT=ignore（既定）: execute は決して終わらない。子のハンドルがイベントループを生かし続ける。
 * - TAKT_TEST_TURN_ABORT=honor: 中断で `interrupted` を返すが、子は残す。
 * - TAKT_TEST_TURN_DROPS_SIGTERM_LISTENERS=1: SDK が SIGTERM のリスナーを外した状況を作る。
 */
export function createTurnBusiness(): TurnBusiness {
  return {
    execute: async (_input, io) => {
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      if (process.env.TAKT_TEST_TURN_DROPS_SIGTERM_LISTENERS === '1') process.removeAllListeners('SIGTERM');
      await io.progress(`descendant:${descendant.pid}`);
      if (process.env.TAKT_TEST_TURN_ABORT !== 'honor') return new Promise<never>(() => {});
      await new Promise<void>((resolve) => {
        if (io.signal.aborted) resolve();
        else io.signal.addEventListener('abort', () => { resolve(); }, { once: true });
      });
      return { kind: 'interrupted' };
    },
    close: async () => {},
  };
}

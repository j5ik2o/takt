import type { TurnBusiness } from '../../features/daemonTurn/processRuntime.js';

/**
 * 中断（AbortSignal）に応じないプロバイダーの代わり。execute は決して終わらない。
 * 止まったプロバイダーが掴んだままのソケットや子プロセスの代わりに、タイマーでイベントループを生かし続ける。
 * TAKT_TEST_TURN_HOLDS_HANDLE=0 のときは何も掴まず、イベントループが空になる状況を作る。
 */
export function createTurnBusiness(): TurnBusiness {
  return {
    execute: async (_input, io) => {
      if (process.env.TAKT_TEST_TURN_HOLDS_HANDLE !== '0') setInterval(() => {}, 60_000);
      await io.progress('started');
      return new Promise<never>(() => {});
    },
    close: async () => {},
  };
}

# ターン用プロセスの終了期限（exitAfter）

- Issue: [j5ik2o/takt#141](https://github.com/j5ik2o/takt/issues/141)
- PR: [j5ik2o/takt#166](https://github.com/j5ik2o/takt/pull/166)（ブランチ `fix/141-turn-exit-deadline`、実装済みコミット `0a8bf2f2b` の後追い設計）
- Quint 仕様: `specs/quint/turn-process-exit-deadline/`

## 何をどう変えるか

ターン用プロセス（`src/app/daemon-turn/index.ts`）が SIGTERM または IPC 切断を受けたとき、`processRuntime.ts` の `shutdown()` は実行中のターン（`active?.completion`）と `business?.close()` の完了を期限なしで待つ。親の daemon が生きている間は `turnProcessHost.ts` が 5 秒後にプロセスグループごと SIGKILL するが、親が先に落ちている（クラッシュや SIGKILL）と誰も SIGKILL しないため、中断に応じないターンを実行中の子が残り続けていた。また、そのターンがハンドルを掴んでいないと、IPC 切断でイベントループが空になり、後片付けが終わっていないのに終了コード 0 で終了していた。

変更は次の 3 点（実装済み `0a8bf2f2b`）と、レビューボットの指摘 5 件に対するテストの修正。

1. `src/core/daemon/processProtocol.ts` に `TURN_SHUTDOWN_GRACE_MS = 5_000` を定義し、親（`src/features/daemon/turnProcessHost.ts` の `SHUTDOWN_GRACE_MS` を置換）と子で共有する。設定での上書きは設けない（親が生きていれば親の 5 秒 SIGKILL が先に来るため、子だけ長くしても意味がない）。
2. `src/app/daemon-turn/index.ts` の `exitAfter` に `setTimeout(..., TURN_SHUTDOWN_GRACE_MS)` を追加する。期限を過ぎたら stderr に `Turn process cleanup timed out\n` を書き、`process.exit(1)` で終了する。
   - タイマーは `unref()` しない。ハンドルを持たない中断無視ターンでも、IPC 切断後にイベントループが空になって終了コード 0 で抜けるのを防ぎ、期限切れで終了コード 1 にするため。
   - 後片付けが期限内に完了したときは、これまでどおり `cleanup.catch(fatal).finally(() => { process.exit(); })` で即終了する（失敗時は `fatal` が `process.exitCode = 1` を設定する）。
3. `src/__tests__/daemon-turn-process.integration.test.ts` に回帰テスト 3 件とフィクスチャ `src/__tests__/fixtures/abort-ignoring-turn-business.ts` を追加する（`tsconfig.tests.json` にも登録）。レビューボット（Devin 3 件・CodeRabbit 2 件）の指摘を受け、次の 3 点をテスト側で直す。
   - `exit` だけでなく `stderr` の `end`（および異常終了時の `close`）まで待ってから `stderr` の診断文を検証する（期限は維持）。`child.disconnect()` 後は子プロセスの `close` が発火しないことがあるため、`exit` と `stderr` の `end` を両方待つ。
   - `reach('ready')` / `reach('turn_progress')` の待機にも期限を付け、通知が来なくても `finally` で子プロセスを確実に終了させる。
   - テスト所有の期限（終了待ち 8 秒、起動通知待ち、ケース上限 30 秒）に `scripts/test-time-factor.mjs` の `scaledMs` を適用する（製品側の 5 秒は変えない）。

### 変えないこと・範囲の外

- `src/features/daemonTurn/processRuntime.ts` の `shutdown()` 自体は変えない（`shutdown()` の中断・後片付けの契約は維持し、プロセス終了の期限を入口の `exitAfter` に置く）。
- 親が送る `shutdown` メッセージの経路（`index.ts:21-24`）は変えない。親が生きている間は親が 5 秒で SIGKILL し、途中で親が落ちれば `disconnect` から `exitAfter` に入る。
- `fatal()` 直接呼び出しの経路（`index.ts:8-14`）は変えない。親が生きている間のプロトコル違反等は親の `terminate()` が 5 秒で SIGKILL し、親が落ちれば `disconnect` から `exitAfter` に入る。
- プロバイダー側を `AbortSignal` に応じるよう直すこと、および daemon 本体（`dist/app/daemon/index.js`）の終了処理（[j5ik2o/takt#142](https://github.com/j5ik2o/takt/issues/142)）は範囲外。

## 守る不変条件

1. **期限超過で子が残らない（`exitsByDeadline`）**: `SIGTERM` または `disconnect` を受けてから `TURN_SHUTDOWN_GRACE_MS` を過ぎたら、親が落ちていても子は `Running` のまま残らない。
2. **後片付け未完了で終了コード 0 にならない（`noZeroExitWithoutCleanup`）**: 終了コード 0 で終わるのは `shutdown()` が正常完了（`CleanupDone`）したときだけ。ハンドルを持たない中断無視ターンでも、IPC 切断後に 0 で終わらない。
3. **中断無視ターンは終了コード 0 にならない（`abortIgnoringNeverExitsZero`）**: 中断に応じないターンが実行中の子は、どの経路でも終了コード 0 にならない。
4. **期限切れ診断と終了コード 1 の一致（`timeoutExitsOne`）**: `Turn process cleanup timed out` を出したら必ず終了コード 1 で終わる。
5. **後片付け失敗は終了コード 0 にならない（`failedCleanupNeverExitsZero`）**: `business.close()` の例外や切断後の `shutdown_complete` 送信失敗では、終了コード 1 で終わる。
6. **親生存時の猶予一致（`parentAliveBoundedShutdown`）**: 親が生きている間の `terminate()` でも、同じ `TURN_SHUTDOWN_GRACE_MS` を超えて子は残らない。
7. **後片付け開始時の中断通知（`cleanupAbortsActiveTurn`）**: 後片付けが始まったら実行中ターンには必ず `AbortController.abort()` が送られる。

## PBT の性質と除外

今回の製品変更は `setTimeout` + `process.exit(1)` の 4 行と共有定数 1 つであり、入力文字列やデータ構造の変換を持たない。状態空間は有限のプロセス終了状態遷移（初期構成 × トリガー順序 × クリーンアップ成否 × 時間経過）であるため、fast-check による PBT ではなく、以下で同等の網羅性を確保する。

- **Quint モデル**: 状態遷移のすべての組み合わせ（`Before` / `UnrefTimer` / `Fixed` の 3 設計比較、不変条件 7 本、witness 9 本、シナリオテスト 15 件）を検査する。
- **実プロセス統合テスト**: 本物の `src/app/daemon-turn/index.ts` を `--import tsx` で起動し、`SIGTERM`（ハンドルあり）、`disconnect`（ハンドルあり）、`disconnect`（ハンドルなし）の 3 件を検証する。修正前は 3 件とも 10 回中 10 回失敗することを確認済み。

除外する入力集合はない。

## Quint の仕様と検査結果

仕様は `specs/quint/turn-process-exit-deadline/turnProcessExitDeadline.qnt`、シナリオテストは `turnProcessExitDeadline_test.qnt`、実行記録は `README.md` に置いた。

- `quint typecheck`: 本体・テストともに成功。
- `quint test`: `beforeTest` 3 件、`unrefTimerTest` 1 件、`fixedTest` 11 件の計 15 件すべて通過。
- `quint run`（`fixed`, `--invariant safety`, `--max-samples 10000 --max-steps 15 --seed 0x2a`）: 違反 0 件、9 本の witness すべて到達（`wTimeoutAfterSigterm` 53 件、`wTimeoutAfterDisconnectHoldsHandle` 1,030 件、`wTimeoutAfterDisconnectNoHandle` 950 件、`wCleanExitAfterSigterm` 4,163 件、`wCleanExitAfterShutdownMsg` 407 件、`wFailedCleanupExitsOne` 2,644 件、`wParentSigkill` 752 件、`wDoubleTriggerTimeout` 1,700 件、`wShutdownMsgThenParentCrashTimeout` 1,230 件）。
- 非自明性の確認（`--max-samples 3000 --max-steps 15 --seed 0x2a`）:
  - `before`（修正前）: `exitsByDeadline`・`noZeroExitWithoutCleanup`・`abortIgnoringNeverExitsZero` で反例を検出。
  - `unrefTimer`（`.unref()` を付けた場合）: `exitsByDeadline` は通るが `noZeroExitWithoutCleanup`・`abortIgnoringNeverExitsZero` で反例を検出。`.unref()` を付けてはいけない根拠を示す。

## 壊しうる入力・状況の一覧

| 状況・入力 | 扱い | 確認手段 |
|---|---|---|
| 親クラッシュ後の `disconnect`（中断無視・ハンドルあり） | `exitAfter` の 5 秒タイマーで stderr 出力後に `exit(1)` | IT・Quint (`fixedTest`) |
| 親クラッシュ後の `disconnect`（中断無視・ハンドルなし） | ref 済みタイマーがイベントループを保持し、0 終了を防ぎ 5 秒後に `exit(1)` | IT・Quint (`fixedTest`, `unrefTimerTest`) |
| 親不在での `SIGTERM`（中断無視・ハンドルあり） | `exitAfter` の 5 秒タイマーで stderr 出力後に `exit(1)` | IT・Quint (`fixedTest`) |
| 境界：`SIGTERM` の後に `disconnect` が重なる（多重発火） | `closing` は共有され、最初のタイマーが 5 秒時点で `exit(1)` する（猶予は延びない） | Quint (`sigtermThenDisconnectKeepsFirstDeadlineTest`) |
| 境界：親が `shutdown` 送信後に途中で落ちる | 落ちた時点で `disconnect` が `exitAfter` を起動し、そこから 5 秒以内に `exit(1)` | Quint (`shutdownMsgThenParentCrashExitsOneTest`) |
| 境界：後片付け完了と期限切れが同時刻 | 後片付け完了が先なら正常終了（0 または `fatal` による 1）、期限切れが先なら `exit(1)` | Quint (`fixed` シミュレーション) |
| 境界：未初期化（`initialize` 前）の `SIGTERM` / `disconnect` | `shutdown()` は `shutdown_complete` 送信をスキップして正常完了し即 `exit(0)` | Quint (`fixed` シミュレーション) |
| 並行：`SIGTERM` 処理中に IPC 切断が起き、協力ターンが終わる | `shutdown_complete` 送信が失敗し `fatal` が `exitCode = 1` を設定して `exit(1)` | Quint (`cooperativeDisconnectExitsOneTest`) |
| 例外：`business.close()` が reject する | `AggregateError` → `fatal` で `exitCode = 1` → 即 `exit(1)` | Quint (`closeFailureExitsOneTest`) |
| `strayHandle` あり・協力ターン（既存ケース） | 後片付け完了後に `process.exit()` で即終了（5 秒待たない） | 既存 IT・Quint (`cooperativeSigtermCleanExitTest`) |
| `fatal()` 直接呼び出し（IPC 接続維持・中断無視） | 本 PR の変更対象外。親が生きていれば親が 5 秒で SIGKILL、親が落ちれば `disconnect` で `exitAfter` に入る | 設計上の前提として明記 |
| 文字列境界（区切り・入れ子・長さ・Unicode）・再開 | `exitAfter` と `TURN_SHUTDOWN_GRACE_MS` は文字列・永続状態を読まないため該当なし | コード確認 |

## 影響

- **上流（`nrslib/takt`）**: `main` および開いている PR に同等の修正がないことを確認済み。変更は 3 ファイル（計 14 行の追加・変更）とテスト・設計・Quint 仕様に限定される。
- **保存済みデータ**: 変更なし（読み書きするファイル形式や状態スキーマには触れない）。
- **公開 API**: `src/core/daemon/processProtocol.ts` に内部定数 `TURN_SHUTDOWN_GRACE_MS` を 1 つ追加するのみ。既存のメッセージスキーマ・CLI オプション・設定スキーマへの破壊的変更はない。
- **守りの仕組み**: 親側の `TURN_SHUTDOWN_GRACE_MS`（5 秒）と `scripts/leftover-turn-processes.mjs` の残存プロセス検査はそのまま維持され、親が落ちた場合の子プロセス残留という穴を塞ぐ。

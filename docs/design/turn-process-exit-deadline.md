# ターン用プロセスの終了期限（exitAfter）

- Issue: [j5ik2o/takt#141](https://github.com/j5ik2o/takt/issues/141)
- PR: [j5ik2o/takt#166](https://github.com/j5ik2o/takt/pull/166)（ブランチ `fix/141-turn-exit-deadline`、実装済みコミット `0a8bf2f2b` の後追い設計）
- Quint 仕様: `specs/quint/turn-process-exit-deadline/`

## 何をどう変えるか

ターン用プロセス（`src/app/daemon-turn/index.ts`）が SIGTERM または IPC 切断を受けたとき、`processRuntime.ts` の `shutdown()` は実行中のターン（`active?.completion`）と `business?.close()` の完了を期限なしで待つ。親の daemon が生きている間は `turnProcessHost.ts` が 5 秒後にプロセスグループごと SIGKILL するが、親が先に落ちている（クラッシュや SIGKILL）と誰も SIGKILL しないため、中断に応じないターンを実行中の子が残り続けていた。また、そのターンがハンドルを掴んでいないと、IPC 切断でイベントループが空になり、後片付けが終わっていないのに終了コード 0 で終了していた。

変更は次の 3 点（実装済み `0a8bf2f2b`）と、レビューボットの指摘 5 件に対するテストの修正。

1. `src/core/daemon/processProtocol.ts` に `TURN_SHUTDOWN_GRACE_MS = 5_000` を定義し、親（`src/features/daemon/turnProcessHost.ts` の `SHUTDOWN_GRACE_MS` を置換）と子で共有する。設定での上書きは設けない（親が生きていれば親の 5 秒 SIGKILL が先に来るため、子だけ長くしても意味がない）。
2. `src/app/daemon-turn/index.ts` の `exitAfter` に `setTimeout(..., TURN_SHUTDOWN_GRACE_MS)` を追加する。期限を過ぎたら stderr に `Turn process cleanup timed out\n` を書き、`process.exit(1)` で終了する。
   - タイマーは `unref()` しない。ハンドルを持たない中断無視ターンでも、IPC 切断後にイベントループが空になって終了コード 0 で抜けるのを防ぎ、期限切れで終了コード 1 にするため。unref した場合でもプロセスは残らず、害は終了コードが 0 になることだけである。ref の代償は、最大 5 秒長く生きることである。親が生きていて IPC だけが切れた場合に、親が失敗として扱えるほうを選んだ。本番の親は stderr を `'ignore'` で起動するので、診断文を読むのは IT だけである。
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
- 親が落ちた後に子の期限が切れたとき、ターン用プロセスのグループに残った子孫は掃除しない。別件にする（末尾の「別件の issue の中身」）。

## 守る不変条件

1. **期限超過で子が残らない（`exitsByDeadline`）**: `SIGTERM` または `disconnect` を受けてから `TURN_SHUTDOWN_GRACE_MS` を過ぎたら、親が落ちていても子は `Running` のまま残らない。ここでいう子はターン用プロセスそのもので、そのプロセスグループに残った子孫は含まない。
2. **後片付け未完了で終了コード 0 にならない（`noZeroExitWithoutCleanup`）**: 終了コード 0 で終わるのは `shutdown()` が正常完了（`CleanupDone`）したときだけ。ハンドルを持たない中断無視ターンでも、IPC 切断後に 0 で終わらない。
3. **後片付けが終わらないなら終了コード 0 にならない（`stalledCleanupNeverExitsZero`）**: `shutdown()` が待つもののどれか（中断に応じないターン、`business.close()`、`createBusiness` の初期化）が終わらない子は、どの経路でも終了コード 0 にならない。
4. **期限切れ診断と終了コード 1 の一致（`timeoutExitsOne`）**: `Turn process cleanup timed out` を出したら必ず終了コード 1 で終わる。
5. **後片付け失敗は終了コード 0 にならない（`failedCleanupNeverExitsZero`）**: `business.close()` の例外や切断後の `shutdown_complete` 送信失敗では、終了コード 1 で終わる。
6. **親生存時の猶予一致（`parentAliveBoundedShutdown`）**: 親が生きている間の `terminate()` でも、同じ `TURN_SHUTDOWN_GRACE_MS` を超えて子は残らない。
7. **後片付け開始時の中断通知（`cleanupAbortsActiveTurn`）**: 後片付けが始まったら実行中ターンには必ず `AbortController.abort()` が送られる。モデルでは、協力ターンは中断を受けた後でしか終わらない。中断を落とした変異（`noAbort`）では、協力ターンが正常終了に届かなくなる。

3 つの設計（修正前・unref・修正後）を区別するのは 1〜3 である。4 と 5 は、期限切れと後片付けの失敗がどの設計でも終了コード 1 を書くので、構成上どの設計でも成り立つ。モデルの健全性を確かめるもので、直しの証拠ではない。1 と 6 は「タイマーは期限ちょうどに発火する」（イベントループが塞がっていない）という前提の上で成り立つ。6 の上限は、実物では親の終了処理の 250 ms（`TERMINATION_GRACE_MS`）を足した値になる。モデルはこれを同じ時刻に含めている。

## PBT の性質と除外

今回の製品変更は `setTimeout` + `process.exit(1)` の 4 行と共有定数 1 つであり、入力文字列やデータ構造の変換を持たない。状態空間は有限のプロセス終了状態遷移（初期構成 × トリガー順序 × クリーンアップ成否 × 時間経過）であるため、fast-check による PBT ではなく、以下で同等の網羅性を確保する。

- **Quint モデル**: 状態遷移の組み合わせ（`Before` / `UnrefTimer` / `Fixed` の 3 設計と中断を落とした変異 `noAbort` の比較、`shutdown()` が止まる場所 4 通り、不変条件 7 本、witness 12 本、シナリオテスト 21 件）を検査する。
- **実プロセス統合テスト**: 本物の `src/app/daemon-turn/index.ts` を `--import tsx` で起動し、`SIGTERM`（ハンドルあり）、`disconnect`（ハンドルあり）、`disconnect`（ハンドルなし）の 3 件を検証する。修正前は 3 件とも 10 回中 10 回失敗することを確認済み。

除外する入力集合はない。

## Quint の仕様と検査結果

仕様は `specs/quint/turn-process-exit-deadline/turnProcessExitDeadline.qnt`、シナリオテストは `turnProcessExitDeadline_test.qnt`、実行記録は `README.md` に置いた。

初期構成には、`shutdown()`（`processRuntime.ts:70-78`）がどこで止まるかの軸 `stallAt` を置く。`StallNone`（止まらない）、`StallTurn`（`active.completion`：中断に応じないターン）、`StallClose`（`business.close()`）、`StallInit`（`await initialization`：`createBusiness` が終わらない）の 4 通りである。後片付けが進むのは、どこも止まっておらず、実行中のターンがあれば中断を受けた後だけにした。イベントループが空になって抜けるのは、後片付けが止まっている間だけにした（進められる後片付けは、マイクロタスクで先に終わるため）。

- `quint typecheck`: 本体・テストともに成功。
- `quint test`: `beforeTest` 5 件、`unrefTimerTest` 1 件、`fixedTest` 14 件、`noAbortTest` 1 件の計 21 件すべて通過。
- `quint run`（`fixed`, `--invariant safety`, `--max-samples 10000 --max-steps 15 --seed 0x2a`）: 違反 0 件、12 本の witness すべて到達。`close()` が止まりハンドルもない切断（`wTimeoutCloseHangsNoHandle` 232 件）と、初期化が止まる場合（`wTimeoutInitHangs` 465 件）も期限切れの `exit(1)` で終わる。seed `0x1`・`0x7`・`0xbeef`（2 万標本・20 手）でも違反 0 件。
- 非自明性の確認（`--max-samples 3000 --max-steps 15 --seed 0x2a`）:
  - `before`（修正前）: `exitsByDeadline`・`noZeroExitWithoutCleanup`・`stalledCleanupNeverExitsZero` で反例を検出。`close()` だけが止まりハンドルもない切断でも 0 で終わる反例が出る（`closeHangsNoHandleExitsZeroTest`）。
  - `unrefTimer`（`.unref()` を付けた場合）: `exitsByDeadline` は通るが `noZeroExitWithoutCleanup`・`stalledCleanupNeverExitsZero` で反例を検出。`.unref()` を付けてはいけない根拠を示す。
  - `noAbort`（`shutdown()` が中断を送らない変異）: 1〜6 は期限があるので通るが、`cleanupAbortsActiveTurn` で反例を検出する。振る舞いの側でも、協力ターンの正常終了（`wCooperativeTurnCleanExit`）が 1 万本中 0 本になる（`fixed` では 45 本）。

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
| `initialize` の処理中（`createBusiness` が終わらない）に `SIGTERM` / `disconnect` | `await initialization` で止まるので、5 秒のタイマーで `exit(1)` | Quint (`initHangsSigtermExitsOneTest`, `wTimeoutInitHangs`) |
| `business.close()` が終わらない（ターンなし・ハンドルなし・親が落ちて切断） | ref 済みタイマーがイベントループを保持し、0 終了を防ぎ 5 秒後に `exit(1)` | Quint (`closeHangsNoHandleDisconnectExitsOneTest`, `beforeTest` の反例) |
| イベントループが同期処理（`execFileSync` など）で塞がる | タイマーも SIGTERM ハンドラも、同期処理が戻るまで動かない。上限はその呼び出しの長さで決まる（今回の変更で生まれた問題ではない） | 前提として明記 |
| 並行：`SIGTERM` 処理中に IPC 切断が起き、協力ターンが終わる | `shutdown_complete` 送信が失敗し `fatal` が `exitCode = 1` を設定して `exit(1)` | Quint (`cooperativeDisconnectExitsOneTest`) |
| 例外：`business.close()` が reject する | `AggregateError` → `fatal` で `exitCode = 1` → 即 `exit(1)` | Quint (`closeFailureExitsOneTest`) |
| `strayHandle` あり・協力ターン（既存ケース） | 後片付け完了後に `process.exit()` で即終了（5 秒待たない） | 既存 IT・Quint (`cooperativeSigtermCleanExitTest`) |
| `fatal()` 直接呼び出し（IPC 接続維持・中断無視） | 本 PR の変更対象外。親が生きていれば親が 5 秒で SIGKILL、親が落ちれば `disconnect` で `exitAfter` に入る | 設計上の前提として明記 |
| 文字列境界（区切り・入れ子・長さ・Unicode）・再開 | `exitAfter` と `TURN_SHUTDOWN_GRACE_MS` は文字列・永続状態を読まないため該当なし | コード確認 |

## 影響

- **上流（`nrslib/takt`）**: `main` および開いている PR に同等の修正がないことを確認済み。変更は 3 ファイル（計 14 行の追加・変更）とテスト・設計・Quint 仕様に限定される。
- **保存済みデータ**: 変更なし（読み書きするファイル形式や状態スキーマには触れない）。
- **公開 API**: `src/core/daemon/processProtocol.ts` に内部定数 `TURN_SHUTDOWN_GRACE_MS` を 1 つ追加するのみ。既存のメッセージスキーマ・CLI オプション・設定スキーマへの破壊的変更はない。
- **守りの仕組み**: 親側の `TURN_SHUTDOWN_GRACE_MS`（5 秒）と `scripts/leftover-turn-processes.mjs` の残存プロセス検査はそのまま維持する。この変更が塞ぐのは、親が落ちた後にターン用プロセスそのものが残る穴である。そのプロセスグループの子孫は、親が落ちていると誰も掃除しない（別件）。`scripts/leftover-turn-processes.mjs` もターン用プロセスしか見ないので、この残りは検出しない。

## 設計レビューの指摘への対応

設計の独立レビュー（高 0、中 3、低 6）への対応。

| 指摘 | 対応 | 内容 |
|---|---|---|
| 中1 親が落ちた後の期限切れで、グループ内の子孫を誰も掃除しない | 別件 | この PR では直さない。不変条件 1 の「子」の範囲と「守りの仕組み」の書き方を直し、issue の中身を末尾に書いた |
| 中2 モデルが `close()` や初期化が止まる場合を表していない | 直す | 止まる場所の軸 `stallAt` を足し、不変条件 3 を `stalledCleanupNeverExitsZero` に一般化した。壊しうる入力の表に 2 行足した |
| 中3 `aborted` がどの遷移にも効いていない | 直す | 後片付けが進む条件に「ターンがあれば中断済み」を入れ、中断を落とした変異 `noAbort` を足した |
| 低1 不変条件 4・5 は構成上真で、1・6 は `canTick` の前提に依る | 直す（文書） | 設計を区別するのは 1〜3 だと、設計書と README に書き分けた |
| 低2 親が生きているときの上限は GRACE + 250 ms | 直す（文書） | 不変条件 6 の説明とモデルの注記に、250 ms を同じ時刻に含めていると書いた |
| 低3 イベントループが同期処理で塞がると、タイマーも SIGTERM ハンドラも動かない | 直す（文書） | 前提として、壊しうる入力の表と README の範囲外に書いた |
| 低4 ref を選んだ理由付けが足りない | 直す（文書） | unref の害（終了コードの誤りだけ）と ref の代償（最大 5 秒長く生きる）の比較を書いた |
| 低5 モデルの近道 | 一部直す | `exitCodeFlag` の届かない分岐を消した。修正前の `Idle` かつ初期化済みの切断で 0 終了する経路は、イベントループが空になる条件を「後片付けが止まっている間」に絞って消した。`shutdown` メッセージの経路が `exitAfter` を通らない点と、shutdown 前の `fatal` による `exitCode = 1` は、終了コードが同じか安全側に寄るだけなので採らず、README の範囲外に書いた |
| 低6 接続中に外から SIGTERM が来ると、親の失敗の文言が実態と合わない | 別件 | 今回の変更とは無関係の既存のずれ。子はもともと終わるところで害はない |

## 別件の issue の中身（中1）

- 題: 親が落ちた後にターン用プロセスの期限が切れると、プロセスグループの子孫が残る
- 再現の形: daemon が SIGKILL などで落ちる。ターン用プロセスは `disconnect` を受けて `exitAfter` に入る。実行中のターンが中断に応じず、プロバイダーが `spawnManagedProcess` を通らずに起こした子孫（SDK が直接 spawn したものなど）がターン用プロセスのグループ（`spawn.ts:215` の `detached: true`）にいる。または `business.close()` 自体が終わらない。5 秒後にターン用プロセスは `process.exit(1)` で終わるが、グループの子孫には何も送らない。親が生きていれば `managed.terminate()` がグループへ SIGTERM と SIGKILL を送るが、親がいないので誰も送らない。
- 案: 期限切れのタイマーで `exit(1)` の前に、自分のグループへ SIGTERM を送る（`process.kill(-process.pid, 'SIGTERM')`）。自分にも届くが、SIGTERM ハンドラが `exitAfter` をもう一度呼ぶだけで、直後の `exit(1)` で終わる。POSIX のみ（Windows はグループの扱いが違う）。
- 影響: 親が落ちた後に、プロバイダーや MCP の子孫が残り続ける。`scripts/leftover-turn-processes.mjs` はターン用プロセスしか見ないので、テストでも検出されない。

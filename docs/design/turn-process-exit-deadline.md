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

---

# 追記: ターン用プロセスのグループに残る子孫の掃除（#177）

- Issue: [j5ik2o/takt#177](https://github.com/j5ik2o/takt/issues/177)（上の「別件の issue の中身（中1）」を切り出したもの）
- Quint 仕様: 同じ `specs/quint/turn-process-exit-deadline/` を広げた（`GROUP_SIGNAL`・`SWEEP_ZOMBIE_EPERM` の軸、子孫・ゾンビ・親の終了後掃除の状態）
- 上流（`nrslib/takt`）: `main` の `src/app/daemon-turn/index.ts` には `exitAfter` 自体がない（#141 の期限もフォークだけの変更）。開いている PR で `src/app/daemon-turn/index.ts`・`src/shared/utils/spawn.ts`・`scripts/leftover-turn-processes.mjs` に触れるものはない（2026-11-27 確認）。

## 何が起きているか

ターン用プロセスは `turnProcessHost.ts` の `spawnManagedProcess` で `detached: true` として起動されるので、自分の PID と同じ ID のプロセスグループを率いる。プロバイダーの SDK が `spawnManagedProcess` を通らずに起こした子（`detached` なし）は、このグループに入る。`spawnManagedProcess` で起こした子は、それぞれ自分のグループを持つ。

グループを掃除するのは親だけである。親が生きていれば、ターン用プロセスが終わったあとに `managed.waitForExit()` に続く `managed.terminate()` がグループへ SIGTERM、250 ms 後に SIGKILL を送る（`turnProcessHost.ts:179-183`）。期限の前に親が SIGKILL するときも同じである。親が落ちていると誰も送らないので、ターン用プロセスが `exit` したあともグループの子孫は動き続ける。

これは期限切れの `exit(1)` に限らない。親が落ちたあと、中断に応じたターンで後片付けが `shutdown_complete` の送信に失敗して `fatal` から `exit(1)` するとき（期限より前）や、親が `shutdown` を送った直後に正常終了し、親の掃除が走る前に親が落ちたときも、同じように残る。Quint の `timeoutOnlyGroupSignal`（issue の案どおり、期限切れのときだけ送る）は前者で反例を出す。

さらに、ターン用プロセス自身が終了直前にグループへ `SIGTERM` を送るようにすると、親が生きている通常終了でも「子孫が `SIGTERM` で終了した直後に未回収ゾンビだけのグループになっている瞬間」へ親の `managed.terminate()` が重なる競合窓が広がる。macOS（XNU）では、グループ内の残存メンバーがすべて未回収ゾンビの状態で `kill(-pgid, sig)`（`sig=0` を含む）を呼ぶと `ESRCH` ではなく `EPERM` が返るため、現行の `src/shared/utils/spawn.ts` では `turnProcessHost.ts:183` の `input.onError(error)` へ無実の `EPERM` が報告される（Quint の `everyExitWithoutEpermFix` で反例が出る）。

## 何をどう変えるか

### 1. ターン用プロセス出口でのグループ SIGTERM（`src/app/daemon-turn/index.ts`）

`src/app/daemon-turn/index.ts` の `exitAfter` で、`process.exit` を呼ぶ 2 か所の直前に、自分のグループへ SIGTERM を送る。

```ts
// 親が落ちているとグループを誰も掃除しないので、終わる前に自分のグループへ SIGTERM を送る。
const signalOwnGroup = (): void => {
  if (process.platform === 'win32') return;
  // 自分自身にも届くため、SIGTERM リスナーが外れていてもシグナル終了にならないよう保険を置く。
  if (process.listenerCount('SIGTERM') === 0) process.on('SIGTERM', () => {});
  try { process.kill(-process.pid, 'SIGTERM'); } catch { /* ESRCH: グループを率いていない。どの失敗でも終了は続ける */ }
};
const exitAfter = (cleanup: Promise<void>): void => {
  setTimeout(() => { process.stderr.write('Turn process cleanup timed out\n'); signalOwnGroup(); process.exit(1); }, TURN_SHUTDOWN_GRACE_MS);
  void cleanup.catch(fatal).finally(() => { signalOwnGroup(); process.exit(); });
};
```

- 期限切れだけでなく、後片付けが済んだときの終了でも送る（issue の案を広げる）。ターン用プロセスの終了は、実際にはすべて `exitAfter` を通る。`shutdown` メッセージの経路は `process.disconnect()` から `'disconnect'` に入り、`fatal` も `process.disconnect()` から同じ所に入る。だから 2 か所に置けば、「`exitAfter` から終わるときは、必ず先にグループへ SIGTERM を送っている」と言える。
- SIGTERM は自分にも届く。`index.ts:33` は読み込みの時点で `process.on('SIGTERM', ...)` を登録しているが、将来のリファクタ（`process.once` 化）や SDK 等によるリスナー解除で既定動作（シグナル終了 `{ code: null, sig: 'SIGTERM' }`）へ壊れないよう、`signalOwnGroup()` 内で送信前に `process.listenerCount('SIGTERM') === 0` なら空リスナーを登録する。JS のハンドラはイベントループに積まれるだけで、直後の同期の `process.exit` が先に走るので動かない。終了コードは今と同じ（期限切れは 1、後片付けの結果どおり 0 か 1）。
- 診断文の書き込みは SIGTERM より前に置く（今の順序を変えない）。
- 親が生きている場合、親の掃除と重なって同じグループに SIGTERM が 2 回届くこと自体は害がない。ただし子孫が先に終了して未回収ゾンビだけになった瞬間に macOS が `EPERM` を返す競合窓が広がるため、下の 2 で `spawn.ts` をあわせて直す。

### 2. macOS のゾンビ専用プロセスグループに対する `EPERM` の扱い（`src/shared/utils/spawn.ts`）

macOS（XNU `bsd/kern/kern_sig.c` の `killpg1`）では、プロセスグループがまだカーネルに残っているがメンバーがすべて未回収ゾンビ（`SZOMB`）である状態（`nfound == 0`）に対し、`kill(-pgid, sig)`（`sig=0` を含む）が `ESRCH` ではなく **`EPERM`** を返し、`launchd`（PID 1）に回収されたあとに初めて `ESRCH` を返す。現行の `spawn.ts`（`signalPosixProcessGroup` / `isPosixProcessGroupRunning`）は `ESRCH` のみを無視して `EPERM` を再送出するため、`turnProcessHost.ts:182-183` の `managed.terminate()` から `input.onError(error)` へ無実の `EPERM` が漏れる（`managed-spawn.test.ts:69-72` がすでに `EPERM` を許容していたのと同じ現象）。

`spawn.ts` の `process.platform === 'darwin'` 経路で、一過性のゾンビ由来 `EPERM` と本物の権限エラー（euid の異なる生存メンバー）を **`ESRCH` への遷移** で区別する。

- `waitForPosixProcessGroupExit(pid)`: `darwin` で `process.kill(-pid, 0)` が `EPERM` を返したときは即座に例外を投げず、「グループがまだ残っている（未回収ゾンビまたは送信不能な生存メンバー）」として最後の `EPERM` を保持したまま `TERMINATION_SETTLE_INTERVAL_MS`（10 ms）間隔でポーリングを続ける。`TERMINATION_SETTLE_TIMEOUT_MS`（2 秒）以内に回収されて `ESRCH` が返れば正常終了し、期限まで `EPERM` が続けば本物の権限エラーとしてその `EPERM` を再送出する。Linux 等の他 POSIX では従来どおり即座に再送出する。
- `terminatePosixProcessTree(pid)`:
  - `SIGTERM` が `ESRCH` なら従来どおり `false` を返す。
  - `SIGTERM` が `darwin` の `EPERM` を返したときは、直ちに `waitForPosixProcessGroupExit(pid)` で回収を待つ。期限内に `ESRCH` が確認できれば「生存メンバーへ送らず自然に消滅した」として `false` を返す（`waitCommandProcess.ts:34` の自然終了判定も維持される）。期限まで `EPERM` が続けば `EPERM` を投げる。
  - `SIGTERM` が成功（`true`）したあとに `SIGKILL` が `darwin` の `EPERM` を返したときは、その `EPERM` を保留して `waitForPosixProcessGroupExit(pid)` を待ち、`ESRCH` でグループ消滅を確認できれば保留した `EPERM` を消して `true` を返す。期限まで `EPERM` が続けば `EPERM` を投げる。
  - `EACCES` や非 `darwin` の `EPERM` は従来どおり即座に失敗させる。
- `turnProcessHost.ts:182-183` は変えない。`spawn.ts` が一過性のゾンビ由来 `EPERM` を吸収し、本物の権限エラーだけが `input.onError(error)` へ伝わる契約を保つ。

### 3. 残存プロセス検査の拡張（`scripts/leftover-turn-processes.mjs`・`scripts/run-heavy-it-parallel.mjs`）

詳細は下の「影響」の「守りの仕組み」にまとめる。実行単位の隔離ルート（`TEST_USER_ISOLATION_ROOT`）で検出範囲を絞り、`uid` / `stat` による絞り込み・一括 `lsof`・リーダーのグループ強制終了と再スキャンを入れる。

### 採らなかった案

- **期限切れのときだけ送る（issue の案のまま）**: 上で書いたとおり、期限より前の `exit(1)` と正常終了のあとに親が落ちる窓が残る。置く場所が 1 か所増えるだけなので、広げるほうを採る。
- **SIGTERM のあと SIGKILL まで送る**: グループへの SIGKILL は自分も殺す。終了コード 1 の代わりにシグナル終了になり、期限も 250 ms 延びる。メンバーを列挙して自分以外に送るには `ps` を同期で呼ぶ必要があり、macOS と Linux で引数が違う。SIGTERM を無視する子孫は残る（範囲の外）として、こちらは採らない。
- **`spawnManagedProcess` で起こした子のグループにも、期限切れで送る**: それらは `business.close()` の `terminateManagedProcesses()` が期限内に止める（ターンが止まっていても `close()` は並行に呼ばれる。`processRuntime.ts:74`）。残るのは `close()` 自体が止まったとき、`initialization`（`createBusiness`）が止まって `close()` が一度も走らないとき（`processRuntime.ts:73`）、または `close()` 完了後から期限切れまでの 5 秒間に中断無視ターンが新たに `spawnManagedProcess` を呼んだとき（`spawn.ts:17-21` は呼び出し時点の集合しか止めない）であり、それらはいずれも今回の範囲の外にする。
- **`turnProcessHost.ts` 側で `EPERM` を無条件に握りつぶす**: 本物の権限エラー（euid の異なる生存メンバー）まで隠してしまい、`managed-spawn.test.ts` 等の他呼び出し元の競合も残る。`spawn.ts` 側で `ESRCH`（回収完了）を確認するほうを採る。

### 範囲の外

- SIGTERM を無視する子孫（親が落ちていると、誰も SIGKILL しない）。Quint では `wOrphanIgnoringDescendantLeft` として、残ることを明示している。
- euid の違うメンバー（setuid された子孫など）自身への配送。なお macOS の `kill(2)` man ページは失敗時にシグナルは送られない旨を書くが、実際の XNU カーネル（`bsd/kern/kern_sig.c` の `killpg1` / `killpg1_callback`）は送信可能なメンバーへ順に配送して `nfound` を加算し、`nfound == 0` のときだけ `EPERM` を返す。`signalOwnGroup()` では自分自身が送信可能メンバーなので、実際には Linux と同様に権限のある子孫へは届き、届かないのは euid の違う子孫だけである。
- 自分でグループを作り直した子孫（`setsid`・`detached: true`）。`spawnManagedProcess` の子、`clone-exec.ts:405`、deepseek-harness の supervisor、devin が追いかける子孫グループなどがこれに当たる。`-process.pid` では届かない。
- `business.close()` が止まったとき、`initialization`（`createBusiness`）が止まったとき、または `close()` 完了後に中断無視ターンが新たに `spawnManagedProcess` を呼んだときに、その別グループの子が掃除されないまま期限が切れる場合。
- `exitAfter` を通らない終わり方（捕まえていない例外での異常終了、外からの SIGKILL）。親が生きていれば親が掃除する。
- Windows（グループの扱いが違う。今と同じく何もしない）。
- `waitCommandProcess.ts:47` の `isProcessGroupRunning`（#177 で競合窓が広がる経路ではないため今回の範囲外）。
- daemon 本体の終了処理（[j5ik2o/takt#142](https://github.com/j5ik2o/takt/issues/142)）。

## 守る不変条件

前半の 1〜7 はそのまま守る（グループへの送信は同期で、時刻も終了コードも変えない）。足すのは次の 4 つ。

8. **親のいないグループの子孫には SIGTERM が届いている（`orphanedGroupSignalled`）**: ターン用プロセスが終わり、親も落ちていて（掃除する者がいない）、ターン用プロセスがグループを率いているなら、まだ動いているグループの子孫は SIGTERM を受け取り済みである。SIGTERM に応じる子孫はそのあと終わる（`descendantExitOnTerm`）。
9. **自分の率いるグループにしか送らない（`signalsOnlyOwnGroup`）**: グループを率いていない（`detached` なしで起動された）とき、`-process.pid` はどのグループも指さず、ほかのグループの子孫には何も届かない。モデルでは構成上成り立つ健全性の確認で、実物では後述の OS の前提に依る。
10. **親の終了後掃除がゾンビ由来の `EPERM` で誤報しない（`noSpuriousParentSweepError`）**: `signalOwnGroup()` で終了した子孫が未回収ゾンビだけになったグループへ親の `managed.terminate()` が重なっても、macOS の `EPERM` を `turnProcessHost` の `onError` に漏らさない。
11. **親の終了後掃除はグループ消滅後だけ正常完了する（`parentSweepClearsGroup`）**: 親の掃除がエラーなしで完了した状態では、生存中の子孫も未回収ゾンビもグループに残っていない（`waitForPosixProcessGroupExit` が `ESRCH` を確認している。構成上の健全性確認）。

設計を区別するのは 8（`noGroupSignal`・`timeoutOnlyGroupSignal` で反例、`fixed` で成り立つ）と 10（`everyExitWithoutEpermFix`・`timeoutOnlyGroupSignal` で反例、`fixed` で成り立つ）である。

## PBT の性質と除外

製品の変更は `exitAfter` の 2 か所と小さな関数 1 つ、および `spawn.ts` の macOS `EPERM` 待機処理であり、入力文字列やデータ構造の変換を持たない。そのため fast-check は使わず、状態遷移の性質を `quint run` の無作為シミュレーションで確かめる。初期構成（`initialized` × `hasTurn` × `stallAt` × `holdsHandle` × `closeFails` × 子孫の種類 3 通り × グループを率いるか）は `init` で全部を非決定に選び、除外する入力はない（`validConfig` が落とすのは実物で起こらない組み合わせだけ。子孫は初期化済みのときだけ置く）。

確かめる性質は、不変条件 1〜11 と次の到達（witness）である。

- 親が落ちたあとの期限切れで、SIGTERM に応じる子孫が終わる（`wOrphanDescendantGoneAfterTimeout`）
- 親が落ちたあとの後片付けの失敗（期限より前の `exit(1)`）でも終わる（`wOrphanDescendantGoneAfterFailedCleanup`）
- 正常終了のあと、親が掃除する前に落ちても、子孫は SIGTERM を受け取り済み（`wParentCrashAfterExitSignalled`）
- 親が生きていれば、終了後の掃除が子孫を消す（`wParentSweepAfterExit`）
- 親が生きていて子孫が未回収ゾンビだけになっていても、回収を待ってエラーなしで掃除を終える（`wParentSweepWaitsZombieReap`）
- 親生存中の IPC 切断後に子が終了する前に親が落ちる経路も通る（`wParentCrashAfterDisconnect`）
- SIGTERM を無視する子孫は残る（`wOrphanIgnoringDescendantLeft`。範囲の外を明示する）
- グループを率いていなければ何も届かない（`wNonLeaderDescendantUntouched`）

実プロセスでは、実装の段で次のテストを足す。

- heavy IT（`src/__tests__/daemon-turn-process.integration.test.ts`）に 2 件: ターン用プロセスは `detached: true` で起動し（グループを率いる）、`cwd` と設定ディレクトリには隔離済み `tmpdir()` 配下の `takt-test-global-*` を使う（万一テスト自身が子孫を漏らしても `scripts/leftover-turn-processes.mjs` の守りに掛かるようにする）。フィクスチャのターンは `detached` なし・`stdio: 'ignore'`（`exitedWithStderr` が待つ `stderr` パイプを子へ継承させない）で子（`setInterval` だけの node）を起こし、その PID を `turn_progress` で知らせる。テストが `child.disconnect()` で親の消失を作り、ターン用プロセスの終了後、子の PID が期限内に消えることを確かめる。`finally` では報告された子 PID だけでなく `-child.pid`（グループ全体）にも `SIGKILL` を送る。
  - 中断に応じないターン: 期限切れで終了コード 1 と診断文、その後に子が消える。修正前は子が残って失敗する。
  - 中断に応じるが子を残すターン: 期限より前に終了コード 1（`shutdown_complete` を送れない）、その後に子が消える。期限切れのときだけ送る形では失敗する。
  - 既存の 3 件は `spawn` を `detached` なしで呼んでいるので、グループを率いない場合（`ESRCH` を握って終了する）の確認を兼ねる。終了コードの検証（1 のまま）で、自分に届く SIGTERM が終了を変えないことも確かめる。
- `src/__tests__/managed-spawn.test.ts` に macOS `EPERM` 待機（ゾンビ専用グループで `EPERM` のあと `ESRCH` に遷移したらエラーにせず完了すること、期限まで `EPERM` が続く本物の権限エラーは `EPERM` を再送出すること）の確認を足し、既存の 69–72 行目の `EPERM` 許容も不要になったことを確認する。

足した回帰テスト（2026-11-27、実装の前に red を確かめた。TEST_TIME_FACTOR に従う）:

- `daemon-turn-process.integration.test.ts`: `signals its own process group before exiting when the parent is gone and …（#177）` の 3 件。フィクスチャ `src/__tests__/fixtures/descendant-spawning-turn-business.ts` が子を起こして PID を `descendant:<pid>` の進捗で知らせる。中断に応じない（期限切れ）、中断に応じるが後片付けが失敗する（期限より前）、SIGTERM のリスナーを外した（低2 の保険。`{ code: 1, signal: null }` のまま）の 3 通り。ターン用プロセスは `detached: true`、`cwd` と設定ディレクトリは `tmpdir()` 配下の `takt-test-global-*`、tsx は絶対 URL で読み込む。
- `managed-spawn.test.ts`:
  - 実 OS（perl の親が回収しない子でゾンビだけのグループを作る）: ゾンビだけのグループでは、回収後に macOS は `false`（`EPERM`、SIGKILL を送らない）、Linux は `true`（送信が成功する。低5）。子が SIGTERM で終わって回収を待つ間に猶予後の SIGKILL が当たる場合は、両 OS で `true`（低7）。
  - `process.platform` と `kill(-pgid)` の結果を差し替えた 4 件: macOS の SIGTERM の `EPERM` → `ESRCH` で `false`、SIGKILL の `EPERM` → `ESRCH` で `true`、`EPERM` が 2 秒続けば `EPERM` を投げる、Linux の `EPERM` は 2 秒待たずに投げる。
  - 既存の `should terminate a process group after its leader exits normally` から `EPERM` の許容を外した。
- `leftover-turn-processes.integration.test.ts`: 各テストは自分の `fixtureRoot()` を `isolationRoot` として渡す（低3）。主が抜けたグループの子孫、ゾンビの主のグループの子孫、`cwd` が `takt-test-global-*` でない子孫（低4。隔離ルートの配下だけで判定する）を報告して止める。別の隔離ルートの子孫は止めない。SIGTERM を無視する主を SIGKILL するとグループごと止まる。検出から送信までの間に範囲から外れたプロセスには送らない（低1。待ちの間に隔離ルートの外へ `chdir` させて表す）。報告の行は `kind`（`'turn'`・`'descendant'`）と `pgid` を持つ。
- 低2（`run-heavy-it-parallel.mjs` が受け継いだ `TEST_USER_ISOLATION_ROOT` を消す）は、スクリプトがトップレベルで Vitest を起こすので、この段では試験にしていない。

## 壊しうる入力・状況の一覧

| 状況・入力 | 扱い | 確認手段 |
|---|---|---|
| 親が落ちたあとの期限切れ（ターンが中断に応じない、`close()` が止まる、初期化が止まる） | `exit(1)` の前にグループへ SIGTERM | Quint (`orphanTimeoutSignalsGroupTest`, `orphanCloseHangsSignalsGroupTest`)・IT |
| 親が落ちたあと、期限より前の `exit(1)`（`shutdown_complete` を送れない） | `finally` でグループへ SIGTERM | Quint (`orphanFailedCleanupSignalsGroupTest`)・IT |
| 正常終了の直後、親の掃除が走る前に親が落ちる | 終了前に送り済み | Quint (`parentCrashAfterCleanExitStillSignalledTest`) |
| 並行：親生存中の IPC 切断後に、子が終了する前に親が落ちる | 切断時に `exitAfter` 済みのため、終了前にグループへ SIGTERM | Quint (`disconnectThenParentCrashSignalsGroupTest`, `wParentCrashAfterDisconnect`) |
| 親が生きている（子孫がまだ生存中、または `signalOwnGroup()` 後に未回収ゾンビだけ） | 生存中の子孫は親の SIGTERM/SIGKILL で消える。macOS で未回収ゾンビだけのグループへ `managed.terminate()` が当たって `EPERM` が返った場合は、`spawn.ts` が `ESRCH`（回収完了）までポーリングして誤報を防ぐ | Quint (`parentSigkillEndsIgnoringDescendantTest`, `parentAliveSweepsWithoutGroupSignalTest`, `parentSweepWaitsForZombieReapTest`, `everyExitWithoutEpermFixTest`)・`managed-spawn.test.ts` |
| SIGTERM を無視する子孫（親が落ちている） | 残る（範囲の外） | Quint (`orphanIgnoringDescendantStaysTest`) |
| 自分にも SIGTERM が届く | `index.ts:33` の `process.on('SIGTERM')` に加え、`signalOwnGroup()` 内で `process.listenerCount('SIGTERM') === 0` のときに空リスナーを登録してから送るため、リスナーが外れていても死なない。ハンドラは同期の `process.exit` より後になるので動かない | IT（終了コード 1 の検証）・コード確認 |
| グループを率いていない（`detached` なしで起動された。既存の IT など） | `kill(-pid)` は `ESRCH`。握って終了する。起動元のグループには何も届かない | Quint (`nonLeaderSignalsNothingTest`)・既存 IT |
| 別のグループ（`setsid`・`detached: true` の子孫、`spawnManagedProcess` の子） | 届かない。`spawnManagedProcess` の子は `close()` が止める（`close()` や `initialization` が止まった場合、`close()` 後に新規起動された場合は範囲の外） | 範囲の外として明記 |
| PID の再利用 | 送るのは自分が生きている間で、自分の PID はほかのプロセスに使われない。グループを率いていないのに同じ ID のグループが残っている状況は、そのグループの元の主が同じ PID を持っていて、それが再利用されたことを意味する。Linux と macOS は、グループ ID として使われている番号をプロセスに割り当てない（OS の前提） | 前提として明記 |
| 権限（setuid された子孫など、送れないメンバーがいる） | Linux でも macOS（XNU `killpg1` は送信可能なメンバーへ順に配送して `nfound` を加算し、`nfound == 0` のときだけ `EPERM`）でも、`signalOwnGroup()` では自分自身が送信可能メンバーなので権限のある子孫へは届き、届かないのは euid の違う子孫だけ（範囲の外。macOS の `kill(2)` man ページの文言より実挙動が緩い）。親側の `spawn.ts` では送信不能な生存メンバーだけが残ると 2 秒間 `EPERM` が続くため、本物の `EPERM` として報告される | XNU 実挙動・`managed-spawn.test.ts`・前提として明記 |
| macOS と Linux の違い | 違いは「残存メンバーが未回収ゾンビだけのグループへの `kill(-pgid, sig)`（`sig=0` 含む）が macOS では `EPERM`、Linux では `ESRCH` を返す」点。`spawn.ts` が `darwin` 限定で `EPERM` を `ESRCH` までポーリングして吸収する。`kill(-pgid)` のグループ配送・`ESRCH`・euid 違いに対する実挙動は共通 | Quint (`everyExitWithoutEpermFix`, `fixed`)・CI（Linux）・手元（macOS）で IT |
| イベントループが同期処理で塞がる | 期限のタイマーと同じく、送信も遅れる（前提は前半と同じ） | 前提として明記 |
| Windows | 何もしない | コード確認 |

## 影響

- **上流**: 該当なし（冒頭）。
- **保存済みデータ・公開 API**: 変更なし。`src/app/daemon-turn/index.ts` と `src/shared/utils/spawn.ts` の内部処理を変えるだけで、メッセージ・設定・CLI に触れない。
- **守りの仕組み（`scripts/leftover-turn-processes.mjs`・`scripts/run-heavy-it-parallel.mjs`）**: 今の検査はターン用プロセス（`dist/app/daemon-turn/index.js` か `src/app/daemon-turn/index.ts` を起動したもの）しか見ないので、グループに残った子孫は見つけない。レビューの中 1・中 2 の指摘を織り込み、実装の段で次を足す。
  - **実行単位の分離（中 1）**:
    - `scripts/run-heavy-it-parallel.mjs` は、`test:deepseek-harness:types` の直後・Vitest 起動前に `isolateUserDirectoriesForTestRun()`（`scripts/test-user-isolation.mjs`）を呼び、この実行に固有の隔離ルート `isolationRoot`（`<tmpdir>/tt-<random>`、`realpathSync.native` 済み）を確定する。Vitest は `TEST_USER_ISOLATION_ROOT` を引き継いで同じ隔離ルートを再利用するため、Vitest 終了時にルートが先に削除されず、`terminateLeftoverTurnProcesses` 完了後（`run-heavy-it-parallel.mjs` 終了時）に `rmSync(isolationRoot)` が走る。
    - `findLeftoverTurnProcesses(repositoryRoot, { isolationRoot })` / `terminateLeftoverTurnProcesses(repositoryRoot, { isolationRoot, ... })` に `isolationRoot` を渡す。`isolationRoot` 指定時は、ターン用プロセス・子孫ともに `cwd` が `isolationRoot` 配下（`realpathSync.native` で正規化した `isolationRoot + sep` の前方一致。Linux の ` (deleted)` 接尾辞にも一致する）かつ `/takt-test-global-` を含むものに限定する。これにより、別 worktree や並行実行中の `npm test` / `npm run test:it` / 別 Heavy IT のプロセスを拾わず・止めない。
    - `isolationRoot` が省略された呼び出し（既存単体・結合呼び出し）では、後方互換のためターン用プロセス（コマンドラインに `repositoryRoot` を含む）のみ検査し、子孫の検出は無効にする。
  - **ゾンビリーダー・全ユーザー `lsof`・リーダー `SIGKILL` 後の取り残しへの対処（中 2）**:
    - 検出クエリを `ps -axww -o pid=,pgid=,uid=,stat=,command=` に広げる。`livePids` は全ユーザーの行から `!stat.startsWith('Z')` の PID で作る（他ユーザー所有のリーダーを持つプロセスを誤って「主不在」とみなさないため）。
    - `cwd` を調べる候補は `uid === process.getuid()` かつ `!stat.startsWith('Z')` かつ `pid !== process.pid` に絞ったうえで、「ターン用プロセス（`entries` 一致）」または（`isolationRoot` 指定時のみ）「孤立子孫（`pid !== pgid && pgid > 1 && !livePids.has(pgid)`）」だけに限定する。ゾンビ自身は候補から外す。
    - macOS では候補 PID が空なら `lsof` を呼ばず、1 件以上のときは `lsof -a -p <pid1,pid2,...> -d cwd -Fn` を 1 回にまとめて実行し `p<pid>` / `n<path>` を解析する（一部 PID が途中で終了して `lsof` が非 0 終了しても標準出力から取得済み分を読む）。Linux では候補 PID だけに `readlinkSync('/proc/<pid>/cwd')` を呼ぶ。
    - 報告の行には種類（ターン用プロセスか子孫か）と `pgid` を出す。
    - 終了手順では、ターン用プロセスがグループリーダー（`kind === 'turn' && pid === pgid`）のとき `SIGTERM`・`SIGKILL` をプロセスグループ（`-pid`）へ送る（非リーダーや孤立子孫は `+pid` へ送る）。グループ送信で macOS のゾンビ由来 `EPERM` が出た場合は `+pid` へのフォールバックと生存確認に委ね、`ESRCH` は終了済みとみなす。さらに、1 回目の強制終了後に同じ `isolationRoot` 範囲で子孫を再スキャン（最大 2 パス）し、リーダー終了と検査の隙間や `SIGKILL` 後に残った子孫も取りこぼさず報告・終了する。
  - **危うさと検証**: 同一実行の隔離ルート内でも、ターンと関係のないテストが `/takt-test-global-` 配下にリーダー不在のプロセスを残していれば拾って heavy IT を落とす。実装の段で heavy IT を流し、拾ったものがあればその場で原因を確認する。
  - **`src/__tests__/leftover-turn-processes.integration.test.ts` への追加**: (1) 主が抜けたグループ・ゾンビ化した主のグループに残る子孫を報告して止めるケース、(2) 別の隔離ルート（別 worktree / 並行テスト相当）の `takt-test-global-*` 配下で動く子孫を検出・終了しないケース、(3) `SIGTERM` を無視するリーダーを `SIGKILL` で落とした際にそのグループの子孫も残らず止めるケース。

## 設計レビューの指摘への対応（#177）

設計の独立レビュー（2026-11-27、高 0・中 3・低 5）への対応。

| 指摘 | 対応 | 内容 |
|---|---|---|
| 中1 `scripts/leftover-turn-processes.mjs` の子孫検出にチェックアウト／実行単位の分離がなく、別 worktree や並行テストを誤検出・終了する | 直す | `run-heavy-it-parallel.mjs` が Vitest 起動前に `isolateUserDirectoriesForTestRun()` で隔離ルートを確定し、`isolationRoot` を渡して `cwd` を実行単位で絞る（省略時は子孫検出を無効にする）設計に直した |
| 中2 `scripts/leftover-turn-processes.mjs` の子孫検出・強制終了手順の 3 つの穴（リーダー `SIGKILL` 後の取り残し・ゾンビリーダー・全ユーザーへの `lsof`） | 直す | `ps` に `uid=,stat=` を足して非ゾンビ集合と現在ユーザーに絞り、macOS は `lsof` を一括実行する。リーダー（`pid === pgid`）は `-pid` へグループ送信し、強制終了後に子孫を再スキャン（最大 2 パス）する設計に直した |
| 中3 macOS のゾンビ専用プロセスグループに対する `EPERM` と親側 `turnProcessHost` / `spawn.ts` の競合 | 直す | `spawn.ts` の `darwin` 経路で `EPERM` を即失敗にせず `waitForPosixProcessGroupExit` が `ESRCH`（回収完了）までポーリングし、期限超過時のみ本物の `EPERM` を投げる方針を決めた。Quint に `descZombie`・`SWEEP_ZOMBIE_EPERM`・不変条件 10/11・反例モデル `everyExitWithoutEpermFix` を追加した |
| 低1 「`spawnManagedProcess` の子が残るのは `close()` 自体が止まったときだけ」の 2 つの取りこぼし（`StallInit` 中の起動と `close()` 後の新規起動） | 直す | 採らなかった案・範囲の外・壊しうる入力の表および Quint `README.md` の記述を、3 つの条件すべてを挙げる形に直した |
| 低2 自分自身への `SIGTERM` 配送が `process.on('SIGTERM')` の存続に暗黙依存している | 直す | `signalOwnGroup()` 内で `process.listenerCount('SIGTERM') === 0` のときに空リスナーを登録してから送る設計に直した |
| 低3 macOS の `kill(2)` `EPERM` に関する man ページの読み取りと XNU 実挙動（`killpg1` の `nfound`）の差 | 直す | 範囲の外・壊しうる入力の表・Quint `README.md` に XNU 実挙動と man ページ表記の差を正確に書き直した（euid 違いの子孫自体は範囲外のまま） |
| 低4 Quint モデルの未モデル化遷移（`ipcDisconnectWhileParentAlive` 後の親クラッシュ） | 直す | Quint モデルに `parentCrashAfterDisconnect`、witness `wParentCrashAfterDisconnect`、シナリオテスト `disconnectThenParentCrashSignalsGroupTest` を追加した |
| 低5 実装段で追加する IT（`daemon-turn-process.integration.test.ts`）の `cwd` と `stdio` の注意点 | 直す | #177 用 IT の設計に、子の `stdio: 'ignore'` 指定、`cwd` への隔離済み `takt-test-global-*` の使用、`finally` での `-child.pid` への `SIGKILL` を明記した |

## Quint の仕様と検査結果（#177）

状態に、グループの子孫の種類 `desc`（`DescNone`・`DescHonorsTerm`・`DescIgnoresTerm`）、グループを率いるか `groupLeader`、`descAlive`・`descZombie`・`descTermed`・`groupSignalled`・親の終了後掃除の状態 `sweep`（`SweepIdle`・`SweepWaitingReap`・`SweepDone`）・`parentSweepError` を足した。操作は、親が終了後に掃除する `parentSweepAfterExit`、ゾンビ回収後に掃除を終える `parentSweepFinishAfterReap`、終了後に親が落ちる `parentCrashAfterExit`、IPC 切断後に子が稼働中のまま親が落ちる `parentCrashAfterDisconnect`、SIGTERM を受けた子孫が終了してゾンビになる `descendantExitOnTerm`、ゾンビが回収される `descendantReaped` を足した。`parentSigkill` はグループ全体を SIGKILL するので、SIGTERM を無視する子孫も消す。設計の軸は `GROUP_SIGNAL`（`None`・`TimeoutOnly`・`EveryExit`）と `SWEEP_ZOMBIE_EPERM`（`Throw`・`WaitReap`）の 2 つで、`fixed` を `EveryExit` × `WaitReap` にし、`noGroupSignal`・`timeoutOnlyGroupSignal`・`everyExitWithoutEpermFix`（レビュー前の `06c8b3f1f` の形）を並べて比較する。#141 の場面は `initWith`（子孫なし、グループを率いる）のまま動く。

- `quint typecheck`: 本体・テストともに成功。
- `quint test`: `beforeTest` 5、`unrefTimerTest` 1、`noGroupSignalTest` 4、`timeoutOnlyGroupSignalTest` 2、`everyExitWithoutEpermFixTest` 2、`fixedTest` 23（#177 の 9 件を含む）、`noAbortTest` 1 の計 38 件すべて通過。
- `quint run`（`--max-samples 3000 --max-steps 15 --seed 0x2a`）:
  - `orphanedGroupSignalled`:
    - `noGroupSignal`（#141 のまま）: 反例。親生存中の IPC 切断 → SIGTERM → 親クラッシュ（`parentCrashAfterDisconnect`）→ 期限切れの `exit(1)`、子孫は SIGTERM を受け取らないまま動いている。
    - `timeoutOnlyGroupSignal`（期限切れのみ送信）: 反例。親クラッシュ → `shutdown_complete` を送れず期限より前に `exit(1)`、子孫は SIGTERM を受け取らないまま残る。
    - `before`・`unrefTimer` も反例（送らないので）。`everyExitWithoutEpermFix`・`fixed`・`noAbort` は違反なし。
  - `noSpuriousParentSweepError`:
    - `everyExitWithoutEpermFix`（レビュー前 `06c8b3f1f` の形、`EveryExit` × `Throw`）: 反例。SIGTERM・切断後に期限切れで `signalOwnGroup()` → 子孫が終了してゾンビ（`descendantExitOnTerm`）→ 親の `parentSweepAfterExit` がゾンビ専用グループへ当たり `parentSweepError = true`（macOS `EPERM` の誤報）。通常終了後でも同じ反例が出る（`everyExitWithoutEpermFixTest`）。
    - `timeoutOnlyGroupSignal`（`TimeoutOnly` × `Throw`）: 同じ経路（期限切れで親生存）で反例。
    - `fixed`（`EveryExit` × `WaitReap`）: 違反なし。
- `quint run`（`fixed`, `--invariant safety`, 20 本の witness, `--max-samples 10000 --max-steps 15 --seed 0x2a`）: 違反 0 件、20 本の witness すべて到達（`wParentSweepWaitsZombieReap`・`wParentCrashAfterDisconnect` を含む）。seed `0x1`・`0x7`・`0xbeef`（2 万標本・20 手）でも違反 0 件。

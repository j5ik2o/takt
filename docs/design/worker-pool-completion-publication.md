# worker pool の経路に、#170 の印と #171 の終了フックを通す

- Issue: [#195](https://github.com/j5ik2o/takt/issues/195)（setup 失敗で終了フックを呼ばない）、[#196](https://github.com/j5ik2o/takt/issues/196)（読めないゴールタスクの通知が ENOSPC で消え、出し直しも効かない）、[#197](https://github.com/j5ik2o/takt/issues/197)（通知のあとも印が残る）
- 基点: [#193](https://github.com/j5ik2o/takt/pull/193) の枝 `j5ik2o/takt-sync-upstream-main`（595d6a826）
- Quint: `specs/quint/worker-pool-completion-publication/`
- 前提の設計: `docs/design/goal-task-completion-publication.md`（#170）、`docs/design/task-finish-hook-notice-loss.md`（#171）

## 結論

worker pool の経路で、ゴールタスクの失敗を保存する 3 か所（読めない内容、claim の setup 失敗、遠隔の実行の終わり）を、#170・#171 がマージ済みの経路と同じ形にそろえる。元帥は、この直しを #193 に入れる形で通した（段2・段3 の 3 コミット、66cdd2963・76659ff46・d7d15cf43）。

1. 保存と同じ書き込みで `completion_publication_pending: true` を付ける。遠隔の終わりにも付ける。
2. 通知は、マージ済みの経路が使う `publishAndClearPendingMark` を通す。通知が成功したら印を消す。
3. 通知の失敗は捕まえて警告し、例外を runtime の外へ出さない。印が残るので daemon が出し直す。上流から入った単体試験 2 件の期待（通知の失敗で `start()` / `remote()` が reject する）は、この形に合わせて改める（「上流と違う振る舞い」の節）。
4. 3 か所とも、通知のあとで `runTaskFinishHooksForStates` を 1 回だけ呼ぶ。遠隔の終わりは、今は誰もフックを呼ばない（3 節）ので、daemon 側で呼ぶ。

試験と本番への頼みは、#209・#211 の分と合わせて `docs/design/193-worker-pool-requests.md` に 1 件 1 行で並べた。

## いまの動きの突き合わせ

### マージ済みの経路が約束していること

`takt run` と `takt watch` の経路（`claimAvailableTasks`、`src/features/tasks/execute/parallelExecution.ts:331-354`）は、次のことを約束している。

| 約束 | 場所 |
|---|---|
| setup 失敗の保存に印を付ける（読めない内容も setup 失敗として扱う） | `taskLifecycleService.ts:383-389`（`toTaskInfo` が投げたら `recordSetupFailure`）、`:471-482`（`buildSetupFailedTaskRecord`） |
| 通知を出し、成功したら印を消す。印を消せなくても警告するだけ | `claimTasks.ts:100-112`（`publishAndClearPendingMark`） |
| 通知の失敗は警告して claim を失わない | `claimTasks.ts:118-126`（`publishSetupFailure`） |
| setup 失敗に終了フックを呼ぶ。呼べなければタスク名つきで警告する | `parallelExecution.ts:348`（`runTaskFinishHooksForStates`）、`taskFinishHook.ts:281-310` |
| 中断の回収にも印を付け、通知して消す | `taskLifecycleService.ts:523-590`、`claimTasks.ts:128-138` |
| 印の残った記録は daemon が出し直す | `taskStateReader.ts:98`（`readPendingGoalTaskCompletions`）、`watchSource.ts:125`・`:157` |

通常の実行の完了（`parallelExecution.ts:497-503`）には印を付けない。#170 の設計の「変えないこと・範囲の外」にある。

### worker pool の経路の今の動き（595d6a826）

daemon は `runDaemon.ts:183` で `TaskDispatcher` を作り、`BuiltinWorkerAdapter`（`src/infra/worker-pool/builtinWorkerAdapter.ts`）が `BuiltinProjectRuntime.start()` を呼ぶ。遠隔の worker の要求は `BuiltinProjectRuntime.remote()` から `RemoteTaskLifecycle.request()` へ行く。この経路で、終わりの記録・通知・終了フック・印を扱う場所は次の 6 つ。

| # | 場所 | 保存 | 印 | 通知 | 通知の失敗 | 印の消し込み | 終了フック |
|---|---|---|---|---|---|---|---|
| W1 | `inspect()`（`builtinProjectRuntime.ts:86`）→ `failInterruptedTasksWithGoalEvents` | 中断の回収 | 付く | `publishAndClearPendingMark` | 警告 | する | 呼ばない（マージ済みの経路も同じ） |
| W2 | `remote()` の unreadable（`:148-150`）→ `failUnreadableGoalTask` | 読めない内容 | **付かない** | `saveCompletion`（`:170-175`）が `saveManagerEvent` を直接 | **投げる** | — | **呼ばない** |
| W3 | `startTask()` の読めない内容（`:193-199`）→ `failUnreadableGoalTask` | 読めない内容 | **付かない** | 同上 | **投げる** | — | **呼ばない** |
| W4 | `startTask()` の claim 失敗（`:213-215`）→ `claimTask` → `buildSetupFailedTaskRecord` | setup 失敗 | 付く | 同上 | **投げる** | **しない** | **呼ばない** |
| W5 | `startTask()` の実行の完了（`:222-226`） | 通常の完了（`completeTask`） | 付かない（マージ済みの経路も同じ） | `saveManagerEvent` を直接 | 投げる（同じ） | — | `withTaskFinishHook`（`taskExecution.ts:126`）が呼ぶ |
| W6 | `RemoteTaskLifecycle.request()` の finish / fail（`remoteTaskLifecycle.ts:120-166`） | 遠隔の終わり | **付かない** | `saveManagerEvent` を直接（`:163-166`） | **投げる** | — | 呼ばない |

太字が、マージ済みの経路の約束から外れている所。W1 と W5 はマージ済みの経路と同じ形で、この設計では変えない。

- W2・W3 の印の抜けは、`failUnreadableGoalTask` が使う `buildUnreadableGoalTask`（`taskLifecycleService.ts:310-317`）が印を書かないことから来る。マージ済みの経路では、読めない内容は claim の中で `buildSetupFailedTaskRecord` を通るので印が付く。worker pool は claim の前に `toTaskInfo` で内容を確かめ（`builtinProjectRuntime.ts:193`）、別の関数で保存する。
- 「投げる」の行き先は重い。`start()` が reject すると `BuiltinWorkerAdapter`（`builtinWorkerAdapter.ts:12-13`）が `hostFailed` を呼び、`TaskDispatcher.hostFailed`（`taskDispatcher.ts:73-79`）がプロジェクトの host を閉じる。host を閉じると、そのプロジェクトで走っている別のタスクまで中断する。
- W6 の `fail` は、遠隔の worker の登録が消えたか、接続が切れて lease が過ぎたときに daemon が送る（`remoteWorkerRuntime.ts:106-108`）。マージ済みの経路で、走っていたタスクを失った run を回収するのは `reconcileLostRun`（印を付ける。#170 の 3 経路の 1 つ）で、W6 の `fail` はこれに近い。W6 の `finish` は通常の完了に近い。

点検の記録（F03-2）の #196 の再現は W3 の形で、`saveManagerEvent` を ENOSPC にすると `start()` が reject し、保存は `failed` で印が無く、`readPendingGoalTaskCompletions` は空を返した。

## 直し方

### 1. 印を付ける場所

- W2・W3：`buildUnreadableGoalTask`（`taskLifecycleService.ts:310-317`）の `buildTerminalTaskRecord` に `completion_publication_pending: true` を足す。`buildSetupFailedTaskRecord` と同じ書き方で、保存と同じ `store.update` の中で付く。この記録は `goal_id`・`completion`・終端の `status`・`run_slug` を持つので、印の有効条件（`taskRecordSchemas.ts:17` の 4 条件）を満たす。
- W4：すでに付いている。変えない。
- W6：`remoteTaskLifecycle.ts:138-151` の `buildTerminalTaskRecord` に、`task.goal_id !== undefined` のとき `completion_publication_pending: true` を足す（元帥の決定で確定）。`run_slug` はこの書き込みで必ず付く（`:145`）。

`buildClaimedTaskRecord`・`buildRetryTaskRecord`・`requeueExceededTask` は再 claim と出し直しで印を外す（#170 の 1 節）。W6 の `fail` で `failed` になった記録は、遠隔の再試行（`remote_assignment.retryReservation`）で `pending` に戻ることがある。muse は、その書き込みが `buildRetryTaskRecord` を通るか、通らないなら印を外しているかを確かめる。印が残ったまま `pending` に戻ると、読むときに警告つきで落とされる（`taskRecordSchemas.ts:320-327`）。

### 2. 通知と、`saveManagerEvent` が投げたときの扱い

通知は、マージ済みの経路の関数をそのまま通す。二重に書かない。

- W2・W3・W4：`BuiltinProjectRuntime.saveCompletion` を、`claimTasks.ts` の `publishSetupFailure` を呼ぶ形に置き換える。`publishSetupFailure` を export するだけで、中身は変えない。これで、通知の成功のあとの印の消し込み（W4 の #197）と、失敗したときの警告（「failed during setup and is saved as failed in .takt/tasks.yaml, but the manager was not notified」）がマージ済みの経路と同じになる。読めない内容も、マージ済みの経路では setup 失敗として同じ文面で警告されるので、文面はそのままでよい。
- W6：`RemoteTaskLifecycle` は `src/infra/task/` にあり、`src/features/` の `claimTasks.ts` を読めない。そこで `publishGoalCompletion` と `publishAndClearPendingMark`（`claimTasks.ts:83-112`）を `src/infra/task/goalCompletionPublication.ts`（新規）へ移し、`claimTasks.ts` と `RemoteTaskLifecycle` の両方から呼ぶ。
  - 移した `publishAndClearPendingMark` は、`TaskRunner` の代わりに印を消す関数を受け取る。`claimTasks.ts` は `taskRunner.clearCompletionPublicationPending` を渡す。
  - `RemoteTaskLifecycle` は `TaskRunner` を持たず、`TaskStore` を持つ。`TaskLifecycleService.clearCompletionPublicationPending`（`taskLifecycleService.ts:593-618`）の本体は `this.store.update` だけを使うので、`(store, taskName, identity)` を受け取る関数として切り出し、メソッドはそれを呼ぶだけにする。`RemoteTaskLifecycle` はこの関数を自分の `store` で呼ぶ。
  - `RemoteTaskLifecycle` の通知の失敗は、`publishSetupFailure` と同じ形で `try/catch` + `warn()` + `log.error()` にする。文面は「Goal task <name> (goal <id>) finished on remote worker <worker> and is saved as <status> in .takt/tasks.yaml, but the manager was not notified: <detail>」。`request()` は保存した記録の返事をそのまま返す。
  - `RemoteTaskLifecycle` のコンストラクタの引数は変えない（既存の単体試験が 3 引数で作る）。

`saveManagerEvent` が投げても、`start()` は `{ kind: 'declined' }` を返し、`remote()` は今と同じ返事を返す。`claim_retry` にはしない。上流の単体試験の名前（「propagates %s completion notification failures outside acquisition retry」）が守っている「取得の再試行と取り違えない」はそのまま残る。

### 3. 終了フックを呼ぶ場所と警告

- W2・W3・W4 で、通知のあとに `await runTaskFinishHooksForStates(this.cwd, [task])` を呼ぶ。マージ済みの経路と同じく、通知が先でフックが後。`runTaskFinishHooksForStates` は投げない。フックの設定が読めないか、フックが落ちたときは、`reportLostHook` がタスク名つきの 1 行を出す（#171）。
- `remote()` の W2 は `async` なので、そのまま `await` できる。`startTask()` の W3・W4 も同じ。フックの待ち時間（最大 60 秒）のあいだ、`start()` は返らない。マージ済みの経路の `claimAvailableTasks` も同じように待つ。
- W6（遠隔の終わり）は、今は誰もフックを呼ばない。
  - 遠隔の worker の子は `executeWorkflowForRun` を直接呼ぶ（`src/features/workerPool/remoteTaskProcess.ts:75`）。フックを呼ぶ `withTaskFinishHook`（`taskExecution.ts:126`）は通らない。`src/features/workerPool/`、`src/infra/worker-pool/`、`src/app/worker-pool-project/` に `taskFinishHook` を呼ぶ行は無い（`grep` で 0 件）。
  - daemon 側の `RemoteTaskLifecycle.request()`（`remoteTaskLifecycle.ts:120-167`）も、終わりの記録を保存して通知するだけで、フックを呼ばない。
  - 組み込みの runtime は `remote_assignment` のある記録を断る（`builtinProjectRuntime.ts:191`）ので、遠隔のタスクを組み込みで実行し直してフックを呼ぶこともない。
- そこで W6 も daemon 側で呼ぶ。`RemoteTaskLifecycle` のコンストラクタに 4 つめの引数 `onTerminal?: (task: TaskState) => Promise<void>` を足し、`request()` が終わりの記録を新しく保存して通知したあと（`:157-167` の `updated !== null && request.kind !== 'renew'` の中）で 1 回だけ呼ぶ。`BuiltinProjectRuntime` は `(task) => runTaskFinishHooksForStates(this.cwd, [task])` を渡す。`infra` は `features` の `taskFinishHook.ts` を読めないので、呼ぶ関数は外から渡す。既存の単体試験は 3 引数で作るので、4 つめは省ける形にする。
- フックが 2 回にならないこと。遠隔の worker が返事を受け取れずに `finish` を送り直しても、記録はもう `running` でないので、`:93` で早く返るか、`:123` の条件で何も保存しない。`fail` が `finish` のあとに来ても同じ。どちらも `updated` が `null` なので `onTerminal` を呼ばない。組み込みの実行の完了（W5）は `withTaskFinishHook` が 1 回呼び、この設計では足さない。

### 4. 通知のあとの印の消し込み

`publishSetupFailure` → `publishAndClearPendingMark` を通すことで、W4 の印は通知の成功のあとに消える（#197）。W2・W3・W6 も、1 で付けた印が同じ関数で消える。消すのに失敗したら警告だけ出し、daemon が受信箱へ出し直して印を消す（受信箱は決定的な `eventId` で同じ試みを 1 回に畳む）。

## 守る不変条件

1 回の試みについて、次の 6 つを守る。I1 が #196、I3 が #195、I4 が #197 に当たる。

- **I1** 保存した完了は manager に届くか、印が残って daemon に出し直される。
- **I2** manager への通知の失敗は runtime の外へ出ない。プロジェクトの host は閉じず、走っている別のタスクを中断しない。
- **I3** 保存（読めない内容、claim の setup 失敗、遠隔の終わり）のあとで runtime が返るとき、終了フックが走ったか、タスク名つきの警告が出ている。
- **I4** runtime が自分で通知したあとは、印を消すのに失敗して警告した場合を除き、印は残らない。
- **I5** runtime が通知できずに返るときは、警告が出ている。
- **I6** 終了フックは 1 回の試みにつき 1 回までしか走らない。遠隔の `finish` の送り直しでも 2 回目は無い。

## Quint

`specs/quint/worker-pool-completion-publication/workerPoolCompletionPublication.qnt`。1 回の試みの保存から、通知、印の消し込み、終了フック、遠隔の `finish` の送り直し、daemon の出し直しまでを書いた。`DESIGN` が `"Current"`（595d6a826）と `"Design"`（この設計）を選ぶ。ディスクはいつでも埋まり、空く。runtime のプロセスは保存のあといつでも死ぬ。quint は 0.32.0。

### (a) 不変条件が恒真でない

`design` は 50,000 サンプル、max-steps 16、seed 0x2a で `safety`（I1〜I6）の違反なし。乱択で、証明ではない。

`current`（595d6a826）は 20,000 サンプル、max-steps 12 で次のとおり。

| 不変条件 | 結果 | 反例の形 |
|---|---|---|
| I1 `deliveredOrMarked` | 違反 | 読めない内容を保存した直後。印が無く、まだ届いていない |
| I2 `notificationFailureStaysInside` | 違反 | ディスクが埋まり、`saveManagerEvent` が投げてプロジェクトが閉じる |
| I3 `localSaveCallsHook` | 違反 | 保存のあと、フックを呼ばずに返る（遠隔の終わりも同じ） |
| I4 `publishedClearsMark` | 違反 | claim の setup 失敗を通知したあと、印が残る |
| I5 `unpublishedIsWarned` | 違反なし | `current` は通知の失敗で `Done` に届かない（例外で抜ける）ので、前提が成り立たない |
| I6 `hookAtMostOnce` | 違反なし | `current` はフックを 1 回も呼ばない |

`design` を 1 か所ずつ壊した版（作業ツリーの外で作り、流したあと消した）。

| 版 | 壊したところ | 見た不変条件 | 結果 |
|---|---|---|---|
| D1 | 読めない内容の保存に印を付けない | I1 | 違反 |
| D2 | 遠隔の保存に印を付けない | I1 | 違反 |
| D3 | `saveManagerEvent` を捕まえない | I2 | 違反 |
| D4 | 読めない内容にフックを呼ばない | I3 | 違反 |
| D5 | 通知のあとで印を消さない | I4 | 違反 |
| D6 | 捕まえた失敗を警告しない | I5 | 違反 |
| D7 | daemon が出し直したあとも印を消さない | `safety` 全体 | 違反なし |
| D8 | 遠隔の終わりにフックを呼ばない（595d6a826 の遠隔の経路） | I3 | 違反 |
| D9 | 遠隔の `finish` の送り直しでフックをもう一度呼ぶ | I6 | 違反 |

D7 は、印が残り続けて daemon が毎回出し直す形で、I1〜I6 のどれも壊さない。daemon が印を消すこと（と、印が残る間 daemon が止まらないこと）は #170 のモデル `specs/quint/goal-task-completion-publication/` が見ている。

### (b) 遷移に届く

`design` の witness（20,000 サンプル、max-steps 16、seed 0x2a）。どの遷移も届く。

| witness | 届いた trace |
|---|---|
| 読めない内容 / claim の setup 失敗 / 遠隔 の保存 | 6620 / 6698 / 6682 |
| `publish` / `publishFails` | 5790 / 4108 |
| `clearMark` / `clearFails` | 1616 / 505 |
| フックが走る / フックを失って警告 | 1890 / 1944 |
| 遠隔の終わりでフックが走る / 遠隔の `finish` の送り直し | 603 / 1267 |
| `kill` / `daemonResend` | 16161 / 18401 |
| 死んだあとに daemon が届ける / 通知の失敗のあとに daemon が届ける | 11952 / 1917 |
| runtime が返る（`Done`） | 3834 |

### (c) 本番との対応

| モデル | 本番（595d6a826） |
|---|---|
| `save(Unreadable)` | `taskLifecycleService.ts:290-317`（`failUnreadableGoalTask` / `buildUnreadableGoalTask`）。呼び出しは `builtinProjectRuntime.ts:149`・`:196` |
| `save(ClaimFailed)` | `taskLifecycleService.ts:283-288`（`claimTask`）→ `:334-454` → `:471-482`。呼び出しは `builtinProjectRuntime.ts:208` |
| `save(Remote)` | `remoteTaskLifecycle.ts:120-156` |
| `marksOnSave` | 印の有無。`Current` は `buildSetupFailedTaskRecord` だけが付ける |
| `publish` / `publishFails` | `Current`：`builtinProjectRuntime.ts:170-175`、`remoteTaskLifecycle.ts:163-166`。`Design`：`claimTasks.ts:100-126` |
| `projectClosed` | `builtinWorkerAdapter.ts:12-13` → `taskDispatcher.ts:73-79` |
| `clearMark` / `clearFails` | `taskLifecycleService.ts:593-618`、`claimTasks.ts:103-111` |
| `finishAttempt` | `taskFinishHook.ts:281-310`（`runTaskFinishHooksForStates`）。`Current` は 3 か所とも呼ばない |
| `repeatRemoteFinish` | `remoteTaskLifecycle.ts:93`（記録が `running` でない `finish` は早く返る）、`:123` |
| `kill` | 本番のコードは無い（プロセスの終了） |
| `daemonResend` | `watchSource.ts:125`・`:157` → `readPendingGoalTaskCompletions`（`taskStateReader.ts:98`）→ `publishPendingGoalTaskCompletions` |
| `diskFills` / `diskFrees` | 本番のコードは無い（環境） |

### (d) 範囲

- 1 回の試みだけ。再 claim・出し直しで記録が `pending` に戻る展開、同じタスクの 2 回目の試み、別のタスクとの競合は見ていない。
- 受信箱の写しの数（同じ試みの写しを 1 回に畳むこと）は見ていない。`delivered` は「届いた」の 1 ビットである。
- daemon が印を消すことと、印のある間 daemon が終わらないことは、#170 のモデルの範囲で、ここでは見ていない（D7）。
- W1（中断の回収）と W5（通常の完了）は、マージ済みの経路と同じ形なのでモデルに入れていない。
- max-steps 16。ディスクの出し入れでどの trace も 17 状態まで伸びるが、runtime の遷移は 5 つ以下で終わる。

## red のテスト（Sonnet が書く）と本番の直し（muse が書く）

`docs/design/193-worker-pool-requests.md` の「#195・#196・#197」の節に、1 件 1 行で並べた。

## #193 に入れるか

**#193 に入れる**。元帥がこの形で通した。

- #193 をマージすると、daemon のゴールタスクは `TaskDispatcher` → `BuiltinProjectRuntime` を通る。`takt run` の経路の #170・#171 の約束（マージ済み）が、統合ブランチの daemon の経路では守られない期間ができる。#193 のマージは今止めてあるので、ここで入れれば、その期間を作らない。
- 直しは worker pool の 2 ファイルと、`taskLifecycleService.ts`・`claimTasks.ts` の小さな移動に収まり、新しい試験は 1 ファイルにまとまる。#193 の差分の中で読める大きさである。
- 別の PR にすると、#193 のマージからその PR のマージまで、読めないゴールタスクの通知が ENOSPC で消える（#196 は使い捨ての木で再現済み）。

## #188（[#200](https://github.com/j5ik2o/takt/issues/200)）の設計との接点

#188 の設計（作業ツリー takt-188-dual-warning、8a33773e4 の `docs/design/same-save-dual-warning.md`）が、この経路を前提にするときに決めておくこと。中身は #188 の設計で決める。

1. **保留の置き場が無い呼び出し**。#188 は `publishSetupFailure` の警告を、`claimTasksWithGoalCompletions` が作る `setupFailedTasks` 配列に `WeakMap` で結んで保留する。worker pool の経路は `claimTasksWithGoalCompletions` を通らずに `publishSetupFailure` を呼ぶ。この呼び方のとき、保留せずにすぐ警告するのか、worker pool も配列を作って同じ配列をフックへ渡すのかを決める。後者なら、`publishSetupFailure` に置き場を渡す引数が要る。
2. **同じ保存の 2 本**。worker pool の W2・W3・W4 は、この設計のあと、マージ済みの経路と同じ組（manager の通知の警告と、フックの取りこぼしの警告）を同じ保存で出しうる。#188 の「いま 2 本が出る場所」と「対象外」に、この経路の名前を書く。
3. **遠隔の終わり**。W6 も通知のあとでフックを呼ぶので、manager の通知の警告とフックの取りこぼしの警告の組が、同じ保存で起きうる。フックを呼ぶのは `RemoteTaskLifecycle` の `onTerminal` の中で、通知の警告は `RemoteTaskLifecycle` が出す。#188 の保留の置き場をここへも渡すかを決める。
4. **出力先**。`publishSetupFailure` の `warn()` は stdout に、`reportLostHook` は stderr に書く。worker pool の runtime は daemon の中で動くので、どちらも daemon の記録に入る。#188 が出力先を 1 本にそろえるとき、この経路でも同じ先になるかを確かめる。

## 上流 nrslib/takt

上流の main（1b1e6bb7c）の `builtinProjectRuntime.ts` と `remoteTaskLifecycle.ts` は、W2〜W6 と同じ行に同じ形を持つ（`saveCompletion` が `saveManagerEvent` を try なしで呼び、終了フックを呼ばない）。上流には `completion_publication_pending` と `readPendingGoalTaskCompletions` がそもそも無いので、「出し直しも効かない」は上流では元からの形である。記録だけで、上流へは何もしない。

## 決まったこと（元帥の答え、11/28）

1. 上流の単体試験 2 件の期待は変えてよい。試験の名前と意図を「失敗しても外へ投げず、印が付き、出し直される」に改め、assert は厳密なまま消さず、新しい期待の assert を足す（`193-worker-pool-requests.md` の S5・S6）。
2. 遠隔の終わりにも印を付ける。
3. 遠隔の終わりのフックは、遠隔の側も daemon 側も呼んでいなかったので、daemon 側で呼ぶ形にした（3 節）。どの経路でもフックが 1 回だけ呼ばれることを確かめる試験を足す（S7）。

## 上げる点

1. **通常の完了（W5）の通知の失敗**。W5 の `saveManagerEvent` が投げると、実行の `.then` が reject し、`this.failed` でプロジェクトが閉じる。マージ済みの経路（`parallelExecution.ts:497-503`）と同じ形で、#170 の範囲の外なので、この設計では変えない。
2. **遠隔の終わりのフックの待ち時間**。W6 のフックは `request()` の中で待つので、遠隔の worker の `finish` の返事が、フックの時間（最大 60 秒）だけ遅れる。遠隔の worker が返事を待つ時間の上限との関係は確かめていない。上限より長くなると `finish` が送り直されるが、2 回目は何も保存しない（I6）。

## 上流と違う振る舞い（次の上流の取り込みのために）

上流 nrslib/takt に同じ直しは無い（上流には印と出し直しの仕組みそのものが無い）。次の上流の取り込みで、次の試験とコードが競合したときは、フォークの側を残す。

| 試験・コード | 上流の振る舞い | フォークの振る舞い | 理由 |
|---|---|---|---|
| `src/__tests__/worker-pool-runtime.test.ts` の「propagates %s completion notification failures outside acquisition retry」（`it.each(['recheck', 'claim'])`） | 通知の失敗で `start()` が reject する | 名前を改め、`start()` は `{ kind: 'declined' }` を返し、印が付き、警告が出る | 印があれば daemon が出し直すので、例外を外へ出すと別のタスクまで中断するだけになる（I2） |
| 同ファイルの「rechecks unreadable remote input after the claim and publishes the saved terminal result」の後半 | 通知の失敗で `remote()` が reject する | `remote()` は `{ kind: 'claim', assignment: null }` を返し、印が付き、警告が出る | 同上 |
| `src/features/workerPool/builtinProjectRuntime.ts` の `saveCompletion` | `saveManagerEvent` を直接呼ぶ | `publishSetupFailure` と `runTaskFinishHooksForStates` を呼ぶ | #170・#171 の約束を worker pool の経路にも通す |
| `src/infra/task/remoteTaskLifecycle.ts` の `request()` の終わり | 印なし、通知の失敗は投げる、フックなし | 印を付け、`publishAndClearPendingMark` で通知し、失敗は警告、`onTerminal` でフック | 同上 |
| `src/infra/task/taskLifecycleService.ts` の `buildUnreadableGoalTask` | 印なし | 印を付ける | 同上 |

## 範囲の外

- W1（中断の回収）と W5（通常の完了）。マージ済みの経路と同じ形。
- worker pool の `claimTask` は `goalSetupGuard`（マージ済みの経路の `createRuntimeAssignmentSetupGuard`）を渡さない。setup の確かめの差で、この設計では見ていない。
- daemon の出し直し（`publishPendingGoalTaskCompletions`）、受信箱の `eventId`、`hasWork` の数え方。#170 の設計のまま変えない。

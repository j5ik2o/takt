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
4. 3 か所とも、通知のあとで `runTaskFinishHooksForStates` を 1 回だけ呼ぶ。遠隔の終わりは、今は誰もフックを呼ばない（3 節）ので、daemon 側で呼ぶ。フックは runtime が返事を返したあとに走らせ、返事を待たせない。runtime の `close()` は、まだ走っているフックを待つ（3 節、段7 の決定）。
5. 通常の完了（W5）の通知の失敗も、捕まえて警告し、host を閉じない。通常の完了には印を付けない（5 節）。遠隔の終わりは、保存から返事までのどの段が失敗しても返事を返す（6 節）。

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
- 「投げる」の行き先は、経路ごとに違う（段7 で読み直して直した）。
  - W3・W4（`start()` が reject）：`BuiltinWorkerAdapter`（`builtinWorkerAdapter.ts:12-13`）が `hostFailed` を呼び、`TaskDispatcher.hostFailed`（`taskDispatcher.ts:73-79`）がプロジェクトの host を閉じる。host の `close()` は runtime の `close()` を呼ぶので、そのプロジェクトで走っている別の組み込みの実行まで中断する。
  - W5（実行の `.then` で投げる）：`hostFailed` は通らない。`.catch`（`builtinProjectRuntime.ts:234-239`）の `this.failed` が、子の `stop()`（`src/app/worker-pool-project/index.ts:11-17`）→ `runtime.close()`（全実行を中断）→ `process.disconnect()` と進み、daemon 側の `BuiltinProjectHost` が切断で閉じる（`projectHost.ts:69`、`:48-56`）。結果は同じく、そのプロジェクトの実行がすべて止まる。
  - W2・W6（`remote()` が reject）：`BuiltinWorkerAdapter` を通らないので host は閉じない。`RemoteWorkerRuntime.receive` から外へ出て、`remoteTransport.ts:92` の `sink.fail` で遠隔の worker との接続が切れ、`reportDaemonError` に出る。W6 では、記録は保存済みなのに `RemoteWorkerRuntime.records` の更新と `dispatcher.release`（`remoteWorkerRuntime.ts:246-249`）が行われず、daemon の持つ割り当てと保存がずれる。
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

- W2・W3・W4・W6 の 4 か所とも、通知のあとに `runTaskFinishHooksForStates(this.cwd, [task])` を 1 回呼ぶ。マージ済みの経路と同じく、通知が先でフックが後。`runTaskFinishHooksForStates` は投げない。フックの設定が読めないか、フックが落ちたときは、`reportLostHook` がタスク名つきの 1 行を出す（#171）。
- **フックは返事のあとに走らせ、返事を待たせない（段7 の決定）**。返事の前にフック（最大 60 秒、`src/core/models/task-finish-hook.ts:4`）を待つと、次の 2 つが起きる。
  - daemon からプロジェクトの host への要求は 30 秒で時間切れになり、切れると daemon が host を閉じる（`projectHost.ts:72-74`）。30 秒を超えるフックは、そのプロジェクトの実行をすべて止める。
  - 遠隔の要求は、daemon の中ですべての worker とプロジェクトの分が 1 本の列で順に処理される（`remoteWorkerRuntime.ts:46-51` の `serialize`）。finish の返事がフックを待つあいだ、ほかの遠隔の実行の heartbeat の renew（`:267-274`）も列に詰まる。lease は 60 秒（`remoteProtocol.ts:6`、設定できない）なので、フックが長いと別の実行の lease が切れ、定期の点検（`:100-113`）がそれを `failed` にするか、その実行の finish が `record: null` で捨てられる（`remoteTaskLifecycle.ts:97`、`:124`）。遠隔の worker の側には返事を待つ上限が無い（`remoteWorker.ts:86-87`、`remoteTransport.ts:136-142`、サーバの `requestTimeout = 0`）ので、時間で切れるのは lease だけである。
- 形：`BuiltinProjectRuntime` に `pendingHooks: Set<Promise<void>>` を足し、`scheduleFinishHook(task)` がフックを始めて集合に入れ、終わったら外す。W2・W3・W4 は `saveCompletion` の中で、W6 は `RemoteTaskLifecycle` の `onTerminal` から、これを呼ぶ。どれも `await` しない。`close()` は `starting`・`active` と並べて `pendingHooks` を待つ。待たないと、閉じるときに走っていたフックが 0 回になる。
- W6（遠隔の終わり）は、今は誰もフックを呼ばない。
  - 遠隔の worker の子は `executeWorkflowForRun` を直接呼ぶ（`src/features/workerPool/remoteTaskProcess.ts:75`）。フックを呼ぶ `withTaskFinishHook`（`taskExecution.ts:126`）は通らない。`src/features/workerPool/`、`src/infra/worker-pool/`、`src/app/worker-pool-project/` に `taskFinishHook` を呼ぶ行は無い（`grep` で 0 件）。
  - daemon 側の `RemoteTaskLifecycle.request()`（`remoteTaskLifecycle.ts:120-167`）も、終わりの記録を保存して通知するだけで、フックを呼ばない。
  - 組み込みの runtime は `remote_assignment` のある記録を断る（`builtinProjectRuntime.ts:191`）ので、遠隔のタスクを組み込みで実行し直してフックを呼ぶこともない。
- そこで W6 も daemon 側で呼ぶ。`RemoteTaskLifecycle` のコンストラクタに 4 つめの引数 `onTerminal?: (task: TaskState) => void` を足し、`request()` が終わりの記録を新しく保存して通知したあと（`:157-167` の `updated !== null && request.kind !== 'renew'` の中）で 1 回だけ呼ぶ。`onTerminal` はフックを始めて集合に入れるだけで、`request()` はそれを待たずに返事を返す。`infra` は `features` の `taskFinishHook.ts` を読めないので、呼ぶ関数は外から渡す。既存の単体試験は 3 引数で作るので、4 つめは省ける形にする。
- フックが 2 回にならないこと。遠隔の worker が返事を受け取れずに `finish` を送り直しても、記録はもう `running` でないので、`:93` で早く返るか、`:123` の条件で何も保存しない。`fail` が `finish` のあとに来ても同じ。どちらも `updated` が `null` なので `onTerminal` を呼ばない。組み込みの実行の完了（W5）は `withTaskFinishHook` が 1 回呼び、この設計では足さない。

### 4. 通知のあとの印の消し込み

`publishSetupFailure` → `publishAndClearPendingMark` を通すことで、W4 の印は通知の成功のあとに消える（#197）。W2・W3・W6 も、1 で付けた印が同じ関数で消える。消すのに失敗したら警告だけ出し、daemon が受信箱へ出し直して印を消す（受信箱は決定的な `eventId` で同じ試みを 1 回に畳む）。

### 5. 通常の完了（W5）の通知の失敗

- 直し：`startTask()` の実行の `.then`（`builtinProjectRuntime.ts:222-227`）で、`saveManagerEvent` を `try/catch` で囲む。失敗したら `warn()` と `log.error()` を出し、`settled = true` にして、`finished(taskName)` を呼ぶ。runtime の `failed` は呼ばず、host を閉じない。警告の文は「Goal task <name> (goal <goal id>, run <run_slug>) completed and is saved in .takt/tasks.yaml, but the manager was not notified: <detail>」。`log.error` にも、タスク名・ゴールの id・`run_slug`・理由を入れる。これで、通知が失われたことを警告とログから追える。
- **印は付けない（推し）**。通常の完了の記録は `TaskLifecycleService.completeTask`・`failTask`（`taskLifecycleService.ts:686`・`:717`）で書かれ、`takt run` の経路（`parallelExecution.ts` → `executeRunTaskAndCompleteWithDetails`）も同じ関数を通る。ここで印を付けると、マージ済みの経路の保存の形も変わり、`parallelExecution.ts:497-503` も通知のあとに印を消さなければならない。消さなければ、daemon がすべての通常の完了を出し直す。#170 はこの経路を範囲の外に置いたので、この PR では広げない。付けるなら、両方の経路を 1 つの issue でそろえる（上げる点 1）。
- マージ済みの経路の `parallelExecution.ts:497-503` も、通知が投げると同じく実行の約束が reject する。この設計では変えない（上げる点 2）。

### 6. 遠隔の終わりの、保存から返事までの間

`request()` の中で、終わりの記録を保存（`:120-156`）してから返事（`:168`）までの間に投げうる所は次の 4 つ。保存のあとで投げると、`RemoteWorkerRuntime` の `records` と `dispatcher.release` が更新されず、保存とずれる（`remoteWorkerRuntime.ts:246-249`）。どれも返事を止めないようにする。

| 所 | 今 | 直し |
|---|---|---|
| `:158` `saved.tasks.find(...)!` | 保存した直後の記録なので見つかる | 変えない |
| `:160-161` `LiveInterventionFileStore` の `read()` と `recordTerminal()`（ファイルの書き込み） | 投げると返事が出ない | `try/catch` で囲み、`warn()` と `log.error()` を出して進む |
| `:163-166` `saveManagerEvent` | 投げると返事が出ない | 2 節のとおり `publishAndClearPendingMark` + `try/catch`。印が残る |
| `onTerminal` | （今は無い） | フックを始めて集合に入れるだけで、投げない |

これで、保存した終わりの記録は必ず返事として `RemoteWorkerRuntime` に返り、`records` の更新と `release` が行われる。

### 7. daemon を止めるときに切ったフック（S23、元帥の決め）

daemon 側の `BuiltinProjectHost.close()`（`projectHost.ts:108-117`）は、子へ `shutdown` を送って 5 秒待ち、子が終わらなければ子のプロセス群を止める（`terminate()`、SIGTERM のあと 250 ミリ秒で SIGKILL、`spawn.ts:23`・`:176-200`）。runtime の `close()` は返事のあとに始めたフックを待つ（3 節）ので、5 秒を超えるフックがあると、この打ち切りで子ごと止まる。元帥の決めで、この打ち切りの振る舞いは変えず、切ったことだけを知らせる。

- **5 秒を超えたフックは、呼ばれたことにならない。** フックのプロセスは `runBoundedCommand` が `detached` で起こすので、子のプロセス群を止めても残って走り続けることがある。それでも終わりを見る者がいないので、成功も失敗も記録されず、`reportLostHook` の警告も出ない。I3 が守るのは runtime の `close()` が待ち終えるまでで、host の 5 秒の外は守らない（上げる点 3）。
- **切ったときは、どのタスクのフックを切ったかを 1 行の警告に出す。** 文は「Stopped the builtin worker for <cwd> before the finish hook of task <name> ended; the hook is not counted as run」。フックが複数あれば、1 行にタスク名を `, ` でつないで並べる。行は `sanitizeSensitiveText` を通し、フックのコマンドも引数も入れない。出すのは host の側の `warn()`（daemon の `[WARN]` の出口）だけで、子の stderr にも `reportDaemonError` にも出さない。どの出口でも 1 行までになる。
- **タスク名を host が知る形。** host は子の中で走っているフックを知らないので、子が知らせる。`ProjectReplySchema`（`src/core/worker-pool/projectProtocol.ts`）に `{ kind: 'hooks', taskNames: string[] }` を足し、子の `BuiltinProjectRuntime` は `pendingHooks` が増えるか減るたびに、走っているフックのタスク名の一覧をそのまま送る（差分ではなく全体なので、順番や取りこぼしを気にしなくてよい）。host は最後に受けた一覧を持つ。`close()` は `Promise.race` で 5 秒の側が勝ち、一覧が空でないときだけ、`terminate()` の前に 1 回だけ警告を出す。
- 子の側（SIGTERM を受けたときに子の stderr へ書く形）は採らない。SIGKILL までの 250 ミリ秒で、macOS のパイプへの非同期の書き込みが流れきる保証が無い。また host は子が 0 以外で終わると子の stderr の末尾を `reportDaemonError` に写す（`projectHost.ts:31-35`）ので、同じ行が 2 つの出口に出る。
- host と子は同じ版の takt なので、`ProjectReplySchema` の `strict()` の和に 1 つ足しても古い子と食い違うことは無い。
- red の試験は S23（`it-worker-pool-completion-publication.test.ts` › names the task whose finish hook the project host cuts off when it stops the builtin worker）。出口（子の stderr、daemon 側の stderr、`[WARN]`）ごとに、タスク名と `hook` を含む行が 1 行まで・少なくとも 1 つの出口に 1 行、秘密の値がどの行にも無いことを見る。この形では `[WARN]` に 1 行、ほかの 2 つは 0 行になる。

## 守る不変条件

1 回の試みについて、次の 8 つを守る。I1 が #196、I3 が #195、I4 が #197 に当たる。I7・I8 は段7 で足した。

- **I1** 保存した完了は manager に届くか、印が残って daemon に出し直される。
- **I2** manager への通知の失敗は runtime の外へ出ない。プロジェクトの host は閉じず、走っている別のタスクを中断しない。
- **I3** 保存（読めない内容、claim の setup 失敗、遠隔の終わり）のあと、返事を返したあとに始めたフックが終わったとき（または `close()` がそれを待ち終えたとき）には、終了フックが走ったか、タスク名つきの警告が出ている。
- **I4** runtime が自分で通知したあとは、印を消すのに失敗して警告した場合を除き、印は残らない。
- **I5** runtime が通知できずに返るときは、警告が出ている。
- **I6** 終了フックは 1 回の試みにつき 1 回までしか走らない。遠隔の `finish` の送り直しでも 2 回目は無い。
- **I7** フックが長くても、ほかの遠隔の実行の lease は切れず、その完了は捨てられない。プロジェクトの host への要求も時間切れにならない。
- **I8** 通常の完了（W5）の通知の失敗でも、host は閉じない。

## Quint

`specs/quint/worker-pool-completion-publication/workerPoolCompletionPublication.qnt`。1 回の試みの保存から、通知、印の消し込み、返事、返事のあとのフック（`close()` が待つ形を含む）、遠隔の `finish` の送り直し、daemon の出し直しまでを書いた。I7 は別のモデル `workerPoolRemoteHookLease.qnt`（下の「lease とフック」）で書いた。`DESIGN` が `"Current"`（595d6a826）と `"Design"`（この設計）を選ぶ。ディスクはいつでも埋まり、空く。runtime のプロセスは保存のあといつでも死ぬ。quint は 0.32.0。

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
| D10 | `close()` が、返事のあとに始めたフックを待たない | I3 | 違反 |

D7 は、印が残り続けて daemon が毎回出し直す形で、I1〜I6 のどれも壊さない。daemon が印を消すこと（と、印が残る間 daemon が止まらないこと）は #170 のモデル `specs/quint/goal-task-completion-publication/` が見ている。

### (b) 遷移に届く

`design` の witness（20,000 サンプル、max-steps 16、seed 0x2a）。どの遷移も届く。

| witness | 届いた trace |
|---|---|
| 読めない内容 / claim の setup 失敗 / 遠隔 の保存 | 6717 / 6579 / 6703 |
| `publish` / `publishFails` | 5911 / 4158 |
| `clearMark` / `clearFails` | 1590 / 534 |
| フックが走る / フックを失って警告 | 2000 / 614 |
| 遠隔の終わりでフックが走る / 遠隔の `finish` の送り直し | 675 / 996 |
| `kill` / `daemonResend` | 17368 / 18491 |
| 返事を返してフックが残っている / `close()` がフックを待って走らせる | 3918 / 1320 |
| 死んだあとに daemon が届ける / 通知の失敗のあとに daemon が届ける | 12468 / 1316 |
| 試みが終わる（`Done`） | 2614 |

### lease とフック（I7、`workerPoolRemoteHookLease.qnt`）

1 つの接続した worker で、遠隔の実行 X が終わり、B が走り続ける。daemon の列（`serialize`）、5 秒ごとの heartbeat と renew、60 秒の lease、lease の切れた実行を `failed` にする定期の点検、プロジェクトの host への要求の 30 秒の時間切れを持つ。`DESIGN` が `"HookBeforeReply"`（段5 の版：finish の返事の前にフックを待つ）と `"HookAfterReply"`（この設計）を選ぶ。フックの長さは 0・10・31・60 秒から選ぶ。

| 版 | `noLeaseLossWhileConnected` | `hostStaysOpen` | `hookOnceAfterSave` |
|---|---|---|---|
| `hookBeforeReply` | 違反 | 違反 | 違反なし |
| `hookAfterReply`（5,000 サンプル、max-steps 400、seed 0x2a） | 違反なし | 違反なし | 違反なし |

`noLeaseLossWhileConnected` は「B が走っているあいだ、B の lease は今の時刻より先にある」。点検が B を `failed` にする形（`remoteWorkerRuntime.ts:100-113`）も、B の finish が `record: null` で捨てられる形（`remoteTaskLifecycle.ts:97`、`:124`）も、lease が切れたことから始まるので、この 1 つで両方の入口を見る。列が空いていれば、溜まった renew は時刻が進む前に処理する（daemon は空いた列を遊ばせない）。

`hookAfterReply` を壊した版：renew を処理しても lease を延ばさない版（L1）は `noLeaseLossWhileConnected`、フックの回数を終わったあとの毎秒数える版（L2）は `hookOnceAfterSave`、返事がフックを待つ版（L3）は `safety` 全体で違反した。witness：60 秒のフックが終わる 2,446 / 5,000、フックのあいだに renew が処理される 4,868、X の保存 4,868、時計が終わりまで進む 5,000（どの trace も行き止まらずに 140 秒まで進む）。

範囲：worker は 1 つで、接続は切れない。実行は 2 つ（X と B）。時計は 140 秒まで。B の finish そのものは遷移に持たず、lease が切れていないことで、捨てられる入口を見る。

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
| `returnReply` / `runScheduledHook` / `closeRuntime` | 返事を返す所（`builtinProjectRuntime.ts` の `start`・`remote`、`remoteTaskLifecycle.ts:168`）／返事のあとのフック（`taskFinishHook.ts:281-310` の `runTaskFinishHooksForStates`）／`close()`（`builtinProjectRuntime.ts:264-276`）。`Current` は 3 か所ともフックを呼ばない |
| `repeatRemoteFinish` | `remoteTaskLifecycle.ts:93`（記録が `running` でない `finish` は早く返る）、`:123` |
| `kill` | 本番のコードは無い（プロセスの終了） |
| `daemonResend` | `watchSource.ts:125`・`:157` → `readPendingGoalTaskCompletions`（`taskStateReader.ts:98`）→ `publishPendingGoalTaskCompletions` |
| `diskFills` / `diskFrees` | 本番のコードは無い（環境） |

### (d) 範囲

- 1 回の試みだけ。再 claim・出し直しで記録が `pending` に戻る展開、同じタスクの 2 回目の試み、別のタスクとの競合は見ていない。
- 受信箱の写しの数（同じ試みの写しを 1 回に畳むこと）は見ていない。`delivered` は「届いた」の 1 ビットである。
- daemon が印を消すことと、印のある間 daemon が終わらないことは、#170 のモデルの範囲で、ここでは見ていない（D7）。
- W1（中断の回収）は、マージ済みの経路と同じ形なのでモデルに入れていない。W5（通常の完了）の通知の失敗は、捕まえて警告するだけなので、I2 と同じ形としてモデルには入れていない。
- 7 節（S23、host の 5 秒の打ち切りで切ったフックの警告）は入れない。モデルの範囲は runtime の `close()` までで、5 秒の打ち切りは別のプロセスからの時間の切れ目であり、警告を 1 行出すだけで記録・印・通知のどれも変えないので、I1〜I6 に関わる状態が無い。
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
3. 遠隔の終わりのフックは、遠隔の側も daemon 側も呼んでいなかったので、daemon 側で呼ぶ形にした（3 節）。どの経路でもフックが 1 回だけ呼ばれることを確かめる試験を足す（S4）。
4. （段7）フックは lease の更新と finish の返事を止めない形にする。I6 は保つ。Quint に I7 を足す（3 節、「lease とフック」）。
5. （段7）通常の完了の通知の失敗も、外へ投げずに警告にとどめ、host を閉じない形を #193 の範囲に入れる（5 節）。遠隔の finish の、保存と `records`・`release` のずれも直す（6 節）。
6. （S23）`BuiltinProjectHost.close()` が 5 秒で子を止めるとき、走りかけの終了フックがあれば、どのタスクのフックを切ったかを 1 行の警告に出す。出口ごとに 1 行まで、タスク名を含み、秘密は出さない。5 秒を超えたフックは呼ばれたことにならない（7 節）。

## 上げる点

1. **通常の完了に印を付けるか**（保存されるデータ）。この設計では付けない（5 節）。付けるなら、`takt run` の経路と worker pool の経路を 1 つの issue で、`completeTask`・`failTask` の印と、両方の経路の通知のあとの消し込みをそろえる。
2. **マージ済みの経路の通常の完了の通知の失敗**（`parallelExecution.ts:497-503`）。worker pool の W5 と同じく投げる。この設計では変えない。直すなら同じ `try/catch` と警告にする。
3. **daemon を止めるときのフック**。runtime の `close()` はフックを待つが、daemon 側の `BuiltinProjectHost.close()`（`projectHost.ts:108-117`）は、子へ shutdown を送ってから 5 秒待ち、過ぎると子のプロセス群を止める。5 秒を超えて走っているフックは、呼ばれたことにならない（I3 は runtime の `close()` までで、host の 5 秒の外は守らない）。走っている実行も同じ 5 秒で止められる今の形と同じなので、5 秒は変えない。元帥の決め（S23）で、切ったときにタスク名つきの警告を 1 行出す（7 節）。延ばすなら、host の待ちを `TASK_FINISH_HOOK_MAX_TIMEOUT_MS` より長くする。

## 上流と違う振る舞い（次の上流の取り込みのために）

上流 nrslib/takt に同じ直しは無い（上流には印と出し直しの仕組みそのものが無い）。次の上流の取り込みで、次の試験とコードが競合したときは、フォークの側を残す。

| 試験・コード | 上流の振る舞い | フォークの振る舞い | 理由 |
|---|---|---|---|
| `src/__tests__/worker-pool-runtime.test.ts` の「propagates %s completion notification failures outside acquisition retry」（`it.each(['recheck', 'claim'])`） | 通知の失敗で `start()` が reject する | 名前を改め、`start()` は `{ kind: 'declined' }` を返し、印が付き、警告が出る | 印があれば daemon が出し直すので、例外を外へ出すと別のタスクまで中断するだけになる（I2） |
| 同ファイルの「rechecks unreadable remote input after the claim and publishes the saved terminal result」の後半 | 通知の失敗で `remote()` が reject する | `remote()` は `{ kind: 'claim', assignment: null }` を返し、印が付き、警告が出る | 同上 |
| `src/features/workerPool/builtinProjectRuntime.ts` の `saveCompletion` | `saveManagerEvent` を直接呼ぶ | `publishSetupFailure` と `runTaskFinishHooksForStates` を呼ぶ | #170・#171 の約束を worker pool の経路にも通す |
| `src/infra/task/remoteTaskLifecycle.ts` の `request()` の終わり | 印なし、通知の失敗は投げる、フックなし | 印を付け、`publishAndClearPendingMark` で通知し、失敗は警告、`onTerminal` でフック | 同上 |
| `src/infra/task/taskLifecycleService.ts` の `buildUnreadableGoalTask` | 印なし | 印を付ける | 同上 |
| `builtinProjectRuntime.ts` の実行の `.then`（W5） | 通知の失敗で `failed` → host が閉じる | 警告とログにとどめ、`finished` を呼ぶ | 1 つの通知の失敗で、そのプロジェクトの実行をすべて止めない（I8） |
| `remoteTaskLifecycle.ts` の `request()` の保存のあと（`:157-167`） | どの段が投げても返事が出ない | 各段を `try/catch` し、必ず返事を返す。フックは返事のあと | `records`・`release` を保存とそろえる。フックで lease と host の要求を止めない（I7） |
| `src/__tests__/worker-pool-runtime.test.ts` の「retains project ownership after an unsaved %s failure until cleanup finishes」（`it.each(['execution', 'completion notification'])`） | `'completion notification'` の行：`saveManagerEvent` が `PrivateFileLockAcquisitionError('cannot notify completion', 'ENOSPC')` を投げ、実行は `{ runSlug: 'run-a', completion: { success: true, interrupted: false } }` で終わる。`failed` がその失敗で 1 回呼ばれ、`close()` の片付けが終わるまで `finished` は呼ばれず、`release` もせず、片付けのあとに `release` が 1 回 | `'completion notification'` の行を `it.each` から外し、新しい試験「keeps the runtime running when a completion notification fails and settles the task like a normal completion」に移した。`saveManagerEvent` は同じ引数で 1 回、`failed` は呼ばれない、`finished` はタスク名で 1 回、`release` は `close()` の前に 1 回で `close()` のあとも 1 回のまま、タスク名・ゴールの id・`run_slug` を含む `[WARN]` が 1 行、失敗の文に混ぜた `api_token=` の作り物の値がどの警告の行にも無い。`'execution'` の行は名前も assert もそのまま | 段7 の決め（5 節、M18）。通知の失敗を捕まえて `finished` を呼ぶので、「`finished` を呼ばず所有を保つ」という元の期待はこの行では成り立たない（I8）。記録は `193-red-log.md` の「既存の試験の期待を変えたもの」 |
| `src/infra/worker-pool/projectHost.ts` の `close()` と `projectProtocol.ts` の返事 | 5 秒で子を止め、走っていたフックについて何も出さない | 子が `hooks` の返事で走っているフックのタスク名を送り、5 秒で止めるときに 1 行の `[WARN]` を出す | 5 秒を超えたフックが黙って消えないようにする（7 節、S23） |

## 範囲の外

- W1（中断の回収）。マージ済みの経路と同じ形。
- worker pool の `claimTask` は `goalSetupGuard`（マージ済みの経路の `createRuntimeAssignmentSetupGuard`）を渡さない。setup の確かめの差で、この設計では見ていない。
- daemon の出し直し（`publishPendingGoalTaskCompletions`）、受信箱の `eventId`、`hasWork` の数え方。#170 の設計のまま変えない。

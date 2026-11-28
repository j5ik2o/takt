# 通常の完了にも出し直しの印を付ける（#216）

- Issue: [#216](https://github.com/j5ik2o/takt/issues/216)（通常の完了で manager への通知に失敗すると、知らせが失われ、出し直しもされない）
- 基点: 統合ブランチ `integration/takt-mcp`（e626fcce3、[#191](https://github.com/j5ik2o/takt/pull/191) のマージのあと）
- worker pool の側: [#193](https://github.com/j5ik2o/takt/pull/193) の枝 `j5ik2o/takt-sync-upstream-main`（601fb47ec）と、その設計 `docs/design/worker-pool-completion-publication.md`
- 前提の設計: `docs/design/goal-task-completion-publication.md`（#170）
- Quint: `specs/quint/normal-completion-publication/`

## 結論

ゴールタスクの通常の完了も、#170 と同じ `completion_publication_pending` の印を、完了の保存と同じ書き込みで付ける。通知が成功したら印を消す。通知に失敗したら警告し、外へ投げず、run の成功・失敗の数は実行の結果のまま数える。印が残るので daemon が出し直す（元帥の決め 1・4、互換は案 A で確定）。

1. 印を付けるのは、通知を出す呼び出し側（takt run の `fillSlots` と worker pool の W5）が頼んだ保存で、`completeTask`・`failTask`・`prFailTask`・`exceedTask` が書く記録のうち、ゴールの id・`completion`・`run_slug` がそろったものだけ。同じ保存の関数を通っても通知しない経路（instruct の再実行）には付けない。ワークフローの前に一時停止で止まった試みは、記録に `run_slug` が無いので印を付けない。今の呼び出し側はこの試みも通知しているので、この試みだけは通知に失敗すると今と同じく失われる（警告は出る）。#216 の範囲は、記録に `run_slug` が残る通常の完了（成功・失敗・`pr_failed`・`exceed`）だけである（元帥の決め、11/28）。一時停止の完了は [#222](https://github.com/j5ik2o/takt/issues/222) で扱う（「範囲の外」の節）。
2. 通知は、新しく export する `publishTaskCompletion`（`claimTasks.ts`）を通す。中で同じ試み（名前・ゴールの id・`execution_id`）の印のある記録を読み直し、マージ済みの `publishAndClearPendingMark` で通知して印を消す。失敗は捕まえて警告する。
3. `takt run`（`parallelExecution.ts`）と worker pool の W5（`builtinProjectRuntime.ts`）は、どちらもこの関数を呼ぶ。`completeTask` は両方の経路が共有しているので、印の付け方は 1 か所の変更で両方にそろう。
4. 印の無い古い記録は、出し直し待ちと読まない。読み替えも書き戻しもしない（元帥の決め 2）。
5. 受信箱の指摘（`inbox.ts`）は、コードと 1 回の実行で確かめたが再現しなかった。#216 の範囲にも別の issue にもしない（「受信箱の指摘」の節）。
6. 別の担当の敵対的な読み（22 件）には、「別の読みへの答え」の節で 1 件ずつ答えた。指摘 4（`completeTask` が `run_slug` を書かない）は当たらなかったが、その近くで、上の 1 の一時停止の経路の穴が見つかった。
7. 2 回目の別の読み（重い 3 件・中 2 件・軽い 7 件）にも同じ節で答えた。重 1（一時停止の完了を印の無いまま送ると、読み直しの失敗で J8 が破れる）は読み違いで、この設計で J8 は保たれる。一時停止の完了の知らせが通知の失敗で失われる穴（上の 1）は、#216 では直さず [#222](https://github.com/j5ik2o/takt/issues/222) で扱うと決まった（「一時停止の完了をどこで直すか」の節）。
8. 3 回目の別の読み（重い 2 件・中 9 件・軽い 5 件）にも同じ節で答えた。R14 を、読み直しの `executionId` の一致を外すと本当に落ちる形にした（前提の assert と、消し込みの呼び出しを見る assert を足した）。J7 のモデルの注を式にそろえ、J3 の 2 つの原因を試しの不変条件で分けた。3 回目の読みの「`brokenMarkUnrequested` は J7 と J8 の両方に違反する」は、TLC では再現せず、J7 だけだった。

## 最初の確かめ（統合ブランチの使い捨ての木）

e626fcce3 の使い捨ての木（`git worktree add --detach`、コミットせず、最後に消した）で、`runWithWorkerPool` に本物の `TaskRunner` と tasks.yaml を渡した。実行は本物の `completeTask` で `completed` を保存して `{ success: true, runSlug: 'run-a', completion }` を返し、`saveManagerEvent` が `PrivateFileLockAcquisitionError('cannot notify completion', 'ENOSPC')` を投げる形にした。

- (a) 結果は `{ success: 0, fail: 1, executedTaskNames: ['goal-a'] }`。成功したタスクが失敗として数えられた。
- (b) tasks.yaml の記録は `status: completed` で `completion` を持ち、`completion_publication_pending` が無い。`readPendingGoalTaskCompletions` は `[]` を返した。
- 警告もログも出ないと読める。`.then` の例外は `:253` で `false` に変わるだけで、その経路に `warn()` も `log` の呼び出しも無い（試験の出力は絞って読んだので、出力そのものでは確かめていない）。

issue の本文の読みのとおりだった。

## いまの動きの突き合わせ

通常の完了を保存する経路ごとに、保存・印・通知・失敗のときの扱い・出し直しを並べる。行番号は、takt run の経路が e626fcce3、worker pool の経路が #193 の 601fb47ec。

| 経路 | 保存 | 印 | 通知 | 通知が失敗したとき | 出し直しが拾うか |
|---|---|---|---|---|---|
| takt run・watch（`parallelExecution.ts:495-508` の `fillSlots`） | `executeTaskAndCompleteWithDetails`（`taskExecution.ts:114-130`）の中で `completeTask`・`failTask`・`prFailTask`・`exceedTask`（`taskLifecycleService.ts:598-660`・`:736-765`、`taskExceedService.ts:25-41`）。merge の経路（`merge/index.ts:220`・`:223`・`:253`）も同じ関数 | 付かない | 保存のあと `saveManagerEvent` を直接（`:503-506`） | タスクの約束が reject し、`:253` で `false` になる。成功が失敗として数えられ（`:296-302`）、警告は出ない。記録は `completed` なので自動の再キュー（`:276-298`）の候補にもならない | 拾わない（印が無い。`taskStateReader.ts:129`） |
| worker pool の W5（`builtinProjectRuntime.ts:217-239`） | 同じ `executeRunTaskAndCompleteWithDetails` → 同じ 4 つの関数 | 付かない | `saveManagerEvent` を直接（`:224-225`） | #193 の設計の前は、runtime の `failed` から host が閉じ、そのプロジェクトの実行がすべて止まる。#193 の M18 のあとは、警告して `finished` を呼ぶ（印は付けない） | 拾わない |
| worker pool の遠隔の終わり（W6、`remoteTaskLifecycle.ts:120-167`） | daemon 側の `buildTerminalTaskRecord`。`completeTask` は通らない | #193 の M6 で、ゴールタスクには付く | #193 の M6 で `publishAndClearPendingMark` | #193 の M6 で、警告して返事を返す | #193 のあとは拾う |
| PR の作り直し（`taskPullRequestActions.ts:264-276` の `completePublishedTask`） | `pr_failed` を `completed` に書き換える | 付けない（この設計でも付けない） | 通知しない（今もしない） | — | — |
| instruct の再実行（`taskInstructionActions.ts:292` の `executeAndCompleteTask`） | `completed`・`pr_failed` のタスクを `startReExecution` で `running` に戻し、同じ `executeTaskAndCompleteWithDetails` で保存する。ゴールタスクにもかけられ（ゴールの確かめは無い）、ゴールタスクなら `completion` と `run_slug` が付く | 付かない（この設計でも付けない） | 通知しない（今もしない） | — | — |
| `takt` の直接の実行（`selectAndExecute.ts:242`・`:263`） | `persistTaskError`・`persistTaskResult` | 付かない（`buildBooleanTaskResult` に `completion` が無い） | 通知しない | — | — |
| `takt merge` の直接の実行（`merge/index.ts:94-100` の `executePrWorkflow`） | `createPrMergeTask` が `goal` なしで作るので、ゴールの id が無い | 付かない | 通知しない | — | — |

W6 は #193 が通常の完了も含めて直すので、この設計で足すことは無い。PR の作り直しは、`pr_failed` の完了をもう一度知らせる経路ではないので範囲の外に置く（「範囲の外」の節）。instruct の再実行は、今は manager に通知しない。保存の関数で一律に印を付けると、daemon が今は送っていない完了を送り始める（J7 に反する）ので、印は通知する呼び出し側が頼んだときだけ付ける（「直し方」の 1）。instruct のゴールタスクを manager に知らせるかは、別に決める（上げる点 4）。

## 直し方

### 1. 印を付ける場所

- 印は、通知する呼び出し側が頼む。`TaskExecutionParallelOptions`（`src/features/tasks/execute/types.ts:354-360`）に `publishesGoalCompletion?: true` を足し、`fillSlots` のゴールタスクの呼び出し（`parallelExecution.ts:487-497` の `executionOptions`）と worker pool の W5（`builtinProjectRuntime.ts:219-221`）が `true` を渡す。instruct（`executeAndCompleteTask`）は渡さない。
- `executeTaskAndCompleteWithDetailsInScope`（`taskExecution.ts:132-`）は、この値を保存の関数へ渡す。`TaskResult` に `completionPublicationPending?: true` を足して `persistTaskResult`・`persistPrFailedTaskResult`・`persistTaskError` の結果に載せ、`ExceedTaskOptions` にも同じ欄を足して `persistExceededTaskResult` に載せる。merge の経路は `executePersistedPrMergeTask`（`merge/index.ts:144-`）の引数に同じ値を足し、`:220`・`:223`・`:253` の `terminal` に載せる。
- `src/infra/task/taskRecordMutations.ts` に `markNormalCompletionPublicationPending(record, requested)` を足す。`requested` が `true` で、記録が `goal_id`・`completion`・`run_slug` を持つときだけ `completion_publication_pending: true` を付け、それ以外はそのまま返す。
- `completeTask`・`failTask`・`prFailTask`（`taskLifecycleService.ts`）と `exceedTask`（`taskExceedService.ts`）が `store.update` の中で作る終端の記録を、この関数に通す（`requested` は `result.completionPublicationPending` か `options.completionPublicationPending`）。保存と同じ書き込みで印が付くので、保存のあとでプロセスが死んでも印は残る。
- 記録の `run_slug` を条件に入れるのは、同じ試みの知らせを受信箱で 1 つにまとめるためである（元帥の決め「同じ知らせが 2 回届いても二重に積まない」、J8）。受信箱の `eventId` は、`runSlug` があれば `(ゴール, タスク, 'run', runSlug)`、無ければ `(ゴール, タスク, 'execution', executionId)` から決まる（`inbox.ts:49-53`）。呼び出し側は結果の `runSlug` で送り、daemon は記録の身元で送る（`pendingGoalTaskCompletions.ts:49-54`）。記録に `run_slug` があれば両者の `eventId` は同じになる。
- `run_slug` の無い記録が実際に出るのは、`GoalPausedError` でワークフローの前に止まった試みである。`taskExecution.ts:462-465` が `taskForPersistence.runSlug` を外し、`failTask` が `run_slug: result.task.runSlug`（`taskLifecycleService.ts:654`）で記録の `run_slug` を消す。ところが返す結果には、`:217` で付けた `setup-…` の `runSlug` が残る（`:479`）。e626fcce3 の使い捨ての木で 1 回流すと、記録は `run_slug` が無く `execution_id` と `completion` を持ち、結果は `runSlug: setup-…` を持ち、`fillSlots` と同じ判定で `saveManagerEvent` が 1 回呼ばれて受信箱に完了が 1 件入った。つまり今の呼び出し側はこの完了も通知している。
- この記録に `isValidCompletionPublicationPending`（`taskRecordSchemas.ts:19-26`、`execution_id` だけでも有効）に合わせて印を付けると、daemon が呼び出し側より先に出し直したとき、または呼び出し側の読み直しが失敗したときに、呼び出し側の `runSlug` の知らせと daemon の `executionId` の知らせで `eventId` がずれ、manager に 2 回届く（Quint の `brokenMarkOnSchema` が J8 に違反する。反例は読み直しの失敗の形）。読み直しが成功すれば、呼び出し側も記録の `executionId` で送って印を消すので 1 回にまとまるが、この 2 つの順番は防げない。そこで印は付けない。代わりに、この試みの通知が失敗すると、今と同じく知らせは失われる（警告は出て、run の数え方は正しくなる）。一時停止の完了をどう直すかは #216 の範囲の外で、[#222](https://github.com/j5ik2o/takt/issues/222) で扱う（「範囲の外」の節）。
- `parallelExecution.ts:499-502` の「結果に `completion` か `runSlug` が無い」の分かれは、ゴールタスクでは結果に `completion` が無いときだけ起きる（`runSlug` は `:217` で必ず付く）。たとえば merge の経路で `updateRunningTaskExecution`（`merge/index.ts:155`）が投げると、`taskExecution.ts:155-158` が `running` のままの記録を読み、`completion` の無い結果を返す。このとき終端の記録は保存されないので、印も付かない。
- `exceedTask` は `buildExceededTaskRecord`（`taskRecordMutations.ts:84-102`）を通る。`clearRetryMetadata` は `run_slug` を消さないので、`running` のときの `run_slug` が残り、印の条件を満たす。
- merge の経路は、`updateRunningTaskExecution(task.name, { runSlug, ... })`（`merge/index.ts:155-157`）で保存した `run_slug` をそのまま `result.runSlug` として返す（`:221`・`:235`・`:263`）。`:253` の `failTask` は `runSlug` を持つ `runningTask` を渡すので、merge の経路の一時停止では `run_slug` は消えない。`:271` で投げ直したときは、`taskExecution.ts:155-158` が保存済みの記録を読み、その `completion` と `run_slug` を返す。どの形でも、保存した `run_slug` と通知の `runSlug` は同じになる。
- #170 の 3 経路（`buildSetupFailedTaskRecord`、中断の回収、`reconcileLostRun`）は、もう印を付けている。変えない。

### 2. 通知の関数

`src/features/tasks/execute/claimTasks.ts` に `publishTaskCompletion(taskRunner, cwd, task: { name, goalId, executionId }, result: { runSlug, completion })` を足して export する。`executionId` は claim した `TaskInfo` のもので、`buildTerminalTaskRecord` と `updateRunningTaskExecution` はどちらも `execution_id` を残すので、終端の記録まで同じ値が残る。

1. `taskRunner.listTaskStateItems()` から、名前・ゴールの id・`executionId` が一致し、状態が終端で、印のある記録を探す。`executionId` で同じ試みに絞るのは、読み直しのあいだに別の試み（再キューして再 claim した次の試み）の印のある記録があっても、それを送ったり、その印を消したりしないためである。`run_slug` では探さない。daemon が出し直すときと同じ身元で送るためである。
2. 見つかったら、その記録を `publishAndClearPendingMark`（`claimTasks.ts:98-112`）に渡す。保存した `completion` と `run_slug` で通知し、成功したら、保存した `status`・`run_slug`・`execution_id` を身元にして印を消す。呼び出し側は保存した `status` を持っていないので、読み直しで身元をそろえる。
3. 見つからない（印の付かない一時停止の記録、daemon が先に出し直して印を消した記録、試みのあいだに消された記録）ときと、1 の読み直しが投げたとき（`listTaskStateItems` は `store.read()` でロックを取る、`store.ts:36-38`。ロックの時間切れや ENOSPC で投げうる）は、今と同じく `result` から `saveManagerEvent` を呼ぶ。印は消さない。読み直しが投げたときは、通知が成功しても印が残りうるので、印を消せなかったときと同じ形で警告する（「Goal task <name> (goal <goal id>, run <run_slug>) finished and the manager was notified, but its saved record could not be read back to clear its completion publication mark; the daemon resends it if the record is marked: <detail>」）。印のある記録は `run_slug` を持つので、daemon の出し直しと呼び出し側の知らせは同じ `eventId` で 1 回にまとまる。読み直せないので印があるかは分からず、出し直しは「印があれば」とだけ書く。警告の `run` は、呼び出し側が結果から送った `runSlug` である。ワークフローの前の一時停止の試みでは、これは結果の `setup-…` で、記録には残っていない（記録は名前と `execution_id` で探す）。その記録には印が無いので「if the record is marked」は成り立たず、daemon は出し直さない。呼び出し側の通知は成功しているので、知らせは失われない。
4. 2・3 の通知を `try/catch` で囲む。失敗したら `warn()` と `log.error()` を出し、投げない。警告の文は「Goal task <name> (goal <goal id>, run <run_slug>) finished and is saved in .takt/tasks.yaml, but the manager was not notified: <detail>」。2 の経路（印のある記録が見つかった）では、その後ろに「; the daemon will resend it from its completion mark」を足す。3 の経路では出し直しを約束しない。`detail` は `sanitizeSensitiveText` を通す。

送る中身は今と同じになる。保存した `completion` は呼び出し側の `result.completion` をそのまま保存したもので、`run_slug` も同じ試みの値である。受信箱の `eventId` は `(受信箱, goalId, taskName, 'run', runSlug)` から決まる（`inbox.ts:49-50`）ので、この関数の通知と daemon の出し直しが重なっても 1 回にまとまる。

`publishAndClearPendingMark` の、印を消せなかったときの警告（`:107`）は「was saved as failed」と書き決めている。通常の完了では `completed` などもあるので、`saved as ${task.status}` にする。#170 の 3 経路では `status` が `failed` なので、文は今と変わらない。

### 3. 呼び出し側

- `parallelExecution.ts:503-506`：`saveManagerEvent` を `publishTaskCompletion(taskRunner, cwd, { name: task.name, goalId, executionId: task.executionId }, { runSlug: result.runSlug, completion: result.completion })` に置き換え、`return result.success` はそのまま。通知が失敗しても約束は reject しないので、成功は成功として数える（元帥の決め 4）。`:499-502` の `completion` の無い結果の扱いは変えない。
- worker pool の W5（`builtinProjectRuntime.ts:224-225`）：`saveManagerEvent` を `publishTaskCompletion(this.runner, this.cwd, { name: taskName, goalId: record.goal_id!, executionId: task.executionId }, result)` に置き換える。#193 の M18 の `try/catch` と警告は、この関数の中のものと同じ役なので、M18 は「この関数を呼び、`settled = true` にして `finished` を呼ぶ」に縮む。
- W5 の `:223` は、結果に `completion` か `runSlug` が無いと `throw` し、runtime の `failed` から host を閉じる（601fb47ec）。takt run の `:499-502` は `log.error` して返すだけなので、ここだけ振る舞いが違う。W5 も `log.error` して `finished` を呼ぶ形にそろえる（P6、上げる点 8）。#193 の M18 がもう扱っていれば、そのままでよい。

### 4. 印を消す場所

印を消すのは 2 か所で、どちらもマージ済みのまま使う。

- 呼び出し側の通知が成功したあと：`publishAndClearPendingMark` が `clearCompletionPublicationPending`（`taskLifecycleService.ts:509-533`）を呼ぶ。身元がすべて一致する記録だけを書き換えるので、遅れて消しても再 claim した次の試みの印は消さない。
- それ以外（通知の失敗、消し込みの失敗、プロセスの死）：daemon が出し直して消す（`watchSource.ts:125`・`:157` → `readPendingGoalTaskCompletions` → `publishPendingGoalTaskCompletions`）。

### 5. #193 との接点

どちらが先に入っても食い違わない。

- **#216 が先**（推し、「PR の分け方」の節）：統合ブランチの `completeTask` などが、頼まれたときに印を付けるようになる。#193 を取り込み直すとき、W5 を「直し方」の 3 のとおり `publishesGoalCompletion` を渡して `publishTaskCompletion` を呼ぶ形にする。#193 の S21（「B の記録は `completed` で、印は無い」）は「B の記録は `completed` で印が残り、`readPendingGoalTaskCompletions` が B を返す」に改める。#193 の設計の 5 節の「印は付けない（推し）」と、#193 の設計の上げる点 1・2 は、この設計で決まったと書き換える。
- **#193 が先**：#193 の M18 は今の設計のまま入る。#216 の PR が W5 を `publishTaskCompletion` に替え、S21 を同じく改める。
- 置き換えを忘れた場合：W5 が `publishesGoalCompletion` を渡さず `saveManagerEvent` を直接呼んだままなら、印は付かず、#193 の M18 の形（警告だけ）のままになる。worker pool の通常の完了の通知の失敗が出し直されないので、worker pool の試験に「通知が失敗したら印が残る」（R9）と「通知が成功したら印が消える」（R8）を置いて、取り込み直しで落ちるようにする。

## 守る不変条件

1 回の試みについて、次の 8 つを守る。

- **J1** 呼び出し側が試みから抜けたとき（返った、例外で抜けた、死んだ）、通知する呼び出し側の完了のうち記録に `run_slug` が残るものは、manager の受信箱にあるか、印が残って daemon に出し直される。ワークフローの前の一時停止の完了（記録に `run_slug` が無い）は外す。#216 の範囲の外で、[#222](https://github.com/j5ik2o/takt/issues/222) で扱う（「範囲の外」の節）。
- **J2** run は、通知がどうなっても、実行の結果のとおりに成功・失敗を数える。
- **J3** 通知の失敗でも、結果に `completion` が無いことでも、プロジェクトの host は閉じない。worker pool だけの性質で、takt run には host が無いので J3 は何も言わない。モデルで host を閉じる遷移は 2 つある。通知の失敗を捕まえない `publishFails`（`current`・`brokenNoCatch`）と、結果の欠けで投げる `skipWithoutResult`（`current`・`brokenPoolThrowsWithoutResult`、P6 の `:223` の直しなし）で、試しの不変条件 `pJ3ByPublishFailure`・`pJ3ByMissingResult` が 1 つずつ見る。
- **J4** 呼び出し側が通知し、印の消し込みも読み直しも失敗しなかったときは、印は残らない（どちらかが失敗したときは警告が出ている）。ただし、読み直しから消し込みまでの間に、ほかの書き手が記録の身元（状態など）を変えたか削除の予約を付けたときは、消し込みは記録が合わずに、警告なしで何もしない。この印は daemon が同じ `eventId` で出し直して消す（Quint の（d））。
- **J5** 呼び出し側が通知すべき完了を通知できずに返ったときは、警告が出ている。
- **J6** 印の無い古い記録は、出し直されない。
- **J7** 今の呼び出し側が通知しない完了（結果に `completion` か `runSlug` が無い完了、通知しない instruct の再実行）には、印も送りも生まれない。ワークフローの前の一時停止の完了は、今の呼び出し側が結果の `runSlug` で通知しているので、J7 では「通知する完了」に数える。モデルの式（`noNewSends`、「印があるか受信箱が空でない ⇒ `publishesToday`」）と注は、この意味にそろえた。印だけが残り、受信箱が空でも違反になる。
- **J8** 1 回の試みの知らせは、呼び出し側の通知と daemon の出し直しが重なっても、受信箱で 1 つの `eventId` にまとまる（元帥の決め「同じ知らせが 2 回届いても二重に積まない」）。

## Quint

`specs/quint/normal-completion-publication/normalCompletionPublication.qnt`。1 回の試みの保存から、呼び出し側の通知、読み直しの失敗、印の消し込み、run の数え方、daemon の出し直し、古い記録の読みまでを書いた。quint は 0.32.0。

- 呼び出し側は `TaktRun`・`WorkerPool`・`Instruct`（通知しない）を初めに選ぶ。印を頼むか（`requested`）は呼び出し側の種類とは別の値として持ち、`TaktRun` が頼み忘れる版（`brokenCallerForgetsRequest`）で外せるようにした。
- 保存の形（`shape`）を 3 つ選ぶ。`Normal`（記録にも結果にも `run_slug`）、`PausedBeforeWorkflow`（記録には無く、結果には有る。「直し方」の 1）、`NoResult`（結果に `completion` が無い）。
- 受信箱は、この試みの `eventId` の集合（`RunId`・`ExecId`）として持つ。呼び出し側は結果の `runSlug`（`RunId`）か、読み直した印のある記録の身元で送り、daemon は記録の身元で送る。集合の大きさが 2 なら、manager に 2 回届いたことになる（J8）。
- `DESIGN` が `"Current"`（e626fcce3）、`"SameWrite"`（案 A、この設計）、`"MarkOnFailure"`（案 B、通知に失敗したときだけ 2 回目の書き込みで印を付ける）を選び、`BREAK` が案 A を 1 か所ずつ壊す。ディスクはいつでも埋まり、空く。プロセスは保存のあといつでも死ぬ。daemon は保存のあといつでも出し直せるので、呼び出し側の通知と daemon の出し直しの重なりもモデルの中にある。

### (a) 不変条件が恒真でない

全部の状態を TLC で調べた（`quint verify --backend tlc --invariant <J>`、版ごと・不変条件ごとに 1 本ずつ、計 96 本）。結果がどの版のモデルのものかを分けて書く。3 回目の別の読みのあとのモデル（J3 の 2 つの試しを足し、J1・J3・J7・`callerSettlesSystemFair` の注を直した版。遷移と J1〜J8 の式は変えていない）で、96 本、`sameWrite` の `safety`、試しの不変条件（`pJ3ByPublishFailure`・`pJ3ByMissingResult`・`pNoExecIdInInbox`・`pJ8DaemonFirst`・`pJ1AfterKill`・`pJ1AfterSecondWriteFails`）、時相の性質 3 本を流し直し、下の表と同じだった。乱択（`quint run`）は今回は流し直していない。（b）の witness の数と、50,000 サンプル・max-steps 16 の `safety` は、2 回目の別の読みのあとのモデルの結果である。10,000 サンプル（max-steps 12、seed 0x2a）の 88 本は、`brokenPoolThrowsWithoutResult` を足す前のモデルの結果で、そのとき違反の出る所は TLC と同じだった。`sameWrite` の状態は 319 個（生成 566）で、TLC が報告する深さは流しによって 7 か 8 だった。V は違反、空欄は違反なし。

| 版 | J1 | J2 | J3 | J4 | J5 | J6 | J7 | J8 |
|---|---|---|---|---|---|---|---|---|
| `sameWrite`（案 A） | | | | | | | | |
| `current`（e626fcce3） | V | V | V | | | | | |
| `markOnFailure`（案 B） | V | | | | | | | |
| `brokenNoClear`（通知のあとで印を消さない） | | | | V | | | | |
| `brokenNoCatch`（通知の失敗を捕まえない） | | V | V | | | | | |
| `brokenNoWarn`（捕まえた失敗を警告しない） | | | | | V | | | |
| `brokenResendUnmarked`（daemon が印の無い記録も出し直す） | | | | | | V | | |
| `brokenMarkOnSchema`（印を schema の条件、`run_slug` か `execution_id` で付ける） | | | | | | | | V |
| `brokenMarkUnrequested`（頼まない instruct の保存にも印を付ける） | | | | | | | V | |
| `brokenSilentReadBack`（読み直しの失敗を警告しない） | | | | V | | | | |
| `brokenCallerForgetsRequest`（takt run が `publishesGoalCompletion` を渡さない） | V | | | | | | | |
| `brokenPoolThrowsWithoutResult`（W5 が結果の欠けで `throw` したまま、P6 の `:223` の直しなし） | | | V | | | | | |

8 つの不変条件は、どれもどれかの壊した版で違反する。`sameWrite` は、まとめた `safety` を乱択で 50,000 サンプル、max-steps 16 で流しても違反しない。

- `current` の J1 は「通知が ENOSPC で投げ、印も無い」、J2 は「成功した実行が失敗と数えられる」で、最初の確かめ（a）（b）と同じ形である。J3 の最短の反例は「worker pool で結果に `completion` が無く、`:223` が投げて host が閉じる」。通知の失敗で host が閉じる形は、`current` と `brokenNoCatch` で同じ遷移（失敗を捕まえない）で、`brokenNoCatch` の J3 の反例がそれである。2 つの原因は別の版に分けたので、`sameWrite` の J3 は P6 の `:223` の直し（`brokenPoolThrowsWithoutResult` で外す）と、通知の失敗を捕まえること（`brokenNoCatch` で外す）の両方に支えられていると分かる。2 つの原因は、試しの不変条件で分けて確かめた。`pJ3ByPublishFailure`（通知の失敗で閉じる）は `current` と `brokenNoCatch` が違反し、`pJ3ByMissingResult`（結果の欠けで閉じる）は `current` と `brokenPoolThrowsWithoutResult` が違反する。`sameWrite` はどちらにも違反しない。
- `markOnFailure` の J1 は、保存の直後にプロセスが死ぬ形（最短、2 手）と、通知の失敗のあとの 2 回目の書き込みも ENOSPC で落ちる形（4 手）で出る（それぞれ `pJ1AfterKill`・`pJ1AfterSecondWriteFails` で確かめた）。案 B を採らない理由の裏づけになる。
- `brokenMarkOnSchema` の J8 の最短の反例（3 手）は「一時停止の記録に印を付ける → 読み直しが投げて呼び出し側が結果の `runSlug` で送る（`RunId`）→ daemon が記録の `executionId` で出し直す（`ExecId`）」。daemon が先に出し直して印を消し、呼び出し側が印の無い記録を見て結果の `runSlug` で送る形でも、J8 に違反する。`brokenMarkOnSchema` が違反するのは J8 だけで、J7 を含むほかの 7 つには違反しない（不変条件ごとに 1 本ずつ TLC で調べた。2 つ目の形は `pJ8DaemonFirst`）。これはこの版についての主張で、どの不変条件に違反するかは壊した版ごとに違い、上の表の各行がその版の TLC の結果である。たとえば `brokenMarkUnrequested` が違反するのは J7 だけで、J8 には違反しない（345 状態）。この版が足す印は instruct の記録への印だが、印の条件の `run_slug` は残るので、印のある記録はどれも `run_slug` を持つ。daemon も呼び出し側もその試みを `RunId` で送るので、受信箱の `eventId` は 1 つのままである。3 回目の別の読みは、この版が J7 と J8 の両方に違反すると読んだが、TLC では再現しなかった。一時停止の記録に印を付けない理由（「直し方」の 1）の裏づけである。前の版のモデルでは、この版は J7 に違反していたが、それは「`run_slug` の無い完了は今は通知しない」という誤った読みからだった。
- `brokenCallerForgetsRequest` の J1 の反例は「takt run が頼まずに保存（印なし）→ ディスクが埋まる → プロセスが死ぬ」。呼び出し側が頼むことを試験で固定する理由（R4・R5、「red のテスト」の節）になる。

### (b) 遷移と、不変条件が見る状態に届く

前の版の witness は、どの action が起きたか（`lastAction`）しか見ておらず、各不変条件の前提が成り立つ状態に届くかは示していなかった。前提の witness を足した。`sameWrite`、20,000 サンプル、max-steps 16、seed 0x2a。

| witness | 届いた trace |
|---|---|
| 保存 / 結果に `completion` が無く通知を飛ばす / instruct が通知せずに返る | 19923 / 2319 / 3254 |
| 通知 / 通知の失敗 / 読み直しの失敗 | 1699 / 1142 / 1631 |
| 印の消し込み / 消し込みの失敗 | 245 / 66 |
| プロセスの死 / daemon の出し直し | 10134 / 4068 |
| J1：抜けたあと受信箱に無く、印だけが残る / 受信箱にあり、印は無い | 2004 / 4228 |
| J2：通知が失敗しても成功と数える（takt run） | 151 |
| J3：worker pool の通知の失敗 / worker pool の結果の欠け | 574 / 1159 |
| J4：保存で印を付け、通知して、警告なしで返る | 482 |
| J5：通知すべき完了を通知せずに返る | 1142 |
| J7：instruct が `run_slug` のある記録を保存して返る / 一時停止の試みを抜ける | 1067 / 4438 |
| J8：呼び出し側の通知と daemon の出し直しが両方起きる | 1419 |
| 一時停止の試みが通知に失敗し、警告して返る（範囲の外の穴、#222） | 570 |
| 一時停止の試みの読み直しの失敗（受信箱は `RunId` だけ。2 回目の読みの重 1） | 856 |
| 通知の失敗のあとの出し直し / 死んだあとの出し直し / worker pool が通知に失敗しても返る | 381 / 1718 / 574 |

案 B だけの 2 回目の書き込みとその失敗は `markOnFailure` で 120 / 390、古い記録の出し直しは `brokenResendUnmarked` で 19844 届いた。`sameWrite` では、この 3 つは 0 になる（その版に無い遷移なので正しい）。J6 は `sameWrite` では `legacyDelivered` を立てる遷移が無いので、構成から成り立つ。`brokenResendUnmarked` では違反する。

試みの途中（`Saved`・`Published`・`FailMarkDue`）で止まり、J4・J5 の前提にいつまでも届かない形が無いことは、時相の性質 `callerSettles` で確かめた（`quint verify --backend tlc --temporal callerSettles`、違反なし）。quint はこれを TLA+ の `WF_s(callerStep) => [](inAttempt => <>settled)` に訳す（`quint compile --target tlaplus --temporal callerSettles` の出力で確かめた）。この性質が成り立つのは、試みの途中のどの状態でも呼び出し側の遷移のどれかが起きうるからで、示しているのは「呼び出し側が動けなくなる状態が無い」ことまでである。公平性を外した `callerSettlesUnfair` の反例は、試みの途中の状態で止まり続けること（stuttering）だった。前の版で「`save` のあとディスクが埋まって空くことだけを繰り返す反例」と書いたのは誤りだった。その形は、止まり続けることだけを外す `callerSettlesSystemFair`（遷移全体に弱い公平性）の反例として出る。ここから言えるのは、遷移全体に弱い公平性を置くだけでは足りないことまでである。呼び出し側の遷移の公平性が無ければ成り立たない（それが要る）ことは、`callerSettles` と `callerSettlesSystemFair` の 2 本からは言えない。Apalache の時相の検査は、quint 0.32.0 自身が「実験的」と警告するので使っていない。

### (c) 本番との対応

| モデル | 本番 |
|---|---|
| `save` | `taskLifecycleService.ts:598-660`・`:736-765`（`completeTask`・`failTask`・`prFailTask`）、`taskExceedService.ts:25-41`（`exceedTask`）。`markedOnSave` は「直し方」の 1 の `markNormalCompletionPublicationPending`。`requested` は P5・P6・P8 の `publishesGoalCompletion` |
| `shape` | `Normal`：`taskExecution.ts:268` → `:450` ほか、`merge/index.ts:155` → `:220`・`:223`・`:253`。`PausedBeforeWorkflow`：`taskExecution.ts:462-465`・`:479`、`taskLifecycleService.ts:654`。`NoResult`：`taskExecution.ts:155-158`（`running` のままの記録を読む） |
| `skipWithoutResult` | takt run：`parallelExecution.ts:499-502` の `log.error`。worker pool：601fb47ec の `builtinProjectRuntime.ts:223` の `throw`（`Current` と `brokenPoolThrowsWithoutResult` では host が閉じる）。この設計では P6 で `log.error` と `finished` にそろえる |
| `returnWithoutPublishing`（`Instruct`） | `taskInstructionActions.ts:292`（`executeAndCompleteTask` は通知しない） |
| `readBackFails` | 「直し方」の 2 の 3（`listTaskStateItems` → `store.read()` が投げる、`store.ts:36-38`） |
| `publish` / `publishFails` | `Current`：`parallelExecution.ts:503-506`、`builtinProjectRuntime.ts:224-225`。`SameWrite`：「直し方」の 2 の `publishTaskCompletion` → `claimTasks.ts:81-112`（`publishGoalCompletion` は記録に `runSlug` があればそれで、無ければ `executionId` で送る） |
| 受信箱の `RunId` / `ExecId` | `inbox.ts:49-53` |
| `Escaped` の数え方と `hostClosed` | `parallelExecution.ts:253`・`:296-302`、`builtinProjectRuntime.ts:234-239`（`failed` → 子の `stop()` → host の切断） |
| `returned` の数え方 | `parallelExecution.ts:301-302`（`settled.result` が実行の結果） |
| `markAfterFailure` / `markAfterFailureFails` | 本番のコードは無い（案 B の比べのためだけの遷移） |
| `clearMark` / `clearFails` | `taskLifecycleService.ts:509-533`、`claimTasks.ts:101-111` |
| `kill` | 本番のコードは無い（プロセスの終了） |
| `daemonResend` | `watchSource.ts:155-181`（`taskCompletions`）→ `readPendingGoalTaskCompletions`（`taskStateReader.ts:96-150`）→ `publishPendingGoalTaskCompletions`（`pendingGoalTaskCompletions.ts:16-60`）。書いた側のプロセスが生きているかは見ず、削除の予約の持ち主だけを見る（`:25-29`）ので、保存から印を消すまでの間でも出し直しうる。ゴールが終わっているか消えているときは、送らずに印だけ消す（`:39-48`） |
| `daemonReadsLegacy` | `taskStateReader.ts:129`（印が `true` でない記録は `completion` を読まずに飛ばす） |
| `diskFills` / `diskFrees` | 本番のコードは無い（環境） |

### (d) 範囲

- 1 回の試みだけ。自動の再キュー（`parallelExecution.ts:276-298`）や再 claim で記録が `pending` に戻ると、`buildClaimedTaskRecord`・`buildRetryTaskRecord` が印を外す（#170 の 1 節）。`failed` の通知に失敗した試みがすぐ再キューされると、その試みの完了は届かず、次の試みの完了が届く。これは #170 の決めのままで、J1 は試みごとの性質としてだけ見ている。
- 別の試みの記録との取り違え（読み直しが、再 claim した次の試みの印のある記録を拾う形）はモデルに入れていない。「直し方」の 2 で、読み直しを `execution_id` で同じ試みに絞ってふさいだ。
- 読み直しから印の消し込みまでの間に、ほかの書き手が記録を書き換える形は入れていない。daemon が先に印を消したときと、再キュー・再 claim のとき（印を外す）は、印は残らない。`clearCompletionPublicationPending` は、身元（ゴールの id・状態・`run_slug`・`execution_id`）がすべて合い、削除の予約が無い記録だけを書き換える（`taskLifecycleService.ts:509-533`）。PR の作り直し（`completePublishedTask`、`:767-`）がこの間に `pr_failed` を `completed` に書き換えたときと、削除の予約が付いたときは、消し込みは何もせず、`publishAndClearPendingMark` はそれを警告しないので、印が警告なしで残る。このとき呼び出し側の通知（読み直した `pr_failed` の記録の `completion`）は、もう受信箱に入っている。作り直しの記録（`completed`）は `buildTerminalTaskRecord` の `...task` で同じ `run_slug` と印を引き継ぐので、daemon は作り直したあとの `completion`（成功）を同じ `eventId` で出し直し、印を消す。受信箱では、同じ `eventId` が保存済みなら `FileEventStore.accept` が `duplicate` として最初の中身を返す（`eventStore.ts:262-267`）。manager に残るのは呼び出し側が送った `pr_failed` の知らせで、作り直しの成功は届かない（コードの読みで、流していない）。今も作り直しは通知しないので、manager から見て今と変わらない。この形の終わりの状態は、記録は `completed` で印が無く、manager の知らせは `pr_failed` の 1 回である。通知そのものが失敗していた形は「範囲の外」の節に書いた（そちらでは、作り直しの成功が 1 回届く）。削除の予約の付いた記録は、daemon が予約の持ち主を見て扱う（`pendingGoalTaskCompletions.ts:25-29`、#170 のまま）。J1・J8 は保たれ、J4 だけがこの形を外す（2 回目の読みの中 1）。
- 結果に `completion` があって `runSlug` が無い形は入れていない。本番で生まれないからである。ふつうの経路では `runSlug` は `taskExecution.ts:217` で最初に決まり、`completion` を返す 5 か所（`:354`・`:421`・`:444`・`:455`・`:479`）はどれも `runSlug` を一緒に返す。merge の経路は、返す 3 か所（`merge/index.ts:221`・`:235`・`:263`）が `:154` の `runSlug` を返す。`taskExecution.ts:155-158` は保存した記録の `run_slug` を `toTaskState`（`mapper.ts:217`）で読み、merge の記録の `run_slug` は `merge/index.ts:155` で書かれ、`failTask` にも `runningTask` を渡すので消えない（2 回目の読みの重 3）。
- 2 つのタスクの同時の保存は見ていない。タスクごとに記録は別で、`store.update` はロックの中で読み・書きをまとめる（`store.ts`）。印を消すのは身元がすべて一致する記録だけ（`taskLifecycleService.ts:509-533`）なので、別のタスクの保存や消し込みが、この試みの印を変えることは無いと読んだ。
- daemon の読み（`readPendingGoalTaskCompletions`）はロックを取らずにファイル全体を読む。書き込みは一時ファイルからの置き換え（`writePrivateFileWithMode` → `writeAtomic`、`private-file.ts:178`）なので、読むのは前か後のどちらかの中身である。前の中身を読んで出し直しても、`eventId` が同じなので 1 回にまとまり、遅れた消し込みは身元の一致で何もしない。
- daemon が印を消し切ること（daemon が止まらずに動き続けること）は #170 のモデル（`specs/quint/goal-task-completion-publication/`）の範囲で、ここでは見ていない。`callerSettles` が見るのは呼び出し側が抜けることだけである。
- daemon がゴールの終わりを見て送らずに印を消す形（`pendingGoalTaskCompletions.ts:39-48`）は入れていない。
- `saveManagerEvent` は、ゴールが中止済みなら何も書かずに返る（`infra/goals/events.ts:32`）。モデルの `publish` はいつも受信箱に書くので、この形は入れていない。印のある記録では、呼び出し側は送ったと読んで印を消し、daemon もゴールの終わりを見て送らずに印を消すので、どちらの経路でも何も届かず、警告も出ない。印の無い一時停止の記録は呼び出し側の通知しか道が無いので、この形で知らせが消える。#216 の範囲の外で、[#223](https://github.com/j5ik2o/takt/issues/223) で扱う。
- 保存そのものの失敗（tasks.yaml の書き込みの ENOSPC）は見ていない。`save` はディスクが空いているときだけ起きる。保存が失敗したときの扱いは今のまま変えない。
- 古い記録は「印の無い記録が 1 つある」とだけ置き、その中身は見ていない。J6 は、daemon が印で記録を選ぶことだけを見る。
- 状態は TLC で尽くした（`sameWrite` で 319 個）。前の版の「呼び出し側の遷移は 4 つ以下で終わる」は数えずに書いた見込みだったので、TLC の深さ（7。流しによって 8 と報告されることがある）に置き換えた。

## 保存データの形と、古い版との互換

### 形は #170 から変えない

足すのは、#170 がすでに使っている `completion_publication_pending: true` を付ける記録の種類だけで、新しい欄も新しい値も無い。#170 の設計は「変えないこと・範囲の外」に、通常の完了へ広げるときもデータの形を変えずに済むよう、有効条件を終端のゴールタスク全般にしたと書いている（`goal-task-completion-publication.md:122`）。

#170 のあとの版は、この形を読める。e626fcce3 の使い捨ての木で、印のある `completed` のゴールタスクの tasks.yaml を読ませた。

- `TaskStore.read()` は通り、`completion_publication_pending` は `true` のまま残る（`TaskRecordSchema` の transform、`taskRecordSchemas.ts:311-322`）。
- `readPendingGoalTaskCompletions` はその記録を返す。#216 の前の daemon も、#216 のあとの takt run が残した印を出し直す。

### #170 より前の版と上流の公開版は読めない（元帥の判断で支えない）

#170 より前の版（2da9c6aa2^）と、npm で入れた上流の公開版 takt 0.77.0 は、印のある記録が 1 件でもあると tasks.yaml 全体を拒む。

- 読む関数：`TaskStore.read()` → `readUnsafe()` → `TasksFileSchema.parse(normalizePersistedTasksFile(parsed))`（2da9c6aa2^ の `src/infra/task/store.ts:93-113`、0.77.0 の `dist/infra/task/store.js` も同じ形）。
- 拒む理由：記録の schema は `TaskExecutionConfigObjectSchema`（`.strict()`、`taskExecutionSchemas.ts:175`、0.77.0 の `dist/infra/task/taskExecutionSchemas.js:170`）を `.extend()` したもので、zod 4.6.7（両方の lockfile で同じ版）では知らない欄を `unrecognized_keys` で拒む。
- 使い捨ての木で読ませた結果：印のある記録は `Invalid tasks.yaml ... unrecognized_keys: completion_publication_pending` で拒まれ、同じ記録から印だけを外すと読めた。
- 拒んだときにファイルを書き換えないこと（別の読むだけの担当の確かめ、takt中将から）：0.77.0 は、印のある tasks.yaml を `takt list`・`takt add`・`takt list --action delete --yes` のどれでも拒んで終了コード 1 で止まった。ファイルは前後で sha256 が同じ（642 バイト）で、ロックも作業のディレクトリも残らない。`readUnsafe` は読みの誤りを捕まえてログに出し、書く前に投げる。書く経路はすべて「読んでから書く」を通るので、古い版は止まるだけで、書き換えも、空にすることも、消すこともしない。

この壊れ方は #170 がマージした時点で入っている（setup 失敗と中断の回収の印）。#216 は印が出る場面を増やすが、形は変えない。通常の完了では、印は保存から通知の成功までの短い間だけ残り、通知に失敗したときは daemon が出し直すまで残る。

方針（元帥の決め）：**フォークの `.takt`（tasks.yaml・config.yaml）は、フォークの版だけが読む。上流の公開版（0.77.0 など）が同じ `.takt` を読むことは支えない。**

検討した 3 案と、採らなかった理由は次のとおり。

| 案 | 形 | 結果 |
|---|---|---|
| A（採る） | 保存と同じ書き込みで印を付け、通知の成功で消す | 古い版は、通知の短い間と通知の失敗のあとに tasks.yaml を読めずに止まる。Quint の J1〜J8 を守る |
| B | 通知に失敗したときだけ、2 回目の書き込みで印を付ける | 成功の経路では古い版も読める。保存と通知の間でプロセスが死ぬか、2 回目の書き込みも ENOSPC で落ちると、知らせが黙って失われる（Quint の `markOnFailure` が J1 に違反）。決め 1 に反する |
| C | 印を tasks.yaml の外のファイルに置く | 古い版は無視できるが、#170 の印と置き場が 2 つになり、daemon の読みと Quint が増える。#170 の印による壊れ方は残るので、互換は戻らない |

## 受信箱の指摘（`inbox.ts:36`・`:49-55`・`:66-67`）

**結論：再現しない。#216 の範囲にも入れず、別の issue にもしない（推し）。** 指摘は「daemon が起きていない間に落ちた受信箱の通知が消える」だった。統合ブランチ（e626fcce3）と #193 の枝（601fb47ec）の `inbox.ts` は同じ中身で、上流の main（a1794751a）も `eventId` の決め方（`:49-53`）を除いて同じ形である。

- `:36`：`change.removed` のときと受信箱でないときに返るだけで、ファイルには触れない。
- 受信箱の変化は、`startDirectoryWatcher`（`watchers/directories.ts:37-111`）が定期の走査で作る。`known` は daemon の起動のたびに空から始まるので、起動の前から受信箱にあるファイルも、最初の走査で「変わった」として `receiveInboxChange` に渡る（`:82-95`）。使い捨ての木で、走査を始める前に受信箱へ置いた完了のファイルが、最初の走査で 1 回渡ることを確かめた。
- `:49-55`：完了の `eventId` は `(受信箱, goalId, taskName, 'run', runSlug)` から決まる。同じ `eventId` の写しは、daemon の中では `admit` が前の受付の返事を返し（`dispatcher.ts:316-317`）、保存では `FileEventStore.accept` が `duplicate` を返して（`eventStore.ts:262-267`）、`admissionSaved` が `accepted` の返事にする（`dispatcher.ts:348-370`）。したがって写しでも `:56` は投げず、`:58` でファイルが消える。受け付けが `rejected`（容量、保存、停止中）のときは `:56` が投げてファイルは残り、`known` に入らないので次の走査でまた渡る。
- `:66-67`：今の木では `legacyResultSchema`（古い director の結果の形）で、受信箱の通知とは関係が無い。指摘を書いた担当が見た行番号は、別の版のものだったと考える。
- ほかに、通知を捨てる所は 2 つあるが、どちらも決めた振る舞いである。中止したゴールへの完了は `saveManagerEvent` がそもそも書かない（`infra/goals/events.ts:32`）。`patrol` の古い形は読んで消す（`inbox.ts:40`・`:58`）。

#216 にとっての意味：通常の完了の印が増えると、保存から印を消すまでの間に daemon が出し直し、受信箱に同じ試みの写しが 2 つ入ることが、ふつうに起きるようになる。上のとおり写しは 1 回にまとまるので、manager に 2 回届くことは無い。

## red のテスト（Sonnet が書く）

既存の試験は弱めない。新しい試験のファイルは `tsconfig.tests.json` と `scripts/test-classification.mjs`（light IT）に足し、`releaseVerificationWiring.test.ts` を単独で流す。ENOSPC は `new PrivateFileLockAcquisitionError(message, 'ENOSPC', -28, { cause: new Error('ENOSPC') })` で作る（コンストラクタの引数は 4 つ）。警告に混ぜる秘密は作り物の値を実行時につないで作る。

R4〜R6・R12・R14 は、`executeRunTaskAndCompleteWithDetails` を mock に替える。mock は本物の `updateRunningTaskExecution` と本物の `completeTask`・`failTask` を呼び、5 番目の引数に `publishesGoalCompletion === true` があるときだけ `completionPublicationPending: true` を保存の関数へ渡す。これで P5 と P8 の欄の名前を試験が固定する。mock の中から先の配線（`executeTaskAndCompleteWithDetailsInScope` → `persist*` → 保存の関数）は R15 が本物で見る。

「本番のどこを外せば落ちるか」は、cdb0d9b36 の本番（#216 の直しの前）で Sonnet が流した結果に合わせた。R1〜R12 のうち 16 件を流して 9 件が落ち（R1×4、R4、R5×2、R6、R12）、7 件が通った（R2、R3、R11×4、R7）。通った 7 件は今の本番でも守られている性質の守りで、直しの一部を外したときに落ちる。R13〜R15 と、直しの一部を外して落ちることは、まだ流していない（直しの本番がまだ無い）。R13・R14 の列には、外す所（ファイル・関数・条件）と、外したときに落ちる assert と値を書いた。試験の担当が、その所だけを外した使い捨ての木で落ちることを確かめる。

| # | ファイル | 試験の名前 | 確かめること | 本番のどこを外せば落ちるか |
|---|---|---|---|---|
| R1 | `src/__tests__/it-normal-completion-publication.test.ts`（新規、light IT） | `marks a normal goal completion for resend in the same save: %s` を `it.each(['completeTask', 'failTask', 'prFailTask', 'exceedTask'])` | `run_slug` のある `running` のゴールタスクを本物の `TaskRunner` で、`completionPublicationPending: true` を付けて各関数に通すと、tasks.yaml の生の記録に `completion_publication_pending: true` があり、`readPendingGoalTaskCompletions` がその名前と `runSlug` を返す | P2・P3（どれか 1 つの関数で印を付けなければ、その行が落ちる）。今の本番では 4 行とも、`run_slug` は残り、印が無いことだけで落ちた |
| R2 | 同上 | `does not mark a goal completion saved without a run slug` | ワークフローの前の一時停止と同じ形の記録（`run_slug` が無く、`execution_id` と `completion` がある）を `failTask` で、頼んで保存すると、印が無く、`readPendingGoalTaskCompletions` は空 | P1 の `run_slug` の条件（`execution_id` だけでも付けると落ちる。付けると daemon の `executionId` の知らせと呼び出し側の `runSlug` の知らせが別の `eventId` になる、J8） |
| R3 | 同上 | `does not mark a completion of a task without a goal` | `goal_id` の無いタスクを `completeTask` で保存すると、印が無い | P1 の `goal_id` の条件 |
| R4 | 同上 | `clears the mark after takt run notifies a normal completion` | `runWithWorkerPool` に本物の `TaskRunner` と上の mock を渡す。`saveManagerEvent`（spy、成功）は今と同じ引数でちょうど 1 回呼ばれ、**呼ばれたときに記録に印がある**（spy の中で tasks.yaml を読む）。そのあと記録に印が無く、結果は `{ success: 1, fail: 0 }`、`[WARN]` は無い | P5・P8（`publishesGoalCompletion` を渡さないと、通知のときに印が無い）、P4（消し込みを外すと印が残る。送る中身を変えると引数が合わない）。通知のときの印を見ない元の形は、今の本番で緑だった（印が付かず、消すものも無い）ので、この assert を足した |
| R5 | 同上 | `keeps the mark and counts the success when the takt run notification fails` を `it.each([true, false])` | `saveManagerEvent` が ENOSPC を投げる。結果は実行の結果のとおり（`true` なら `{ success: 1, fail: 0 }`、`false` なら `{ success: 0, fail: 1 }`）。記録に印が残り、`readPendingGoalTaskCompletions` がそれを返す。`[WARN]` の行のうちタスク名・ゴールの id・`run_slug`・`manager was not notified` を含むものがちょうど 1 行で、失敗の文に混ぜた秘密がどの行にも無い | P4 の `try/catch`（外すと約束が reject して数が変わる）、P4 の警告、P5・P8（頼まないと印が残らない） |
| R6 | 同上 | `names the saved status when the mark cannot be cleared after a notification` | `clearCompletionPublicationPending` を投げる形で R4 を流す。タスク名を含む `[WARN]` の行がちょうど 1 行で、そこに `saved as completed` があり、`saved as failed` は無い。結果は `{ success: 1, fail: 0 }` | P4（警告の文の `status`） |
| R7 | 同上 | `reads an old completed goal record without the mark as not pending` | 印の無い `completed` のゴールタスクだけの tasks.yaml で、`readPendingGoalTaskCompletions` が空、`TaskStore.read()` が通り、ファイルのバイトが変わらない | 今も緑（決め 2 の守り）。`readPendingGoalTaskCompletions` が印の無い記録を拾う変更で落ちる |
| R8 | `src/__tests__/it-worker-pool-completion-publication.test.ts`（#193 の枝。既存に足す） | `clears the completion mark after the worker pool notifies a normal completion` | 組み込みの実行が `completed` で終わり、`saveManagerEvent` が成功すると、通知のときに記録に印があり、そのあと印が無く、受信箱の完了がちょうど 1 件 | P6（W5 が `publishesGoalCompletion` を渡さないと通知のときに印が無い。`saveManagerEvent` を直接呼んだままだと印が残る） |
| R9 | 同上（S21 を改める） | `keeps the project open when the notification of a normal completion fails` | 「B の記録は `completed` で、印は無い」を「B の記録は `completed` で印が残り、`readPendingGoalTaskCompletions` が B を返す」に改める。ほかの assert（A を中断しない、host を閉じない、`finished` が B で呼ばれる、警告の 1 行）はそのまま | P2・P6（印を付けない、頼まない） |
| R10 | `src/__tests__/workerPool.test.ts`（既存に足す、単体） | `counts a goal task by its execution result when its completion notification fails` を `it.each([true, false])` | 既存の `ゴールのタスクの終了を受信箱へ保存し…` と同じ形で `saveEvent` が ENOSPC を投げる。結果は R5 と同じ数え方で、`[WARN]` が 1 行。runner の mock の `listTaskStateItems`（`workerPool.test.ts:65`、`[]` を返す）のままで、印のある記録は見つからず、`result` から送る経路を通る | P4 の `try/catch`（外すと約束が reject して失敗と数える）、P5 の `return result.success`。印の消し込みはこの試験では通らない（R4・R6 が見る） |
| R11 | `it-normal-completion-publication.test.ts` | `does not mark a goal completion saved by a caller that does not publish it` を `it.each(['completeTask', 'failTask', 'prFailTask', 'exceedTask'])` | R1 と同じ記録を、`completionPublicationPending` を渡さずに各関数へ通すと、印が無く、`readPendingGoalTaskCompletions` は空（instruct の再実行の保存の形） | P1・P2・P3 の `requested`（頼まれなくても付けると落ちる） |
| R12 | 同上 | `notifies from the run result and keeps the mark when the saved record cannot be read back` | R4 の形で、保存のあとの最初の `listTaskStateItems` だけを ENOSPC で投げさせる。`saveManagerEvent` は今と同じ引数でちょうど 1 回呼ばれ、結果は `{ success: 1, fail: 0 }`、記録には印が残る（daemon が出し直す）。`[WARN]` の行のうちタスク名と `could not be read back` を含むものがちょうど 1 行 | P4 の 3（読み直しの失敗で通知を止めると落ちる）。今の本番には読み直しが無いので、仕掛けた失敗は完了のあとの claim の読みに当たり、claim の再試行（5 秒）を 1 回待ってから落ちる |
| R13 | 同上 | `gives the caller's notice and the daemon's resend of one attempt one inbox event id: %s` を `it.each(['normal', 'paused before the workflow'])` | 元帥の決め「同じ知らせが 2 回届いても二重に積まない」の試験。R4 の mock の保存のあと、**呼び出し側が通知する前に** daemon が出し直す順にする（mock の保存のあとで、本物の `readPendingGoalTaskCompletions` → `publishPendingGoalTaskCompletions` を呼ぶ）。そのあと呼び出し側（`fillSlots` から P4）が本物の `saveManagerEvent` で通知する。`normal` は R4 の記録、`paused before the workflow` は R2 の形の記録（`run_slug` なし）を頼んで保存し、結果の `runSlug: 'setup-…'` で通知する形。受信箱のファイルを `receiveInboxChange` に渡し（`goal-completion-inbox-event-id.test.ts` の記録する ingress と同じ形）、渡った `eventId` の種類がちょうど 1 つ | 外した木で確かめる。`paused` の行：P1 の `markNormalCompletionPublicationPending` から `run_slug` の条件を外し、`run_slug` か `execution_id` があれば印を付ける形にする。daemon が記録の `executionId` で送って印を消し、呼び出し側の読み直しは印のある記録を見つけずに結果の `runSlug` で送るので、`eventId` が `'execution'` と `'run'` の 2 種類になって落ちる。P4 が設計どおり印のある記録だけを読み直すなら、呼び出し側が記録と結果のどちらの身元で送る実装でも、この順では 2 種類になる。`normal` の行：`inbox.ts:49-53` で `executionId` を `runSlug` より先に見るように入れ替える。daemon の知らせは両方を持つ（`pendingGoalTaskCompletions.ts:49-53`）ので `'execution'`、呼び出し側の知らせは `runSlug` だけなので `'run'` になり、2 種類で落ちる。直しの本番の P1〜P8 のどれを外しても `normal` の行は落ちない（守りの行） |
| R14 | 同上 | `does not publish or clear another attempt's mark when reading the saved record back` | R4 の mock を、最初の試み（`execution_id` を E1、`runSlug` を R1 とする）を頼んで `failTask` で保存する形にする（`completed` は再キューできない。`requeueFailedTask` は `failed` だけ、`taskRetryService.ts:185`）。mock はその保存のあと、返る前に、同じタスクを `requeueFailedTask` で再キューし、claim し直し（`execution_id` が E2 に変わる）、`updateRunningTaskExecution` で `runSlug` を R2 にして、次の試みを頼んで `completeTask` で保存する。2 つの `completion` は中身で見分けられるようにする（`summary` を変える）。そのあと mock は最初の試みの結果（`success: false`、R1、最初の `completion`）を返す。`autoRequeueMaxAttempts` は 0 のまま（自動の再キューを起こさない）。**前提の assert**（mock の中、次の試みの保存の直後）：tasks.yaml の生の記録が `execution_id: E2`（E1 と違う）・`run_slug: R2`・`goal_id`・次の `completion`・`completion_publication_pending: true` を持つ。**A**：`saveManagerEvent`（spy）がちょうど 1 回、`toHaveBeenCalledWith(cwd, { kind: 'completion', goalId, taskName, runSlug: R1, result: 最初の completion })` で呼ばれる。**B**：呼び出し側が返ったあと、生の記録は `execution_id: E2` で `completion_publication_pending: true` を持ち、`readPendingGoalTaskCompletions` が E2・R2 の 1 件を返す。**C**：`vi.spyOn(taskRunner, 'clearCompletionPublicationPending')`（`runWithWorkerPool` に渡す本物の `TaskRunner` のもの）が 1 回も呼ばれない。結果は `{ success: 0, fail: 1 }` | 外した木で確かめる。外す所は P4 の `publishTaskCompletion` の読み直しの絞り込みのうち `executionId` の一致で、名前・ゴールの id・終端の状態・印だけで探す形にする。読み直しは次の試みの記録（E2）を見つけて `publishAndClearPendingMark` に渡す。前提の assert のとおり、この記録は `goalId` と `completion` を持つ（`toTaskState` が写す、`mapper.ts:202-207`）ので、`publishGoalCompletion`（`claimTasks.ts:81-93`）は `false` を返さず、記録の R2 と次の `completion` で `saveManagerEvent` を呼ぶ。A は `runSlug: R2` と次の `completion` を受けて落ちる。続けて `:98-111` が身元 `{ goalId, status: 'completed', runSlug: R2, executionId: E2 }` で消し込みを呼ぶので、C はこの身元での 1 回の呼び出しを受けて落ちる。身元はすべて合うので印は消え、B は印の無い記録と空の `readPendingGoalTaskCompletions` を受けて落ちる。外し方を変えて、送るのは結果から、消し込みだけを読み直した記録の身元で呼ぶ実装にした木でも、C（呼び出しの身元が E2）と B は落ちる（A は通る）。消し込みの外側で身元を見るのが C で、`clearCompletionPublicationPending` が何も合わずに `undefined` を返す実装（`:101-111` は戻り値を見ない）でも、呼んだこと自体で落ちる。正しい本番では読み直しが何も見つけず、結果から送って消し込みを呼ばないので、A・B・C とも緑である。前提の assert が落ちるときは、外した木でも赤にならない組み方になっているので、そこで止めて組み方を直す |
| R15 | 同上 | `passes the caller's request from the execution to the save: %s` を `it.each(['completed', 'failed'])` | 本物の `executeTaskAndCompleteWithDetails` を、`resolveTaskExecution` と実行を mock にして（`it-goal-task-stop.test.ts` と同じ形）流す。6 番目の引数（`parallelOptions`）に `{ publishesGoalCompletion: true }` を渡すと記録に印が付き、渡さないと付かない | P8（`executeTaskAndCompleteWithDetailsInScope` から `persist*` を経て保存の関数まで渡さないと落ちる） |

既存の `workerPool.test.ts` の「ゴールのタスクの終了を受信箱へ保存し、イベントを処理せず終了する」（`saveEvent` を同じ引数でちょうど 1 回）は変えない。`worker-pool-runtime.test.ts` の M18 の試験（#193）は、runner の mock に `listTaskStateItems` が無いと `publishTaskCompletion` が投げて警告に回る。assert は変えず、mock に `listTaskStateItems: vi.fn(() => [])` を足すだけにする。

## 本番の直し（muse が書く）

| # | ファイル | 関数 | 変えること |
|---|---|---|---|
| P1 | `src/infra/task/taskRecordMutations.ts` | `markNormalCompletionPublicationPending`（新規） | `requested` が `true` で、`goal_id`・`completion`・`run_slug` がそろう記録にだけ `completion_publication_pending: true` を付ける。`execution_id` だけの記録（ワークフローの前の一時停止）には付けない（「直し方」の 1） |
| P2 | `src/infra/task/taskLifecycleService.ts`、`src/infra/task/types.ts`（`TaskResult`、`:23`） | `completeTask`、`failTask`、`prFailTask`、`TaskResult` | `TaskResult` に `completionPublicationPending?: true` を足し、`store.update` の中で作る終端の記録を P1 に通す |
| P3 | `src/infra/task/taskExceedService.ts`（`ExceedTaskOptions` も同じファイル、`:7`） | `exceedTask` | `ExceedTaskOptions` に同じ欄を足し、`buildExceededTaskRecord` の結果を P1 に通す |
| P8 | `src/features/tasks/execute/types.ts`、`taskExecution.ts`、`taskResultHandler.ts`、`src/features/merge/index.ts` | `TaskExecutionParallelOptions`、`executeTaskAndCompleteWithDetailsInScope`、`persist*`、`executePersistedPrMergeTask` | `publishesGoalCompletion?: true` を足し、保存の関数の `completionPublicationPending` まで渡す（「直し方」の 1）。merge の経路は `:220`・`:223`・`:253` の 3 つの保存に渡す |
| P4 | `src/features/tasks/execute/claimTasks.ts` | `publishTaskCompletion`（新規、export）、`publishAndClearPendingMark` | 「直し方」の 2 のとおり。読み直しは名前・ゴールの id・`executionId` で同じ試みに絞る。読み直しの失敗の警告は「印があれば daemon が出し直す」と書く。印を消せなかったときの警告を `saved as ${task.status}` にする |
| P5 | `src/features/tasks/execute/parallelExecution.ts` | `fillSlots`（`:487-506`） | ゴールタスクの `executionOptions` に `publishesGoalCompletion: true` を足し、`saveManagerEvent` を P4 に替える（`executionId: task.executionId` を渡す）。`return result.success` は変えない |
| P6 | `src/features/workerPool/builtinProjectRuntime.ts`（#193） | `startTask`（`:219-225`） | `executeRunTaskAndCompleteWithDetails` の第 5 引数に `publishesGoalCompletion: true` を足し、`.then` の `saveManagerEvent` を P4 に替える（`executionId: task.executionId` を渡す）。#193 の M18 の `try/catch` は P4 の中に入るので外し、`settled = true` と `finished` は残す。`:223` の、結果に `completion` か `runSlug` が無いときの `throw` を、takt run と同じく `log.error` して `finished` を呼ぶ形にする（上げる点 8） |
| P7 | `docs/goal-management.md`（ja も） | — | ゴールタスクの完了の通知が失敗しても、印から daemon が出し直すことを 1 文足す（#193 の M8 と同じ文に合わせる） |

## PR の分け方

**推し：takt run の分（P1〜P5、P7、P8、R1〜R7、R10〜R15）を、#193 を待たずに統合ブランチ宛ての別の PR で先に入れる。worker pool の分（P6、R8、R9）は #193 に入れる。**

- 統合ブランチでは、takt run と watch の経路がもう動いていて、通常の完了の通知が失敗すると今も知らせが失われ、成功が失敗と数えられる。#193 はマージを止めてあるので、#193 に入れるとその期間が #193 のマージまで延びる。
- 直しは infra の 4 ファイルと features の 5 ファイル（`claimTasks.ts`、`parallelExecution.ts`、`types.ts`、`taskExecution.ts`・`taskResultHandler.ts`、`merge/index.ts`）に収まり、worker pool のコードに触れない。#193 の差分を大きくしない。
- 「直し方」の 5 のとおり、どちらが先でも食い違わない。#216 が先なら、#193 の取り込み直しで P6 と S21（R9）を直すだけで、置き換えを忘れても知らせは失われない（印が残り、daemon が出し直す）。
- #193 にまとめると、#193 の差分に takt run の経路が混ざり、#193 の設計で範囲の外に置いた所（#193 の設計の上げる点 1・2）を #193 で変えることになる。

## 上流 nrslib/takt

上流の main（a1794751a）の `parallelExecution.ts:451-462` は、統合ブランチの `:495-508` と同じ形で、`saveManagerEvent` が投げると約束が reject し、成功が失敗として数えられる。上流には `completion_publication_pending` も `readPendingGoalTaskCompletions` も無いので、通知が失われたあとに拾う仕組みが元から無い。worker pool の W5 も同じ形（#193 の設計の「上流 nrslib/takt」）。記録だけで、上流へは何もしない。

## 上流と違う振る舞い（次の上流の取り込みのために）

| 試験・コード | 上流の振る舞い | フォークの振る舞い | 理由 |
|---|---|---|---|
| `taskLifecycleService.ts` の `completeTask`・`failTask`・`prFailTask`、`taskExceedService.ts` の `exceedTask` | 印を付けない | ゴールの id・`completion`・`run_slug` のある記録に印を付ける | 通知が失敗しても daemon が出し直す（J1） |
| `parallelExecution.ts` の `fillSlots` の通知 | `saveManagerEvent` を直接呼び、投げると失敗と数える | `publishTaskCompletion` で通知し、失敗は警告にとどめ、実行の結果のとおりに数える | J1・J2 |
| `claimTasks.ts` の `publishAndClearPendingMark` の警告 | （上流に関数が無い） | `saved as <status>` | 通常の完了でも状態を正しく書く |
| tasks.yaml の `completion_publication_pending` | 上流の schema は知らない欄として拒む（`.strict()`） | #170 と #216 が書く | #170・#216 を上流へ出すときは、印のキーを上流のスキーマに足すことが前提になる |

## 範囲の外

- `completePublishedTask`（PR の作り直し）。`pr_failed` を `completed` に書き換えるだけで、今も通知しない。#216 のあと、`pr_failed` の通知に失敗して印が残ったまま作り直すと、印は `buildTerminalTaskRecord` の `...task` でそのまま `completed` の記録に移り、daemon は書き換えたあとの `completion`（成功）を同じ `run_slug` で出し直す。manager には、まだ届いていなかった試みの最新の結果が 1 回届くので、この形のままにする。通知は成功し、読み直しから消し込みまでの間に作り直しが入った形は、Quint の（d）に書いた（manager に残るのは `pr_failed` の知らせの 1 回で、作り直しの成功は届かない。今と同じ）。
- #216 の範囲は、記録に `run_slug` が残る通常の完了（成功・失敗・`pr_failed`・`exceed`）だけである（元帥の決め、11/28）。
- ワークフローの前に一時停止で止まった試みの完了（記録に `run_slug` が無く、結果には `setup-…` の `runSlug` がある）。#216 では印を付けず、今と同じく結果の `runSlug` で 1 回通知する。通知が失敗すると、警告が出て、run は実行の結果のとおり失敗と数え、知らせは失われる。J1 がこの完了を外すのはこのためである。直し方は [#222](https://github.com/j5ik2o/takt/issues/222) で扱う（素描は「一時停止の完了をどこで直すか」の節の (a)）。
- ゴールが中止されていると、`saveManagerEvent` が何も書かずに返る形（`infra/goals/events.ts:32`）。通知も警告も無く、知らせは届かない。印の無い一時停止の記録は呼び出し側の通知しか道が無いので、この形で知らせが消える。モデルの `publish` はいつも届く前提で、この形は入れていない（Quint の（d））。[#223](https://github.com/j5ik2o/takt/issues/223) で扱う。
- 保存そのもの（tasks.yaml の書き込み）の失敗。今のまま投げる。
- 再キューや再 claim で印を外す #170 の決め。変えない。
- daemon の出し直し（`publishPendingGoalTaskCompletions`）、受信箱の `eventId`、`hasWork` の数え方。#170 のまま。
- PATH にどの版の takt があるか（元帥の決め）。

## 別の読みへの答え

別の担当（DS41F）の敵対的な読み（重い 10 件・中 7 件・軽い 5 件）に、e626fcce3 の本番のコード（worker pool は #193 の 601fb47ec）と Quint で 1 件ずつ答える。中と軽の 12 件は、原文が 1 行ずつの列挙だけで詳細が届いていないので、文から読み取れる範囲で確かめた。読み取れないものは「材料が少ない」とし、どこまで確かめたかを書いた。

当たる 5 件、一部当たる 5 件、当たらない 3 件、読み違い 5 件、材料が少ない 4 件（答えの欄の最初の語で数え、括弧の中の補足は数に入れない。この担当が見つけた最後の行「4 の近く」は数に入れない）。指摘 4 は当たらなかったが、その近くで一時停止の経路の穴が見つかった（表の最後の行）。

| # | 指摘（要約） | 答え | 理由 | 直したこと |
|---|---|---|---|---|
| 重 1 | 設計は印を「頼んだときだけ」と書くが、Quint は呼び出し側の種類で決めており、R11 と `safety` が両立しない | 一部当たる | R11 は「頼まずに保存すると印が無い」を見る。前の版のモデルでは「頼まない」が `Instruct` に当たり、J7 は `Instruct` の印を禁じるので、R11 と同じことを言っている。両立しないという点は読み違いである。ただ、頼むことと呼び出し側の種類を 1 つの値にまとめていたので、takt run が頼み忘れる形をモデルで外せなかった | `requested` を別の値にし、`brokenCallerForgetsRequest` を足した（J1 に違反する） |
| 重 2 | takt run では J3 が実行の結果に関係なく恒真 | 当たる（書き方） | `hostClosed` を立てるのは worker pool の遷移だけ。takt run には host が無いので、J3 は worker pool だけの性質である。設計にそう書いていなかった | J3 を worker pool だけと書き、worker pool の通知の失敗に届く witness（574 trace）を足した |
| 重 3 | `.then` は `result.success` を返すので、`:296-302` の失敗の数え方はこの経路に当たらない | 読み違い | `saveManagerEvent` が `.then` の中で投げると約束が reject し、`:253` で `false` になって `:296-302` で失敗と数える。最初の確かめ（a）で、本物の `runWithWorkerPool` が `{ success: 0, fail: 1 }` を返すことを流して確かめている | なし |
| 重 4 | `completeTask` は `failTask` と違って `run_slug` を書かないので、成功の完了に印が付かない | 当たらない | `completeTask` は `buildTerminalTaskRecord` を通り、`...task` で記録を引き継ぐ（`taskRecordMutations.ts:69-74`）。`clearRetryMetadata`（`:178-190`）は `run_slug` を消さない。ゴールタスクの `completeTask` は、どれも `updateRunningTaskExecution` で `run_slug` を書いたあとに呼ばれる（`taskExecution.ts:268` → `:450`、`merge/index.ts:155` → `:223`）。`failTask` の `:654` は書くためではなく、一時停止の経路で消すためにある。Sonnet の R1 も、`completeTask` の行は `run_slug` が残り、印が無いことだけで落ちた | なし（近くの穴は最後の行） |
| 重 5 | 印の無い既存の `completed` の記録を PR の作り直しと instruct の再実行に通すと、R3・R11 の 4 例のうち 3 例が落ちる。印が `...task` で移るのは印のある `pr_failed` だけ | 読み違い | instruct は `startReExecution` → `buildRetryTaskRecord`（`taskRetryService.ts:286`、`taskRecordMutations.ts:136-138`）で `run_slug`・`completion`・印を外してから実行し、頼まずに保存するので印は付かない。PR の作り直しは印を足さない。R3・R11 はどちらの経路も通らない。設計の「範囲の外」も、印が移るのは印の残った `pr_failed` のときだけと書いている | なし |
| 重 6 | merge の経路は通知せず、呼び出し側が `run_slug` で通知するが、設計は扱いを書いていない | 一部当たる（書き漏れ） | merge の 3 つの保存（`merge/index.ts:220`・`:223`・`:253`）は P8 に入っていた。書いていなかったのは、`:271` で投げ直したときに `taskExecution.ts:155-158` が保存済みの記録から `completion` と `run_slug` を返す形と、merge の一時停止では `run_slug` が消えないこと | 「直し方」の 1 に書き足した |
| 重 7 | R4・R5・R12 は印が付かなくても通り、P5 だけ壊しても落ちない | 当たる | 表のままの R4 は、今の本番で緑だった（印が付かず、消すものも無い）。Sonnet が確かめた | R4・R8 に「通知のときに印がある」を足した。mock が `publishesGoalCompletion` を見て頼む形にし、P5・P8 を外すと R4・R5 が落ちるようにした。P8 の中の配線は R15 で本物を通す |
| 重 8 | R10 は mock の `listTaskStateItems` が空でも通り、P4 を壊しても落ちない。mock に store が無い | 一部当たる | mock は `listTaskStateItems` を持つ（`workerPool.test.ts:65`）ので、`publishTaskCompletion` は投げずに結果から送る経路を通る。R10 が見るのは数え方と警告で、P4 の `try/catch` を外すと落ちる。印の消し込みは R10 では通らないのに、表の列は P5 とだけ書いていた | R10 の列を「P4 の `try/catch` と P5 の `return`。消し込みは R4・R6」に直した |
| 重 9 | Quint は読み直しのあとの身元のずれと、並行の形（2 つのタスクの同時保存、通知と daemon の出し直しの重なり）を見ていない | 一部当たる | 通知と出し直しの重なりは前の版にもあった（`daemonResend` は `Saved`・`Published` でも起きる）が、受信箱を 1 ビットで持っていたので、2 回届いても見えなかった。読み直しは名前とゴールだけで探すので、別の試みの印のある記録を拾いうる | 受信箱を `eventId` の集合にし、J8 を足した（`brokenMarkOnSchema` が違反、重なりの witness 1419 trace）。読み直しを `execution_id` で同じ試みに絞り、R14 を足した。2 つのタスクの同時保存を見ない理由は（d）に書いた |
| 重 10 | liveness が無いので、`Saved` で止まると J4・J5・J7 が空振りする。探索の件数も見積もりの値 | 一部当たる | 前の版の witness は action しか見ておらず、前提に届くかは示していなかった。「呼び出し側の遷移は 4 つ以下」も数えずに書いていた | 各不変条件の前提の witness を足し（（b）の表）、`callerSettles` を TLC で確かめた。公平性を外すと違反する。状態は TLC で尽くした（319 個、深さ 7） |
| 中 1 | R12 の `MarkUnrequested` の空振り | 材料が少ない | 文から読めたのは「`MarkUnrequested` に当たる試験」の話までで、R12 との関係は読み取れない。確かめたのは、`brokenMarkUnrequested` が J7 に違反すること（TLC）と、それを本番で守る試験が R11 で、R12 ではないこと | なし |
| 中 2 | R4 の 3 例が落ちない | 当たる | 重 7 と同じ | 重 7 と同じ |
| 中 3 | `.then` の reject が cause 無しの Sync→restore での印の消しもれ | 材料が少ない | 文が崩れていて、どの経路かが読み取れない。確かめたのは、`publishTaskCompletion` が失敗をすべて捕まえて投げないので、通知の失敗で `.then` が reject しないこと（J2・J3、`brokenNoCatch` で違反） | なし |
| 中 4 | `readPendingGoalTaskCompletions` がファイルを直に読み、ロックを取らない | 当たる（害は無い） | 事実として当たる（`taskStateReader.ts:103`）。書き込みは一時ファイルからの置き換え（`private-file.ts:178`）なので、読むのは前か後の中身で、古い中身で出し直しても `eventId` が同じで 1 回にまとまる。遅れた消し込みは身元の一致で何もしない。#170 の決めのまま | （d）に書いた |
| 中 5 | `takt merge` の直接の実行 | 当たらない | `executePrWorkflow`（`merge/index.ts:94-100`）は `createPrMergeTask` を `goal` なしで呼び（`:96`、`:139-140` で `startPrMergeTask`）、ゴールの id の無い記録を作る。P1 の条件で印は付かず、通知もしない。設計の突き合わせの表のとおり | なし |
| 中 6 | `RemoteAssignment` の setup の印が J7 に反する | 当たらない | `RemoteAssignment` は #193 の遠隔の実行の型（601fb47ec の `remoteProtocol.ts:27`）。setup の失敗の印は #170・#193 のもので、今も通知している完了なので J7（今通知しない完了に印を生まない）には当たらない。J7 はこの設計の通常の完了の性質で、#193 の印は #193 の設計とモデルの範囲 | なし |
| 中 7 | `.qnt:238` の witness と設計 `:141` の説明のずれ | 材料が少ない | 前の版の `.qnt:238` は `wResendAfterKill`（死んだあとの出し直し）で、設計の表の 1 行前（`:140`）の説明と合っていた。どこがずれているのかは読み取れない | witness と表は作り直した（（b）） |
| 軽 1 | `normalizeTaskConfig` が `:52` で知らない欄を落とすので出し直しは起きない、という設計の前提が 0.77.0 の問題と関係しないことが確かめられていない | 読み違い | `normalizeTaskConfig` の `:52` は `{ ...record }` で全部の欄を写し、落とさない（`taskConfigSerialization.ts:52`）。設計もそうした前提を置いていない。印が読みで残ることは、e626fcce3 で印のある記録を読ませて確かめている（「保存データの形」の節） | なし |
| 軽 2 | R6・R12 の「ちょうど 1 行」が、別の `[WARN]` で破られる | 読み違い | どちらも、タスク名（R12 はさらに `could not be read back`）を含む行に絞ってから数える。別の `[WARN]` は数に入らない | R6 の文に「タスク名を含む行」と書いた |
| 軽 3 | witness 2 件（案 B の 2 回目の書き込み）が表に無い | 読み違い | 表の下の文（前の版の `:143`）に `markOnFailure` の 116 / 264 として書いていた | 作り直した表の下に同じく書いた（120 / 390） |
| 軽 4 | 表の `log.error` は、実装は `parallelExecution.ts:500` だけ | 当たる | worker pool の W5 は、同じ場面で `log.error` ではなく `throw` する（601fb47ec の `builtinProjectRuntime.ts:223`）。前の版の対応表は takt run の行しか書いていなかった | （c）の表に W5 の `throw` を書き、P6 で `log.error` と `finished` にそろえる（上げる点 8） |
| 軽 5 | `kill` の実装が無い。型付けが `.then` の戻り値の型と合わない | 材料が少ない | `kill` に本番のコードが無いことは、前の版の対応表にも書いていた（プロセスの終了）。後半はどの型を指すのかが読み取れない | なし |
| 4 の近く | （この担当が見つけた）ワークフローの前の一時停止では、記録の `run_slug` が消えるのに結果には残り、今の呼び出し側は通知している | 当たる（新しい穴） | 「直し方」の 1。e626fcce3 の使い捨ての木で 1 回流して確かめた。前の版の設計は「`run_slug` の無い完了は今は通知しない」と読んでいたが、それはこの経路では成り立たない | 印は付けない（J8 を守る）と決め、理由を直した。J1 から外し、J7 を結果の形で書き直した。この穴は #216 の範囲の外で、[#222](https://github.com/j5ik2o/takt/issues/222) で扱う（「範囲の外」の節） |

### 2 回目の読み（cdb0d9b36..f830f0d82 への読み）

別の担当（DS41F）の 2 回目の敵対的な読み（重い 3 件・中 2 件・軽い 7 件）に、同じく e626fcce3 の本番のコードと Quint で 1 件ずつ答える。原文は一部の文が崩れていて、軽い 7 件は要約だけが届いた。原文から読み取れない所は、どう読んだかを書いた。

当たる 1 件、一部当たる 3 件、当たらない 2 件、読み違い 4 件、材料が少ない 2 件（1 回目と同じく、答えの欄の最初の語で数える。軽 2 の「読み違い（示し方は直した）」は読み違い、軽 5 の「一部当たる（書き方）」は一部当たる、軽 6 の「当たらない（書き方は直した）」は当たらないに数える）。重い 3 件と中 2 件に、本番の直しを変えるものは無かった。直したのは、J4 の文、Quint の説明の誤り（`callerSettlesUnfair` の反例）、R13・R14 の行である。

| # | 指摘（要約） | 答え | 理由 | 直したこと |
|---|---|---|---|---|
| 重 1 | 一時停止の記録を印の無いまま送るので、読み直しが失敗すると呼び出し側は `RunId`、daemon は `ExecId` を出し、J8 が破れる（`readBackFails` で受信箱が埋まる trace が 1712） | 読み違い | daemon が送るのは印のある記録だけである（`taskStateReader.ts:129`）。一時停止の記録には P1 の `run_slug` の条件で印が付かないので、daemon はこの試みを送らない。印を付ける本番のほかの 3 か所（`taskLifecycleService.ts:402` の setup の失敗、`:477` の中断の回収、`reconcileLostRun.ts:44`）は、claim のときの失敗と `running` のまま残った記録の回収で、終端まで保存した一時停止の記録には当たらない。Quint の `sameWrite` で、受信箱に `ExecId` が入る状態が無いことを TLC で確かめた（`pNoExecIdInInbox`、319 状態）。読み直しが失敗する一時停止の試み（`wPausedReadBackFails`）には 856 trace 届き、そのとき受信箱は `RunId` だけである。1712 trace は呼び出し側が 1 回送った状態を数えたものと読む。`RunId` と `ExecId` がそろう反例は `brokenMarkOnSchema` にだけある | `wPausedReadBackFails` を足した。一時停止の扱いを決める節を足した（「一時停止の完了をどこで直すか」の節） |
| 重 2 | `brokenMarkOnSchema` は J8 でなく J7 で外れていて、`safety` に含めて初めて違反する。設計は J8 違反と言い切っている | 読み違い | `brokenMarkOnSchema` を不変条件ごとに 1 本ずつ TLC で調べると、この版が違反するのは J8（`oneEventPerAttempt`）だけで、J7 を含むほかの 7 つは違反しない。これは `brokenMarkOnSchema` だけについての答えで、ほかの壊した版に言える一般則ではない（たとえば `brokenMarkUnrequested` は J7 だけに違反する。3 回目の読みの重 1）。J7（`noNewSends`）は、一時停止の完了を「今の呼び出し側が通知する完了」に数えるので、印が付いても違反しない。最短の反例は読み直しの失敗の形（3 手）で、daemon が先に出し直す形でも違反する（`pJ8DaemonFirst`） | Quint の（a）の説明に、2 つ目の形と、ほかの 7 つに違反しないことを書いた |
| 重 3 | 結果に `completion` と `runSlug` がそろうのに、`taskExecution.ts:156-158` で `runSlug` が落ちて `skipWithoutResult` に当たる形がモデルに無い。J5 の 1142 は、警告の無い未通知を数えていない | 当たらない | `completion` があって `runSlug` が無い結果は、本番では生まれない（理由は（d）に書いた）。`:155-158` は保存した記録の `run_slug` を返し、merge の記録はいつも `run_slug` を持つ。`skipWithoutResult` に当たるのは `completion` の無い結果だけで、そのとき終端の記録は保存されず、知らせるものが無い。J5 の witness の 1142 は、通知の失敗の witness と同じ数だった。`sameWrite` で、通知すべき完了（`publishesToday`）を送らずに `Returned` に入る遷移は `publishFails` だけである（`readBackFails` と `publish` は `publishedByCaller` を立て、`skipWithoutResult` と `returnWithoutPublishing` は `publishesToday` が偽のときにしか起きない）。これはモデルの遷移を読んで言えることで、J7 やほかの不変条件で確かめたものではない（3 回目の読みの中） | （d）に、この組み合わせが生まれない理由を書いた |
| 中 1 | `Published` に入れずに返る同時の形がモデルに無いので、J4 が実物より緩い | 一部当たる | 原文は短く、どの同時の形かが書かれていない。この担当は「読み直しから印の消し込みまでの間に、ほかの書き手が記録を書き換える形」と読んだ。`clearCompletionPublicationPending`（`taskLifecycleService.ts:509-533`）は身元がすべて一致しないと何もせず、`publishAndClearPendingMark`（`claimTasks.ts:101-111`）はそれを警告しない。PR の作り直しがこの間に `pr_failed` を `completed` に書き換えたときと、削除の予約が付いたときは、印が警告なしで残る。J4 は実物について言い過ぎていた。印は daemon が同じ `eventId` で出し直して消すので、J1・J8 は保たれる。「daemon が先に印を消し、呼び出し側が印の無い記録を見て結果から送る形」と読むなら、それは `publish` の印の無い分かれ（`.qnt:166-171`）でモデルにある | J4 の文と（d）に、この形を書いた。モデルには足していない（害が無く、J4 の外す形を文で書けば足りるため） |
| 中 2 | `markOnFailure` の J1 の違反の理由（設計の 140 行）が、モデルの `markAfterFailure`（`.qnt:188`）と合わない | 読み違い | 設計が挙げた 2 つの形は、どちらも TLC の反例として出る。「保存 → プロセスの死」（最短、2 手）と、「保存 → ディスクが埋まる → 通知の失敗 → 2 回目の書き込みも失敗」（4 手）である（`pJ1AfterKill`・`pJ1AfterSecondWriteFails`）。`:188` の `mark: recordRunSlug(s.shape)` は、案 B の 2 回目の書き込みも P1 と同じく `run_slug` のある記録にだけ印を付けるという置き方で、J1 は一時停止を外しているので、J1 の違反の形には関わらない | Quint の（a）の説明に、2 つの形の手数を書いた |
| 軽 1 | `callerSettles` は `callerStep` を前件に含むので必ず抜ける。`callerSettlesUnfair` の反例は止まり続けること（stuttering） | 当たる | TLC の反例は、試みの途中の状態で止まり続ける形だった。前の版の「ディスクが埋まって空くことを繰り返す反例」は誤り。`callerSettles` が示すのは、試みの途中のどの状態でも呼び出し側の遷移が起きうることまでである | Quint の（b）の段落を直した。遷移全体にだけ公平性を置く `callerSettlesSystemFair` を足した。これはディスクが埋まって空くことを繰り返す反例で違反するので、遷移全体の公平性だけでは足りないと分かる（呼び出し側の遷移の公平性が要るとまでは言えない。3 回目の読みの中） |
| 軽 2 | 古典の TLA には弱い公平性の演算子が無いのに、tla2sany が通している。公平性の読み方が示されていない | 読み違い（示し方は直した） | TLA+ には `WF_vars(A)` がある。`quint compile --target tlaplus --temporal callerSettles` の出力で、`WF_s(callerStep) => [](inAttempt => <>settled)` に訳されることを確かめた | Quint の（b）とモデルの注に、TLC が読む式を書いた |
| 軽 3 | 期間中に呼び出し側へ返る形を、`callerSettles` の書き方（前件は抜けてから）で確かめていない | 材料が少ない | 文が崩れていて、どの形かが読み取れない。確かめたのは、`callerSettles` の前件は試みの途中（`inAttempt`）で、抜けた後の状態は J1〜J8 の不変条件が見ていること | なし |
| 軽 4 | 同期の保存の走査で、実物では `runSlug` が印より先に増えて読むことは無い | 材料が少ない | 文が崩れている。読めた範囲で確かめたのは、`run_slug` は `running` の間に `updateRunningTaskExecution` で書かれ、印は終端の保存と同じ書き込みで付くこと、daemon は印のある記録しか読まないので、`run_slug` だけがある途中の記録を送ることは無いこと | なし |
| 軽 5 | 警告の条件で見た印が、keep や表示に書かれていない（J4 は `clearWarned` だけを見る） | 一部当たる（書き方） | モデルの `clearWarned` は、消し込みの失敗の警告と読み直しの失敗の警告の両方を表す。設計にもモデルにもそう書いていなかった | モデルの J4 の注に書いた |
| 軽 6 | R13 の `paused` の行は、「結果の `runSlug` で送る」実装なら `eventId` が 1 種類のままで落ちない。P6 の実行を禁じる試験は無い | 当たらない（書き方は直した） | R13 は daemon が先に出し直す順にしている。P1 の `run_slug` の条件を外すと、daemon が `executionId` で送って印を消し、呼び出し側は結果の `runSlug` で送るので、P4 が設計どおり印のある記録だけを読み直す限り、呼び出し側の送り方に関わらず 2 種類になる。後半は文が崩れていて読み取れない | R13 の行に、外す所と、落ちるときの値を書いた |
| 軽 7 | R14 は最初の試みの通知が実行の結果から行くので、別の試みの印を拾う経路をほとんど通らない | 一部当たる | 正しい本番では拾わないので、結果から送る。拾う経路を通るのは `executionId` の絞り込みを外した木だけで、そのとき R14 の assert が落ちる（3 回目の読みのあと、前提の assert と、消し込みの呼び出しを見る assert を足した）。一方、前の R14 は最初の試みを `completed` で保存してから再キューする形で、`completed` は `requeueFailedTask` で再キューできないので、試験として組めなかった | R14 を、最初の試みを `failTask` で保存してから再キューする形に直し、外す所と落ちる値を書いた |

### 3 回目の読み（83c4f98fc・5235cdabe への読み）

別の担当（DS41F）の 3 回目の敵対的な読み（重い 2 件・中 9 件・軽い 5 件）に、e626fcce3 の本番のコードと Quint で答える。届いたのは要約で、行番号は読みのときの版のものである。1 回目・2 回目と同じく答えの欄の最初の語で数えると、当たる 13 件、一部当たる 3 件。本番の表（P1〜P8）を変えるものは無かった。直したのは、試験の表の R14、J1・J3・J7 の文、Quint の注と試しの不変条件、範囲の外（#222・#223）、文の食い違いである。

| # | 指摘（要約） | 答え | 理由 | 直したこと |
|---|---|---|---|---|
| 1 重 | 2 回目の重 2 の「`brokenMarkOnSchema` は J8 だけに違反」は、同じ表の `brokenMarkUnrequested` に当たらない。`brokenMarkUnrequested` は J7 と J8 の両方に違反する | 一部当たる（書き方） | 2 回目の答えは `brokenMarkOnSchema` についての主張で、どの壊した版にも言える一般則ではない。そう読める書き方だった。ただし `brokenMarkUnrequested` が J8 に違反することは、TLC では再現しなかった（`oneEventPerAttempt`、345 状態、違反なし）。この版が足すのは instruct の記録への印だが、`markedOnSave` は `MarkUnrequested` でも `recordRunSlug` を求めるので、印のある記録はどれも `run_slug` を持つ。daemon も呼び出し側も `RunId` で送るので、受信箱の `eventId` は 1 つのままである。違反するのは J7 だけ | 2 回目の重 2 の答えと Quint の（a）の説明を、壊した版ごとの主張に書き直した |
| 1 中 | J5 の witness 1142 が通知の失敗と同じ数である理由を、J7 の書き方では確かめていない。J7 の注と式も違う | 当たる（書き方） | 理由はモデルの遷移の読みで言えることで、J7 で確かめたものではなかった | 2 回目の重 3 の答えを、遷移の読みとして書き直した。J7 の注は式にそろえた（4 中） |
| 1 軽 | daemon は印を消す前に受信箱へ書く（`pendingGoalTaskCompletions.ts:53-59`）ので、その間に呼び出し側が印を消す形が本番で起きる | 当たる（害は無い） | その間に呼び出し側が印のある記録を読み直して送り、印を消すと、daemon の消し込みは身元が合わずに何もしない。どちらも記録の `run_slug` で送るので `eventId` は 1 つで（J8）、印も残らない（J4）。モデルの `daemonResend` は書き込みと消し込みを 1 手にしているが、この重なりで終わりの状態は変わらない | なし |
| 2 中 | (b) は J1 を外す理由を「範囲の外」へ移すと書くが、J1 の文に「上げる点 6」が残り、「範囲の外」に移した先が無い。P1 の `run_slug` の条件が「要る」理由も、両案で同じに書かれている | 当たる | 移し忘れだった | J1 の文、「範囲の外」、上げる点 6、(b) の箇条を直した。P1 の条件は「一時停止の記録に印を付けず J8 を守るため」と書き、#222 で見直すとした |
| 2 中 | 2 回目の答えの件数が表と合わない（読み違いは 3 件） | 一部当たる | 答えの欄の最初の語で数えると、読み違いは重 1・重 2・中 2・軽 2 の 4 件で、文と合う。数え方を書いていなかった | 1 回目・2 回目の件数の文に数え方を書いた |
| 2 中 | PR の作り直しが読み直しから消し込みまでの間に入る形で、Quint の（d）と「範囲の外」の終わりの状態が違う | 当たる | 2 つは別の形（通知が成功した形と、失敗した形）で、それを分けて書いていなかった。通知が成功した形では、daemon の出し直しは受信箱で `duplicate` になり（`eventStore.ts:262-267`）、manager に残るのは `pr_failed` の知らせである（コードの読み） | （d）に終わりの状態を書き、「範囲の外」から（d）を指した |
| 2 軽 | P4 の読み直しの失敗の警告の `run <run_slug>` と「if the record is marked」は、一時停止の試みに合わない | 当たる（説明の不足） | 警告の `run` は結果から送った `runSlug` で、一時停止の試みでは記録に無い。その記録には印が無いので、条件の節は成り立たず、出し直しも無いが、通知は成功している | 「直し方」の 2 の 3 に書き足した。警告の文と P4 は変えていない |
| 3 重 | R14 の外す所では、「次の試みの印が消える」assert が赤になるとは限らない。`publishAndClearPendingMark` は `publishGoalCompletion` が `false` なら印を消さない（`claimTasks.ts:81-93`・`:98-111`） | 当たる | 外した木で赤になるのは、拾った記録が `goalId` と `completion` を持つときだけで、試験はそれを固定していなかった。消し込みの外側で身元を見る assert も無かった | R14 に、前提の assert（次の試みの記録が E2・R2・`goal_id`・`completion`・印を持つ）と、消し込みの spy が呼ばれないこと（C）を足し、外し方ごとに落ちる assert と値を書いた |
| 3 中 | `callerSettles` と `callerSettlesSystemFair` の 2 本から、「呼び出し側の遷移に公平性が要る」とは言えない | 当たる | 言えるのは、遷移全体の公平性だけでは足りないことまでである | Quint の（b）、2 回目の軽 1 の答え、モデルの注を直した |
| 3 中 | (b) の「失われるのは通知も失敗したときだけ」は、ゴールが中止済みで `saveManagerEvent` が何も書かずに返る形（`infra/goals/events.ts:32`）を見落としている | 当たる | 印の無い一時停止の記録は呼び出し側の通知しか道が無いので、この形では通知も警告も無く知らせが消える。モデルの `publish` はいつも届く前提である | #223 に切り出したと「範囲の外」と（d）に書き、(b) の理由の文を直した |
| 3 中 | (a) の「manager の側は確かめていない」は本番で読める。`TurnEvent` には `runSlug` と `executionId` が両方載る（`inboxEvent.ts:8-12`） | 当たる | そのとおりだった。(a) を採ると R13 の `normal` の行の前提も崩れる | (a) は #222 へ引き継ぐ素描とし、その中に書いた |
| 3 軽 | J4 の注は、モデルに無い形（警告なしで何もしない消し込み）を説明していて、試験に落とす先が設計とモデルで違う | 一部当たる | 注は「この形はモデルに無い」と書くためのもので、その形はどの R の行も見ていない（「確かめていないこと」の最後の行）。設計の（d）とモデルの注は同じ形を指す | なし |
| 4 中 | J7 の式は印だけでも違反し、注とは別のものを言っている | 当たる | 式は「印があるか受信箱が空でない ⇒ `publishesToday`」で、一時停止の完了を「今通知する完了」に数える。注はそれを書き切っていなかった | 注を式にそろえた（式は変えていない）。`sameWrite` の `noNewSends` を TLC で流し、違反なし（319 状態） |
| 4 中 | J3 は host を閉じる遷移が 2 つ（`publishFails`・`skipWithoutResult`）あり、2 つの原因が読み取りにくい | 当たる | — | J3 の文とモデルの注に 2 つの遷移を書き、試しの不変条件 `pJ3ByPublishFailure`・`pJ3ByMissingResult` を足した |
| 4 軽 | TLC の結果は 1 回の流しで一致した | 当たる（確かめの一致） | — | 今回のモデルで 96 本と試し・時相の性質を流し直した（Quint の（a）） |
| 4 軽 | 「96 本を流し直した」に対し、10,000 サンプルの乱択 88 本は前の版のまま | 当たる | どの結果がどの版のモデルのものかを、1 つの段落に混ぜて書いていた | Quint の（a）と README で、版ごとに分けて書いた |

## 一時停止の完了をどこで直すか（(b) で確定、11/28）

元帥の決め（11/28）で (b) に確定した。#216 の範囲は、記録に `run_slug` が残る通常の完了（成功・失敗・`pr_failed`・`exceed`）だけである。(a) は #216 では扱わず、別の issue（[#222](https://github.com/j5ik2o/takt/issues/222)）で扱う。ゴールが中止されていると `saveManagerEvent` が何も書かずに返る形は [#223](https://github.com/j5ik2o/takt/issues/223) に切り出した。どちらも「範囲の外」の節に書いた。

**(b) #216 の範囲を「記録に `run_slug` が残る完了の知らせを失わない」に狭める（採る）。** 一時停止以外でワークフローの前に失敗した試みは、記録に `setup-…` の `run_slug` が残る（`taskExecution.ts:461-465` が外すのは `GoalPausedError` のときだけ）ので、P1 で印が付き、この範囲に入る。

- 本番の表（P1〜P8）は変わらない。P1 の `run_slug` の条件は、一時停止の記録に印を付けず、J8 を守るために置く（`brokenMarkOnSchema` が J8 に違反する）。#222 で一時停止の完了の送り方を変えるときは、そちらでこの条件を見直す。
- 不変条件：J1 は一時停止を外す。外す理由は「範囲の外」の節に書いた。ほかの J2〜J8 は変わらない。
- Quint：`PausedBeforeWorkflow` は残す。`brokenMarkOnSchema` が J8 に違反することで、P1 の `run_slug` の条件の理由を示すためである。
- 試験の表：R2 と R13 の `paused` の行は、一時停止の記録に印を付けないことの守りとして残す。
- 一時停止の完了の振る舞い：今と同じく、結果の `runSlug: setup-…` で 1 回通知する。通知が失敗すると、警告が出て、run は実行の結果のとおり失敗と数え、知らせは失われる。印が付かないので daemon は送らず、2 回届く形は無い（J8、TLC）。今との違いは、警告が出ることと、通知の失敗で約束が reject しないことだけである。

(b) を採った理由は 3 つある。2 回目の読みの重 1 は当たらず、今の設計で J8 は保たれている。失われるのは、一時停止したゴールの、ワークフローが始まる前の中断の知らせで、通知が失敗したとき（警告が出る）と、ゴールが中止済みで `saveManagerEvent` が何も書かずに返るとき（通知も警告も無い、#223）である。どちらでも記録は `failed` と `completion` を持って tasks.yaml に残る。(a) は `eventId` の決め方を変え、Quint と試験の作り直しが要るので、通常の完了の穴（成功が失敗と数えられ、知らせが失われる）を塞ぐのが遅れる。

**(a) 一時停止の試みを #216 の中で直す（採らない。#222 で扱う）。** 下は #222 へ引き継ぐ素描で、モデルにも入れておらず、TLC でも確かめておらず、P・R の行も書いていない。一時停止の試みは、呼び出し側も daemon も `execution_id` で送り、`eventId` を `(ゴール, タスク, 'execution', executionId)` にそろえる。

- 本番：`taskExecution.ts:479` で、記録から `run_slug` を外したときは結果にも `runSlug` を付けない。呼び出し側（`parallelExecution.ts:499-502`、W5 の `:223`）は、`completion` があり `runSlug` が無いゴールタスクを、claim した `executionId` で送る（P4 の結果から送る分かれも同じ）。P1 は `run_slug` か `execution_id` がある記録に印を付ける（schema の条件にそろえる）。読み直しが失敗しても、daemon が先に出し直しても、`eventId` は 1 つになる。
- Quint：`PausedBeforeWorkflow` の結果の身元を `ExecId` にし、J1 から外していた一時停止を戻す。今の `brokenMarkOnSchema` は設計そのものになるので、壊した版を「呼び出し側が結果の `setup-…` の `runSlug` で送る」に替える。J7 の「結果に `runSlug` が無い完了」も書き直す。
- 試験：R2 は逆になり（印が付く）、R13 の `paused` の行は `'execution'` の 1 種類を期待する。R5 と R12 に一時停止の行を足す。R13 の `normal` の行の前提（呼び出し側の知らせは `runSlug` だけを持つ）も崩れるので見直す。
- manager の側：manager の `TurnEvent` には、完了の知らせの `runSlug` と `executionId` が両方とも載る（`src/features/daemon/inboxEvent.ts:8-12`、3 回目の読み）。`eventId` が `'run'` から `'execution'` に変わっても、manager が身元を読めなくなることは無いと読む。`setup-…` は試みごとに作る乱数なので、`execution_id` に替えても試みごとに 1 つに決まることは変わらない。

## 上げる点

1. **R1〜R7・R11〜R15 を置くファイル**。新しい light IT にした。`it-goal-task-completion-publication` 系の既存のファイルに足すほうがよければ、Sonnet が決めてよい（assert は変えない）。
2. **P7 の docs の場所**。`docs/goal-management.md` にした。完了の通知の説明が別の節にあれば、muse がそこへ置く。#193 の M8 と同じ文にそろえる。
3. **出し直しの頻度**。通常の完了のたびに、保存から印を消すまでの短い間に daemon が出し直すことがある。受信箱で 1 回にまとまるので害は無いが、受信箱に写しのファイルが増える。気になるなら、daemon が印を読むときに `completed_at` から数秒の猶予を置く形を別に考える（この設計では入れない）。
4. **instruct の再実行のゴールタスク**。instruct（`taskInstructionActions.ts:292`）はゴールタスクにもかけられるが、今も manager に完了を通知しない。この設計では印を付けず、今の振る舞いのままにした。manager に知らせるべきなら、instruct も `publishesGoalCompletion` を渡して `publishTaskCompletion` を呼ぶ形で、別に直す（#217）。
5. **#193 の文書の書き換え**。#193 の設計（`worker-pool-completion-publication.md` の 5 節と上げる点 1・2）と `193-worker-pool-requests.md` の S21・M18 の行は、まだ「通常の完了には印を付けない」と書いている。#216 の設計が採られたら、#193 の設計の担当（Opus）がそこを書き換え、Sonnet が S21 を R9 のとおりに改める。この担当は #193 の作業ツリーに書いていない。
6. **ワークフローの前の一時停止の完了（決まった）**。記録に `run_slug` が無く、結果には `runSlug: setup-…` があり、今の呼び出し側はこれを通知している。#216 では印を付けず（P1 の `run_slug` の条件）、範囲の外として [#222](https://github.com/j5ik2o/takt/issues/222) で扱う（元帥の決め、11/28。「範囲の外」の節と「一時停止の完了をどこで直すか」の節）。考えた別の案は、#222 に引き継ぐ。
   - 別の案 B：一時停止の記録にも印を付け、呼び出し側は読み直した記録の `executionId` で送る。読み直しが投げたときは結果から送らず、daemon に任せる。知らせは失われず 2 回にもならないが、この試みの `eventId` が `run` から `execution` に変わり、「読み直しの失敗でも通知する」（03bd67d74 の決め）をこの形だけ変えることになる。
   - 別の案 C：結果からも `runSlug` を外し、記録とそろえる。呼び出し側は `:499-502` で通知しなくなる。今 manager に届いている知らせが届かなくなる。
7. **読み直しを `execution_id` で絞ること**。読み直しで別の試みの印のある記録を拾う穴（重 9）をふさぐため、`publishTaskCompletion` に `executionId` を渡す形にした（P4・P5・P6）。claim した `TaskInfo` は必ず `executionId` を持つ（`taskExecution.ts:222` が無ければ投げる）ので、新しい失敗の形は生まれないと読んだ。
8. **W5 の結果が欠けたときの扱い**。601fb47ec の W5（`builtinProjectRuntime.ts:223`）は、結果に `completion` か `runSlug` が無いと `throw` し、host を閉じる。takt run は `log.error` して返す。P6 で W5 も `log.error` と `finished` にそろえる形を推す。#193 の M18 の範囲なので、#193 の担当が別の形をもう決めていれば、そちらに合わせてよい。ただし `throw` のままにすると、Quint の `brokenPoolThrowsWithoutResult` のとおり J3 が成り立たなくなる。

## 確かめていないこと

- 実際の daemon を起こしての、出し直しから manager の 1 回の起動までの通し。#170 の試験（`goal-task-completion-publication` の IT）が見ている範囲で、ここでは流していない。R13 は、daemon の読みと受信箱の受け取りの関数を直に呼ぶ形にとどまる。
- `publishTaskCompletion` の読み直し（`listTaskStateItems`）が tasks.yaml のロックで待つ時間。読みだけで、ロックの時間切れは警告に回る（印は残る）と読んだが、流していない。
- merge の経路で、保存した `run_slug` と `result.runSlug` が一致すること。コードの読み（「直し方」の 1）だけで、試験では見ていない。
- R13〜R15 と、直しの一部を外したときに各試験が本当に落ちること。直しの本番がまだ無いので、試験の表の「外せば落ちる」は、R1〜R12 の今の本番での赤と緑（Sonnet の 16 件）と、コードの読みに基づく。
- 中と軽の 12 件のうち、文が崩れていた中 1・中 3・中 7・軽 5 の元の意味。
- 2 つのタスクの同時の保存（Quint の（d））。
- natural-japanese の段落ごとの確認と `newfacts.py`。lint と `calques.py` だけを流した。3 回目の読みのあとに書き足した文には、lint と `calques.py` も流していない。
- R13・R14 を、表に書いた所だけを外した木で流して、書いた assert が書いた値で落ちること（試験の担当が確かめる）。R14 は、前提の assert・A・B・C のどれが、どちらの外し方で落ちるかまで確かめる。
- 2 回目の読みの中 1・軽 3・軽 4・軽 6 の後半の元の意味。中 1 は、この担当の読み（読み直しから消し込みまでの間の書き換え）で答えた。
- 「一時停止の完了をどこで直すか」の (a)。#222 に移したので、ここでは確かめない。素描だけで、モデル・TLC・P と R の行のどれも無い。
- 乱択（`quint run`）は、3 回目の読みのあとのモデルで流し直していない。（b）の witness の数と 50,000 サンプルの `safety` は 2 回目の読みのあとのモデル、10,000 サンプルの 88 本はその前のモデルの結果である（Quint の（a））。
- 読み直しから消し込みまでの間の PR の作り直しと削除の予約は、コードの読みだけで、流していない。

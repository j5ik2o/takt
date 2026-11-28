# 通常の完了にも出し直しの印を付ける（#216）

- Issue: [#216](https://github.com/j5ik2o/takt/issues/216)（通常の完了で manager への通知に失敗すると、知らせが失われ、出し直しもされない）
- 基点: 統合ブランチ `integration/takt-mcp`（e626fcce3、[#191](https://github.com/j5ik2o/takt/pull/191) のマージのあと）
- worker pool の側: [#193](https://github.com/j5ik2o/takt/pull/193) の枝 `j5ik2o/takt-sync-upstream-main`（601fb47ec）と、その設計 `docs/design/worker-pool-completion-publication.md`
- 前提の設計: `docs/design/goal-task-completion-publication.md`（#170）
- Quint: `specs/quint/normal-completion-publication/`

## 結論

ゴールタスクの通常の完了も、#170 と同じ `completion_publication_pending` の印を、完了の保存と同じ書き込みで付ける。通知が成功したら印を消す。通知に失敗したら警告し、外へ投げず、run の成功・失敗の数は実行の結果のまま数える。印が残るので daemon が出し直す（元帥の決め 1・4、互換は案 A で確定）。

1. 印を付けるのは、`completeTask`・`failTask`・`prFailTask`・`exceedTask` が書く記録のうち、ゴールの id・`completion`・`run_slug` がそろったものだけ。これは、今の呼び出し側が通知を出す条件（`parallelExecution.ts:499-502`）と同じである。
2. 通知は、新しく export する `publishTaskCompletion`（`claimTasks.ts`）を通す。中で保存済みの記録を読み直し、マージ済みの `publishAndClearPendingMark` で通知して印を消す。失敗は捕まえて警告する。
3. `takt run`（`parallelExecution.ts`）と worker pool の W5（`builtinProjectRuntime.ts`）は、どちらもこの関数を呼ぶ。`completeTask` は両方の経路が共有しているので、印の付け方は 1 か所の変更で両方にそろう。
4. 印の無い古い記録は、出し直し待ちと読まない。読み替えも書き戻しもしない（元帥の決め 2）。
5. 受信箱の指摘（`inbox.ts`）は、コードと 1 回の実行で確かめたが再現しなかった。#216 の範囲にも別の issue にもしない（「受信箱の指摘」の節）。

## 最初の確かめ（統合ブランチの使い捨ての木）

e626fcce3 の使い捨ての木（`git worktree add --detach`、コミットせず、最後に消した）で、`runWithWorkerPool` に本物の `TaskRunner` と tasks.yaml を渡した。実行は本物の `completeTask` で `completed` を保存して `{ success: true, runSlug: 'run-a', completion }` を返し、`saveManagerEvent` が `PrivateFileLockAcquisitionError('cannot notify completion', 'ENOSPC')` を投げる形にした。

- (a) 結果は `{ success: 0, fail: 1, executedTaskNames: ['goal-a'] }`。成功したタスクが失敗として数えられた。
- (b) tasks.yaml の記録は `status: completed` で `completion` を持ち、`completion_publication_pending` が無い。`readPendingGoalTaskCompletions` は `[]` を返した。
- 警告もログの行も出なかった（`.then` の例外は `:253` で `false` に変わるだけ）。

issue の本文の読みのとおりだった。

## いまの動きの突き合わせ

通常の完了を保存する経路ごとに、保存・印・通知・失敗のときの扱い・出し直しを並べる。行番号は、takt run の経路が e626fcce3、worker pool の経路が #193 の 601fb47ec。

| 経路 | 保存 | 印 | 通知 | 通知が失敗したとき | 出し直しが拾うか |
|---|---|---|---|---|---|
| takt run・watch（`parallelExecution.ts:495-508` の `fillSlots`） | `executeTaskAndCompleteWithDetails`（`taskExecution.ts:114-130`）の中で `completeTask`・`failTask`・`prFailTask`・`exceedTask`（`taskLifecycleService.ts:598-660`・`:736-765`、`taskExceedService.ts:25-41`）。merge の経路（`merge/index.ts:220`・`:223`・`:253`）も同じ関数 | 付かない | 保存のあと `saveManagerEvent` を直接（`:503-506`） | タスクの約束が reject し、`:253` で `false` になる。成功が失敗として数えられ（`:296-302`）、警告は出ない。記録は `completed` なので自動の再キュー（`:276-298`）の候補にもならない | 拾わない（印が無い。`taskStateReader.ts:129`） |
| worker pool の W5（`builtinProjectRuntime.ts:217-239`） | 同じ `executeRunTaskAndCompleteWithDetails` → 同じ 4 つの関数 | 付かない | `saveManagerEvent` を直接（`:224-225`） | #193 の設計の前は、runtime の `failed` から host が閉じ、そのプロジェクトの実行がすべて止まる。#193 の M18 のあとは、警告して `finished` を呼ぶ（印は付けない） | 拾わない |
| worker pool の遠隔の終わり（W6、`remoteTaskLifecycle.ts:120-167`） | daemon 側の `buildTerminalTaskRecord`。`completeTask` は通らない | #193 の M6 で、ゴールタスクには付く | #193 の M6 で `publishAndClearPendingMark` | #193 の M6 で、警告して返事を返す | #193 のあとは拾う |
| PR の作り直し（`taskPullRequestActions.ts:264-276` の `completePublishedTask`） | `pr_failed` を `completed` に書き換える | 付けない（この設計でも付けない） | 通知しない（今もしない） | — | — |

W6 は #193 が通常の完了も含めて直すので、この設計で足すことは無い。PR の作り直しは、`pr_failed` の完了をもう一度知らせる経路ではないので範囲の外に置く（「範囲の外」の節）。

## 直し方

### 1. 印を付ける場所

- `src/infra/task/taskRecordMutations.ts` に `markNormalCompletionPublicationPending(record)` を足す。記録が `goal_id`・`completion`・`run_slug` を持つときだけ `completion_publication_pending: true` を付け、それ以外はそのまま返す。
- `completeTask`・`failTask`・`prFailTask`（`taskLifecycleService.ts`）と `exceedTask`（`taskExceedService.ts`）が `store.update` の中で作る終端の記録を、この関数に通す。保存と同じ書き込みで印が付くので、保存のあとでプロセスが死んでも印は残る。
- `run_slug` を条件に入れるのは、今の呼び出し側が `result.runSlug` の無い完了を通知しない（`parallelExecution.ts:499-502`）からである。`isValidCompletionPublicationPending`（`taskRecordSchemas.ts:19-26`）は `execution_id` だけでも印を有効と読むので、それに合わせて印を付けると、`GoalPausedError` でワークフローの前に止まった試み（`taskExecution.ts:462-465` が `runSlug` を外して保存する）の完了を、今は送らないのに daemon が送るようになる。今送っていないものを新しく送らないこと（J7）を守るため、条件は呼び出し側の条件にそろえる。
- `exceedTask` は `buildExceededTaskRecord`（`taskRecordMutations.ts:84-102`）を通る。`clearRetryMetadata` は `run_slug` を消さないので、`running` のときの `run_slug` が残り、印の条件を満たす。
- #170 の 3 経路（`buildSetupFailedTaskRecord`、中断の回収、`reconcileLostRun`）は、もう印を付けている。変えない。

### 2. 通知の関数

`src/features/tasks/execute/claimTasks.ts` に `publishTaskCompletion(taskRunner, cwd, task: { name, goalId }, result: { runSlug, completion })` を足して export する。

1. `taskRunner.listTaskStateItems()` から、名前とゴールの id が一致し、状態が終端で、印のある記録を探す。`run_slug` では探さない。保存した `run_slug` と `result.runSlug` がずれていても、daemon が出し直すときと同じ `run_slug` で送るためである。
2. 見つかったら、その記録を `publishAndClearPendingMark`（`claimTasks.ts:98-112`）に渡す。保存した `completion` と `run_slug` で通知し、成功したら、保存した `status`・`run_slug`・`execution_id` を身元にして印を消す。呼び出し側は保存した `status` と `execution_id` を持っていないので、読み直しで身元をそろえる。
3. 見つからない（印の付かない記録、または試みのあいだに消された記録）ときは、今と同じく `result` から `saveManagerEvent` を呼ぶ。消す印は無い。
4. 1〜3 をまとめて `try/catch` で囲む。失敗したら `warn()` と `log.error()` を出し、投げない。警告の文は「Goal task <name> (goal <goal id>, run <run_slug>) finished and is saved in .takt/tasks.yaml, but the manager was not notified; the daemon will resend it: <detail>」。`detail` は `sanitizeSensitiveText` を通す。

送る中身は今と同じになる。保存した `completion` は呼び出し側の `result.completion` をそのまま保存したもので、`run_slug` も同じ試みの値である。受信箱の `eventId` は `(受信箱, goalId, taskName, 'run', runSlug)` から決まる（`inbox.ts:49-50`）ので、この関数の通知と daemon の出し直しが重なっても 1 回にまとまる。

`publishAndClearPendingMark` の、印を消せなかったときの警告（`:107`）は「was saved as failed」と書き決めている。通常の完了では `completed` などもあるので、`saved as ${task.status}` にする。#170 の 3 経路では `status` が `failed` なので、文は今と変わらない。

### 3. 呼び出し側

- `parallelExecution.ts:503-506`：`saveManagerEvent` を `publishTaskCompletion(taskRunner, cwd, { name: task.name, goalId }, { runSlug: result.runSlug, completion: result.completion })` に置き換え、`return result.success` はそのまま。通知が失敗しても約束は reject しないので、成功は成功として数える（元帥の決め 4）。`:499-502` の `runSlug` の無い完了の扱いは変えない。
- worker pool の W5（`builtinProjectRuntime.ts:224-225`）：`saveManagerEvent` を `publishTaskCompletion(this.runner, this.cwd, { name: taskName, goalId: record.goal_id! }, result)` に置き換える。#193 の M18 の `try/catch` と警告は、この関数の中のものと同じ役なので、M18 は「この関数を呼び、`settled = true` にして `finished` を呼ぶ」に縮む。

### 4. 印を消す場所

印を消すのは 2 か所で、どちらもマージ済みのまま使う。

- 呼び出し側の通知が成功したあと：`publishAndClearPendingMark` が `clearCompletionPublicationPending`（`taskLifecycleService.ts:509-533`）を呼ぶ。身元がすべて一致する記録だけを書き換えるので、遅れて消しても再 claim した次の試みの印は消さない。
- それ以外（通知の失敗、消し込みの失敗、プロセスの死）：daemon が出し直して消す（`watchSource.ts:125`・`:157` → `readPendingGoalTaskCompletions` → `publishPendingGoalTaskCompletions`）。

### 5. #193 との接点

どちらが先に入っても食い違わない。

- **#216 が先**（推し、「PR の分け方」の節）：統合ブランチの `completeTask` が印を付けるようになる。#193 を取り込み直すとき、W5 を「直し方」の 3 のとおり `publishTaskCompletion` にする。#193 の S21（「B の記録は `completed` で、印は無い」）は「B の記録は `completed` で印が残り、`readPendingGoalTaskCompletions` が B を返す」に改める。#193 の設計の 5 節の「印は付けない（推し）」と、#193 の設計の上げる点 1・2 は、この設計で決まったと書き換える。
- **#193 が先**：#193 の M18 は今の設計のまま入る。#216 の PR が W5 を `publishTaskCompletion` に替え、S21 を同じく改める。
- 置き換えを忘れた場合：W5 が `saveManagerEvent` を直接呼んだままでも、印は `completeTask` が付けるので消えずに残り、daemon が出し直す。受信箱で 1 回にまとまるので、manager に 2 回は届かない。ただし worker pool の通常の完了のたびに daemon の出し直しが 1 回走る。これを防ぐため、worker pool の試験に「通知が成功したら印が消える」を足す（R8）。

## 守る不変条件

1 回の試みについて、次の 7 つを守る。

- **J1** 呼び出し側が試みから抜けたとき（返った、例外で抜けた、死んだ）、今の呼び出し側が通知する完了（`run_slug` あり）は、manager の受信箱にあるか、印が残って daemon に出し直される。
- **J2** run は、通知がどうなっても、実行の結果のとおりに成功・失敗を数える。
- **J3** 通知の失敗で、プロジェクトの host は閉じない。
- **J4** 呼び出し側が通知し、印を消すのに失敗しなかったときは、印は残らない。
- **J5** 呼び出し側が通知すべき完了を通知できずに返ったときは、警告が出ている。
- **J6** 印の無い古い記録は、出し直されない。
- **J7** 今の呼び出し側が通知しない完了（`run_slug` なし）には、印も送りも生まれない。

## Quint

`specs/quint/normal-completion-publication/normalCompletionPublication.qnt`。1 回の試みの保存から、呼び出し側の通知、印の消し込み、run の数え方、daemon の出し直し、古い記録の読みまでを書いた。呼び出し側は `TaktRun` と `WorkerPool` を初めに選ぶ。`DESIGN` が `"Current"`（e626fcce3）、`"SameWrite"`（案 A、この設計）、`"MarkOnFailure"`（案 B、通知に失敗したときだけ 2 回目の書き込みで印を付ける）を選び、`BREAK` が案 A を 1 か所ずつ壊す。ディスクはいつでも埋まり、空く。プロセスは保存のあといつでも死ぬ。quint は 0.32.0。

### (a) 不変条件が恒真でない

どの版も 10,000 サンプル、max-steps 12、seed 0x2a。不変条件ごとに 1 本ずつ流した。V は違反、空欄は違反なし。

| 版 | J1 | J2 | J3 | J4 | J5 | J6 | J7 |
|---|---|---|---|---|---|---|---|
| `sameWrite`（案 A） | | | | | | | |
| `current`（e626fcce3） | V | V | V | | | | |
| `markOnFailure`（案 B） | V | | | | | | |
| `brokenNoClear`（通知のあとで印を消さない） | | | | V | | | |
| `brokenNoCatch`（通知の失敗を捕まえない） | | V | V | | | | |
| `brokenNoWarn`（捕まえた失敗を警告しない） | | | | | V | | |
| `brokenResendUnmarked`（daemon が印の無い記録も出し直す） | | | | | | V | |
| `brokenMarkOnSchema`（印を schema の条件、`run_slug` か `execution_id` で付ける） | | | | | | | V |

7 つの不変条件は、どれもどれかの壊した版で違反する。`sameWrite` は、まとめた `safety` を 50,000 サンプル、max-steps 16 で流しても違反なし。乱択で、証明ではない。

- `current` の J1 は「通知が ENOSPC で投げ、印も無い」、J2 は「成功した実行が失敗と数えられる」、J3 は「worker pool で host が閉じる」。最初の確かめ（a）（b）と同じ形である。
- `markOnFailure` の J1 の反例は 2 つの形で出た。保存の直後にプロセスが死ぬ形（seed 0x1・0x2）と、通知の失敗のあとの 2 回目の書き込みも ENOSPC で落ちる形（seed 0x2a）。案 B を採らない理由の裏づけになる。
- `current` の J4・J5 は前提が成り立たない（印を付けず、通知の失敗では返らない）ので空振りする。J4 は `brokenNoClear`、J5 は `brokenNoWarn` で違反を確かめた。

### (b) 遷移に届く

`sameWrite` の witness（20,000 サンプル、max-steps 16、seed 0x2a）。

| witness | 届いた trace |
|---|---|
| 保存 / `run_slug` が無く通知を飛ばす | 19921 / 4988 |
| 通知 / 通知の失敗 | 3740 / 1202 |
| 印の消し込み / 消し込みの失敗 | 1047 / 323 |
| プロセスの死 / daemon の出し直し | 11300 / 8929 |
| 通知の失敗のあとの出し直し / 死んだあとの出し直し | 824 / 4373 |
| 通知が失敗しても成功と数える（takt run） / 通知が失敗しても返る（worker pool） | 295 / 611 |

案 B だけの 2 回目の書き込みとその失敗は `markOnFailure` で 154 / 490、古い記録の出し直しは `brokenResendUnmarked` で 19849 届いた。`sameWrite` では、この 3 つは 0 になる（その版に無い遷移なので正しい）。

### (c) 本番との対応

| モデル | 本番 |
|---|---|
| `save` | `taskLifecycleService.ts:598-660`・`:736-765`（`completeTask`・`failTask`・`prFailTask`）、`taskExceedService.ts:25-41`（`exceedTask`）。`markedOnSave` は「直し方」の 1 の `markNormalCompletionPublicationPending` |
| `skipWithoutRunSlug` | `parallelExecution.ts:499-502` の `log.error` |
| `publish` / `publishFails` | `Current`：`parallelExecution.ts:503-506`、`builtinProjectRuntime.ts:224-225`。`SameWrite`：「直し方」の 2 の `publishTaskCompletion` → `claimTasks.ts:98-112` |
| `Escaped` の数え方と `hostClosed` | `parallelExecution.ts:253`・`:296-302`、`builtinProjectRuntime.ts:234-239`（`failed` → 子の `stop()` → host の切断） |
| `returned` の数え方 | `parallelExecution.ts:301-302`（`settled.result` が実行の結果） |
| `markAfterFailure` / `markAfterFailureFails` | 本番のコードは無い（案 B の比べのためだけの遷移） |
| `clearMark` / `clearFails` | `taskLifecycleService.ts:509-533`、`claimTasks.ts:101-111` |
| `kill` | 本番のコードは無い（プロセスの終了） |
| `daemonResend` | `watchSource.ts:125`・`:157` → `readPendingGoalTaskCompletions`（`taskStateReader.ts:96-150`）→ `publishPendingGoalTaskCompletions` |
| `daemonReadsLegacy` | `taskStateReader.ts:129`（印が `true` でない記録は `completion` を読まずに飛ばす） |
| `diskFills` / `diskFrees` | 本番のコードは無い（環境） |

### (d) 範囲

- 1 回の試みだけ。自動の再キュー（`parallelExecution.ts:276-298`）や再 claim で記録が `pending` に戻ると、`buildClaimedTaskRecord`・`buildRetryTaskRecord` が印を外す（#170 の 1 節）。`failed` の通知に失敗した試みがすぐ再キューされると、その試みの完了は届かず、次の試みの完了が届く。これは #170 の決めのままで、J1 は試みごとの性質としてだけ見ている。
- 受信箱の写しの数は見ていない。`delivered` は 1 ビットで、同じ試みの写しは `eventId` で 1 回にまとまる（「直し方」の 2、「受信箱の指摘」の節）。daemon が印を消すことと、印のある間 daemon が止まらないことは #170 のモデル（`specs/quint/goal-task-completion-publication/`）の範囲で、ここでは見ていない。
- 保存そのものの失敗（tasks.yaml の書き込みの ENOSPC）は見ていない。`save` はディスクが空いているときだけ起きる。保存が失敗したときの扱いは今のまま変えない。
- 古い記録は「印の無い記録が 1 つある」とだけ置き、その中身は見ていない。J6 は、daemon が印で記録を選ぶことだけを見る。
- max-steps 12（比べ）と 16（witness と `safety`）。ディスクの出し入れでどの trace も伸びるが、呼び出し側の遷移は 4 つ以下で終わる。

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
| A（採る） | 保存と同じ書き込みで印を付け、通知の成功で消す | 古い版は、通知の短い間と通知の失敗のあとに tasks.yaml を読めずに止まる。Quint の J1〜J7 を守る |
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

既存の試験は弱めない。新しい試験のファイルは `tsconfig.tests.json` と `scripts/test-classification.mjs`（light IT）に足し、`releaseVerificationWiring.test.ts` を単独で流す。ENOSPC は `PrivateFileLockAcquisitionError('cannot notify completion', 'ENOSPC')` で作る。警告に混ぜる秘密は作り物の値を実行時につないで作る。

| # | ファイル | 試験の名前 | 確かめること | 本番のどこを外せば落ちるか |
|---|---|---|---|---|
| R1 | `src/__tests__/it-normal-completion-publication.test.ts`（新規、light IT） | `marks a normal goal completion for resend in the same save: %s` を `it.each(['completeTask', 'failTask', 'prFailTask', 'exceedTask'])` | `run_slug` のある `running` のゴールタスクを本物の `TaskRunner` で各関数に通すと、tasks.yaml の生の記録に `completion_publication_pending: true` があり、`readPendingGoalTaskCompletions` がその名前と `runSlug` を返す | P2・P3（どれか 1 つの関数で印を付けなければ、その行が落ちる） |
| R2 | 同上 | `does not mark a goal completion saved without a run slug` | `run_slug` が無く `execution_id` のある記録を `failTask`（`completion` あり）で保存すると、印が無く、`readPendingGoalTaskCompletions` は空 | P1 の条件（`execution_id` でも付けると落ちる） |
| R3 | 同上 | `does not mark a completion of a task without a goal` | `goal_id` の無いタスクを `completeTask` で保存すると、印が無い | P1 の条件 |
| R4 | 同上 | `clears the mark after takt run notifies a normal completion` | `runWithWorkerPool` に本物の `TaskRunner` と、本物の `completeTask` を呼ぶ実行を渡す。`saveManagerEvent`（spy、成功）は今と同じ引数でちょうど 1 回呼ばれ、そのあと記録に印が無く、結果は `{ success: 1, fail: 0 }` | P4・P5（消し込みを外すと印が残る。送る中身を変えると引数が合わない） |
| R5 | 同上 | `keeps the mark and counts the success when the takt run notification fails` を `it.each([true, false])` | `saveManagerEvent` が ENOSPC を投げる。結果は実行の結果のとおり（`true` なら `{ success: 1, fail: 0 }`、`false` なら `{ success: 0, fail: 1 }`）。記録に印が残り、`readPendingGoalTaskCompletions` がそれを返す。`[WARN]` の行のうちタスク名・ゴールの id・`run_slug`・`manager was not notified` を含むものがちょうど 1 行で、失敗の文に混ぜた秘密がどの行にも無い | P5（`try/catch` を外すと数が変わる）、P4（警告） |
| R6 | 同上 | `names the saved status when the mark cannot be cleared after a notification` | `clearCompletionPublicationPending` を投げる形で R4 を流す。`[WARN]` の 1 行に `saved as completed` があり、`saved as failed` は無い。結果は `{ success: 1, fail: 0 }` | P4（警告の文の `status`） |
| R7 | 同上 | `reads an old completed goal record without the mark as not pending` | 印の無い `completed` のゴールタスクだけの tasks.yaml で、`readPendingGoalTaskCompletions` が空、`TaskStore.read()` が通り、ファイルのバイトが変わらない | 今も緑（決め 2 の守り）。`readPendingGoalTaskCompletions` が印の無い記録を拾う変更で落ちる |
| R8 | `src/__tests__/it-worker-pool-completion-publication.test.ts`（#193 の枝。既存に足す） | `clears the completion mark after the worker pool notifies a normal completion` | 組み込みの実行が `completed` で終わり、`saveManagerEvent` が成功すると、記録に印が無く、受信箱の完了がちょうど 1 件 | P6（W5 が `saveManagerEvent` を直接呼んだままだと印が残る） |
| R9 | 同上（S21 を改める） | `keeps the project open when the notification of a normal completion fails` | 「B の記録は `completed` で、印は無い」を「B の記録は `completed` で印が残り、`readPendingGoalTaskCompletions` が B を返す」に改める。ほかの assert（A を中断しない、host を閉じない、`finished` が B で呼ばれる、警告の 1 行）はそのまま | P2（印を付けない） |
| R10 | `src/__tests__/workerPool.test.ts`（既存に足す、単体） | `counts a goal task by its execution result when its completion notification fails` を `it.each([true, false])` | 既存の `ゴールのタスクの終了を受信箱へ保存し…` と同じ形で `saveEvent` が ENOSPC を投げる。結果は R5 と同じ数え方で、`[WARN]` が 1 行。runner の mock の `listTaskStateItems` は `[]` のままで、`result` から送る経路を通る | P5 |

既存の `workerPool.test.ts` の「ゴールのタスクの終了を受信箱へ保存し、イベントを処理せず終了する」（`saveEvent` を同じ引数でちょうど 1 回）は変えない。`worker-pool-runtime.test.ts` の M18 の試験（#193）は、runner の mock に `listTaskStateItems` が無いと `publishTaskCompletion` が投げて警告に回る。assert は変えず、mock に `listTaskStateItems: vi.fn(() => [])` を足すだけにする。

## 本番の直し（muse が書く）

| # | ファイル | 関数 | 変えること |
|---|---|---|---|
| P1 | `src/infra/task/taskRecordMutations.ts` | `markNormalCompletionPublicationPending`（新規） | `goal_id`・`completion`・`run_slug` がそろう記録にだけ `completion_publication_pending: true` を付ける |
| P2 | `src/infra/task/taskLifecycleService.ts` | `completeTask`、`failTask`、`prFailTask` | `store.update` の中で作る終端の記録を P1 に通す |
| P3 | `src/infra/task/taskExceedService.ts` | `exceedTask` | `buildExceededTaskRecord` の結果を P1 に通す |
| P4 | `src/features/tasks/execute/claimTasks.ts` | `publishTaskCompletion`（新規、export）、`publishAndClearPendingMark` | 「直し方」の 2 のとおり。印を消せなかったときの警告を `saved as ${task.status}` にする |
| P5 | `src/features/tasks/execute/parallelExecution.ts` | `fillSlots`（`:503-506`） | `saveManagerEvent` を P4 に替える。`return result.success` は変えない |
| P6 | `src/features/workerPool/builtinProjectRuntime.ts`（#193） | `startTask` の実行の `.then`（`:224-225`） | `saveManagerEvent` を P4 に替える。#193 の M18 の `try/catch` は P4 の中に入るので外し、`settled = true` と `finished` は残す |
| P7 | `docs/goal-management.md`（ja も） | — | ゴールタスクの完了の通知が失敗しても、印から daemon が出し直すことを 1 文足す（#193 の M8 と同じ文に合わせる） |

## PR の分け方

**推し：takt run の分（P1〜P5、P7、R1〜R7、R10）を、#193 を待たずに統合ブランチ宛ての別の PR で先に入れる。worker pool の分（P6、R8、R9）は #193 に入れる。**

- 統合ブランチでは、takt run と watch の経路がもう動いていて、通常の完了の通知が失敗すると今も知らせが失われ、成功が失敗と数えられる。#193 はマージを止めてあるので、#193 に入れるとその期間が #193 のマージまで延びる。
- 直しは infra の 3 ファイルと features の 2 ファイルに収まり、worker pool のコードに触れない。#193 の差分を大きくしない。
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

- `completePublishedTask`（PR の作り直し）。`pr_failed` を `completed` に書き換えるだけで、今も通知しない。#216 のあと、`pr_failed` の通知に失敗して印が残ったまま作り直すと、印は `buildTerminalTaskRecord` の `...task` でそのまま `completed` の記録に移り、daemon は書き換えたあとの `completion`（成功）を同じ `run_slug` で出し直す。manager には、まだ届いていなかった試みの最新の結果が 1 回届くので、この形のままにする。
- 保存そのもの（tasks.yaml の書き込み）の失敗。今のまま投げる。
- 再キューや再 claim で印を外す #170 の決め。変えない。
- daemon の出し直し（`publishPendingGoalTaskCompletions`）、受信箱の `eventId`、`hasWork` の数え方。#170 のまま。
- PATH にどの版の takt があるか（元帥の決め）。

## 上げる点

1. **R1〜R7 を置くファイル**。新しい light IT にした。`it-goal-task-completion-publication` 系の既存のファイルに足すほうがよければ、Sonnet が決めてよい（assert は変えない）。
2. **P7 の docs の場所**。`docs/goal-management.md` にした。完了の通知の説明が別の節にあれば、muse がそこへ置く。#193 の M8 と同じ文にそろえる。
3. **出し直しの頻度**。通常の完了のたびに、保存から印を消すまでの短い間に daemon が出し直すことがある。受信箱で 1 回にまとまるので害は無いが、受信箱に写しのファイルが増える。気になるなら、daemon が印を読むときに `completed_at` から数秒の猶予を置く形を別に考える（この設計では入れない）。

## 確かめていないこと

- 実際の daemon を起こしての、出し直しから manager の 1 回の起動までの通し。#170 の試験（`goal-task-completion-publication` の IT）が見ている範囲で、ここでは流していない。
- `publishTaskCompletion` の読み直し（`listTaskStateItems`）が tasks.yaml のロックで待つ時間。読みだけで、ロックの時間切れは警告に回る（印は残る）と読んだが、流していない。
- merge の経路（`merge/index.ts:220`・`:223`）で、保存した `run_slug` と `result.runSlug` が一致すること。コードの読みでは一致するが、試験では見ていない。「直し方」の 2 の 1 は保存した記録の `run_slug` で送るので、ずれていても daemon の出し直しと同じ `eventId` になり、manager に 2 回は届かない。送る `runSlug` が今と変わるのは、ずれていた場合だけである。

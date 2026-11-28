# #216 の red の記録

設計：`docs/design/issue-216-normal-completion-publication.md`（5c7418941）の「red のテスト」の表。今の本番は統合ブランチの基点 e626fcce3 と同じ中身（この枝は設計の文書と Quint だけを足している）。

## 1 コミット目：takt run の light IT（R1〜R7、R11〜R13、R15）

ファイル：`src/__tests__/it-normal-completion-publication.test.ts`（新規、light IT。`tsconfig.tests.json` と `scripts/test-classification.mjs` の `lightNamedIntegrationTestFiles` に登録）。

流し方：`npx vitest run --config vitest.config.it.parallel.ts src/__tests__/it-normal-completion-publication.test.ts`。

結果：**20 件が走り、12 件が落ち、8 件が通った。** `releaseVerificationWiring.test.ts` を単独で流して 73 件が通った。`npx tsc -p tsconfig.tests.json --noEmit` は通った（`npm run build` のあと）。

### 落ちた 12 件（red）

| # | 試験 | 落ちた所 |
|---|---|---|
| R1 | `marks a normal goal completion for resend in the same save: completeTask` / `failTask` / `prFailTask` / `exceedTask`（4 件） | 生の記録の `completion_publication_pending` が `undefined`（`true` のはず）。`run_slug` は残っている |
| R4 | `clears the mark after takt run notifies a normal completion` | 通知のときの印が `[undefined]`（`[true]` のはず） |
| R5 | `keeps the mark and counts the success when the takt run notification fails: success=true` | 結果が `{ success: 0, fail: 1 }`（`{ success: 1, fail: 0 }` のはず）。通知の例外で約束が reject している |
| R5 | 同 `success=false` | 数え方は合う。記録に印が無い（`completion_publication_pending: true` のはず） |
| R6 | `names the saved status when the mark cannot be cleared after a notification` | `clearCompletionPublicationPending` が 0 回（1 回のはず）。今の本番は消し込みを呼ばない |
| R12 | `notifies from the run result and keeps the mark when the saved record cannot be read back` | 記録に印が無い。今の本番には読み直しが無く、仕掛けた読みの失敗は claim の読みに当たる |
| R13 | `gives the caller's notice and the daemon's resend of one attempt one inbox event id: normal` | 前提の assert で落ちる：保存の直後の `readPendingGoalTaskCompletions` が `[]`（この試みの 1 件のはず）。印が無いので daemon は出し直さない |
| R15 | `passes the caller's request from the execution to the save: completed` / `failed`（2 件） | 本物の `executeTaskAndCompleteWithDetails` に `publishesGoalCompletion: true` を渡しても、記録の `completion_publication_pending` が `undefined` |

### 通った 8 件（守り）

| # | 試験 | 守りであること | 本番のどこを壊せば落ちるか |
|---|---|---|---|
| R2 | `does not mark a goal completion saved without a run slug` | 今は印を付けないので通る | P1 の `run_slug` の条件を外し、`execution_id` だけでも印を付けると落ちる |
| R3 | `does not mark a completion of a task without a goal` | 同上 | P1 の `goal_id` の条件を外すと落ちる（のちの確かめで、P1 の条件だけを外しても落ちないと分かった。下の「直す前から緑の守りの 8 件」） |
| R11 | `does not mark a goal completion saved by a caller that does not publish it: completeTask` / `failTask` / `prFailTask` / `exceedTask`（4 件） | 同上 | P1〜P3 の `requested` を見ずに印を付けると落ちる |
| R7 | `reads an old completed goal record without the mark as not pending` | 決め 2 の守り | `readPendingGoalTaskCompletions`（`taskStateReader.ts:129`）が印の無い記録を拾うと落ちる。読み替え・書き戻しでファイルのバイトが変わっても落ちる |
| R13 | `gives the caller's notice and the daemon's resend of one attempt one inbox event id: paused before the workflow` | 一時停止の記録には印が付かないので、受信箱は呼び出し側の 1 通だけ | P1 の `run_slug` の条件を外すと落ちる（下の確かめ） |

### 設計の表との違い

- **R13 の `normal` の行は、設計の表では「守りの行」だが、今の本番で赤にした。** 設計どおり「渡った `eventId` の種類がちょうど 1 つ」だけを見ると、今の本番では印が無く daemon が何も送らないので、呼び出し側の 1 通だけで緑になり、試みが重なる形を見ていない（何も確かめずに通る）。そこで mock の中に前提の assert を足した：保存の直後に `readPendingGoalTaskCompletions` がこの試みの 1 件を返し、daemon の出し直しのあとに受信箱のファイルが 1 つ、呼び出し側の通知のあとに 2 つ。このため `normal` の行は、今の本番に加えて、P1・P2・P5・P8（印が付かない）を外したときにも落ちる。直しの本番では、設計の表のとおり `inbox.ts:49-53` の `runSlug` と `executionId` の順を入れ替えると落ちる（下の確かめ）。
- `paused before the workflow` の行にも前提の assert を置いた：保存した生の記録に `run_slug` が無く `execution_id` がある、daemon は何も出し直さない（受信箱は 0 個）、呼び出し側の通知のあと 1 個。
- R13 は、渡った `eventId` を `goal-completion-sha256([受信箱, goalId, タスク名, 'run', runSlug])` と比べて、種類が 1 つであることに加え、呼び出し側の `runSlug`（`normal` は `run-normal-completion`、一時停止は `setup-…`）の `'run'` の id であることまで見る。
- R15 は、印を頼んだ試みと頼まない試みを 1 つの試験の中で続けて流す（頼まない側は印が無いことを見る）。

### 「外せば落ちる」を外した木で確かめた（R13）

使い捨ての `git worktree add --detach`（コミットせず、最後に消す）で、本番を最小限だけ変えた：`completeTask`・`failTask` が、頼まれ、`goal_id`・`completion`・`run_slug` のある記録に印を付け、`fillSlots` がゴールタスクに `publishesGoalCompletion: true` を渡す（P1・P2・P5 の代わり。P4 は入れず、呼び出し側は今のまま結果の `runSlug` で送る）。

- 印を付けるだけの木：R13 の 2 行とも通った。
- そこから P1 の `run_slug` の条件を外し、`execution_id` だけでも印を付けた木：`paused before the workflow` が落ちた（前提の assert で、daemon が `executionId` の 1 件を出し直した）。前提の assert を外して流すと、`eventId` の種類の assert で 2 種類（`'execution'` と `'run'`）になって落ちた。`normal` は通った。
- `inbox.ts` で `executionId` を `runSlug` より先に見るようにした木：`normal` が `eventId` の種類の assert で 2 種類になって落ちた。`paused` は通った。

R2・R3・R11・R7 の壊し方は、読みで確かめた（印の条件と、`readPendingGoalTaskCompletions` の印の見方）。流してはいない。のちに別の担当が使い捨ての木で流した（下の「直す前から緑の守りの 8 件」）。

## 2 コミット目：worker pool の数え方の単体（R10）

ファイル：`src/__tests__/workerPool.test.ts`（既存に足す、単体。`tsconfig.tests.json` に載っている）。既存の試験は変えていない。

流し方：`npm test -- src/__tests__/workerPool.test.ts`。

結果：**69 件が走り、2 件が落ち、67 件が通った。** 落ちた 2 件は足した R10 の 2 行で、既存の 67 件は通った。`npx tsc -p tsconfig.tests.json --noEmit` は通った。

| # | 試験 | 落ちた所 |
|---|---|---|
| R10 | `counts a goal task by its execution result when its completion notification fails: success=true` | 結果が `{ success: 0, fail: 1 }`（`{ success: 1, fail: 0 }` のはず）。`saveManagerEvent` の ENOSPC で約束が reject し、失敗と数えられる |
| R10 | 同 `success=false` | 数え方は今も合う（reject は失敗と数えられる）。`[WARN]` の行が 0（1 行のはず）。今の本番は通知の失敗を警告しない |

`success=false` の行は、数え方の assert では赤にならず、警告の assert だけで赤になる。直しの本番で P4 の警告を外すと、この行は落ちる。P4 の `try/catch` を外すと `success=true` の行が数え方で落ちる。runner の mock の `listTaskStateItems` は `[]` を返すので、直しの本番では印のある記録が見つからず、結果から送る経路（設計「直し方」の 2 の 3）を通る。警告の行にはタスク名が入ることも見る。

## 3 コミット目：元帥の決め「同じ完了の知らせが 2 回届いても、manager がゴールを 2 回進めない」の試験

R13 は、設計の表のとおり「受信箱のファイルを `receiveInboxChange` に渡し、渡った `eventId` の種類がちょうど 1 つ」を見る。これは記録する ingress で `eventId` が同じことまでで、manager の turn が 1 回だけ始まること（タスクを二重に積まないこと）は見ていない。同じ `eventId` を 1 回にまとめるのは daemon の `FileEventStore.accept`（`eventStore.ts:262-267`、`duplicate` を返す）なので、そこまで通す試験を 1 本足した。設計の表で別のファイルに置く試験は R8・R9（#193）と R10（2 コミット目）だけで、ほかに無い。

ファイル：`src/__tests__/it-normal-completion-publication.test.ts`（1 コミット目と同じファイルに足す）。

| 試験 | 確かめること |
|---|---|
| `starts one manager turn for the caller's notice and the daemon's resend of one attempt` | R13 の `normal` と同じ順（保存 → daemon が出し直す → 呼び出し側が本物の `saveManagerEvent` で通知）で、受信箱の 2 つのファイルを本物の `receiveInboxChange` と本物の `FileEventStore`（`getGlobalConfigDir()`）に通すと、新しい turn がちょうど 1 つ（`task_completed`、このゴールとタスク）、`duplicate` がちょうど 1 つ、受信箱は空になる。前提の assert：保存の直後に daemon がこの試みの 1 件を出し直し、受信箱に 2 つのファイルがある |

流し方：1 コミット目と同じ。

結果：**21 件が走り、13 件が落ち、8 件が通った。** 足した 1 件は落ちた。1 コミット目の 20 件の結果は変わらない（12 件が落ち、8 件が通った）。`npx tsc -p tsconfig.tests.json --noEmit` は通った。

- 落ちた所：前提の assert で、保存の直後の `readPendingGoalTaskCompletions` が `[]`（この試みの 1 件のはず）。今の本番は印を付けないので、daemon は出し直さず、試みが重ならない。R13 の `normal` の行と同じ理由である。
- 直しの本番で落ちる所：P1・P2・P5・P8 を外すと、前提の assert で落ちる。`inbox.ts:49-53` で `executionId` を `runSlug` より先に見るように入れ替えると、turn の数の assert で落ちる。

外した木で確かめた：1 コミット目と同じ使い捨ての木（`completeTask`・`failTask` が頼まれたときに `run_slug` のある記録に印を付け、`fillSlots` が `publishesGoalCompletion: true` を渡す）で、この試験は通った。そこから `inbox.ts` の順を入れ替えると、新しい turn が 2 つになって落ちた（`expected [ … ] to have a length of 1 but got 2`）。

## 4 コミット目：別の試みの印を読み直しで拾わない（R14）

設計が通ったあとに頼まれた分。ファイル：`src/__tests__/it-normal-completion-publication.test.ts`（同じファイルに足す）。

| # | 試験 | 組み方 |
|---|---|---|
| R14 | `does not publish or clear another attempt's mark when reading the saved record back` | R4 の mock を、最初の試み（claim した `executionId` を E1、`runSlug` を `run-first-attempt` とする）を頼んで `failTask` で保存する形にする。mock は返る前に、同じタスクを `requeueFailedTask` で再キューし、`claimNextTasks` で claim し直し（E2）、`runSlug` を `run-next-attempt` にして、次の試みを頼んで `completeTask` で保存する。2 つの `completion` は中身が違う（最初は `failureReason` 付きの失敗、次は成功）。mock は最初の試みの結果（`success: false`、`run-first-attempt`、最初の `completion`）を返す。`autoRequeueMaxAttempts` は既定の 0 のまま。**前提**：E2 が E1 と違い、mock の中の次の試みの保存の直後の生の記録が `status: completed`・`goal_id`・`execution_id: E2`・`run_slug: run-next-attempt`・次の `completion`・`completion_publication_pending: true` を持つ。**A**：`saveManagerEvent` がちょうど 1 回、`runSlug: run-first-attempt` と最初の `completion` で呼ばれる。**B**：返ったあと生の記録が E2・`run-next-attempt`・印を持ち、`readPendingGoalTaskCompletions` が E2 の 1 件を返す。**C**：`runWithWorkerPool` に渡す本物の `TaskRunner` の `clearCompletionPublicationPending` の spy が 1 回も呼ばれない。結果は `{ success: 0, fail: 1 }` |

流し方：1 コミット目と同じ。

結果：**22 件が走り、14 件が落ち、8 件が通った。** 足した R14 は落ちた。前の 21 件の結果は変わらない（13 件が落ち、8 件が通った）。`npx tsc -p tsconfig.tests.json --noEmit` は通った。

- 落ちた所：前提の assert で、次の試みの生の記録に `completion_publication_pending` が無い（今の本番は印を付けない）。E2 と E1 が違うこと、`status`・`goal_id`・`execution_id`・`run_slug`・`completion` は合っていた（下の木で前提が通ることから）。
- 直しの本番で落ちる所：P1・P2・P5・P8 を外すと前提で落ちる。P4 の読み直しの絞り込みから `executionId` の一致を外すと、A・B・C がそれぞれ落ちる（下の確かめ）。

外した木で確かめた（1 コミット目と同じ使い捨ての木に、P4 の代わりを足した）：`fillSlots` が `saveManagerEvent` の代わりに、`listTaskStateItems` から名前・ゴールの id・`executionId`・終端の状態・印で記録を探し、見つかればマージ済みの `publishAndClearPendingMark` に渡し、無ければ結果から `saveManagerEvent` を呼ぶ関数を呼ぶ。

- `executionId` の一致を入れた木：R14 は通った（前提・A・B・C とも）。
- `executionId` の一致を外した木：A で落ちた（`saveManagerEvent` が次の試みの `run-next-attempt` と次の `completion` で呼ばれた）。A を外して流すと B で落ちた（印が消えた）。A と B を外して流すと C で落ちた（`clearCompletionPublicationPending` が 1 回呼ばれた）。A・B・C は、それぞれ単独で `executionId` の一致を外したことを捕まえる。

## 5 コミット目（記録だけ）：red の行の「外せば落ちる」と、試験の後半が届くことの確かめ

試験のコードは変えていない。

### 基点の確かめ

`git diff --stat e626fcce3 5c7418941 -- src scripts` は何も出さなかった。この枝の本番と scripts は e626fcce3 と同じで、上の結果は統合ブランチの本番の結果である。

### 直しの近似の木で全体を流した

使い捨ての木（コミットせず、最後に消した）に、直しの一部だけを近似で入れた：

- `completeTask`・`failTask` に P1・P2 の代わりを入れた。`prFailTask` と `exceedTask`（P2 の残り・P3）は入れていない。
- `fillSlots` に P5 の代わりを入れた。
- P4 の代わりを入れた：読み直しを名前・ゴールの id・`executionId`・終端の状態・印で絞り、見つかれば `publishAndClearPendingMark`、無ければ結果から送る。読み直しの失敗と通知の失敗は警告する。`saved as ${task.status}` も入れた。
- P8 は入れていない。

22 件のうち 18 件が通り、4 件が落ちた。

- 通った：R1 の `completeTask`・`failTask`、R4、R5 の 2 行、R6、R12、R13 の 2 行、manager の turn の試験、R14、守りの 8 件。
  - R4 の `warnings()` が `[]`、R5 の警告の行と秘密の無さ、R6 の `saved as completed`、R12 の `could not be read back` など、今の本番では最初の失敗の行より後ろで走らなかった assert も、この木では走って通った。
  - 試験の後半の組み方が直しの形とかみ合っていることは、これで確かめた。
- 落ちた：R1 の `prFailTask`・`exceedTask` と、R15 の 2 行。どれも印の assert で落ちた。近似で入れていない P2 の残り・P3・P8 を外したときに落ちる行で、表のとおりである。

この近似は本物の直しではない。muse の本番で同じことを確かめ直す必要がある。

### R15 の後半

R15 は、頼む試み → 頼まない試みの順で流す。今の本番では最初の試みの印の assert で落ちるので、頼まない側と末尾の assert は走らない。

順を入れ替えて一時的に流して確かめた（ファイルは元に戻した）。頼まない側は通り、頼む側は印の assert で落ちた。行は `completed`・`failed` の 2 行とも同じだった。

### red の行の「外せば落ちる」（読みで確かめた所）

R1・R4・R5・R6・R12・R15 の外す所は、設計の表の列を読みで確かめた。上の近似の木で通った行は、近似で入れた所を外すと今の本番と同じ落ち方に戻る。

- R1：保存の関数で印を付けないと、印の assert で落ちる。
- R4：P5・P8 で頼まないと、通知のときの印の assert で落ちる。P4 の消し込みを外すと、そのあとの印の assert で落ちる。
- R5：P4 の `try/catch` を外すと、`success=true` の行が数え方で落ちる。警告を外すと、警告の行の数で落ちる。
- R6：警告の文を `saved as failed` のままにすると落ちる。
- R12：読み直しの失敗で通知を止めると、`saveManagerEvent` の 1 回の assert で落ちる。
- R15：P8 の渡しを外すと、印の assert で落ちる。

一つずつ外した木では流していない。

## 6 コミット目：worker pool の組み込みの完了（W5）の R8・R9

基点：統合ブランチの先端 6b2595fe8。#224（takt run の分、P1〜P5・P8）と #193（worker pool）が両方入っている。W5（`builtinProjectRuntime.ts` の `startTask`）は直す前のままで、`publishesGoalCompletion` を渡さず、`saveManagerEvent` を直に呼んで `try/catch` で警告する。

ファイル：`src/__tests__/it-worker-pool-completion-publication.test.ts`（既存に足す、heavy IT。`tsconfig.tests.json` に載っている）。試験のコミットは 8b3022d65。

流し方：`npm test -- src/__tests__/it-worker-pool-completion-publication.test.ts`（heavy parallel IT の runner に回る）。

結果：**16 件が走り、2 件が落ち、14 件が通った。** 落ちた 2 件は R8 と R9 で、ほかの 14 件（#193 の S1〜S8・S19・S20・S23 など）は通った。`releaseVerificationWiring.test.ts` を単独で流して 74 件が通った。`npx tsc -p tsconfig.tests.json --noEmit` は通った（`npm run build` のあと）。

| # | 試験 | 落ちた所 |
|---|---|---|
| R8 | `clears the completion mark after the worker pool notifies a normal completion`（新規） | 通知のときの印が `[undefined]`（`[true]` のはず、`:246`）。W5 が印を頼まないので、保存に印が付かない |
| R9 | `keeps the project open when the notification of a normal completion fails`（#193 の S21 を改めた） | B の記録の `completion_publication_pending` が `undefined`（`true` のはず、`:435`）。その前の `status: completed`・`run_slug: run-${b.name}` の assert は通った |

### R8 の組み方

W5 の実行（`executeRunTaskAndCompleteWithDetails`）の代わりは、本物の `updateRunningTaskExecution` で `run_slug` を書き、本物の `completeTask` で保存する。5 番目の引数に `publishesGoalCompletion === true` があるときだけ `completionPublicationPending: true` を頼む（takt run の R4 の mock と同じ形）。`saveManagerEvent` の spy は、このタスクの完了が送られたときに tasks.yaml の生の印を控え、本物で送る。`runtime.start` から `finished` が呼ばれるまで待ち、通知のときに印があり、そのあと印が無く（schema を通した記録と生の記録の両方）、`readPendingGoalTaskCompletions` が空で、受信箱の完了がこのタスクと `run_slug` でちょうど 1 件、このタスクの `[WARN]` が無く、`fatal` が呼ばれないことを見る。

### S21 を R9 に改めた所

- 期待が逆になった行：`expect(savedRecord(b.name)?.completion_publication_pending)` を、改める前の `.toBeUndefined()`（通常の完了には印を付けない）から、改めた後の `.toBe(true)` にした。
- 足した assert：その前に B の記録が `status: completed`・`run_slug: run-${b.name}` を持つこと、その後に `readPendingGoalTaskCompletions` が B（`completed`、`run-${b.name}`）の 1 件だけを返すこと。
- そのままの assert：A を中断しない、`closes`（host を閉じる）と `fatal` が呼ばれない、`finished` が B で呼ばれる、タスク名・ゴールの id・`run-${b.name}` を含む `[WARN]` がちょうど 1 行、秘密がどの行にも無い、A があとで `completed` になる。
- 実行の代わりも改めた。改める前は、`run_slug` を書かずに claim した `task` のまま `completeTask` を呼び、印を頼まなかった。P1 は `run_slug` の無い記録に印を付けないので、このままでは直しの本番でも印が付かない。改めた後は、成功のときに本物の `updateRunningTaskExecution` で `run-${task.name}` を書き、その戻りの `task` で `completeTask` を呼び、`publishesGoalCompletion === true` のときだけ `completionPublicationPending: true` を頼む。結果の `runSlug` は前と同じ `run-${task.name}`。中断された A は前と同じく保存しない。

### 直しの近似の木で確かめた

使い捨ての `git worktree add --detach`（8b3022d65 から。コミットせず、最後に消した）の W5 に、P6 の近似を入れた：第 5 引数に `publishesGoalCompletion: true` を足し、`saveManagerEvent` の `try/catch` を `publishTaskCompletion(this.runner, this.cwd, { name: taskName, goalId: record.goal_id!, executionId: task.executionId }, result)` に替えた。`:223` の `throw` は変えていない。

| 木 | 結果 |
|---|---|
| 両方を入れた | 16 件が通った |
| 通知の関数だけ替え、`publishesGoalCompletion` を渡さない | R8 が `:246`（通知のときの印が `[undefined]`）で、R9 が `:435`（印が `undefined`）で落ちた。14 件は通った |
| `publishesGoalCompletion` だけ渡し、`saveManagerEvent` を直に呼んだまま | R8 が `:248`（通知のあとも印が `true` のまま）で落ちた。R9 は通った（印は付いて残り、警告は W5 の `try/catch` が 1 行出す）。15 件が通った |

- R9 だけでは、通知の関数の置き換え忘れを捕まえない。置き換え忘れは R8 が捕まえる。設計の P6 の「両方が要る」に合う。
- P6 のうち `:223`（結果に `completion` か `runSlug` が無いときの `throw` を `log.error` と `finished` にそろえる）は、R8・R9 のどちらも通らない。この 2 件はその所を確かめていない。

### 本番の直し（82141f838）で期待を変えた既存の単体試験

- `worker-pool-runtime.test.ts` の `passes only a confirmed assignment to execution and saves completion before releasing it`：第 5 引数の期待を `{ abortSignal, outputMode: 'silent' }` から `{ abortSignal, outputMode: 'silent', publishesGoalCompletion: true }` に改め（設計の P6 に従った期待の追加で、厳密な一致のまま。assert は消していない）、runner の mock に `listTaskStateItems: vi.fn(() => [])` を足して、`publishTaskCompletion` の読み直しの失敗の警告（`could not be read back`）が出ないようにした（設計の M18 の試験の記述のとおり）。

## 直す前から緑の守りの 8 件

1 コミット目の「通った 8 件」を、守っている本番の箇所で並べ直した。箇所は 6b2595fe8 の本番の行。「外すと落ちる」は、別の担当が使い捨ての木で確かめた結果である（この担当は流していない）。7 件は 1 か所を外すと落ちた。R3 は 2 重に守られていた。

- R2 `does not mark a goal completion saved without a run slug`：`markNormalCompletionPublicationPending`（P1、`taskRecordMutations.ts:123`）の `run_slug` の条件。外すと落ちた。
- R3 `does not mark a completion of a task without a goal`：P1 の `goal_id` の条件（`taskRecordMutations.ts:123`）と、`TasksFileSchema` の `isValidCompletionPublicationPending`（`taskRecordSchemas.ts:24` の `goal_id` の条件、`:323` で使い、合わない印を落とす）の 2 重。P1 の条件だけを外しても落ちず（schema が `goal_id` の無い印を落とす）、両方を外すと落ちた。1 コミット目の表の「P1 の `goal_id` の条件を外すと落ちる」は、これで改めた。
- R11 `does not mark a goal completion saved by a caller that does not publish it: completeTask`：P1 の `requested` の条件（`taskRecordMutations.ts:122`）。`completeTask`（`taskLifecycleService.ts:714`）がここを通る。外すと落ちた。
- R11 同 `failTask`：同じ条件。`failTask`（`taskLifecycleService.ts:748`）がここを通る。外すと落ちた。
- R11 同 `prFailTask`：同じ条件。`prFailTask`（`taskLifecycleService.ts:852`）がここを通る。外すと落ちた。
- R11 同 `exceedTask`：同じ条件。`exceedTask`（`taskExceedService.ts:36`）がここを通る。外すと落ちた。
- R7 `reads an old completed goal record without the mark as not pending`：`readPendingGoalTaskCompletions`（`taskStateReader.ts:131`）の、印の無い記録を飛ばす条件。外すと落ちた。1 コミット目の表の `:129` は、基点 e626fcce3 の行である。
- R13 `gives the caller's notice and the daemon's resend of one attempt one inbox event id: paused before the workflow`：P1 の `run_slug` の条件（`taskRecordMutations.ts:123`、R2 と同じ所）。外すと落ちた。

### 設計の文書の直し

設計（`issue-216-normal-completion-publication.md`）の文を、上の結果に合わせて直した。P の表と R の表の中身は、下の 2 つの欄のほかは変えていない。

- R の表の R3 の「本番のどこを外せば落ちるか」：P1 の `goal_id` の条件だけから、P1 と `isValidCompletionPublicationPending` の 2 重の守りに改めた。
- R の表の R13 の同じ欄：「直しの本番の P1〜P8 のどれを外しても `normal` の行は落ちない（守りの行）」を、前提の assert を置いた試験の形（直す前の本番で赤、P1・P2・P5・P8 を外すと落ちる）に改めた（1 コミット目の「設計の表との違い」のとおり）。
- 「直し方」の 3 の W5 の行：W5 には通知の関数の置き換えと `publishesGoalCompletion` を渡すことの両方が要ること、片方だけのときにどうなり、どの試験が落ちるかを足した（#224 の review の指摘）。

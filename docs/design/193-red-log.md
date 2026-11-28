# #193 の red の試験の記録

`docs/design/193-worker-pool-requests.md` の S の行ごとに、足した・改めた試験と、直す前の本番（3bcae5cc9）で流した結果を残す。本番を直したら、ここに書いた red の試験が緑になることを確かめる。

流し方：単体は `npx vitest run <file>`、heavy の並列 IT は `npm_config_ignore_scripts=true node scripts/run-heavy-it-parallel.mjs <file>`（`npm test -- <file>` と同じ設定。deepseek-harness の型の前段だけ飛ばした）。

## #195・#196・#197（S1〜S8）

### 足した・改めた試験

- S1 `it-worker-pool-completion-publication.test.ts` › marks an unreadable goal task failure for resend when the worker pool notification hits ENOSPC
- S2 同 › marks a remote terminal record for resend when its manager notification fails
- S3 同 › clears the completion mark after the worker pool notifies a failed claim
- S4 同 › calls the task finish hook exactly once for each worker pool terminal save: %s（unreadable task / failed claim / remote finish / remote fail / builtin completion）
- S5 `worker-pool-runtime.test.ts` › keeps a %s completion notification failure inside the runtime so its marked record is resent（recheck / claim。既存を改めた）
- S6 同 › rechecks unreadable remote input after the claim, publishes the saved terminal result, and keeps a failed notification inside the runtime so its marked record is resent（既存を改めた）
- S7 `it-worker-pool-completion-publication.test.ts` › keeps A running when a worker pool setup failure notification hits ENOSPC: %s（unreadable task / failed claim）
- S8 同 › keeps the remote request result when its manager notification fails

### 直す前の本番で流した結果

`worker-pool-runtime.test.ts`：13 件走り、3 件落ちた（ほかの 10 件は緑のまま）。

| 試験 | 落ちた理由（期待 → 実際） |
|---|---|
| S5 recheck | `start()` が `{ kind: 'declined' }` で解決する → `notification failed`（ENOSPC）で reject |
| S5 claim | 同上 |
| S6 | 2 回目の `remote(claim)` が `{ kind: 'claim', assignment: null }` で解決する → `Cannot notify manager` で reject |

`it-worker-pool-completion-publication.test.ts`：11 件走り、10 件落ちた。

| 試験 | 落ちた理由（期待 → 実際） |
|---|---|
| S1 | 保存の `completion_publication_pending` が `true` → `undefined` |
| S2 | 遠隔の `fail` の保存の `completion_publication_pending` が `true` → `undefined` |
| S3 | 通知のあとの `completion_publication_pending` が `undefined` → `true`（`readManagerEvents` の 1 件は通る） |
| S4 unreadable task | フックのファイルにタスク名が 1 回 → 0 回（`[]`） |
| S4 failed claim | 同上 |
| S4 remote finish | 同上 |
| S4 remote fail | 同上 |
| S7 unreadable task | A の `signal.aborted` が `false` → `true`（B の通知の ENOSPC で host が閉じ、A が中断された） |
| S7 failed claim | 同上 |
| S8 | `remote({ kind: 'fail' })` が保存した記録の返事を返す → `disk full` で reject |

緑の 1 件：S4 builtin completion。通常の完了（W5）のフックは今も `withTaskFinishHook` が 1 回呼ぶので、今の本番で緑になる守りの行である。M5 が W5 にもう 1 回フックを足すと、2 回になって落ちる。この行は red の件数に入れない。

### 本番のどこを外せば落ちるか

| 設計の行 | 当たる試験 |
|---|---|
| M1（`buildUnreadableGoalTask` の印） | S1 |
| M5（`publishSetupFailure` を通す置き換え） | S3（印の消し込み）、S5・S6（`declined` / `claim` の返事と警告） |
| M5（捕まえる `try/catch`） | S5、S6、S7 |
| M5（ローカルのフック `scheduleFinishHook`） | S4 の unreadable task・failed claim |
| M6（遠隔の終わりの印） | S2 |
| M6（`onTerminal` の呼び出し） | S4 の remote finish・remote fail（外すと 0 回）。同じ `finish` / `fail` の送り直しで 2 回呼ぶ変更でも落ちる |
| M6（`try/catch` の警告と返事） | S8 |
| フックを 2 回呼ぶ変更（W5 を含む） | S4 の全行（`close()` のあとも 1 回のまま） |

### 既存の試験の期待を変えたもの（S5・S6）

- 試験の名前を「propagates %s completion notification failures outside acquisition retry」から「keeps a %s completion notification failure inside the runtime so its marked record is resent」に、「rechecks unreadable remote input after the claim and publishes the saved terminal result」の名前に「... and keeps a failed notification inside the runtime so its marked record is resent」を足した。
- S5：`rejects.toBe(failure)` を `resolves.toEqual({ kind: 'declined' })` に替えた。`doubles.event` の `toHaveBeenCalledExactlyOnceWith(...)`、`execute` と `finished` が呼ばれないことの assert は残した。足した assert：runtime の `failed` が呼ばれない、`clearCompletionPublicationPending` が呼ばれない（fixture の `saved` に `completion_publication_pending: true` を足し、その印が `saved` に乗っていることも確かめる）、`[WARN]` の行のうちタスク名と `manager was not notified` を含むものがちょうど 1 行。`claim_retry` を返さないことは `toEqual({ kind: 'declined' })` が見る。
- S6：後半の `rejects.toBe(failure)` を `resolves.toEqual({ kind: 'claim', assignment: null })` に替え、`doubles.event` が 2 回目まで呼ばれたこと（`toHaveBeenCalledTimes(2)`）と警告の 1 行を足した。前半の assert と、そのあとの「Git or storage failed」で reject する assert は残した。
- fixture：`claimTasks.js` の mock を、本物を広げたうえで `CLAIM_RETRY_INTERVAL_MS` と `failInterruptedTasksWithGoalEvents` だけを差し替える形にした（M5 のあと本番が `publishSetupFailure` を import しても mock に無い export で落ちないように）。`TaskRunner` の mock に `clearCompletionPublicationPending` を足した。警告は `console.log` を覗いて `[WARN]` の行を拾う（`shared/ui` の `warn()` の出口）。

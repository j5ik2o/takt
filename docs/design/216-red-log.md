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
| R3 | `does not mark a completion of a task without a goal` | 同上 | P1 の `goal_id` の条件を外すと落ちる |
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

R2・R3・R11・R7 の壊し方は、読みで確かめた（印の条件と、`readPendingGoalTaskCompletions` の印の見方）。流してはいない。

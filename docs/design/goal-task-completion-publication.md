# ゴールのタスクの失敗の完了通知を `tasks.yaml` から daemon が再送する設計

- Issue: [j5ik2o/takt#170](https://github.com/j5ik2o/takt/issues/170)（[j5ik2o/takt#168](https://github.com/j5ik2o/takt/pull/168) の設計レビューから切り出した別件。`docs/design/goal-task-claim-setup-failure.md` の『別件』の 2）
- 基点ブランチ: `integration/takt-mcp`（`657f16ad6`）
- Quint 仕様: `specs/quint/goal-task-completion-publication/`

## 結論と上流の確認

`tasks.yaml` に失敗と `completion` を書くときに `completion_publication_pending: true` の印を同じ書き込みで残し、`saveManagerEvent` が成功したら印を外す。書き込み失敗やプロセス終了で印が残った場合は、daemon の定期監視（`WATCH_INTERVALS.files` = 5 秒）が受信箱へ再送して印を外す。二重配信は `inbox.ts` の決定的な `eventId` で排除し、再キュー後の新しい試行の印を古い掃除で消さないよう、印を外すときは試行識別子（`run_slug`・`execution_id`）まで照合する。

上流 `nrslib/takt` の `main`（`5d7581a85`）および開いている PR 7 件（[#2110](https://github.com/nrslib/takt/pull/2110)・[#2109](https://github.com/nrslib/takt/pull/2109)・[#2102](https://github.com/nrslib/takt/pull/2102)・[#2099](https://github.com/nrslib/takt/pull/2099)・[#2073](https://github.com/nrslib/takt/pull/2073)・[#2023](https://github.com/nrslib/takt/pull/2023)・[#788](https://github.com/nrslib/takt/pull/788)）を確認し、完了通知の再送に当たる修正がないことを確かめた（PR #2073 は `watchSource.ts` に `remote_assignment` の除外を足すだけ、PR #2099 は director の問い合わせ通知のみ）。なお、上流にはゴールの質問の回答に対する同型の仕組み（`answerPublicationPending`、[#2062](https://github.com/nrslib/takt/commit/3a49fb810)）があり、本設計はその流儀に合わせる。

## 何が起きているか

次の 3 経路はいずれも「`.takt/tasks.yaml` に `status: 'failed'` と `completion` を書いてから `saveManagerEvent(..., { kind: 'completion', ... })` で受信箱へ書く」構造を持つ。

1. **claim の setup 失敗**（`TaskLifecycleService.claimNextTasks` + `claimTasks.ts:publishSetupFailure`）: `pending` から `running` を通らず直接 `failed` になる。
2. **中断された running タスクの回復**（`TaskLifecycleService.failInterruptedRunningTasks` + `claimTasks.ts:failInterruptedTasksWithGoalEvents`）: `running` から `failed` になる。現状は `onRecovered` の `saveManagerEvent` 例外を捕まえておらず、1 件目で失敗すると 2 件目の通知と `takt run` / `takt watch` の起動まで止まる。
3. **daemon の消失 run 調停**（`src/features/daemonTurn/reconcileLostRun.ts`）: `running` から `failed` になる。`saveManagerEvent` が失敗しても `tasks.yaml` はすでに `failed` なので再試行時は `recovered = false` になり、二度と通知されない。また、`updateRunningTaskExecution` 前に死んだタスクは `run_slug` が `undefined` のままになり得る。

daemon の `runs()` は `status === 'running'` のタスクしか見ない（`src/features/daemon/watchSource.ts:90`）。したがって、`saveManagerEvent` が失敗するか、`tasks.yaml` の保存直後にプロセスが終了すると、manager が起きずゴールが止まったままになる。

なお、「`tasks.yaml` の `failed` と `completion` を見て受信箱に無いものを再送する」という素朴な案だけでは、受信箱のファイルは daemon が受け付けた直後に削除される（`inbox.ts:53`）ため、配信済みの過去タスクと未配信のタスクを区別できない。そのため、上流 #2062 の `answerPublicationPending` と同じく、明示的な `completion_publication_pending` の印を使う。

## 何をどう変えるか

### 1. `tasks.yaml` のスキーマと状態遷移の印（`src/infra/task/`）

- `src/infra/task/taskRecordSchemas.ts`: `TaskRecordSchema` に `completion_publication_pending: z.literal(true).optional()` を追加する。`superRefine` で、`completion_publication_pending === true` は次の条件をすべて満たすときに限る。
  - `goal_id !== undefined`
  - `completion !== undefined`
  - `status !== 'pending' && status !== 'running'`（終端状態のみ）
  - `run_slug !== undefined || execution_id !== undefined`（試行識別子が必ずあること）
- `src/infra/task/types.ts`・`src/infra/task/mapper.ts`: `TaskState` に `completionPublicationPending?: true` を追加し、`toTaskState` で写す。
- `src/infra/task/taskRecordMutations.ts`・`src/infra/task/taskExceedService.ts`:
  - `buildClaimedTaskRecord`・`buildRetryTaskRecord`・`requeueExceededTask` で `completion_publication_pending: undefined` を明示的に外す（再キューや再 claim で古い印が残らないことを型とスキーマの両方で保証する）。
- `src/infra/task/taskLifecycleService.ts`・`src/infra/task/runner.ts`:
  - `buildSetupFailedTaskRecord`: `completion_publication_pending: true` を同じ `store.update` 内で書く（`run_slug: setup-<uuid>` と `execution_id` は既存のまま付く）。
  - `failInterruptedRunningTasks`: `task.goal_id !== undefined` のレコードに `completion_publication_pending: true` を同じ `store.update` 内で書く（`run_slug: task.run_slug ?? setup-<uuid>` が必ず付く）。また、書き込み後の `onRecovered` 呼び出しを 1 件ずつ `try/catch` で囲み、`onWarning` へ渡して次のタスクへ進む（`claimNextTasks` の `onSetupFailed` と同じ境界保護）。
  - `clearCompletionPublicationPending(taskName, identity)` を `TaskLifecycleService` と `TaskRunner` に追加する。`this.store.update`（`tasks.yaml.lock` のみ取得）の中で、次の 7 条件がすべて一致するレコードだけから `completion_publication_pending` を削除する。一致がなければ `undefined` を返し、`tasks.yaml` を書き換えない。
    1. `task.name === taskName`
    2. `task.goal_id === identity.goalId`
    3. `task.status === identity.status`
    4. `task.run_slug === identity.runSlug`
    5. `task.execution_id === identity.executionId`
    6. `task.completion_publication_pending === true`
    7. `task.deletion === undefined`

### 2. 3 つの書き手による即時送信と印の解除

- `src/features/tasks/execute/claimTasks.ts`:
  - `publishSetupFailure(taskRunner, cwd, task)`: `publishGoalCompletion` が成功した後に、`task.completionPublicationPending === true` なら `taskRunner.clearCompletionPublicationPending(...)` を呼ぶ。印の解除は別の `try/catch` で囲み、失敗しても「manager was not notified」とは誤報せず、警告・ログだけ出して claim の戻り値を失わない（daemon が重複排除つきで印を外す）。
  - `failInterruptedTasksWithGoalEvents(taskRunner, cwd)`: 各回復タスクの `publishGoalCompletion` + `clearCompletionPublicationPending` を `publishSetupFailure` と同じく `try/catch` + `warn()` + `log.error()` で囲む。1 件目の `saveManagerEvent` や印の解除が失敗しても 2 件目の通知と `takt run` / `takt watch` の起動を止めない。
- `src/features/daemonTurn/reconcileLostRun.ts`:
  - `tasks.yaml` 更新時に `completion_publication_pending: true` を同じ `store.update` 内で書く。`task.run_slug === undefined && task.execution_id === undefined`（`execution_id` 導入前の旧 running タスク）の場合だけ `execution_id: randomUUID()` を補い、試行識別子を必ず確保する。
  - `saveManagerEvent` には `runSlug: reference.runSlug` に加えて、`reference.runSlug === undefined` のとき `executionId: resolvedExecutionId` を渡す。
  - `saveManagerEvent` と印の解除はそれぞれ `try/catch` + `log.error` で囲み、`tasks.yaml` への調停書き込みが済んでいれば `recovered = true` を返す（失敗した分は daemon が再送する）。

### 3. 受信箱の形式と決定的な `eventId` による重複排除

- `src/infra/goals/events.ts`（`ManagerEventSchema`）と `src/infra/daemon/persistedFiles.ts`（`inboxEvent`）:
  - `kind: 'completion'` のオブジェクトに `executionId: z.string().min(1).optional()` を追加する（`runSlug` がある既存経路の入力形は変えない）。
- `src/features/daemon/inboxEvent.ts`:
  - `managerInboxTurnEvent` の `case 'completion'` で `saved.executionId` があるとき `task.executionId` に写す（`TaskRef` と `eventRecord.ts` はすでに `executionId?: string` を持つ）。
- `src/features/daemon/inbox.ts`:
  - `receiveInboxChange` で `saved.kind === 'completion'` の `eventId` を次の規則で決定的に算出する（`goal-answer-` と同じ方針）。
    - `saved.runSlug !== undefined`:
      `goal-completion-${sha256(JSON.stringify([inboxDir, saved.goalId, saved.taskName, 'run', saved.runSlug]))}`
    - `saved.runSlug === undefined && saved.executionId !== undefined`:
      `goal-completion-${sha256(JSON.stringify([inboxDir, saved.goalId, saved.taskName, 'execution', saved.executionId]))}`
    - 両方とも `undefined`（変更前に書かれた旧受信箱ファイル）:
      従来どおり `inbox-${sha256(change.path)}`
  - 書き手と daemon が同じ試行を二重に受信箱へ書いても、`FileEventStore.accept` が同一 `eventId` を `duplicate` として吸収し、daemon 再起動後でも manager を二度起こさない。長さは `16 + 64 = 80` 文字で `EventInputSchema` の上限 128 文字に収まる。

### 4. daemon による未送信完了通知の再送（非同期・到達性規則準拠）

daemon 本体（`src/features/daemon/`・`src/infra/daemon/`）は `daemon-reachability.integration.test.ts` の規則により同期 FS（`TaskStore`・`GoalStore`・`events.ts`・`TaskRecordSchema`）を推移的にも import できない。そのため、上流 #2062（`publishPendingGoalAnswers`）と同じ非同期経路で実装する。

- `src/infra/task/taskStateReader.ts`:
  - `WatchTaskSchema` に `deletion: z.unknown().optional()`、`completion: GoalTaskResultSchema.optional()`、`completion_publication_pending: z.literal(true).optional()` を追加し、`TaskRecordSchema` と同じ `superRefine` 制約を付ける（`GoalTaskResultSchema` は同期 FS を持たず、`persistedFiles.ts` で既に import 済み）。
- `src/infra/daemon/persistedFiles.ts`:
  - `saveInboxEvent` を共通化し、`saveGoalTaskCompletion(repositoryDirectory, input)` を追加する（`saveManagerEvent` と同じファイル名・権限 `0o600`・原子配置）。
  - `markGoalTaskCompletionPublished(repositoryDirectory, identity)` を追加する:
    - `FileAsyncLock` で `.takt/tasks.yaml.lock` のみを取得する（ロック階層の末端。`goal-execution.lock` は取らない）。
    - `readEntirePrivateFile` で `.takt/tasks.yaml` を読む（256 KiB の `MAX_PROJECTION_BYTES` 制限に引っかからないようにする。シンボリックリンクは `O_NOFOLLOW` で拒否）。ファイルが無ければ `false` を返す。
    - `parseDocument(text)` + `document.toJS({ maxAliasCount: 0 })` で YAML エイリアス爆弾を防ぎつつ解析し、`tasksFile` 形式で検証する。
    - 1 節の 7 条件すべてに一致するレコードだけから `completion_publication_pending` を除き、他のタスク・他の列はそのままにして `stringifyYaml` + `writePrivateFile` で原子書き込みする。一致がなければ書き換えず `false` を返す。
- `src/features/daemon/pendingGoalTaskCompletions.ts`（新規、`pendingInquiryAnswers.ts` と対称）:
  - `publishPendingGoalTaskCompletions(configDirectory, completions, readGoal, onError)`:
    - 1 件ずつ `try/catch` で処理し、1 件の失敗で残りのタスクを止めない。
    - `readGoal(repositoryDirectory, goalId)`（`WatchGoalReader` 経由、4 MiB 超の `goal.json` も読める）でゴールを読む:
      - `executionStatus === 'aborted'` または `isMissing(error)`（`ENOENT`、削除済みゴール）のとき: 受信箱へは書かず、`markGoalTaskCompletionPublished` で印だけ外す。
      - その他の読み取りエラー（破損 JSON、スキーマ不正、権限エラー、タイムアウト）のとき: `onError` に報告し、印は残す（次回再試行）。
      - `active` または `paused` のとき: `saveGoalTaskCompletion` で受信箱へ書き、成功したら `markGoalTaskCompletionPublished` で印を外す（`paused` の完了イベントは `conversationService.ts:141` が `deferred` にして再開時に処理する。既存の `saveManagerEvent` と同じ振る舞い）。
- `src/features/daemon/watchSource.ts`・`src/features/daemon/watchers/index.ts`:
  - `FileDaemonWatchSource.hasWork(files)`: `readWatchTasks` の判定に `isPendingGoalTaskCompletion(task)`（`completion_publication_pending === true && deletion === undefined`）を加え、未送信の印が残る間は daemon がアイドル終了しないようにする。
  - `FileDaemonWatchSource.taskCompletions()` を追加し、`startDaemonWatchers` に `WATCH_INTERVALS.files`（5 秒）の独立ループとして登録する（`DaemonWatchSource` では `taskCompletions?(): Promise<void>` とし、`runs()` は `run(targetId)` の純粋な再確認に使うため副作用を入れない）。

### 変えないこと・範囲の外

- **通常実行の完了経路**（`parallelExecution.ts:504` の `completeTask` / `failTask` / `exceedTask` / `prFailTask`）: issue #170 の対象外。ただしスキーマの制約を「終端のゴールタスク全般」にしておくため、将来同じ仕組みへ広げるときにデータ形式の変更は不要。
- **ロック解放失敗時の claim 取り残し**（`docs/design/goal-task-claim-setup-failure.md` 別件 1）および **`task_finish_hook` の読み取り失敗**（別件 3）: 本件の範囲外。
- **ロック実装自体**（`file-lock.ts`・`private-file-lock.ts`・`daemon/lock.ts`）: 既存の両ロック実装は `.takt/tasks.yaml.lock` で相互排他し、死んだ持ち主の回収も互換があるため変更しない（`FileAsyncLock` が書く `{ pid, startTime, token }` を `withFileLock` が読むときは `processIdentity` 無しの PID 確認になる点のみ既存仕様どおり）。
- **daemon が一度も起動されない環境**（`takt run` 単体利用）: 即時 `saveManagerEvent` が失敗した場合、印は `tasks.yaml` に残り、後で daemon が起動した時点で再送される。`takt run` 単体で再送ループは増やさない。
- **本変更以前に保存された `tasks.yaml` の過去 `failed` レコード**: `completion_publication_pending` が無いため再送されない（アップグレード時の誤通知を防ぐ）。

## 守る不変条件

Quint 仕様（`specs/quint/goal-task-completion-publication/goalTaskCompletionPublication.qnt`）の `safety` は次の 5 つの連言で、`fixed` において違反なし。

1. **`noDuplicateManagerWake`**: 同一 `(task, attempt)` で manager が起きるのは多くとも 1 回。
2. **`noUnrecoverableLoss`**: ゴールが `Active` または `Paused` のとき、現在の状態が `Failed` かつ `completion` を持つタスクは、必ず「既に manager を起こした」「`Paused` として `deferred` に積まれている」「受信箱ファイルが存在する」「送信前の書き手が生存中」「`tasks.yaml` に `completion_publication_pending: true` が永続化されている」のいずれかを満たす。
3. **`pendingPubSchemaValid`**: `completion_publication_pending: true` は `Failed`（終端）・`completion` あり・試行識別子（`run_slug` または `execution_id`）ありのゴールタスクにしか付かない。
4. **`noPhantomWake`**: 書き手が `Failed` として保存していない `(task, attempt)` では manager は起きない。
5. **`noDeferredWhenAbortedOrDeleted`**: ゴールが `Aborted` または `Deleted` になったら `deferred` に残らない。

実装側ではさらに次を守る。

- `claimNextTasks` は `publishSetupFailure` や `clearCompletionPublicationPending` が何を投げても claim したタスクを返し、再試行分類に誤入させない（PR #168 の不変条件を維持）。
- `failInterruptedTasksWithGoalEvents` は 1 件の通知・印解除失敗で残りの回復タスクや起動処理を止めない。
- `markGoalTaskCompletionPublished` / `clearCompletionPublicationPending` は `task.deletion !== undefined` のレコードを変更しない。
- daemon の推移的到達グラフ（`daemon-reachability`）に同期 FS を一切持ち込まない。
- ロック階層 `epics.lock` → `goal.json.lock` → `goal-execution.lock` → `tasks.yaml.lock` を守る（印解除は末端の `tasks.yaml.lock` のみ）。

## PBT の性質（除外なし）

`package.json` に `fast-check`（`^4.11.0`）があるため、純粋関数の性質は `fast-check`、ファイル・ストアを伴う状態遷移は実コンポーネントの網羅表で検証する。**除外する入力集合は設けない。**

1. **受信箱 `eventId` の決定性と単射性（`fast-check`、ユニットテスト）**
   - 生成入力: 任意の `(inboxDir, goalId, taskName, runSlug | undefined, executionId | undefined, filePath1, filePath2)`。区切り文字（`"`・`,`・`[`・`]`・`/`・`\n`・`\0`）、Unicode、長文、`runSlug === executionId` を含む全文字列領域（空文字除く `min(1)`）。
   - 性質:
     - `runSlug !== undefined || executionId !== undefined` のとき、`filePath1 !== filePath2` でも `eventId` が一致し、形式 `/^goal-completion-[a-f0-9]{64}$/`（80 文字 ≤ 128 文字）を満たす。
     - `(inboxDir, goalId, taskName, runSlug !== undefined ? ['run', runSlug] : ['execution', executionId])` が異なれば `eventId` も異なる（`runSlug` と `executionId` が同値でもタグ `'run'` / `'execution'` により衝突しない）。
     - `runSlug === undefined && executionId === undefined` のときだけ `inbox-<sha256(filePath)>` に戻る。
2. **スキーマ不変条件（`fast-check`、ユニットテスト）**
   - 任意の `status` × `goal_id` 有無 × `completion` 有無 × `run_slug` 有無 × `execution_id` 有無 × `completion_publication_pending`（`undefined` / `true` / `false`）に対し、`TaskRecordSchema` と `WatchTaskSchema` が同一の受理条件（終端・`goal_id` あり・`completion` あり・`run_slug || execution_id` ありのときのみ `true` を受理）を満たす。
3. **実ファイル結合での状態遷移の組み合わせ（light IT、本物の `TaskRunner`・`DaemonPersistedFiles`・`FileDaemonWatchSource`・`receiveInboxChange`・`FileEventStore`）**
   - 軸: 失敗経路 4 通り（`setupFail`・`interruptedFail`・`reconcileLostRun` `runSlug` あり・`reconcileLostRun` `runSlug` なし）× 障害 4 通り（なし・`saveManagerEvent` 例外・書き込み後クラッシュ・印解除失敗）× 状態・競合 5 通り（通常回復・書き手と daemon の同時送信・再キュー後の 2 回目失敗と古い印解除・ゴール状態 `active`/`paused→resumed`/`aborted`/`deleted`・`deletion` 予約の取消／完了）。
   - 性質: すべての組み合わせで (a) `active`（および `paused→resumed`）では各試行につき manager 起動はちょうど 1 回、(b) `aborted` / `deleted` では起動 0 回かつ印が外れて `hasWork() === false`、(c) 2 回目試行の印が 1 回目の古い解除で消えない、(d) `deletion` 予約中のレコードは書き換わらない。

## Quint の仕様と検査結果

仕様は `specs/quint/goal-task-completion-publication/goalTaskCompletionPublication.qnt`、シナリオテストは `goalTaskCompletionPublication_test.qnt`、記録は `README.md` に置いた（Quint 0.32.0）。

同じ状態遷移モデルを `DESIGN` で 4 通りに切り替えて検査した。

- `before`: 修正前（印なし・daemon 再送なし・ファイル名ハッシュの `eventId`）。
- `fixedNoDedup`: 印と daemon 再送だけ入れ、`inbox.ts` の重複排除を省いた版。
- `fixedUncheckedClear`: 重複排除まで入れ、印の解除で試行識別子の照合を省いた版。
- `fixed`: 本設計の全体。

| 検査 | 結果 |
|---|---|
| `quint typecheck`（本体・テスト） | どちらも成功 |
| `quint test`（4 モジュール計 16 件） | `beforeTest` 4 件（setup 失敗・中断回復・`reconcileLostRun` それぞれで通知消失の反例）、`fixedNoDedupTest` 1 件（二重起動の反例）、`fixedUncheckedClearTest` 1 件（2 回目試行の印消失の反例）、`fixedTest` 10 件、すべて通過 |
| `quint run`（各不変条件 × 4 版、3,000 標本・16 ステップ、seed `0x2a`） | `before` は `noUnrecoverableLoss` で違反（25 ms）。`fixedNoDedup` は `noDuplicateManagerWake` で違反（341 ms）。`fixed` は 5 本とも違反なし |
| `quint run`（`fixedUncheckedClear`, `noUnrecoverableLoss`, 50,000 標本・25 ステップ、seed `0x2a`） | 11,485 標本目で違反を検出（2,534 ms）。試行識別子なしの印解除が 2 回目試行の通知を失わせることを乱択でも確認 |
| `quint run --main fixed --invariant safety`（10,000 標本・20 ステップ、seed `0x2a`、witness 10 本） | 違反 0 件（3,029 ms）。全 10 本の witness が到達（最少 `wSecondAttemptWoke` 20 本、`wReconcileWithoutRunSlugWoke` 30 本、`wDeferredDelivered` 61 本、`wDaemonRepublished` 75 本） |
| `quint run --main fixed --invariant safety`（20,000 標本・25 ステップ × 3 seed: `0x2a`・`0x1`・`0xbeef`） | 計 60,000 標本すべて違反 0 件 |

## 壊しうる入力・状況の一覧

| 区分 | 入力・状況 | 設計上の扱い |
|---|---|---|
| 境界 | 1 回の claim / 中断回復で複数のゴールタスクが同時に失敗し、1 件目の `saveManagerEvent` だけが失敗する | 1 件ずつ `try/catch` し、1 件目は印を残して警告、2 件目は即時送信して印を外す |
| 境界 | `reconcileLostRun` 対象の running タスクに `run_slug` が無い（さらに旧レコードで `execution_id` も無い） | `run_slug` と `execution_id` が両方無いときは `reconcileLostRun` が `execution_id` を採番して保存し、`inbox.ts` は `executionId` で決定的な `eventId` を作る |
| 境界 | 非ゴールタスク（`goal_id` なし）や `invalidatePendingGoalTasks`（`completion` なし） | 印を付けず、スキーマでも禁止する |
| 区切り・入れ子・Unicode | `taskName`・`runSlug`・`executionId` に `"`・`,`・`[`・`]`・`/`・改行・Unicode を含む、あるいは `runSlug === executionId` | `JSON.stringify([inboxDir, goalId, taskName, tag, attemptId])` で単射的に直列化し、`'run'` / `'execution'` タグで分離する |
| 長さ | `tasks.yaml` が 256 KiB を超える / `goal.json` が 4 MiB を超える | `markGoalTaskCompletionPublished` は `readEntirePrivateFile`（上限なし）、ゴール読み取りは `WatchGoalReader`（4 MiB 超対応）を使う |
| 長さ | `eventId` の上限（`EventInputSchema` 128 文字） | `goal-completion-`（16）+ SHA-256 hex（64）= 80 文字固定 |
| 並行 | 書き手と daemon が同時に同じ失敗を送信する、または書き手が送信後・印解除前に死ぬ | どちらも同じ `eventId` になり、`FileEventStore.accept` が `duplicate` として吸収する |
| 並行 | daemon が試行 1 を読んだ直後にタスクが再キューされ、試行 2 が失敗して即時送信も失敗する | 試行 1 の印解除は `(name, goal_id, status, run_slug, execution_id)` が一致せず無操作になり、試行 2 の印が残る |
| 並行 | タスクに `deletion` 予約がある間に daemon または書き手が印解除を試みる | `task.deletion === undefined` を条件にするため変更しない。削除完了ならレコードごと消え、取消なら次回 tick で処理する |
| 並行・再開 | ゴールが `paused` の間に失敗通知が再送される | 受信箱へ書き、印を外す。`conversationService` が `deferred` にして再開時に 1 回だけ実行する |
| 並行・再開 | ゴールが `aborted` または削除済み（`goal.json` が `ENOENT`） | 受信箱へ書かずに印だけ外し、`hasWork()` が `false` へ収束する |
| 障害・破損 | `goal.json` が破損 JSON / スキーマ不正 / EACCES / タイムアウト、または受信箱書き込みが ENOSPC | `onError` へ報告し、印は外さない。復旧後の次回 tick で再送される |
| 障害・破損 | `.takt/tasks.yaml` がシンボリックリンク・YAML エイリアス爆弾・構文エラー | `O_NOFOLLOW`・`maxAliasCount: 0`・スキーマ検証で拒否して `onError` へ報告し、ファイルを書き換えない |
| 再開 | daemon 再起動をまたいだ重複配信 | `FileEventStore` が `daemon-events/<sha256(eventId)>.json` を永続化しているため、再起動後も `duplicate` で止まる |
| 互換 | 旧形式の `tasks.yaml`（`completion_publication_pending` なし）および旧受信箱ファイル（`runSlug`・`executionId` なし） | 過去タスクは再送せず、旧受信箱ファイルは従来の `inbox-<sha256(change.path)>` へフォールバックする |

## 影響

- **上流（`nrslib/takt`）**: 何も流さない。`claimTasks.ts`・`taskLifecycleService.ts`・`reconcileLostRun.ts`・`watchSource.ts`・`persistedFiles.ts`・`inbox.ts` にフォーク側変更が加わるため、今後の取り込み時に競合し得るが、上流 #2062（`answerPublicationPending`）と同じ構造に揃えており見通しを保てる。
- **保存済みのデータ**:
  - `.takt/tasks.yaml`: オプション列 `completion_publication_pending: true` の追加のみ。送信完了後は削除されるため、定常状態では既存形式と同一。既存の `tasks.yaml` はそのまま読める。
  - `manager-inbox/*.json`: `kind: 'completion'` にオプション列 `executionId` を追加（`runSlug` が無い `reconcileLostRun` でのみ付与）。既存の受信箱ファイルはそのまま読める。
  - `daemon-events/*.json`: `EventRecordSchema` は既に `task.executionId` と最大 128 文字の `eventId` を受理するため変更不要。
- **公開 API**:
  - `TaskRunner` / `TaskLifecycleService` に `clearCompletionPublicationPending` を追加、`TaskState` に `completionPublicationPending?: true` を追加、`DaemonWatchSource` に任意メソッド `taskCompletions?(): Promise<void>` を追加。既存の呼び出し元・MCP・CLI への破壊的変更はない。
- **守りの仕組み**:
  - `daemon-reachability.integration.test.ts`（同期 FS の推移的到達禁止）を厳守するため、daemon 側は `FileAsyncLock` + `readEntirePrivateFile` + `writePrivateFile` + `WatchGoalReader` のみを使う。
  - ロック階層（`epics.lock` → `goal.json.lock` → `goal-execution.lock` → `tasks.yaml.lock`）を維持する。
  - `TaskStore.assertDeletionsUnchanged` の契約を `markGoalTaskCompletionPublished` でも `task.deletion === undefined` 条件で守る。
  - PR #168 の不変条件（`claimNextTasks` が claim 済みタスクを必ず返す、`listTaskStateItems` は 1 回だけ、書き込み後の例外を再試行分類しない）を維持する。
  - 警告ログに出すエラー文面は `sanitizeSensitiveText`、端末出力のタスク名は `sanitizeTerminalText` を通す。

## 実装時に先行して red を確かめる主な回帰テスト

1. setup 失敗で `saveManagerEvent` が投げた後、`FileDaemonWatchSource.taskCompletions()` が受信箱へ再送し、印を外し、`receiveInboxChange` で manager が 1 回起きること（修正前は `tasks.yaml` に印が無く、daemon が再送しないため失敗）。
2. `failInterruptedTasksWithGoalEvents` で 1 件目の `saveManagerEvent` が投げても 2 件目が送信され、1 件目は daemon が再送して印を外すこと（修正前は例外で止まり失敗）。
3. `reconcileLostRun`（`runSlug` あり／なし両方）で `saveManagerEvent` 失敗または書き込み直後クラッシュの後、daemon が再送して印を外すこと（修正前は失敗）。
4. 書き手が受信箱へ書いた後に印解除に失敗／クラッシュし、daemon が再送しても `receiveInboxChange` が同じ `eventId` に丸め、`FileEventStore` が daemon 再起動後を含めて 1 回だけ受け付けること（修正前は別 `eventId` で 2 回起動して失敗）。
5. 再キュー後の 2 回目失敗に対する古い印解除が 2 回目の印を消さないこと、`aborted` / 削除済みゴールで受信箱へ書かずに印だけ外れて `hasWork() === false` になること、`deletion` 予約中は書き換えないこと、`tasks.yaml` > 256 KiB・`goal.json` > 4 MiB でも動作すること。
6. `daemon-reachability.integration.test.ts` を通して同期 FS 到達が無いこと。

## 相対見積もり

- **設計と Quint（本作業）**: 3（基準: [j5ik2o/takt#166](https://github.com/j5ik2o/takt/pull/166) の後追い設計 + Quint 仕様を 2 とし、本件は 3 経路 + daemon 非同期書込 + 受信箱重複排除 + `deletion`/再キュー競合を跨ぐため 3）。
- **今後の実装・PBT・統合テスト（設計レビュー後）**: 5（変更ファイルは `task/` 5・`claimTasks.ts`・`reconcileLostRun.ts`・`events.ts`・`daemon/` 6 の約 14 ファイルと、`fast-check` PBT + 実ファイル light IT + `daemon-reachability` 検証）。

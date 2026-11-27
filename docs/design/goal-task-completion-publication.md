# ゴールのタスクの失敗の完了通知を `tasks.yaml` から daemon が再送する設計

- Issue: [j5ik2o/takt#170](https://github.com/j5ik2o/takt/issues/170)（[j5ik2o/takt#168](https://github.com/j5ik2o/takt/pull/168) の設計レビューから切り出した別件。`docs/design/goal-task-claim-setup-failure.md` の『別件』の 2）
- 基点ブランチ: `integration/takt-mcp`（`657f16ad6`）
- Quint 仕様: `specs/quint/goal-task-completion-publication/`

## 結論と上流の確認

`tasks.yaml` に失敗と `completion` を書くときに `completion_publication_pending: true` の印を同じ書き込みで残し、`saveManagerEvent` が成功したら印を外す。書き込み失敗やプロセス終了で印が残った場合は、daemon の定期監視（`WATCH_INTERVALS.files` = 5 秒）が受信箱へ再送して印を外す。二重配信は `inbox.ts` の決定的な `eventId` で排除し、再キュー後の新しい試行の印を古い掃除で消さないよう、印を外すときは試行識別子（`run_slug`・`execution_id`）まで照合する。

1 件の不正な記録で `tasks.yaml` 全体や daemon の run 監視が止まらないよう、`TaskRecordSchema` では不正な印を拒否せず読み取り時に正規化（削除＋警告）し、daemon 側では `WatchTaskSchema` を寛容なまま保ったうえで未送信完了だけを 1 件ずつ `safeParse` する。また、daemon の `hasWork` が有効な印を仕事として数え、死んだ持ち主の `deletion` 予約は非同期プロセス検査で回収することで、印が置き去りのままアイドル終了・停滞しないことを保証する。

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

- `src/infra/task/taskRecordSchemas.ts`・`src/infra/task/taskConfigSerialization.ts`:
  - `TaskRecordSchema` に `completion_publication_pending: z.literal(true).optional()` を追加する。
  - **厳格拒否ではなく読み取り時正規化（#1273 の `TaskFailureSchema` と同じ方針）**: `superRefine` でファイル全体を拒否すると、手動編集や想定外の状態遷移で 1 件だけ不正な印が残っただけで `TaskStore.readUnsafe()` が `Invalid tasks.yaml` を投げ、claim・run・MCP のタスク操作全体が止まる。そのため、印が有効とみなす 4 条件を共通述語 `isValidCompletionPublicationPending(record)` に切り出し、条件を満たさない印は拒否せず読み取り時に落として警告ログ（`log.warn`、タスク名はサニタイズ）を出す。
    - 有効条件（4 条件すべて満たすこと）:
      1. `goal_id !== undefined`
      2. `completion !== undefined`
      3. `status !== 'pending' && status !== 'running'`（終端状態のみ）
      4. `run_slug !== undefined || execution_id !== undefined`（試行識別子が必ずあること）
    - `normalizeTaskConfig` で `completion_publication_pending !== undefined && completion_publication_pending !== true`（例: `false` や型違い）を警告のうえ削除し、`TaskRecordSchema` 末尾の `.transform(...)` で `completion_publication_pending === true && !isValidCompletionPublicationPending(value)` の場合に警告のうえ `completion_publication_pending: undefined` へ正規化する。
    - 出力型は `completion_publication_pending?: true` を維持し、不変条件 `pendingPubSchemaValid` は書き手の実装と PBT で担保する。
    - 正規化するのは印だけである。`completion` は今の `GoalTaskResultSchema.optional()`（`.strict()`、`taskRecordSchemas.ts:52`）のまま変えないので、`completion` に未知の列があるレコードを含む `tasks.yaml` は、従来どおり `TaskStore.readUnsafe` がファイル全体を拒む（低 1。本件で変える振る舞いではない）。
- `src/infra/task/types.ts`・`src/infra/task/mapper.ts`: `TaskState` に `completionPublicationPending?: true` を追加し、`toTaskState` で写す。
- `src/infra/task/taskRecordMutations.ts`・`src/infra/task/taskExceedService.ts`:
  - `buildClaimedTaskRecord`・`buildRetryTaskRecord`・`requeueExceededTask` で `completion_publication_pending: undefined` を明示的に外す（再キューや再 claim で古い印が残らないことを書き手側で保証する）。
- `src/infra/task/taskLifecycleService.ts`・`src/infra/task/runner.ts`:
  - `buildSetupFailedTaskRecord`: `completion_publication_pending: true` を同じ `store.update` 内で書く（`run_slug: setup-<uuid>` と `execution_id` は既存のまま付く）。
  - `failInterruptedRunningTasks`: `task.goal_id !== undefined` のレコードに `completion_publication_pending: true` を同じ `store.update` 内で書く（`run_slug: task.run_slug ?? setup-<uuid>` が必ず付く）。また、書き込み後の `onRecovered` 呼び出しを 1 件ずつ `try/catch` で囲み、`onWarning` へ渡して次のタスクへ進む（`claimNextTasks` の `onSetupFailed` と同じ境界保護）。
  - `clearCompletionPublicationPending(taskName, identity)` を `TaskLifecycleService` と `TaskRunner` に追加する。`this.store.update`（`tasks.yaml.lock` のみ取得。既存の `clearStaleDeletions` が死んだ持ち主の `deletion` を先に外す）の中で、次の 7 条件がすべて一致するレコードだけから `completion_publication_pending` を削除する。一致がなければ `undefined` を返し、`tasks.yaml` を書き換えない。
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
    - 両方とも `undefined`（`runSlug`・`executionId` のどちらも無い旧受信箱ファイル）:
      従来どおり `inbox-${sha256(change.path)}`
  - 書き手と daemon が同じ試行を二重に受信箱へ書いても、`FileEventStore.accept` が同一 `eventId` を `duplicate` として吸収し、daemon 再起動後でも manager を二度起こさない。長さは `16 + 64 = 80` 文字で `EventInputSchema` の上限 128 文字に収まる。
  - **通常実行の完了経路への波及**: この規則は `kind: 'completion'` の全イベントに適用されるため、`parallelExecution.ts:504` の通常完了もファイル名ハッシュから `runSlug` ベースの決定的 `eventId` に切り替わる。通常実行の `runSlug` は試行ごとに一意（秒精度時刻＋6 文字乱数、`run-slug.ts`）であるため、正当な 2 回の完了がまとめられることはなく、むしろファイル再処理時の重複排除が効く。
  - **アップグレード時の旧受信箱ファイル**: 現行の書き手（setup・中断・通常）は既に `runSlug` を付けているため、更新前に書かれた受信箱ファイルの大半も更新後は新しい決定的 `eventId` に切り替わる。したがって、更新前に「旧ハッシュで受領済み・ファイル削除前」で daemon が停止していた狭い窓のファイルに限り、更新直後に 1 回だけ再起動し得る（`runSlug`・`executionId` が両方無い旧ファイルのみ従来ハッシュへフォールバック）。

### 4. daemon による未送信完了通知の再送（非同期・到達性規則準拠）

daemon 本体（`src/features/daemon/`・`src/infra/daemon/`）は `daemon-reachability.integration.test.ts` の規則により同期 FS（`TaskStore`・`GoalStore`・`events.ts`・`TaskRecordSchema`）を推移的にも import できない。そのため、上流 #2062（`publishPendingGoalAnswers`）と同じ非同期経路で実装する。

- `src/infra/task/taskStateReader.ts`:
  - **`WatchTaskSchema` は現行の寛容な形を保つ**: `readWatchTasks` は `runs()`・`hasWork()`・`patrolGoalIds()`・`launches()`・`hasTaskDirectory()` の共通読み取りであり、`GoalTaskResultSchema`（`.strict()`）や `superRefine` を `WatchTaskSchema` へ足すと、版ずれで `completion` に 1 列増えた場合や 1 件の印が不正なだけで、そのリポジトリの消失 run 検出（`run_process_lost` → `reconcileLostRun`）まで止まる。そのため `WatchTaskSchema` 自体は厳格化しない。
  - 代わりに、未送信完了だけを 1 件ずつ検証する専用読み取り `readPendingGoalTaskCompletions(repositoryDirectory, reports)` を追加する（`listPendingInquiryAnswerPublications` の「読めない 1 件は報告して飛ばす」と同じ流儀、`persistedFiles.ts:42-65`。`reports` は 4 節の報告の記録で、同じ記録の報告を 1 回にまとめる）:
    - `readEntirePrivateFile`（256 KiB の `MAX_PROJECTION_BYTES` 制限なし、`O_NOFOLLOW` でシンボリックリンク拒否）＋ `parseDocument(text)` ＋ `document.toJS({ maxAliasCount: 0 })` で `.takt/tasks.yaml` を読む（`ENOENT` なら `[]`）。
    - `tasks` 配列を 1 件ずつ走査し、`completion_publication_pending !== true` のレコードは即座に飛ばす（通常レコードの `completion` は解析しない）。
    - `completion_publication_pending === true` のレコードだけを `PendingGoalTaskCompletionSchema.safeParse(record)` で検証する（終端 `status`・`goal_id`・`completion: GoalTaskResultSchema`・`run_slug || execution_id`・任意の `deletion: WatchTaskDeletionSchema`）。失敗した 1 件だけを報告して飛ばし、他の有効なレコードの処理と `runs()` を止めない。
    - `completion` に未知の列がある印は `GoalTaskResultSchema`（`.strict()`）で失敗するので、報告されるだけで届かずに残る。`GoalTaskResultSchema` は `goal.json` でも使うため緩めない（低 1）。
- `src/infra/daemon/persistedFiles.ts`:
  - `saveInboxEvent` を共通化し、`saveGoalTaskCompletion(repositoryDirectory, input)` を追加する（`saveManagerEvent` と同じファイル名・権限 `0o600`・原子配置）。
  - `markGoalTaskCompletionPublished(repositoryDirectory, identity, processes?)` を追加する:
    - `FileAsyncLock` で `.takt/tasks.yaml.lock` のみを取得する（ロック階層の末端。`goal-execution.lock` は取らない）。
    - `readEntirePrivateFile` で `.takt/tasks.yaml` を読む（ファイルが無ければ `false` を返す）。
    - `parseDocument(text)` で YAML `Document` を構築し、`document.toJS({ maxAliasCount: 0 })` で YAML エイリアス爆弾を防ぎつつ `tasks` 配列から 1 節の 7 条件に一致する要素のインデックスを探す。
    - **死んだ持ち主の `deletion` 予約の扱い（低 5）**: 対象レコードに `deletion` がある場合、非同期プロセス検査 `processes.inspect({ pid: deletion.owner_pid, startTime: deletion.owner_start_time ?? null }, ...)`（`AsyncProcess.inspect`、`daemon-reachability` 準拠）を行う。`kind === 'dead'` のときだけ `TaskStore.clearStaleDeletions` と同じく死んだ予約として回収可能とみなし、`kind === 'alive' | 'unknown'`（または `deletion` の形が不正）のときは安全側に倒れて書き換えず `false` を返す。
    - **最小差分の YAML 書き戻し（低 4）**: `stringifyYaml` でファイル全体を再直列化せず、YAML `Document` 上で `document.deleteIn(['tasks', index, 'completion_publication_pending'])`（死んだ `deletion` を回収したときは `document.deleteIn(['tasks', index, 'deletion'])` も）を実行し、`document.toString()` を `writePrivateFile` で原子書き込みする。対象以外のレコード・列・コメント・書式をそのまま保つ。一致がなければ書き換えず `false` を返す。
- `src/features/daemon/pendingGoalTaskCompletions.ts`（新規、`pendingInquiryAnswers.ts` と対称）:
  - `publishPendingGoalTaskCompletions(configDirectory, completions, readGoal, processes, onError)`:
    - 1 件ずつ `try/catch` で処理し、1 件の失敗で残りのタスクを止めない。
    - 対象に `deletion` がある場合は `processes.inspect(...)` で持ち主を確認し、`kind !== 'dead'`（生存中または不明）ならこの tick では送信も書き換えもせずスキップする。`kind === 'dead'` なら死んだ予約として処理を続行する。`unknown` は後述の報告の記録で 1 回だけ `onError` へ報告する（毎 tick 繰り返さない）。
    - `readGoal(repositoryDirectory, goalId)`（`WatchGoalReader` 経由、4 MiB 超の `goal.json` も読める）でゴールを読む:
      - `isGoalFinished(goal)`（`executionStatus === 'aborted'` または `status === 'completed'`、`activity.ts`）または `isMissing(error)`（`ENOENT`、削除済みゴール）のとき: 受信箱へは書かず、`markGoalTaskCompletionPublished` で印（および死んだ `deletion`）だけ外す。終わったゴールの manager を起こしても次の仕事は無く、`hasWork` のゴール判定（`isGoalFinished`）とも揃う。Quint では `completed` を `Aborted` と同じ枝として扱う（README の `Not modelled`）。
      - その他の読み取りエラー（破損 JSON、スキーマ不正、権限エラー、タイムアウト）のとき: `onError` に報告し、印は残す（次回再試行）。
      - `active` または `paused` のとき: `saveGoalTaskCompletion` で受信箱へ書き、成功したら `markGoalTaskCompletionPublished` で印を外す（`paused` の完了イベントは `conversationService.ts:141` が `deferred` にして再開時に処理する。既存の `saveManagerEvent` と同じ振る舞い）。
- `src/features/daemon/watchSource.ts`・`src/features/daemon/watchers/index.ts`:
  - `FileDaemonWatchSource.hasWork(files)`: 既存の `readWatchTasks`（`pending` / `running`）に加え、`readPendingGoalTaskCompletions(project.repositoryDirectory, reports)` が 1 件以上の仕事として数える未送信完了を返せば `true` を返す。
    - **読む順（低 3）**: プロジェクトごとに「ゴール → 未送信完了の印 → 受信箱 → タスク」の順に読む。印の確認を受信箱の確認より前に置く。`runDaemon.ts` の `idle()` は `watchers.drain()` の後に別ループの `taskCompletions()` が走り出すことを止めないため、`hasWork` と再送は交互に起こり得る。再送は「受信箱へ書く → 印を外す」の順なので、印の読み取りで印が見えなければ、受信箱への書き込みはその前に済んでおり、後から読む受信箱の確認で見つかる。`taskCompletions()` が動いている間 `idle()` を偽にする案は、状態を 1 つ増やすので採らない。この順により、Quint の `daemonIdleExit` を「`daemon.phase == DaemonIdle` のときの 1 回の検査」として扱える（README の `daemonIdleExit`）。
    - **`deletion` 予約つきの印（低 4）**: `processes.inspect` の結果が `alive`（完了か取消まで待つ）か `dead`（次の `taskCompletions()` で回収する）のときだけ仕事として数える。`unknown`（`owner_start_time` が無く、PID が存在する）は数えず、1 回だけ報告する。PID が再利用されていると `unknown` は解けず、数えると daemon が永久に終わらないためである。印は `tasks.yaml` に残り、次に daemon が起きたときに再び確かめる。
    - **不正な印とファイル全体の読み取り失敗（低 5）**: 不正な印のレコードは `readPendingGoalTaskCompletions` 内で報告して除外し、仕事に数えない。`tasks.yaml` 全体が読めないとき（構文エラー、シンボリックリンク、権限エラー）も報告して仕事なし（`false` 側）とする。今の `readWatchTasks` の失敗の扱いと同じで、壊れたファイルで daemon が永久に終われなくなることを避ける。印はファイルに残り、ファイルが直った後の次の daemon で再送される。
    - **報告の重複の抑え（低 5）**: `hasWork`（500 ms ごと）と `taskCompletions()`（5 秒ごと）が同じ記録を毎回報告しないよう、`FileDaemonWatchSource` が 1 つの報告の記録（`InvalidInquiryFileReports` と同じ形。`tasks.yaml` の `ino`・`size`・`mtimeMs` と対象の鍵を覚え、内容が変わるまで 1 回だけ `onError` を呼ぶ）を持ち、両方から共有する。鍵はファイル全体の失敗なら `tasks.yaml` のパス、1 件の不正な印や `unknown` の `deletion` ならパスとタスク名の組とする。読めるようになったら記録を消し、次に壊れたときにまた報告する。
  - `FileDaemonWatchSource.taskCompletions()` を追加し、`startDaemonWatchers` に `WATCH_INTERVALS.files`（5 秒）の独立ループとして登録する（`DaemonWatchSource` では `taskCompletions?(): Promise<void>` とし、`runs()` は `run(targetId)` の純粋な再確認に使うため副作用を入れない）。

### 変えないこと・範囲の外

- **通常実行の完了経路への印付与・再送**（`parallelExecution.ts:504` の `completeTask` / `failTask` / `exceedTask` / `prFailTask`）: issue #170 の対象外。ただし `completion_publication_pending` の有効条件を「終端のゴールタスク全般」にしておくため、将来同じ仕組みへ広げるときにデータ形式の変更は不要。なお、3 節の `receiveInboxChange` の `eventId` 決定規則は `kind: 'completion'` 全体に掛かるため、通常完了の `eventId` も一意な `runSlug` ベースの決定的 ID へ変わる（3 節参照）。
- **ロック解放失敗時の claim 取り残し**（`docs/design/goal-task-claim-setup-failure.md` 別件 1）および **`task_finish_hook` の読み取り失敗**（別件 3）: 本件の範囲外。
- **ロック実装自体**（`file-lock.ts`・`private-file-lock.ts`・`daemon/lock.ts`）: 既存の両ロック実装は `.takt/tasks.yaml.lock` で相互排他し、死んだ持ち主の回収も互換があるため変更しない（`FileAsyncLock` が書く `{ pid, startTime, token }` を `withFileLock` が読むときは `processIdentity` 無しの PID 確認になる点のみ既存仕様どおり）。
- **daemon が一度も起動されない環境**（`takt run` 単体利用）: 即時 `saveManagerEvent` が失敗した場合、印は `tasks.yaml` に残り、後で daemon が起動した時点で再送される。`takt run` 単体で再送ループは増やさない。
- **本変更以前に保存された `tasks.yaml` の過去 `failed` レコード**: `completion_publication_pending` が無いため再送されない（アップグレード時の誤通知を防ぐ）。

## 設計レビュー指摘の扱い

独立設計レビュー（`~/.orca/bots/takt/memory/reports/2026-11-27-170-design-review.md`、高 0・中 2・低 6）の指摘に対する扱いと反映先を整理する。

| 指摘 | 重要度 | 扱い | 反映内容（節・ファイル） |
|---|---|---|---|
| `safety` が通知到達を確かめておらず、daemon 再送を外しても通る。アイドル終了（`hasWork`）も未モデル化 | 中 1 | **直す** | Quint に `daemonRunning`・`daemonHasWork`・`daemonIdleExit` と不変条件 `noDaemonExitWithWork`・`quiescentDelivery`、単一除去の負対照 `fixedNoRepublisher`・`fixedNoHasWork`、および witness `wDaemonSoleRepublishWoke`・`wDaemonIdleExitedAfterSettle` を追加し、再送除去や `hasWork` 欠落で反例が出ることを検証（`goalTaskCompletionPublication.qnt`・`_test.qnt`・`README.md`・本設計「守る不変条件」「Quint の仕様と検査結果」）。 |
| `superRefine` の厳格拒否で 1 件の不正記録から `tasks.yaml` 全体と `WatchTaskSchema` 経由の `runs()`／消失 run 検出が止まる | 中 2 | **直す** | 1 節の `TaskRecordSchema` を読み取り時正規化（不正な印は警告＋削除、ファイル全体を止めない）へ変更。4 節の `WatchTaskSchema` は現行のまま保ち、未送信完了だけ専用関数 `readPendingGoalTaskCompletions` で 1 件ずつ `safeParse`＋`onError` 報告してスキップする形に変更。PBT 2 も書き換えた。 |
| 通常の完了経路の `eventId` も変わることを設計に明記していない | 低 1 | **直す** | 3 節と「変えないこと」節を整合させ、通常完了の `eventId` が `runSlug` ベースへ変わる点・一意性の根拠（`run-slug.ts`）・別 `runSlug` の 2 回が衝突しないテスト（PBT 1・回帰テスト）を明記。 |
| 古い受信箱ファイル・版ずれ・ロールバック時の互換記述が実際と少しずれている | 低 2 | **直す** | 3 節・「壊しうる入力・状況の一覧」・「影響」節に、既存書き手が既に `runSlug` を付けているための狭い窓での 1 回重複起動、および旧 daemon（`.strict()` による `executionId` 拒否）・旧 `TaskStore.update`（未知列落とし）の版ずれ／ロールバック挙動を正確に追記。 |
| モデルの抽象化が支えになっている前提（`RunKey`/`ExecKey` の試行番号直結、単一書き手／daemon、`completed`・`Active` 直接削除・`MAX_FILES`）を隠している | 低 3 | **直す** | `specs/quint/goal-task-completion-publication/README.md` の `Not modelled` と本設計の「Quint の仕様と検査結果」にすべての前提・抽象化と PBT 1 による担保範囲を明記。 |
| daemon の `tasks.yaml` 書き戻しで `stringifyYaml` するとコメント・書式が落ちる | 低 4 | **直す** | 4 節の `markGoalTaskCompletionPublished` を YAML `Document.deleteIn`＋`document.toString()` による最小差分書き戻しに変更し、PBT 3 と回帰テストに「対象以外の記録・列・書式が変わらないこと」を追加。 |
| 死んだ持ち主の `deletion` 予約が印を塞ぎ、ゴール終了後に daemon がアイドル終了して残り得る | 低 5 | **直す** | 4 節で `hasWork` が `deletion` 付きの有効な印も仕事として数え、`taskCompletions()` と `markGoalTaskCompletionPublished` が `AsyncProcess.inspect` で `dead` の予約を回収（`deletion` も削除）する設計に変更。Quint にも `DeletionState`（`DelNone`/`DelAlive`/`DelDead`）・`deletionOwnerCrash`・負対照 `fixedStaleDeletionBlocks`・witness `wStaleDeletionRecovered` を追加して検証。 |
| PBT 3 の「書き込み後クラッシュ」を実プロセス終了で作ると heavy IT 扱いになる | 低 6 | **直す** | 「PBT の性質」3 番で、クラッシュを「印の永続化直後に即時送信をスキップ／例外注入」で作り light IT に収めること、新規 IT は `scripts/test-classification.mjs` と `tsconfig.tests.json` に登録して `releaseVerificationWiring.test.ts` を単独実行することを明記。 |

### 再レビュー指摘の扱い

再レビュー（`~/.orca/bots/takt/memory/reports/2026-11-27-170-design-rereview.md`、高 0・中 1・低 5）の指摘に対する扱いと反映先を整理する。

| 指摘 | 重要度 | 扱い | 反映内容（節・ファイル） |
|---|---|---|---|
| `quiescentDelivery` が出し直しの動作そのものを見ていない。`taskRecoveryEnabled` が動作の条件の式を書き写しており、`daemonReadPending` が guard を残したまま進まない（P1）、`daemonClearOk` が印を外さない（P3）のどちらも `safety` を通る | 中 1 | **直す** | Quint に出し切りの段（`drain`・`dsteps`・`initD`・`stepD`・`progress`）と不変条件 `drainedDelivery`、witness 3 本（`wDrainedWoke`・`wDrainedDaemonOnlyWoke`・`wDrainedSettledExit`）を足した。P1・P2・P3 を、旗でなく動作を外す負対照として `actionAblations.sh` と README に載せ、`safety` は P1・P3 を通すが `drainedDelivery` は 3 つとも反例を出すことを確かめた。`quiescentDelivery` が「届かないことを捕まえる」とした言い過ぎを、本設計「守る不変条件」「Quint の仕様と検査結果」、README、`.qnt` の注釈で直した。 |
| 回帰テスト 5 と PBT 2 の「未知の列つき `completion` でも `TaskRecordSchema` が全体を読み込める」は、`GoalTaskResultSchema` が `.strict()` なので今のコードでは成り立たない | 低 1 | **直す** | `GoalTaskResultSchema` は緩めない。1 節と 4 節に「未知の列つき `completion` の印は報告されるだけで届かずに残る。`TaskStore` は従来どおりファイル全体を拒む」と書き、PBT 2 と回帰テスト 5 の対象を `readWatchTasks` と `readPendingGoalTaskCompletions` に絞った。 |
| ゴールが `completed` のときの扱いが README（受信箱を飛ばす）と設計（受信箱へ書く）で食い違う | 低 2 | **直す** | `isGoalFinished(goal)` が真（`aborted` または `completed`）か `ENOENT` なら、受信箱へ書かずに印だけ外すと決めた（4 節）。README の `Not modelled` と `daemonPublishOk` の説明もこれに揃えた。回帰テスト 6 に `completed` を足した。 |
| `idle()` は `taskCompletions` の途中かを見ず、`hasWork` が「ゴール → 受信箱 → タスク」の順だと、印の確認を後ろに足したとき受信箱にファイルを残したまま終わり得る | 低 3 | **直す** | `hasWork` の読む順を「ゴール → 印 → 受信箱 → タスク」と決め、再送が「受信箱へ書く → 印を外す」の順であることと合わせて、モデルの `daemonIdleExit` の guard との対応を 4 節と README に書いた。`idle()` に条件を足す案は採らない。 |
| 生死が `unknown` の `deletion` 予約つきの印を `hasWork` に数えると、PID の再利用で daemon が永久に終わらない | 低 4 | **直す** | `hasWork` は `alive` と `dead` だけを数え、`unknown` は数えずに 1 回だけ報告する（4 節）。モデルに `unknown` は足さず、README の `Not modelled` に前提として書いた。 |
| 不正な印の報告が tick ごとに繰り返される。`tasks.yaml` 全体が読めないときの `hasWork` の値が決まっていない | 低 5 | **直す** | `InvalidInquiryFileReports` と同じ形の報告の記録を `hasWork` と `taskCompletions()` で共有し、内容が変わるまで 1 回だけ報告する（4 節）。ファイル全体が読めないときは報告して仕事なし（`false`）とする。「壊しうる入力・状況の一覧」も直した。 |

## 守る不変条件

Quint 仕様（`specs/quint/goal-task-completion-publication/goalTaskCompletionPublication.qnt`）の `safety` は次の 7 つの連言で、`fixed` において違反なし。

1. **`noDuplicateManagerWake`**: 同一 `(task, attempt)` で manager が起きるのは多くとも 1 回。
2. **`noUnrecoverableLoss`**: ゴールが `Active` または `Paused` のとき、現在の状態が `Failed` かつ `completion` を持つタスクは、必ず「既に manager を起こした」「`Paused` として `deferred` に積まれている」「受信箱ファイルが存在する」「送信前の書き手が生存中」「`tasks.yaml` に `completion_publication_pending: true` が永続化されている」のいずれかを満たす。
3. **`pendingPubSchemaValid`**: `completion_publication_pending: true` は `Failed`（終端）・`completion` あり・試行識別子（`run_slug` または `execution_id`）ありのゴールタスクにしか付かない。
4. **`noPhantomWake`**: 書き手が `Failed` として保存していない `(task, attempt)` では manager は起きない。
5. **`noDeferredWhenAbortedOrDeleted`**: ゴールが `Aborted` または `Deleted` になったら `deferred` に残らない。
6. **`noDaemonExitWithWork`**: daemon がアイドル終了した状態（`not(daemonRunning)`）では、ゴールは `Aborted` または `Deleted` であり、`inbox`・`deferred` は空で、`Pending`・`Running` および `pendingPub == true` のタスクは 1 件も残らない。
7. **`quiescentDelivery`**（状態の性質）: タスク `t` について回復・配信・生存中の削除のどの動作の条件も成り立たない状態（`not(taskRecoveryEnabled)` — `not(pendingPub)` は仮定しない）では、(a) ゴールが `Active` かつ `Failed`・`completion` ありなら必ず `wakes >= 1`、(b) ゴールが `Paused` かつ `Failed`・`completion` ありなら必ず `wakes >= 1` または `deferred` に積まれている、(c) ゴールが `Aborted` / `Deleted` なら `pendingPub == false` である。
   - 限界: `taskRecoveryEnabled` は動作の条件の式（`republisherAccepts` など）を書き写したものなので、言えるのは「条件が偽なら、もう届いている」ことだけである。条件を残したまま動作が働かなくなっても（P1: `daemonReadPending` が起きない、P3: `daemonClearOk` が印を外さない）この性質は通る。`fixedNoRepublisher` で反例が出るのは、旗 `usesRepublisher` が `republisherAccepts` にも入っているためである。
   - `hasWork` から印を外した版（`fixedNoHasWork`）と死んだ `deletion` 予約を塞いだままにする版（`fixedStaleDeletionBlocks`）では、条件が偽になったまま印が残るので、この性質で反例が出る。

`safety` とは別の入口（`--init initD --step stepD`）で、次も確かめる。

8. **`drainedDelivery`**（限られた手数での到達）: 通常の `step` の途中で出し切りの段に入ると、失敗の動作（送信・印の解除の失敗、クラッシュ）と外からの変化（新しいタスク、旧 `Running` の生成、再キュー、一時停止、中止、削除、新しい削除予約）が止まり、前に進む動作（書き手の送信と解除、daemon の読み取り・送信・解除・アイドル終了、受信箱の受け付け、`deferred` の配信、削除予約の取消・完了・持ち主の死亡、ゴールの再開）だけが動く。足踏みは、前に進む動作が 1 つも有効でないときだけ許す（`drainProgressPossible`）。`drainProgressPossible` は各動作の条件を写し、`deliverAnyDeferred` については `daemonRunning`・`goal == Active`・`deferred` 非空を写す。出し切りの段に入って 40 手の後に、`Active` のゴールの `Failed`・`completion` ありのタスクは必ず `wakes >= 1` かつ `pendingPub` が残っておらず、`Aborted` / `Deleted` のゴールには `pendingPub` が残っていない。`Paused` では `drainSettled` の 2 つの含意の前件が偽で空虚に真になるので、この性質は `Paused` について何も要求しない。`goal != Paused` の除外は置かない。`drainProgressPossible` は `resumeGoal` だけでなく、受信箱の消費、書き手、daemon、削除の前進も数える。`Paused` では足踏みは許されないが、各手が `resumeGoal` とは限らないので、出し切りの段が 40 手に達したときに `Paused` のままでもモデル上あり得る。`drainSettled` が空虚に真なので、その到達で検査結果は変わらない。動作の条件ではなく動作の結果を見るので、P1・P3 のように条件を残して動作だけ止めた形でも反例が出る。シミュレーションでの有限の検査であり、活性の証明ではない。

実装側ではさらに次を守る。

- `claimNextTasks` は `publishSetupFailure` や `clearCompletionPublicationPending` が何を投げても claim したタスクを返し、再試行分類に誤入させない（PR #168 の不変条件を維持）。
- `failInterruptedTasksWithGoalEvents` は 1 件の通知・印解除失敗で残りの回復タスクや起動処理を止めない。
- `TaskRecordSchema` の読み取り時正規化および `readPendingGoalTaskCompletions` の 1 件ごとの `safeParse` により、1 件の不正な印や `completion` 拡張で `tasks.yaml` 全体や `runs()`／消失 run 検出が止まらない。
- `markGoalTaskCompletionPublished` / `clearCompletionPublicationPending` は生存中または生死不明の `deletion` 予約（`alive` / `unknown`）があるレコードを変更せず、死亡確認済み（`dead`）の予約だけを回収する。また、書き戻しは YAML `Document.deleteIn` により対象以外のレコード・列・コメント・書式をそのまま保つ。
- daemon の推移的到達グラフ（`daemon-reachability`）に同期 FS を一切持ち込まない。
- ロック階層 `epics.lock` → `goal.json.lock` → `goal-execution.lock` → `tasks.yaml.lock` を守る（印解除は末端の `tasks.yaml.lock` のみ）。

## PBT の性質（除外なし）

`package.json` に `fast-check`（`^4.11.0`）があるため、純粋関数の性質は `fast-check`、ファイル・ストアを伴う状態遷移は実コンポーネントの網羅表で検証する。**除外する入力集合は設けない。**

1. **受信箱 `eventId` の決定性と単射性（`fast-check`、ユニットテスト）**
   - 生成入力: 任意の `(inboxDir, goalId, taskName, runSlug | undefined, executionId | undefined, filePath1, filePath2)`。区切り文字（`"`・`,`・`[`・`]`・`/`・`\n`・`\0`）、Unicode、長文、`runSlug === executionId` を含む全文字列領域（空文字除く `min(1)`）。
   - 性質:
     - `runSlug !== undefined || executionId !== undefined` のとき、`filePath1 !== filePath2` でも `eventId` が一致し、形式 `/^goal-completion-[a-f0-9]{64}$/`（80 文字 ≤ 128 文字）を満たす。
     - `(inboxDir, goalId, taskName, runSlug !== undefined ? ['run', runSlug] : ['execution', executionId])` が異なれば `eventId` も異なる（`runSlug` と `executionId` が同値でもタグ `'run'` / `'execution'` により衝突しない。通常完了の異なる `runSlug` 2 回も衝突しない）。
     - `runSlug === undefined && executionId === undefined` のときだけ `inbox-<sha256(filePath)>` に戻る。
2. **スキーマ正規化と 1 件単位の障害分離（`fast-check`、ユニットテスト）**
   - 生成入力: 任意の `status` × `goal_id` 有無 × `completion` 有無（および未知列付き `completion`）× `run_slug` 有無 × `execution_id` 有無 × `completion_publication_pending`（`undefined` / `true` / `false` / 文字列等の不正値）。
   - 性質:
     - `TaskRecordSchema.parse` は、`completion` が `GoalTaskResultSchema` を満たすレコードについて、`completion_publication_pending` の値や組み合わせを理由に例外を投げない。4 条件（終端・`goal_id` あり・`completion` あり・`run_slug || execution_id` あり）を満たす `true` のみ `true` を保持し、それ以外は `undefined` に正規化して警告を出す。未知列付き `completion` のレコードは従来どおり拒まれる（本件で変えない振る舞いで、性質の対象に入れない）。
     - `readWatchTasks` は任意のレコードの不正な `completion_publication_pending` や `completion` の未知列に影響されず全タスクを返す。
     - `readPendingGoalTaskCompletions` は不正な印の 1 件（未知列付き `completion` を含む）だけを報告してスキップし、同一ファイル内の他の有効な未送信完了をすべて返す。同じ内容の `tasks.yaml` を何度読んでも、同じ記録の報告は 1 回だけである。
3. **実ファイル結合での状態遷移の組み合わせ（light IT、本物の `TaskRunner`・`DaemonPersistedFiles`・`FileDaemonWatchSource`・`receiveInboxChange`・`FileEventStore`）**
   - テスト層の扱い: 「書き込み後クラッシュ」は実プロセス終了（heavy IT 相当）ではなく「印の永続化直後に即時送信をスキップ／例外注入する」ことで再現し、子プロセス起動を伴わない軽量な実ファイル結合テスト（light IT）に収める。新規 IT ファイルは `scripts/test-classification.mjs` と `tsconfig.tests.json` に登録し、追加後に `npm test -- src/__tests__/releaseVerificationWiring.test.ts` を単独で実行する。
   - 軸: 失敗経路 4 通り（`setupFail`・`interruptedFail`・`reconcileLostRun` `runSlug` あり・`reconcileLostRun` `runSlug` なし）× 障害 4 通り（なし・`saveManagerEvent` 例外・書き込み直後の送信スキップ／例外注入・印解除失敗）× 状態・競合 5 通り（通常回復・書き手と daemon の同時送信・再キュー後の 2 回目失敗と古い印解除・ゴール状態 `active`/`paused→resumed`/`aborted`/`deleted`・`deletion` 予約の生存中／取消／完了／持ち主死亡）。
   - 性質: すべての組み合わせで (a) `active`（および `paused→resumed`）では各試行につき manager 起動はちょうど 1 回、(b) `aborted` / `deleted` では起動 0 回かつ印が外れて `hasWork() === false`、(c) 2 回目試行の印が 1 回目の古い解除で消えない、(d) 生存中 `deletion` 予約中のレコードは書き換わらず、持ち主死亡の `deletion` 予約は回収されて印も外れる、(e) 書き戻し前後で対象以外のタスク記録・列・コメント・書式が変わらない。

## Quint の仕様と検査結果

仕様は `specs/quint/goal-task-completion-publication/goalTaskCompletionPublication.qnt`、シナリオテストは `goalTaskCompletionPublication_test.qnt`、詳細記録とモデル化の境界は `README.md` に置いた（Quint 0.32.0）。

同じ状態遷移モデルを `DESIGN` で 7 通り（修正前 + 単一除去の負対照 5 種 + 完全版）に切り替えて検査した。

- `before`: 修正前（印なし・daemon 再送なし・`hasWork` に印なし・重複排除なし）。
- `fixedNoRepublisher`: 印・`hasWork`・重複排除・試行照合・死んだ予約回収を入れ、daemon 再送だけ旗で外した版（`noUnrecoverableLoss` は通る。`quiescentDelivery` の違反は旗が `republisherAccepts` にも入っているため。`drainedDelivery` でも違反）。
- `fixedNoHasWork`: `hasWork` から `pendingPub` だけ外した版（ゴール終了後に未処理の印を残したままアイドル終了し、`noDaemonExitWithWork` と `quiescentDelivery` で違反）。
- `fixedStaleDeletionBlocks`: 死んだ持ち主の `deletion` 予約を回収せず一律スキップする版（低 5。`quiescentDelivery` で違反）。
- `fixedNoDedup`: `inbox.ts` の決定的な重複排除だけ省いた版（`noDuplicateManagerWake` で違反）。
- `fixedUncheckedClear`: 印解除の試行識別子照合だけ省いた版（`noUnrecoverableLoss` と `quiescentDelivery` で違反。`drainedDelivery` はサンプルでは `ok` だが、stale clear の後の状態は `drainSettled` の `Active` 節を偽にするので違反し得る）。
- `fixed`: 本設計の全体。

これとは別に、旗でなく動作を外す負対照 P1〜P3 を `actionAblations.sh` で作る（モデルの写しの 1 行を書き換え、`fixed` で流す）。

- P1: `daemonReadPending` の guard を残したまま `daemon' = daemon` にして進めない（`republisherAccepts` はそのまま）。
- P2: `daemonPublishOk` が受信箱へ書かずに常に飛ばす枝を通り、その後に印が外れる。
- P3: `daemonClearOk` が印を外さない（`tasks' = tasks`）。

| 検査 | 結果 |
|---|---|
| `quint typecheck`（本体・テスト） | どちらも成功 |
| `quint test`（7 モジュール計 22 件） | `beforeTest` 4 件、`fixedNoRepublisherTest` 2 件、`fixedNoHasWorkTest` 1 件、`fixedStaleDeletionBlocksTest` 1 件、`fixedNoDedupTest` 1 件、`fixedUncheckedClearTest` 1 件、`fixedTest` 12 件、すべて通過 |
| `quint run`（7 不変条件 × 7 版、3,000 標本・16 ステップ、seed `0x2a`） | `before` は `noUnrecoverableLoss`・`quiescentDelivery` で違反。`fixedNoRepublisher` は `noUnrecoverableLoss` を通過しつつ `quiescentDelivery` で違反（旗が `republisherAccepts` に入っているため）。`fixedNoHasWork` は `noDaemonExitWithWork`・`quiescentDelivery` で違反。`fixedStaleDeletionBlocks` は `quiescentDelivery` で違反。`fixedNoDedup` は `noDuplicateManagerWake` で違反。`fixedUncheckedClear` はこの標本では 7 本すべて通過。`fixed` は 7 本すべて違反なし |
| `quint run`（`fixedUncheckedClear`, 50,000 標本・25 ステップ、seed `0x2a`） | `noUnrecoverableLoss`・`quiescentDelivery` の両方で違反を検出 |
| `quint run --main fixed --invariant safety`（10,000 標本・20 ステップ、seed `0x2a`、witness 13 本） | 違反 0 件。全 13 本の witness が到達（`wDaemonSoleRepublishWoke` 14 本、`wSecondAttemptWoke` 20 本、`wReconcileWithoutRunSlugWoke` 76 本、`wDeferredDelivered` 59 本、`wDaemonRepublished` 138 本、`wStaleDeletionRecovered` 346 本、`wDaemonIdleExitedAfterSettle` 627 本など） |
| `quint run --main fixed --invariant safety`（20,000 標本・25 ステップ × 3 seed: `0x2a`・`0x1`・`0xbeef`） | 計 60,000 標本すべて違反 0 件 |
| `quint run --init initD --step stepD --invariant drainedDelivery`（7 版、5,000 標本・70 ステップ、seed `0x2a`） | `before`・`fixedNoRepublisher`・`fixedNoHasWork`・`fixedStaleDeletionBlocks` で違反。`fixedNoDedup`・`fixedUncheckedClear`・`fixed` はこの標本では違反なし。`fixedUncheckedClear` の `ok` はサンプルであって到達不能の証明ではない（下記） |
| `quint run --main fixed --init initD --step stepD --invariant drainedDelivery`（10,000 標本・70 ステップ × 3 seed、witness 3 本） | 計 30,000 標本すべて違反 0 件。seed `0x2a` で `wDrainedWoke` 1,202 本、`wDrainedDaemonOnlyWoke` 191 本、`wDrainedSettledExit` 15 本が到達 |
| `actionAblations.sh`（P1〜P3 を `fixed` で、`safety`・`quiescentDelivery` は 10,000 標本・20 ステップ、`drainedDelivery` は 5,000 標本・70 ステップ） | P1・P3 は `safety` と `quiescentDelivery` を通り、`drainedDelivery` で違反。P2 は 3 つすべてで違反 |

`fixedUncheckedClear` の `drainedDelivery` が 5,000 標本・seed `0x2a` で `ok` なのは、そのサンプルが stale clear の後に 40 手の排出へ至らなかったという意味にすぎない。stale clear の後、試行 2 は `Active` の下で `Failed`・`completion` あり・`wakes == 0`・`pendingPub == false` になり、`drainSettled` の `Active` 節が偽になる。排出に入れば足踏みの上限で違反し得る。この版の `noUnrecoverableLoss` の違反期待は変えない。

`wDaemonRepublished` は同じ試行 `p` で `daemonRepublished.contains(p)` と `wakes.get(p) == 1` を要求する。別の試行の wake では満たせない点は意図どおりである。ただし同じ試行でも、書き手の受信箱ファイルの消費や `deferred` の配信で wake し得るので、138 本は daemon の再送が wake の原因だったことを示さない。原因を示すのは、その試行で書き手が送信していないことを条件に加えた `wDaemonSoleRepublishWoke`（14 本）である。`wReconcileWithoutRunSlugWoke` は `Failed`・`run_slug` なし・`wakes == 1` だけを要求し、`startTask(t, false)` で満たせる。`adoptLegacyRunningTask` を要求せず、シナリオテストも adopt を使っていないので、発行された `execution_id` が再送を可能にしたことは示さない。

`adoptLegacyRunningTask` は `Pending` から `Running` を作るだけで、既存の `Running` を読まない。`startTask(t, false)` とほぼ同じで、違うのは `hasExecId = false` だけである。`goal == Active` 限定なので、ゴールを見ない `reconcileLostRun` の `Paused` 側の旧 `Running` は表せない。モデルが観測するのは `writeReconcileFailure` で `hasExecId` が真になる形までで、発行された識別子の値やそれによる再送の効果はモデルに無い。

なお、モデルの前提とモデル外とした要素（`RunKey`/`ExecKey` が試行番号をそのまま鍵にしているため実物の一意性・書き手と daemon の一致は PBT 1 で担保すること、単一書き手・単一 daemon、ゴールの `completed`（`Aborted` と同じ枝）、`Active` から直接の削除、`deletion` の生死 `unknown`、不正な印とファイル全体の読み取り失敗、`Paused`/`Aborted` の下での旧 `Running` の `reconcileLostRun`、`MAX_FILES = 32` 上限など）は `specs/quint/goal-task-completion-publication/README.md` の `Not modelled` に明記している。

## 壊しうる入力・状況の一覧

| 区分 | 入力・状況 | 設計上の扱い |
|---|---|---|
| 境界 | 1 回の claim / 中断回復で複数のゴールタスクが同時に失敗し、1 件目の `saveManagerEvent` だけが失敗する | 1 件ずつ `try/catch` し、1 件目は印を残して警告、2 件目は即時送信して印を外す |
| 境界 | `reconcileLostRun` 対象の running タスクに `run_slug` が無い（`execution_id` 導入前の旧記録で `execution_id` も無い） | `run_slug` と `execution_id` が両方無いのは `execution_id` 導入前の旧記録であり、claim のあと `run_slug` の前に死んだ記録（claim が書いた `execution_id` が残る）ではない。`reconcileLostRun` は `execution_id` を採番して保存し、`inbox.ts` は `executionId` で決定的な `eventId` を作る。Quint モデルではこの旧記録の形を `adoptLegacyRunningTask` が `Pending` から `hasExecId = false` の `Running` として作る |
| 境界 | 非ゴールタスク（`goal_id` なし）や `invalidatePendingGoalTasks`（`completion` なし）、または手動編集で不正な印が付いた 1 件 | 書き手は印を付けない。万一ファイルに混入しても `TaskRecordSchema` は警告のうえ正規化して落とし、`readWatchTasks` は影響を受けず、`readPendingGoalTaskCompletions` はその 1 件だけ `onError` 報告して飛ばす |
| 区切り・入れ子・Unicode | `taskName`・`runSlug`・`executionId` に `"`・`,`・`[`・`]`・`/`・改行・Unicode を含む、あるいは `runSlug === executionId` | `JSON.stringify([inboxDir, goalId, taskName, tag, attemptId])` で単射的に直列化し、`'run'` / `'execution'` タグで分離する |
| 長さ | `tasks.yaml` が 256 KiB を超える / `goal.json` が 4 MiB を超える | `readPendingGoalTaskCompletions`・`markGoalTaskCompletionPublished` は `readEntirePrivateFile`（上限なし）、ゴール読み取りは `WatchGoalReader`（4 MiB 超対応）を使う |
| 長さ | `eventId` の上限（`EventInputSchema` 128 文字） | `goal-completion-`（16）+ SHA-256 hex（64）= 80 文字固定 |
| 並行 | 書き手と daemon が同時に同じ失敗を送信する、または書き手が送信後・印解除前に死ぬ | どちらも同じ `eventId` になり、`FileEventStore.accept` が `duplicate` として吸収する |
| 並行 | daemon が試行 1 を読んだ直後にタスクが再キューされ、試行 2 が失敗して即時送信も失敗する | 試行 1 の印解除は `(name, goal_id, status, run_slug, execution_id)` が一致せず無操作になり、試行 2 の印が残る |
| 並行 | タスクに `deletion` 予約がある間に daemon または書き手が印解除を試みる（生存中／持ち主死亡） | 生存中は変更せず待機（`hasWork() === true` を維持）。持ち主死亡（`dead`）は `TaskStore.clearStaleDeletions` と同じく死んだ予約として回収し、印と `deletion` を外す |
| 並行 | `deletion` 予約の持ち主の生死が `unknown`（`owner_start_time` が無く PID が存在、PID 再利用を含む） | 変更しない。`hasWork()` は仕事に数えず、1 回だけ報告する。印は残り、次の daemon で再び確かめる |
| 並行 | `hasWork()` の読み取りと `taskCompletions()` の再送が交互に起こる | `hasWork()` は印を受信箱より先に読み、再送は受信箱へ書いてから印を外すので、どちらかで必ず見つかる |
| 並行・再開 | ゴールが `paused` の間に失敗通知が再送される | 受信箱へ書き、印を外す。`conversationService` が `deferred` にして再開時に 1 回だけ実行する |
| 並行・再開 | ゴールが `aborted`・`completed` または削除済み（`goal.json` が `ENOENT`） | `hasWork()` が印の残存を検知して daemon を維持し、受信箱へ書かずに印だけ外した後 `hasWork()` が `false` へ収束してアイドル終了できる |
| 障害・破損 | `goal.json` が破損 JSON / スキーマ不正 / EACCES / タイムアウト、または受信箱書き込みが ENOSPC | `onError` へ報告し、印は外さない。復旧後の次回 tick で再送される |
| 障害・破損 | `.takt/tasks.yaml` がシンボリックリンク・YAML エイリアス爆弾・構文エラー | `O_NOFOLLOW`・`maxAliasCount: 0` で拒否し、内容が変わるまで 1 回だけ報告し、ファイルを書き換えない。`hasWork()` はこの理由では仕事に数えない（`readWatchTasks` の失敗と同じ） |
| 障害・破損 | 不正な印や未知列付き `completion` の印が残り続ける | 1 件ずつ報告して飛ばす。`hasWork()`（500 ms ごと）と `taskCompletions()`（5 秒ごと）で共有する報告の記録により、内容が変わるまで 1 回だけ報告する |
| 再開 | daemon 再起動をまたいだ重複配信 | `FileEventStore` が `daemon-events/<sha256(eventId)>.json` を永続化しているため、再起動後も `duplicate` で止まる |
| 互換・版ずれ | 旧形式の `tasks.yaml`、アップグレード前の受信箱ファイル、旧 daemon / 旧 CLI の混在やロールバック | 過去タスクは印が無いため再送しない。既存の `runSlug` 付き受信箱ファイルは新 `eventId` に切り替わる（受領後・削除前クラッシュの狭い窓のみ 1 回重複起動し得る）。旧 daemon は `executionId` を `.strict()` で拒むが再起動で解消、旧 `TaskStore.update` は未知列の印を落とすが次試行で収束する |

## 影響

- **上流（`nrslib/takt`）**: 何も流さない。`claimTasks.ts`・`taskLifecycleService.ts`・`reconcileLostRun.ts`・`watchSource.ts`・`persistedFiles.ts`・`inbox.ts` にフォーク側変更が加わるため、今後の取り込み時に競合し得るが、上流 #2062（`answerPublicationPending`）と同じ構造に揃えており見通しを保てる。
- **保存済みのデータ**:
  - `.takt/tasks.yaml`: オプション列 `completion_publication_pending: true` の追加のみ。送信完了後は YAML `Document.deleteIn` で当該キーのみ削除されるため、定常状態では既存形式・書式・コメントと同一。既存の `tasks.yaml` はそのまま読める。なお、古い版のコード（`TaskStore.update` の `z.object`）が印付きの `tasks.yaml` を書き換えた場合やロールバック時は、未知列の `completion_publication_pending` が黙って落ちるがファイル自体は壊れない。
  - `manager-inbox/*.json`: `kind: 'completion'` にオプション列 `executionId` を追加（`runSlug` が無い `reconcileLostRun` でのみ付与）。既存の受信箱ファイルはそのまま読める。なお、更新前から動き続けている古い daemon は `inboxEvent`（`.strict()`）で `executionId` 付きファイルを拒み再起動まで失敗を繰り返すが、daemon 再起動で解消する。また、更新前の `runSlug` 付き受信箱ファイルが「受領済み・削除前」で残っていた狭い窓に限り、更新直後に 1 回だけ重複起動し得る。
  - `daemon-events/*.json`: `EventRecordSchema` は既に `task.executionId` と最大 128 文字の `eventId` を受理するため変更不要。
- **公開 API**:
  - `TaskRunner` / `TaskLifecycleService` に `clearCompletionPublicationPending` を追加、`TaskState` に `completionPublicationPending?: true` を追加、`DaemonWatchSource` に任意メソッド `taskCompletions?(): Promise<void>` を追加。既存の呼び出し元・MCP・CLI への破壊的変更はない。
- **守りの仕組み**:
  - `daemon-reachability.integration.test.ts`（同期 FS の推移的到達禁止）を厳守するため、daemon 側は `FileAsyncLock` + `readEntirePrivateFile` + `writePrivateFile` + `WatchGoalReader` + `AsyncProcess` のみを使う。
  - ロック階層（`epics.lock` → `goal.json.lock` → `goal-execution.lock` → `tasks.yaml.lock`）を維持する。
  - `TaskStore.assertDeletionsUnchanged` の契約を `markGoalTaskCompletionPublished` でも生存中／不明 `deletion` の不変と `dead` 予約のみの回収で守る。
  - PR #168 の不変条件（`claimNextTasks` が claim 済みタスクを必ず返す、`listTaskStateItems` は 1 回だけ、書き込み後の例外を再試行分類しない）を維持する。
  - 警告ログに出すエラー文面は `sanitizeSensitiveText`、端末出力のタスク名は `sanitizeTerminalText` を通す。

## 実装時に先行して red を確かめる主な回帰テスト

1. setup 失敗で `saveManagerEvent` が投げた後、`FileDaemonWatchSource.taskCompletions()` が受信箱へ再送し、印を外し、`receiveInboxChange` で manager が 1 回起きること（修正前は `tasks.yaml` に印が無く、daemon が再送しないため失敗）。
2. `failInterruptedTasksWithGoalEvents` で 1 件目の `saveManagerEvent` が投げても 2 件目が送信され、1 件目は daemon が再送して印を外すこと（修正前は例外で止まり失敗）。
3. `reconcileLostRun`（`runSlug` あり／なし両方）で `saveManagerEvent` 失敗または書き込み直後の送信スキップの後、daemon が再送して印を外すこと（修正前は失敗）。
4. 書き手が受信箱へ書いた後に印解除に失敗／スキップし、daemon が再送しても `receiveInboxChange` が同じ `eventId` に丸め、`FileEventStore` が daemon 再起動後を含めて 1 回だけ受け付けること。あわせて通常完了で別々の `runSlug` を持つ 2 回の完了が別々の `eventId` になりまとめられないこと（修正前は前者が 2 回起動して失敗）。
5. 不正な `completion_publication_pending` を含む 1 件や未知列付き `completion` の印が `tasks.yaml` に混ざっていても、`readWatchTasks` / `runs()` が止まらず、`readPendingGoalTaskCompletions` が他の有効な未送信完了を処理できること。未知列付き `completion` の印は報告されるだけで届かずに残り、報告は tick をまたいで 1 回だけであること。あわせて、`completion` が正しく印だけが不正なレコードは `TaskRecordSchema` が警告＋正規化で読み込めること（未知列付き `completion` のファイルを `TaskStore` が拒むのは従来どおりで、このテストの対象外）。
6. 再キュー後の 2 回目失敗に対する古い印解除が 2 回目の印を消さないこと、`aborted` / `completed` / 削除済みゴールで `hasWork() === true` を保ったまま受信箱へ書かずに印だけ外れて `hasWork() === false` に収束すること、`hasWork` が印を受信箱より先に読むこと、生死 `unknown` の `deletion` 予約つきの印と `tasks.yaml` 全体の読み取り失敗では `hasWork()` が仕事に数えず報告が 1 回だけであること、生存中 `deletion` 予約中は書き換えず死亡済み `deletion` 予約は回収して印と `deletion` を外すこと、YAML 書き戻し前後で対象以外の記録・列・コメント・書式が変わらないこと、`tasks.yaml` > 256 KiB・`goal.json` > 4 MiB でも動作すること。
7. `daemon-reachability.integration.test.ts` を通して同期 FS 到達が無いこと、および新規 IT を `scripts/test-classification.mjs`・`tsconfig.tests.json` へ登録して `npm test -- src/__tests__/releaseVerificationWiring.test.ts` が通ること。

## 相対見積もり

- **設計と Quint（本作業）**: 3（基準: [j5ik2o/takt#166](https://github.com/j5ik2o/takt/pull/166) の後追い設計 + Quint 仕様を 2 とし、本件は 3 経路 + daemon 非同期書込 + 受信箱重複排除 + `deletion`/再キュー競合 + 設計レビュー反映を跨ぐため 3）。
- **今後の実装・PBT・統合テスト（設計レビュー後）**: 5（変更ファイルは `task/` 6・`claimTasks.ts`・`reconcileLostRun.ts`・`events.ts`・`daemon/` 6 の約 15 ファイルと、`fast-check` PBT + 実ファイル light IT + `daemon-reachability` + `releaseVerificationWiring` 検証）。

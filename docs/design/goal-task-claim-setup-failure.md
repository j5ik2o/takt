# 上流の取り込み（#168）で戻った、claim の setup の失敗の知らせ方を直す（項目201）

PR: https://github.com/j5ik2o/takt/pull/168 ／ 枝 `sync/upstream-main-20261125`（先端 `d2bd16a30`）に追加コミットで直す。

レビュー: `~/.orca/bots/sub-marshal/audit/takt-168-merge-review/REPORT.md`（結論「だめ」。2026-11-26 に範囲を広げた版で、公開 API（MCP・`TaskRunner`）と `takt run` の終わり方が加わった）。

Quint: `specs/quint/goal-task-claim/`。

## 何が起きているか

取り込みのマージ `d2bd16a30` は、`claimTasks.ts` の競合を上流 #2084 の形で解いた。claim の後に `listTaskStateItems()` で tasks.yaml を読み直し（`afterClaim`）、1回目に読んだ pending と突き合わせて setup の失敗を探す形である。フォーク側 PR #50（`bddbe7b66`）の `GoalTaskSetupGuard` と `onSetupFailed` は落ちた。さらに、フォーク側の時間切れの再試行（#91）に合わせて、`claimNextTasks` と `afterClaim` を同じ `try` に入れた。

このため次のことが起きる（Quint の反例と、レビューの実物での再現の両方で確かめた）。

| 重さ | 何が起きるか | Quint の反例 |
|---|---|---|
| Critical | `claimNextTasks` が running を書いた後、`afterClaim` がロックの時間切れか ENOSPC で失敗すると、`catch` が再試行できる失敗として投げ直し、claim したタスクがキューに入らない。持ち主は生きている自分のプロセスなので、そのプロセスが生きている間（`takt watch`、または run が続いている間）は、どの経路でも拾われない。プロセスが終わった後は、次の run の `failInterruptedRunningTasks` か daemon の `reconcileLostRun` が failed（interrupted）にするが、実行はされないまま失敗として残る。同じ回の setup の失敗の知らせも消える。 | `mergedTest.rereadTimeoutOrphansClaimedTaskTest`、`orphanIsNotReclaimedTest` |
| Critical（続き） | 5秒後の再試行で claim できるタスクが無いと、`claimRetryAt` が外れる。実行中のタスクも、キューの中身も無いので、`takt run` はループを抜けて正常に終わる（`success 0 / fail 0`、`runAllTasks` では「No pending tasks in .takt/tasks.yaml」）。tasks.yaml には、実行されないままの running が残る。 | `mergedTest.rereadTimeoutEndsRunAsCleanTest` |
| High（2a） | 2つのプロセスが同じ pending を読み、B の claim が setup の失敗を書くと、A の読み直しもそれを自分の失敗として知らせる。完了の知らせ・終了フック・`failCount` が2回出る。 | `mergedTest.duplicateReportTest` |
| High（2b） | 1回目の読みの後に足されたゴールのタスクを自分の claim が setup の失敗にしても、1回目の pending に無いので知らせない。 | `mergedTest.lateTaskReportMissedTest` |
| High | 公開のポート `GoalTaskSetupGuard`、型の契約テスト、`onSetupFailed` と「`listTaskStateItems` は1回だけ」を確かめる試験が、消えたか上流の形に書き換えられた。 | — |
| Medium | MCP の公開 API が親1 と食い違う。旧 `*_goal_registration*` の4つのツールが旧名を残さずに改名され、`takt_list_runtime_assignments` は `state` キーを拒否するようになった（「公開 API の非互換と扱い」の節）。 | — |
| Medium | `goal-execution.lock` の時間切れ（10 秒）は再試行の対象にならず、`preparationFailure` でその run の claim が止まる。フォーク側からある挙動。 | `mergedTest.goalLockTimeoutStopsTest` |
| Low | `daemon-storage.integration.test.ts` から、上流 #2060 の回帰テスト「restores legacy summary approvals and dismissals saved without a conversation id」が消えた。 | — |

PR #50 の形に戻すだけでは、穴が1つ残る（`forkP1Test.publishFailureOrphansClaimedTaskTest`）。`onSetupFailed` の中の `saveManagerEvent` が ENOSPC などで投げると、その例外が書き込みの後に `claimNextTasks` から出て、claim したタスクが同じように取り残される。投げた例外は分類されないので、`preparationFailure` で claim も止まる。今回いっしょに塞ぐ。

上流 nrslib/takt の main（`claimTasks.ts` の最新は #2084 `dd3e03151`）にも、開いている PR にも、同じ直しは無い（2026-11-26 に確かめた）。上流は今も読み直しの形で、時間切れの再試行が無い。上流へは何も流さない。

## 何をどう変えるか

### 1. PR #50 の形に戻す（フォーク側を取る）

上流が同じ不具合を同じかそれ以上に直しているとは確かめられない。読み直しの形そのものが 2a・2b のレースを生むので、取り込みの決まり1に従ってフォーク側を残す。

- `src/infra/task/goalTaskSetupGuard.ts` を戻す（`GoalTaskSetupGuard { setupFailureReason(task: TaskInfo): string | undefined }`）。`src/infra/task/index.ts` の `export type { GoalTaskSetupGuard }` も戻す。
- `TaskRunner.claimNextTasks` と `TaskLifecycleService.claimNextTasks` を `(count, goalSetupGuard?: GoalTaskSetupGuard, onSetupFailed?: (task: TaskState) => void)` に戻す。`claimNextTasks` は、1回の `withGoalExecutionLock` + `store.update` の中で自分が setup の失敗として書いたレコードだけを集め、書き込みが済んでから `onSetupFailed` に渡す。
- `src/features/tasks/execute/runtimeAssignmentGuard.ts` に `createRuntimeAssignmentSetupGuard(cwd)` を戻す。中身は上流 #2084 の `runtimeAssignmentUnavailableReason(cwd, task.data)` を呼ぶ（判定の本体はフォークと上流で同じ）。doc コメントは PR #60 の文面（「名前が runtime.yaml から消えている場合と、名前は定義済みで provider section が無効な場合がある」）に戻す。
- `claimTasks.ts` から `afterClaim` の読み直しと `pending` の突き合わせを消す。`onSetupFailed` のコールバックで `setupFailedTaskNames` に名前を足し、`publishGoalCompletion` を呼ぶ。1回目の `listTaskStateItems()` は、ロックの失敗の分類（`hasPending`）にだけ使う。
- 上流から残すもの: `runtimeAssignmentUnavailableReason`、`completePublishedTask` の `publishedSha`、`AutoRequeueRestartCheck` まわり、`parallelExecution.ts` の ENOSPC のログに伏せた error を付ける行。どれも claim の知らせ方とは独立している。

### 2. コールバックの中の失敗で claim を失わない（新しく足す）

`onSetupFailed` は書き込みの後に呼ばれるので、そこで出た例外が `claimNextTasks` から出ると、Critical と同じ壊れ方になる（`forkP1Test.publishFailureOrphansClaimedTaskTest`）。これを doc コメントの約束ではなく、構造で防ぐ（設計レビュー 中-1 の (a)）。

- **境界で捕まえる（`taskLifecycleService.ts`）**: `claimNextTasks` は、`withGoalExecutionLock(... store.update ...)` が返った後に、集めた `setupFailures` を1件ずつ `onSetupFailed` に渡す。その呼び出しを1件ずつ `try/catch` で囲み、投げたら `onWarning` に「Task <name> was saved as failed during setup, but reporting it failed: <伏せた文面>」を渡して、次の1件へ進む。`onWarning` 自身が投げたときは何もしない（`try/catch` の入れ子。claim したタスクを返すことを優先する）。書き込みの後で例外を捕まえるのは、ここ1か所だけにする。どの呼び出し元が `onSetupFailed` を渡しても、claim したタスクは必ず返る。
- **知らせの書き込みの失敗は見える形で出す（`claimTasks.ts`）**: コールバックは、まず名前を `setupFailedTaskNames` に足し、次に `publishGoalCompletion` を呼ぶ。`publishGoalCompletion` の例外は、コールバックの中で捕まえて、`warn()`（画面）と `log.error`（ログ）の両方に出す（設計レビュー 中-3）。文面は「Goal task <name> (goal <goalId>) failed during setup and is saved as failed in .takt/tasks.yaml, but the manager was not notified: <伏せた文面>」とし、タスク名・ゴールの ID・tasks.yaml に failed が残っていることを入れる。エラーの文面は `sanitizeSensitiveText` を通す。
- 名前を先に足すので、終了フックには必ず名前が渡る。tasks.yaml には `failed` と `completion` が残る。
- `onWarning` は、`takt run`・`takt watch`・`selectAndExecute` では `warn` につながっている（`runAllTasks.ts:37`、`watch/index.ts:34`、`selectAndExecute.ts:173`）。

見え方の限界（設計レビュー 中-3）:

- `log.error` は、`logging.debug` を有効にしたときしか書かれない（`src/shared/utils/debug.ts`）。既定で残るのは `warn()` の出力だけ。
- ゴールのタスクの多くは、manager の自動 run が起動した `takt run` で動き、その stdout と stderr は `.takt/manager-logs/run-<uuid>.log` に向く（`src/features/manager/autoRun.ts` の 52〜55 行）。このときの警告は、そのファイルにしか残らず、利用者がその場で目にすることはない。
- setup の失敗は pending から直接 failed になり、running を通らない。daemon の `runs()` は running のゴールのタスクしか見ない（`src/features/daemon/watchSource.ts` の 89〜90 行）ので、完了の知らせが失われると manager は起きず、ゴールは止まったように見える。状態（tasks.yaml の failed と `completion`）は失われない。
- 失われた知らせを後から出し直す仕組み（tasks.yaml の failed と `completion` から、inbox に無い知らせを出し直す）は、別件にする（末尾の「別件」の2）。`reconcileLostRun` と `failInterruptedTasksWithGoalEvents` も「書いてから知らせる」形で、同じ限界を持つ。

### 3. `goal-execution.lock` の時間切れを再試行の対象にする（Medium）

- `src/shared/utils/private-file-lock.ts` に `PrivateFileLockTimeoutError extends Error` を足し、`assertLockDeadline` はこれを投げる。文面（`Timed out waiting for private file lock: <path>`）は変えない。
- `TaskLifecycleService.claimNextTasks` は、`withGoalExecutionLock` から出た `PrivateFileLockTimeoutError` を `TaskClaimLockAcquisitionError(message, 'TIMEOUT', { cause })` に変える。`claimTasks.ts` はこれを今の分類のまま `TaskClaimLockUnavailableError('TIMEOUT')` にし、`parallelExecution.ts` は5秒後に再試行する。
- **変換は書き込みの前に限る（設計レビュー 中-2）**: 変換の `try` は `withGoalExecutionLock(...)` の呼び出しだけを囲み、2節の `onSetupFailed` のループはその外に置く。さらに、`store.update` に渡す関数の先頭で「書き込みに入った」印を立て、印が立っていれば変換しない。こうすると、書き込みの後に動くもの（`file-lock.ts` 165〜167 行の `tasks.yaml.lock` の解放、`private-file-lock.ts` 243〜244 行の `goal-execution.lock` の解放、`onSetupFailed` のループ）から何が出ても、再試行には回らない。再試行に回ると Critical の誤った正常終了が戻る（Quint の `fixedPostWriteRetried`）。
- これが安全な理由: `goal-execution.lock` が取れなければ `store.update` は始まらず、何も書かれない。中で `GoalStore.getSync` が失敗しても、タスクごとに捕まえて pending のまま残す。上の印があるので、変換するのは、書き込みに入る前に出た `PrivateFileLockTimeoutError` だけになる。
- 再試行の警告の文面（設計レビュー 低-3）: 今は「Cannot claim pending tasks because the task store lock is held」と出る（`parallelExecution.ts` の 192 行）。`goal-execution.lock` のときは誤りなので、変換するときに `TaskClaimLockAcquisitionError` にどちらのロックかを持たせ、`goal-execution.lock` のときは「Cannot claim pending tasks because the goal execution lock is held. Waiting to retry.」と出す。`tasks.yaml.lock` のときの文面は変えない（`workerPool.test.ts:254`・`watcher.test.ts:344` が確かめている）。
- #91 はこの時間切れをわざと対象の外にした（`it-task-store-process-lock.test.ts` の試験で固定した）が、issue に理由は書かれていない。#91 の「期待する振る舞い」は「一時的なロックの時間切れで、その run の claim を止めない」なので、`goal-execution.lock` にもそのまま当てはまる。このロックを取るのは claim、`GoalStore.update`、`autoRun`、`reconcileLostRun` で、どれも短く持つ。
- `task.test.ts` の「keeps goal-execution.lock timeouts outside the recoverable claim classification」は、tasks.yaml の store が同じ文面の普通の `Error` を投げる場合の試験で、型で見分ける今回の形でも分類されない。中身は変えない。ただし、直した後は本物の `goal-execution.lock` の時間切れが分類に入るので、名前を「does not classify a plain Error with the private-lock timeout text from the task store」に直す（設計レビュー 低-4）。

### 4. 公開 API の非互換と扱い（親1 との比べ）

takt-dash（`j5ik2o/takt-dash` の main、`f3c90e5`、2026-11-26 に読み直した。最初に読んだ `8fb0658` から進んでいたが、結論は変わらない。設計レビュー 低-8）の呼び出しを確かめたうえで、次のように扱う。

| 非互換 | takt-dash の使い方 | 扱い |
|---|---|---|
| `TaskRunner.claimNextTasks` の第2・第3引数、`GoalTaskSetupGuard` の型 | 使わない（TaskRunner はリポジトリの中だけ） | 1節のとおり親1 の形に戻す。 |
| 旧4ツール `takt_list_goal_registration_proposals`、`takt_get_goal_registration_proposal`、`takt_approve_goal_registration`、`takt_reject_goal_registration` が無い（上流 #2083 で `*_goal_proposal*` に改名） | 本番のコード `backend/src/mcp/tools/goal_registration.rs` が本文・承認・却下を、`sets.rs` が一覧を呼ぶ（4つとも）。今のままでは `Tool not found` になり、ゴール登録案の一覧・本文・承認・却下が全部止まる。 | **旧名を別名として残す。** |
| 持ち主が違うときのエラーの文面が「does not own the pending registration proposal」から「does not own the pending goal proposal」に変わった | `backend/src/grpc/writes.rs:308` の `is_stale_registration` がこの文面で「登録案が作り直された」を見分ける。今のままでは、画面を読み込み直す案内が出ず、ただの書き込みの失敗になる。 | **親1 の文面に戻す。** |
| `takt_list_runtime_assignments` が `state` を拒否する（親1 は受け付けて使わなかった） | 呼ばない | 上流の形を取る（下に理由）。 |

旧名の別名の作り方:

- 4つの旧名を、新しい名前と同じ入力の schema、同じ処理でサーバーに登録する。入力の形（`cwd`・`conversationId`・`revision`・`path`・`textOffset` など）と応答の形（`proposals`・`proposal`・`fields`・`revision`）は、親1 と今の版で同じであることを確かめた（処理のファイルは名前の置き換えだけの差だった）。
- 登録する道具の組: 一覧と本文の旧名は `all` と `manager`、承認と却下の旧名は `all` だけ（承認と却下は、親1 でも既定の組 `toolSet` なしか `all` だけだった）。親1 は一覧と本文を `read-only` にも出していたが、旧名は `read-only` には出さない。`read-only` の組は takt 自身のエージェント（`taskStateMcp.ts` が `--tool-set read-only` で起動する task state の道具）向けで、takt-dash は使わない（`docs/requirements.md:47`「read-only ではなく操作を含む tool-set（manager または all）」。常駐の HTTP サーバーも `--tool-set` なしで起動し、`all` になる）。`it-conversation-task-state-mcp.test.ts:431` は「エージェントの許可リストが read-only の組の道具をすべて含む」ことを確かめているので、read-only に旧名を出すと、旧名をエージェントに許すか、この試験を弱めるかになる。
- 旧名は `TAKT_MCP_READ_ONLY_TOOL_NAMES` と `TAKT_MCP_MANAGER_TOOL_NAMES` には入れず、別の一覧（`TAKT_MCP_DEPRECATED_ALIAS_TOOL_NAMES`）にする。この2つの一覧は、manager と task state のエージェントに渡す道具の許可にも使われる（`turnExecutor.ts`、`taskStateMcp.ts`）。エージェントの許可には新しい名前だけを入れる。manager のエージェントがつなぐ `manager` の組の `listTools()` には、一覧と本文の旧名が出る。許可リストを守る provider では、許可リストに無いので呼ばれない。`allowedTools` を守らない provider（`cursor.ts`・`devin.ts`・`kiro.ts` は「does not support allowedTools; ignoring」と出して無視する）では見えるが、旧名は新しい名前と同じ処理で、description も新しい名前を指すので、呼ばれても正しく動く。親1 でもこの名前は見えていたので、害は無い（設計の再レビュー 低-B）。
- 道具名を完全一致で確かめている試験（設計レビュー 中-4）: `all` と `manager` の組の一覧を完全一致で確かめる試験は、期待する一覧に旧名を足す。足すだけなので、試験は弱まらない。該当は `runtime-mcp.integration.test.ts`（302 行以降）と `it-goal-mcp-stdio.test.ts`（1036 行、`TAKT_MCP_MANAGER_TOOL_NAMES` に別名の一覧を足した期待にする）。実装では、`listTools()` の名前を `toEqual` で比べる試験を grep で洗い直し、`all`・`manager` の組のものはすべて同じように足す。`read-only` の組の完全一致（`mcp-entrypoint.test.ts:1075`、`it-goal-mcp-stdio.test.ts:1044`）と、エージェントの許可リストの試験（`it-assistant-mcp-cli-args.test.ts`・`it-conversation-task-state-mcp.test.ts`・`it-opencode-task-state-mcp.test.ts`・`it-opencode-v2-assistant-mcp.test.ts`）は変えない。試験を通すために旧名を許可リストの一覧へ入れてはならない。
- 旧名の description は「Deprecated alias of `takt_list_goal_proposals`. Kept for MCP clients written against the earlier name.」のように、新しい名前を指す。
- 持ち主が違うときの文面は、旧名・新名のどちらから呼んでも親1 の「The conversationId … does not own the pending registration proposal of …」にする。上流の試験はこの文面を確かめていない（上流の `goal-proposal-operations.test.ts` は 84 行で、この確かめは無い）。今の版の 833 行目の確かめは、親1 の試験を改名したときに書き換えたものなので、親1 の文面に戻す。

知らせと移り方:

- PR 本文に、「旧名の4つは別名として残す。新しい名前に移ってほしい」「`--tool-set read-only` には旧名を出さない（親1 は一覧と本文の旧名を出していた。新しい名前を使う）」「`takt_list_runtime_assignments` は `state` を受け付けない」と書く（設計の再レビュー 低-A）。`docs/CHANGELOG.ja.md` は上流のファイルなので触らない（次の取り込みで競合する）。
- takt-dash へ、新しい名前に移ることと、持ち主の食い違いを文面ではなく安定したコードで見分けることの issue を出す（宛先と出すかどうかは元帥に聞く。今回は takt-dash には何も書かない）。
- 別名を消すのは、takt-dash が新しい名前に移って公開された後の、別の PR にする。この PR では消さない。

`state` について上流の形を取る理由: `state` はゴールの一覧（`takt_list_goals`）の絞り込みで、`takt_list_runtime_assignments` は親1 でも受け取って捨てていた。schema に載っていたのは、ゴールの一覧の schema から `errorOffset` だけを外して流用した結果で、意図した引数ではない。リポジトリの中（試験・builtins のプロンプト・docs）にも takt-dash にも、`state` を渡す呼び出しは無い。今の版では schema にも載らないので、schema を読むクライアント（LLM を含む）は渡さない。取り込みの決まり1は「不具合の直し」についての決まりで、これは意図しない引数を外す変更なので、上流に合わせて次の取り込みの競合を減らす。設計レビューで「残すべき」となれば、`omit({ errorOffset: true })` に戻すだけで済む。

### 範囲の外（変えていない）

- ロックの解放が書き込みの後で失敗する場合（`unlink` の EIO・EACCES、または「ownership changed before release」）。claim したタスクは返らず、生きている自分のプロセスを持ち主とする running として残る。この例外は分類されない普通の `Error` なので、claim は `preparationFailure` で止まり、「Cannot prepare pending tasks」が出て、run は失敗として終わる。誤った正常終了にはならない（Quint の `fixedReleaseFails`）。副元帥の答えで別件にした（末尾の「別件」の1）。ただし、この PR に「解放の失敗が再試行に分類されない」ことの試験を入れる（試験の8）。
- 1回目の読みで pending が無いときの ENOSPC（上流 #1857 の設計のまま、claim を止める）。
- claim の後にプロセスが死ぬ場合（設計レビュー 低-1）: running のタスクは、次の run の `failInterruptedRunningTasks` か `reconcileLostRun` が拾う。tasks.yaml に setup の失敗（failed）を書いた後、`onSetupFailed` を呼ぶ前に死ぬと、そのタスクの完了の知らせと終了フックは、どの経路でも出なくなる。窓は狭く、取り込み版・親1・この設計のどれにも前からある。別件の2で、出し直しといっしょに扱う。
- 終了フックの中の読みの失敗（設計レビュー 低-2）: `runTaskFinishHooks` は自分で `listTaskStateItems()` を読み（`taskFinishHook.ts` の 136 行）、それが失敗するか設定が読めないと、`log.error` だけを残してフックを呼ばない（139〜141 行）。既定では何も表示されない。前からある挙動で、この設計では変えない。この設計の「終了フックは1回」は「名前がちょうど1回フックへ渡る」の意味で、フックの中の読みが成功した場合に限られる。取りこぼしを `warn()` で見えるようにするのは、別件の3。
### 触らないもの（レビューで健全とされたもの）

範囲を広げたレビュー（REPORT.md の 3-1〜3-4）で問題なしとされた次のものは、この直しでは変えない。差分にこれらのファイルが入ったら、設計から外れている。

- 秘密の保護: `src/shared/utils/sensitive*.ts`、`src/core/workflow/report-phase-runner.ts` の伏せる処理（`buildProviderErrorEventMessage`、`content: ''` 化、`buildReportAttemptSpanOutcome`、`context_compacted` の経路）。新しく足す警告のログは、既存の `sanitizeSensitiveText` を通すだけで、伏せる処理そのものは変えない。
- 保存済みのデータ: tasks.yaml のスキーマ（`schema.ts`・`taskRecordSchemas.ts`・`taskExecutionSchemas.ts`・`taskConfigSerialization.ts`）、`eventStore.ts`・会話の記録、再開の記録（`declared-report-inputs.ts` ほか）。消えた回帰テスト1件を戻すだけで、本体は変えない。
- 設定と会話の API: 設定のキー・正規化（`config-types.ts`・`config-schemas.ts`・`globalConfig*`・`projectConfig.ts`）、会話のコマンドとポート（`conversationCommands.ts`・`conversationPort.ts`）。MCP で変えるのは4節の別名と文面だけ。
- 並行の上限: `concurrency` の扱い（`freeSlots`・`fillSlots`・`merge.concurrency`）。
- ロックの順の階層: `epics.lock` → `goal.json.lock` → `goal-execution.lock` → `tasks.yaml.lock`。`project-execution-lock.ts`、`file-lock.ts` の `linkSync` と `heldLocks`、`private-file-lock.ts` の取り方と放し方。`private-file-lock.ts` で変えるのは、時間切れで投げるエラーの型（文面は同じ）だけ。

## 取り込みの決まりとの対応

`~/.orca/bots/takt/memory/handoff/upstream-sync-rules.md` の各項に、この直しがどう従うか。

1. フォーク側を消すのは、上流が同じ不具合を同じかそれ以上に直したと確かめたときだけ: 上流の読み直しの形は、2a・2b のレースと afterClaim の失敗を生む（Quint の `merged` と、レビューの実物での再現）。同じかそれ以上の直しではないので、フォーク側（PR #50）を残す。MCP の旧名もフォーク側の利用者がいるので残す。`state` は不具合の直しではない（4節）。
2. テストは消さない・弱めない: 消えた試験は戻す。書き換えられた試験は親1 の形に戻し、書き換え後の試験が親1 より強いもの（`it-task-finish-hook.test.ts` の本物の claim を通す試験）は、別の試験として足す。期待を逆にする試験は1件だけで（`it-task-store-process-lock.test.ts`）、何も書かないことの確かめは残す。ほかに期待を変えるのは、道具名の完全一致の一覧に旧名を足す2件（`runtime-mcp.integration.test.ts`・`it-goal-mcp-stdio.test.ts:1036`。足すだけで、確かめは強くなる）と、中身を変えずに名前だけ直す1件（`task.test.ts`）。旧名の改名で書き換えられた試験（下の「改名で書き換えられた試験」）は、新しい名前の確かめとして残し、旧名の確かめを別に足す。
3. 競合を解いた箇所の一覧: PR 本文に書く（「進め方と残り」の4）。
4. 状態遷移は Quint つきの設計 → 設計レビュー → 実装: この設計と `specs/quint/goal-task-claim/`。
5. 秘密・保存済みのデータ・公開 API・守りの仕組みに触れる競合は、マージの前に独立レビュー: この設計のレビューに加えて、副元帥の独立レビュー（REPORT.md）がある。
6. 上流へは何も流さない。force-push しない。マージは中将がする。

## 守る不変条件

Quint の `safety` は次の7つの連言で、`fixed` で違反が無い。

1. `noOrphanRunning`: running と書いたタスクは、必ず持ち主のキューに入る。入るまでの間は、同じ呼び出しの中にある。
2. `queuedByOwnerOnly`: タスクをキューに入れるのは、claim したプロセスだけ。
3. `noDuplicateSetupReport`: setup の失敗の終了フックと完了の知らせは、それぞれ多くとも1回。
4. `noFalseSetupReport`: 知らせるのは、claim が setup の失敗として書いたタスクだけ。
5. `noMissedSetupReport`: setup の失敗を書いた claim が終わったら、終了フックへ名前がちょうど1回渡っている。完了の知らせは書けたか、書けなかったことが `warn()` で出ている。
6. `claimingNeverStops`: ロックの失敗と `onSetupFailed` の中の失敗では、その run の claim は止まらない。
7. `noFalseCleanEnd`: `takt run` は、自分が running と書いたタスクが実行されないまま、正常に終わらない。

実装の側では、さらに次を守る。

- claim の再試行に回すのは、tasks.yaml にまだ何も書いていない失敗だけ。書き込みに入った後に出たものは、どの型でも再試行に回さない。
- `claimNextTasks` は、`onSetupFailed` が何を投げても、claim したタスクを返す。
- `claimTasksWithGoalCompletions` は `listTaskStateItems` を1回だけ呼ぶ。
- `claimNextTasks` の第2引数に匿名の関数は渡せない（型の契約テストで確かめる）。
- 親1 の MCP クライアントが呼んでいた4つの旧名は、同じ入力で同じ応答を返す。持ち主が違うときの文面は「does not own the pending registration proposal」を含む。
- エージェントに渡す道具の許可リストには、旧名を入れない。

## Quint

`specs/quint/goal-task-claim/`（`goalTaskClaim.qnt`、`goalTaskClaim_test.qnt`、`README.md`）。同じモデルの `DESIGN` を `Merged`（`d2bd16a30`）、`ForkP1`（PR #50 のまま）、`Fixed`（この設計）に切り替えて比べる。プロセス2つ、タスク3つ（実行できるもの1つ、setup の失敗になるもの2つ、うち1つは途中で足される）。各プロセスは `takt run` として、`runWithWorkerPool` の終わりの条件（実行中が無い、`claimRetryAt` が無い、キューが空、claim を試した後）で正常に終われる（`endRun`）。`takt watch` は終わらないので、`noOrphanRunning` だけが当たる。`claimSaved` の `callbackFails` は「`onSetupFailed` の中で何かが投げる」（知らせの書き込み、または名前を足した後の `warn()` など）を表す（設計レビュー 中-1）。`POST_WRITE` は、書き込みの後、`claimNextTasks` が返る前に出る例外（ロックの解放の失敗）を足す。`fixedReleaseFails`（`Stops`: 分類されずに止まる。この設計の振る舞い）と `fixedPostWriteRetried`（`Retried`: 再試行に分類される。採らない形）で比べる。MCP の別名は状態遷移ではないので、Quint には入れず、試験で確かめる。

| 検査 | 結果 |
|---|---|
| `quint run`（各不変条件 × 5つの版、3,000 標本、12 ステップ、seed 0x2a） | `merged` は `noOrphanRunning`・`noDuplicateSetupReport`・`noMissedSetupReport`・`claimingNeverStops`・`noFalseCleanEnd` が破れる。`forkP1` は `noOrphanRunning`・`noMissedSetupReport`・`claimingNeverStops` が破れる（`noFalseCleanEnd` は、取り残す経路で claim も止まり、失敗で終わるので破れない）。`fixed` は7つとも違反なし。`fixedReleaseFails` は `noOrphanRunning`・`noMissedSetupReport`・`claimingNeverStops` が破れ、`noFalseCleanEnd` は保たれる（別件で直すものと、それまでも誤った正常終了にはならないこと）。`fixedPostWriteRetried` は `noOrphanRunning`・`noMissedSetupReport`・`noFalseCleanEnd` が破れる（変換を書き込みの後まで広げると Critical が戻る）。 |
| `quint run --main fixed --invariant safety`（10,000 標本、15 ステップ、witness 9つ） | 違反なし。witness はすべて到達（最少は `wOtherProcReported` の 1,883 本、`wRunEnded` 5,193 本、`wRunEndedAfterWork` 2,886 本）。15 ステップより短い跡は、2つのプロセスがどちらも終わった状態で、設計どおりの終わり。 |
| `quint run --main fixedReleaseFails --invariant noFalseCleanEnd`（10,000 標本、15 ステップ） | 違反なし。書き込みの後の例外の手（`wPostWriteThrew`）は 9,076 本で起きた。 |
| `quint verify --main fixed --invariant safety --max-steps 10` | 違反なし（281 秒）。わかっている反例はどれも7手以内で、2つのプロセスがどちらも再試行してタスクを足して終わる組み合わせ（9〜10 手）も含む深さ（設計レビュー 低-6）。 |
| `quint verify --main fixedReleaseFails --invariant noFalseCleanEnd --max-steps 8` | 違反なし（35 秒）。 |
| `quint verify`（8 ステップ）で反例が出ることの確かめ | `merged` の `noFalseCleanEnd`（12 秒）、`forkP1` の `noOrphanRunning`（5 秒）、`fixedPostWriteRetried` の `noFalseCleanEnd`（6 秒）。verify が空振りでない。 |
| `quint test` | `mergedTest` 6件、`forkP1Test` 3件、`fixedTest` 9件、`fixedReleaseFailsTest` 2件、`fixedPostWriteRetriedTest` 1件、計21件すべて通る。 |

## 試験

### 戻す試験（取り込みで消えたか、書き換えられたもの）

| ファイル | 何をしたか | 戻し方 |
|---|---|---|
| `src/__tests__/type-contracts/goal-task-setup-guard.ts` | 消えた | `337062193` の内容に戻す。 |
| `src/__tests__/manager-task-events.test.ts`「publishes task setup failures once when claiming changes their state」 | 上流の形（`claimNextTasks` の後の状態を読み直す mock）に書き換えられ、`listTaskStateItems` が1回だけであることと `onSetupFailed` の確かめが消えた | `337062193` の形に戻す。上流のこの試験は読み直しの形を前提にしているので、置き換える。 |
| `src/__tests__/it-task-finish-hook.test.ts`（418〜431 行） | `onSetupFailed` を通す mock の試験が、`runtime_assignment: 'gone'` で本物の claim を通す試験に書き換えられた | `337062193` の試験を戻す。書き換え後の試験も本物の経路を通す点で強いので、別の試験として残す（このファイルは上流に無く、フォーク側のもの）。 |
| `src/__tests__/workerPool.test.ts`「claim で失敗として保存されたゴールのタスクを run の失敗に数える」 | `onSetupFailed` を呼ぶ mock が、読み直しの結果を変える mock に書き換えられた | `337062193` の形に戻す。 |
| `src/__tests__/daemon-storage.integration.test.ts`「restores legacy summary approvals and dismissals saved without a conversation id」 | 消えた（上流 #2060 のもの） | 上流 `5d7581a85` の内容を戻す。 |
| `src/__tests__/goal-proposal-operations.test.ts`（833 行目、親1 の `goal-registration-proposal-operations.test.ts` を改名したもの） | 持ち主が違うときの文面の確かめが「goal proposal」に書き換えられた | 親1 の「does not own the pending registration proposal」に戻す（4節）。 |

### 改名で書き換えられた試験（残す）

上流 #2083 の改名に合わせて、次の親1 の試験は道具名・schema 名・関数名だけを新しい名前に書き換えられた。確かめている中身は変わっておらず、新しい名前の確かめとして正しいので、このまま残す。旧名の確かめは、下の「足す試験」で別に足す。

- `goal-registration-proposal-operations.test.ts` → `goal-proposal-operations.test.ts`（親1 の 37 件はすべて残り、上流の3件が足された。833 行目の文面だけは上の表のとおり戻す）
- `mcpSchemas.test.ts`（schema 名）、`mcp-entrypoint.test.ts`・`it-goal-mcp-stdio.test.ts`・`runtime-mcp.integration.test.ts`（道具名の一覧。新しい名前はこのまま残し、`all` と `manager` の組の完全一致の一覧には4節のとおり旧名を足す）
- `it-assistant-mcp-cli-args.test.ts`・`it-conversation-task-state-mcp.test.ts`・`it-opencode-task-state-mcp.test.ts`・`it-opencode-v2-assistant-mcp.test.ts`（エージェントに渡す道具の許可リスト。旧名を入れないので、このままが正しい）
- `manager-conversation-client.integration.test.ts`・`manager-conversation-turn-service.test.ts`（関数名と試験の名前の「registration proposal」→「goal proposal」）

### 書き換える試験（期待を逆にする1件と、名前だけ直す1件）

- `src/__tests__/it-task-store-process-lock.test.ts`「does not convert another process holding the goal-execution lock into a recoverable claim timeout」: 期待を逆にする。別のプロセスが `goal-execution.lock` を持っているとき、claim は `TaskClaimLockAcquisitionError`（`code: 'TIMEOUT'`）を投げ、タスクは pending のまま、`tasks.yaml.lock` は残らない。理由は上の3節（Medium の直し）。副元帥の答え（1）に従い、次のようにする。
  - `errorName === 'TaskClaimLockAcquisitionError'` と `code === 'TIMEOUT'` を確かめる。
  - 書き込みが無いこと（pending のまま・`tasks.yaml.lock` が残らない）の確かめは、そのまま残す。
  - 持ち主がロックを放した後に、同じ runner の claim が成功すること（再試行の経路）を1つ足す。
  - 試験のコメントに「#91 の期待する振る舞い（一時的なロックの時間切れで claim を止めない）は goal-execution.lock にも当てはまるので、期待を逆にした（項目201）」と1行書く。PR 本文にも同じ理由を1行書く。
- `src/__tests__/task.test.ts` 2851 行: 中身は変えず、名前だけを「does not classify a plain Error with the private-lock timeout text from the task store」に直す（3節、設計レビュー 低-4）。

### 足す回帰テスト（直す前に `d2bd16a30` で落ちるのを確かめる）

1. Critical: 本物の `TaskRunner`（一時ディレクトリ）で、`claimNextTasks` の後の `listTaskStateItems` がロックの時間切れ（`File lock: timed out waiting for lock`）を投げるようにする。`claimTasksWithGoalCompletions` が claim したタスクを返すこと、tasks.yaml の running のタスクが戻り値に入っていることを確かめる。ENOSPC（`PrivateFileLockAcquisitionError` の `ENOSPC`）でも同じものを1件。`d2bd16a30` では `TaskClaimLockUnavailableError` が投げられて落ちる。
2. High 2a: 同じディレクトリの `TaskRunner` を2つ使い、A の1回目の読みと A の claim の間に、B の claim を入れる（A の `claimNextTasks` に spy を付け、本物を呼ぶ前に B を動かす）。setup の失敗を知らせるのは B だけで、`saveManagerEvent` は1回。
3. High 2b: A の1回目の読みと A の claim の間に、setup の失敗になるゴールのタスクを足す。A の `setupFailedTaskNames` にそのタスクが入る。
4. 知らせの書き込みの失敗: `saveManagerEvent` が投げても、claim したタスクが返り、`setupFailedTaskNames` に名前が入り、`warn()` にタスク名・ゴールの ID・「saved as failed in .takt/tasks.yaml」を含む警告が出る（`log.error` にも出る）。
4b. コールバックが投げる（設計レビュー 中-1）: `TaskLifecycleService.claimNextTasks` に、投げる `onSetupFailed` を渡す。claim したタスクが返り、`onWarning` に警告が渡り、2件目の setup の失敗にも `onSetupFailed` が呼ばれる。`onWarning` も投げる場合も、claim したタスクが返る。直す前（`d2bd16a30`）は `onSetupFailed` が無いので、親1 の形に戻したうえでこの試験だけ先に流し、境界の `try/catch` を足す前に落ちることを確かめる。
5. Medium: `withGoalExecutionLock` が `PrivateFileLockTimeoutError` を投げると、`claimNextTasks` は `TaskClaimLockAcquisitionError('TIMEOUT')` を投げる（ユニット）。上の書き換える試験（heavy IT）も直す前に落ちる。再試行の警告が、`goal-execution.lock` のときは「the goal execution lock is held」、`tasks.yaml.lock` のときは今の文面になることも確かめる（低-3）。
6. Critical の続き（`takt run` の誤った正常終了）: 本物の `TaskRunner` と `runWithWorkerPool(..., 'run')` で、pending のタスク1つを置き、claim の後の1回目の `listTaskStateItems` だけを時間切れにする（実行は stub）。結果が `success 1`・`executedTaskNames` にそのタスク、tasks.yaml で `completed` になることを確かめる。`d2bd16a30` では `{ success: 0, fail: 0, executedTaskNames: [] }` で終わり、tasks.yaml に running が残って落ちる（レビューの実物での再現と同じ条件）。待ちは `CLAIM_RETRY_INTERVAL_MS`（5秒）を1回含むので、heavy IT に置く。
7. MCP の旧名: `listTools()` で、一覧と本文の旧名が `all` と `manager` に出て `read-only` に出ないこと、承認と却下の旧名が `all` だけに出ること。旧名と新名を同じ入力で呼んで同じ応答になること（一覧・本文・承認・却下。承認と却下は、既存の `goal-proposal-operations.test.ts` の会話の stub を使う）。持ち主が違うとき、旧名・新名のどちらでも文面に「does not own the pending registration proposal」が入ること。`TAKT_MCP_READ_ONLY_TOOL_NAMES`・`TAKT_MCP_MANAGER_TOOL_NAMES` に旧名が入っていないこと。`d2bd16a30` では旧名が無いので落ちる。
8. 書き込みの後の例外を再試行に回さない（設計レビュー 中-2、副元帥の答え（2）の条件）: 書き込みが済んだ後に (i) `tasks.yaml.lock` の解放が失敗する、(ii) `goal-execution.lock` の解放が失敗する（「ownership changed before release」と `unlink` の EIO）、(iii) 書き込みの後に `PrivateFileLockTimeoutError` が出る（spy で入れる）、の3つで、`claimNextTasks` から出る例外が `TaskClaimLockAcquisitionError` ではないこと、`claimTasksWithGoalCompletions` から出る例外が `TaskClaimLockUnavailableError` ではなく `isClaimLockTimeoutFailure` も false であることを確かめる（ユニット）。tasks.yaml には claim が書かれていることも確かめ、別件で直す形（claim したタスクが返らない）を試験の名前で示す。

### 性質の試験（PBT）

このブランチには fast-check が無い（#160 の revert で外れた）ので、全部の組み合わせを流す表の試験にする（light IT、本物の `TaskRunner` を一時ディレクトリで2つ）。

- 入力の集合: A の2手（1回目の読み・claim）と B の2手と「タスクを足す」1手の、各プロセスの順序を保った並べ方すべて（30 通り）× 失敗の入れ方 {なし, A の claim の後の読みが時間切れ, `saveManagerEvent` が投げる, A の `goal-execution.lock` が時間切れ}（4 通り）= 120 通り。タスクは、実行できるもの1つ、setup の失敗になるもの1つ、途中で足すもの（setup の失敗になる）1つ。
- 性質: (a) tasks.yaml で running のタスクは、ちょうど1つのプロセスの戻り値に入っている（戻り値がキューに入るので、`takt run` の正常な終わりは、そのタスクを実行した後にしか来ない。終わりそのものは上の回帰テスト6で確かめる）。(b) setup の失敗として failed になったタスクは、2つのプロセスの `setupFailedTaskNames` を合わせてちょうど1回出る。(c) `saveManagerEvent` の呼び出しと、書き込みの失敗のログを合わせて、そのタスクについてちょうど1回。(d) setup の失敗でないタスクは知らせない。(e) 失敗を入れた手が投げたなら、それは `TaskClaimLockUnavailableError` で、そのとき tasks.yaml は手の前と同じ。
- 除外: ロックの解放の失敗とプロセスの死（範囲の外）。前者は、分類されないことを回帰テスト8で確かめる。後者の running のタスクは、`failInterruptedRunningTasks` の既存の試験が確かめる。
- `d2bd16a30` では (a)(b) が落ちる組み合わせがあるはず。直す前に流して、落ちる組み合わせの数を報告に残す。

## 壊しうる入力

- 境界: `count` より pending が多い／少ない、`count = 0`、pending が0件、claim するタスクも setup の失敗も無い回。
- 並行: 2つのプロセスが同じ pending を読む（2a）、読みと claim の間にタスクが足される（2b）、読みと claim の間にほかのプロセスがタスクを消す（`deletion` の印。`claimNextTasks` が飛ばす）。
- 失敗の場所: 1回目の読み（時間切れ・ENOSPC）、`goal-execution.lock` の取得（時間切れ・ENOSPC）、`tasks.yaml.lock` の取得（時間切れ・ENOSPC）、tasks.yaml の書き込み（ENOSPC。書けなければ何も変わらない）、`saveManagerEvent`（ENOSPC・goal.json が読めない）、`onSetupFailed` の中の `warn()`（stdout が閉じている EPIPE）、`onWarning` 自身、ロックの解放（別件。再試行に回らないことだけをこの PR で確かめる）。
- 再開: 再試行の次の tick で、前の回の setup の失敗を二度知らせない（failed は pending ではないので claim の対象にならない）。
- 中断: `signal.aborted` は claim の前だけで見る。claim の後に中断されても、claim したタスクはキューに入る（今までどおり）。
- `goalTasksOnly`: ゴールのタスクだけを claim する run でも、分類と知らせ方は同じ。
- 文面: 警告のログに出すエラーは `sanitizeSensitiveText` を通す。
- `takt run` の終わり: 再試行の待ちの間（`claimRetryAt` がある）と、キューにタスクがある間は終わらない。claim したタスクが無い tick でも、取り残したタスクがあれば、それは戻り値に入っているので終わらない。
- MCP の旧名: 旧名と新名を同じ会話で混ぜて呼ぶ（旧名で一覧、新名で承認）。どちらも同じ処理なので、`revision` と `conversationId` の照合は変わらない。

## 影響

- 上流（nrslib/takt）: 何も流さない。上流の `claimNextTasks(count, fn)` の形とは違うままなので、次の取り込みでも同じ場所が競合する。そのときは、この設計と Quint の仕様を見て解く。
- 保存済みのデータ: tasks.yaml・manager の inbox の形式は変えない。setup の失敗のレコードは今までどおり `buildSetupFailedTaskRecord` で作る。
- 公開 API: `TaskRunner.claimNextTasks` の形を PR #50 の形に戻す。`GoalTaskSetupGuard` の型を `infra/task/index.ts` から出す。`PrivateFileLockTimeoutError` を足す（文面は変えない）。この3つのリポジトリの外の呼び出し元は無い。MCP は4節のとおり、旧4ツールを別名で戻し、持ち主の食い違いの文面を親1 に戻す。新しい名前と `takt_create_goal_proposal` はそのまま。`takt_list_runtime_assignments` の `state` は上流の形（拒否）を取り、PR 本文で知らせる。
- 守りの仕組み: claim の再試行の対象に `goal-execution.lock` の時間切れが加わる。何も書いていない失敗だけを再試行する、という条件は変えない。ロックの順序（`goal.json.lock` → `goal-execution.lock` → `tasks.yaml.lock`）は変えない。
- イベントループ（設計レビュー 低-3）: `runPrivateFileExclusive` は `Atomics.wait` で同期的に待つ（`private-file-lock.ts` の 39〜41 行、157〜166 行）。ほかのプロセスが `goal-execution.lock` を長く持つと、claim を試すたびに 10 秒イベントループが止まり、5 秒空けてまた試す。同じプロセスで動いているタスク（provider の応答の流れ、SIGINT の扱い）が、時間のおよそ 2/3 止まる。前は1回で claim が止まったので、この影響は無かった。`tasks.yaml.lock` の時間切れ（5 秒）にも #91 から同じ形がある。今のロックの持ち主はどれも短く持つ（claim、`GoalStore.update`、`autoRun` の spawn、`reconcileLostRun`）ので受け入れる。警告は最初の1回しか出ないので、長く待っていることは利用者に見えない。
- 利用者に見えるもの: setup の失敗の知らせの書き込みに失敗すると、`warn()` に警告が出る。manager の自動 run では `.takt/manager-logs/run-<uuid>.log` にだけ残る（2節）。

## 進め方と残り

1. 設計レビュー（`~/.orca/bots/sub-marshal/audit/takt-168-merge-review/DESIGN-REVIEW.md`、条件つきでよい、高0・中4・低8）の指摘を反映した（「設計レビューの指摘の扱い」）。副元帥の答え: `goal-execution.lock` の heavy IT の期待を逆にするのは賛成、ロックの解放の失敗は別件でよい（分類されない試験はこの PR に入れる）。変えた点だけを設計レビューに見せる（今ここ）。
2. 通ったら、試験を戻し、回帰テストと表の試験を足し、`d2bd16a30` で落ちるのを確かめて、その出力を残す。
3. 直す。PR #168 は今 `integration/takt-mcp` と競合している（#164・#167 が先に入った）。直した後に `integration/takt-mcp` を枝へマージして解く（force-push はしない）。
4. 競合を解いた箇所の一覧と、戻した・書き換えた試験の理由、MCP の非互換の知らせを PR 本文に書く。CI・Quint・レビューボットで確かめる。
5. takt-dash への issue（新しい名前に移る、食い違いを文面ではなくコードで見分ける）は、出すかどうかと宛先を元帥に聞く。
6. 末尾の「別件」の issue は、中将がマージの前に起票する。

大きさ: 8。前の見積もり（5）に、MCP の旧名4つの別名と文面の戻し、その試験、`takt run` の終わり方の heavy IT が加わった。直すコードは claim の4ファイル、lock の1ファイル、MCP の2ファイル（`server.ts`・`goalProposalOperations.ts`）と小さいが、戻す試験6件、書き換え1件、回帰テスト9種（4b と 8 を足した）、120 通りの表の試験、`integration/takt-mcp` との競合の解消がある。

## 設計レビューの指摘の扱い

`~/.orca/bots/sub-marshal/audit/takt-168-merge-review/DESIGN-REVIEW.md`（2026-11-26）の指摘を、次のように扱った。

| 指摘 | 扱い | どこに書いたか |
|---|---|---|
| 中-1 `onSetupFailed` が投げないことが doc コメント頼み | 直す。`claimNextTasks` が1件ずつ `try/catch` で囲み、`onWarning` に回す（(a) の形。PR #50 の形を保つ） | 2節、回帰テスト 4b、Quint の `callbackFails` |
| 中-2 `PrivateFileLockTimeoutError` の変換の範囲 | 直す。`try` は `withGoalExecutionLock` の呼び出しだけを囲み、書き込みに入った印が立っていれば変換しない | 3節、回帰テスト8、Quint の `fixedPostWriteRetried` |
| 中-3 知らせの書き込みの失敗が誰にも見えない | 直す。`warn()` と `log.error` の両方に、タスク名・ゴールの ID・tasks.yaml に failed が残っていることを出す。自動 run ではログのファイルにしか残らないことを書く。出し直しは別件の2 | 2節、影響、回帰テスト4 |
| 中-4 完全一致の試験が別名で落ちる | 直す。旧名は `all` と `manager` だけに出し、その2つの組の完全一致の試験は期待に旧名を足す。`read-only` には出さない | 4節、取り込みの決まり2、改名で書き換えられた試験 |
| 低-1 死ぬ場合の「`failInterruptedRunningTasks` が拾う」は setup の失敗に当たらない | 直す（文）。出し直しは別件の2 | 範囲の外 |
| 低-2 `hooks` はフックへ名前を渡した回数 | 設計に書く。フックの取りこぼしを見えるようにするのは別件の3 | 範囲の外、不変条件5、Quint の README |
| 低-3 再試行の警告の文面と、イベントループへの影響 | 文面は直す（`goal-execution.lock` のときは別の文面）。影響は設計に書いて受け入れる | 3節、影響、回帰テスト5 |
| 低-4 `task.test.ts` の試験名が直した後の振る舞いと逆 | 直す（名前だけ。中身は変えない） | 3節、書き換える試験 |
| 低-5 「永久に取り残される」はプロセスが生きている間の話 | 直す（文）。重さは Critical のまま | 何が起きているか |
| 低-6 verify の深さ | 直す。`fixed` を 10 ステップで verify し、`merged`・`forkP1`・`fixedPostWriteRetried` で反例が出ることも記録した | Quint、README |
| 低-7 ロックの解放と生存性がモデルに無い | 一部直す。書き込みの後の例外を `POST_WRITE` として足した（分類されないこと・誤った正常終了にならないことまで）。「ロックは必ず外れる」と生存性は別件の1 | Quint、別件の1 |
| 低-8 takt-dash の main が進んでいる | 直す（`f3c90e5` で読み直した。結論は同じ） | 4節 |

## 別件（中将がマージの前に起票する）

宛先は j5ik2o/takt、基点は `integration/takt-mcp`。上流へは出さない。

### 1. claim の書き込みの後にロックの解放が失敗すると、claim したタスクが取り残される

- 現象: `claimNextTasks` が tasks.yaml に claim を書いた後、`tasks.yaml.lock`（`file-lock.ts` の `unlinkSnapshot`）か `goal-execution.lock`（`private-file-lock.ts` の `combineLockActionErrors`）の解放が失敗すると（`unlink` の EIO・EACCES、「ownership changed before release」）、例外が `claimNextTasks` から出る。claim したタスクは返らず、生きている自分のプロセスを持ち主とする running として残る。claim は `preparationFailure` で止まり、run は失敗で終わる（項目201 の直しの後。誤った正常終了にはならない）。プロセスが終わると `failInterruptedRunningTasks` か `reconcileLostRun` が failed（interrupted）にするが、実行はされない。ロックのファイルが消せずに残ると、そのプロセスが生きている間、ほかのプロセスの claim・`GoalStore.update`・`autoRun` が待たされる。
- 直し方の案: (a) 書き込みが済んだ後に解放が失敗したら、claim したタスクを返し、解放の失敗はロックのパスを付けて `warn()` で知らせる。(b) `specs/quint/goal-task-claim/` に、解放の失敗を直した形を `POST_WRITE` の新しい値として足し、「ロックは必ず外れるか、外れないことが知らされる」を不変条件にする（`fixedReleaseFails` がひな形）。(c) 同じ形の `invalidatePendingGoalTasks`・`failInterruptedRunningTasks`・`reconcileLostRun` も見直す。
- 項目201 で入れたもの: 解放の失敗が再試行に分類されないことの試験（回帰テスト8）と、Quint の `fixedReleaseFails`。

### 2. setup の失敗の完了の知らせが失われると、manager が起きない

- 現象: setup の失敗は pending から直接 failed になり、daemon の `runs()` は running のゴールのタスクしか見ない（`watchSource.ts` の 89〜90 行）。完了の知らせ（`saveManagerEvent`）の書き込みが失敗するか、tasks.yaml に書いた後で知らせる前にプロセスが死ぬと、manager は起きず、ゴールが止まったように見える。tasks.yaml には failed と `completion` が残る。項目201 の後は、書き込みの失敗は `warn()` で出るが、manager の自動 run では `.takt/manager-logs/run-<uuid>.log` にしか残らない。
- 直し方の案: tasks.yaml の failed と `completion` から、inbox に無い完了の知らせを出し直す（patrol か claim の tick で）。`reconcileLostRun` と `failInterruptedTasksWithGoalEvents` の「書いてから知らせる」形も同じ仕組みで覆う。

### 3. task_finish_hook の取りこぼしが黙って起きる

- 現象: `runTaskFinishHooks` は自分で `listTaskStateItems()` を読み（`taskFinishHook.ts` の 136 行）、それが時間切れになるか設定が読めないと、`log.error` だけを残してフックを呼ばない（139〜141 行）。`log.*` は `logging.debug` のときしか書かれないので、既定では何も残らない。前からある挙動。
- 直し方の案: 取りこぼしを `warn()` で、タスク名とともに出す。読みの時間切れは再試行するかを決める。

# 上流の取り込み（#168）で戻った、claim の setup の失敗の知らせ方を直す（項目201）

PR: https://github.com/j5ik2o/takt/pull/168 ／ 枝 `sync/upstream-main-20261125`（先端 `d2bd16a30`）に追加コミットで直す。

レビュー: `~/.orca/bots/sub-marshal/audit/takt-168-merge-review/REPORT.md`（結論「だめ」。2026-11-26 に範囲を広げた版で、公開 API（MCP・`TaskRunner`）と `takt run` の終わり方が加わった）。

Quint: `specs/quint/goal-task-claim/`。

## 何が起きているか

取り込みのマージ `d2bd16a30` は、`claimTasks.ts` の競合を上流 #2084 の形で解いた。claim の後に `listTaskStateItems()` で tasks.yaml を読み直し（`afterClaim`）、1回目に読んだ pending と突き合わせて setup の失敗を探す形である。フォーク側 PR #50（`bddbe7b66`）の `GoalTaskSetupGuard` と `onSetupFailed` は落ちた。さらに、フォーク側の時間切れの再試行（#91）に合わせて、`claimNextTasks` と `afterClaim` を同じ `try` に入れた。

このため次のことが起きる（Quint の反例と、レビューの実物での再現の両方で確かめた）。

| 重さ | 何が起きるか | Quint の反例 |
|---|---|---|
| Critical | `claimNextTasks` が running を書いた後、`afterClaim` がロックの時間切れか ENOSPC で失敗すると、`catch` が再試行できる失敗として投げ直し、claim したタスクがキューに入らない。持ち主は生きている自分のプロセスなので、以後どの経路でも拾われない。同じ回の setup の失敗の知らせも消える。 | `mergedTest.rereadTimeoutOrphansClaimedTaskTest`、`orphanIsNotReclaimedTest` |
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

### 2. 知らせの書き込みの失敗で claim を失わない（新しく足す）

`claimTasks.ts` のコールバックは、名前を `setupFailedTaskNames` に足してから `publishGoalCompletion` を呼び、その例外を捕まえて警告のログに残す（エラーの文面は `sanitizeSensitiveText` を通す）。こうすると、`onSetupFailed` は投げない。終了フックは `setupFailedTaskNames` から呼ばれるので、知らせの書き込みが失敗しても1回出る。tasks.yaml には `failed` と `completion` が残る。

`claimNextTasks` 側には捕まえる処理を置かず、`onSetupFailed` は投げてはならない、と doc コメントに書く。書き込みをするのは呼び出し側なので、そこで扱う。

### 3. `goal-execution.lock` の時間切れを再試行の対象にする（Medium）

- `src/shared/utils/private-file-lock.ts` に `PrivateFileLockTimeoutError extends Error` を足し、`assertLockDeadline` はこれを投げる。文面（`Timed out waiting for private file lock: <path>`）は変えない。
- `TaskLifecycleService.claimNextTasks` は、`withGoalExecutionLock` から出た `PrivateFileLockTimeoutError` を `TaskClaimLockAcquisitionError(message, 'TIMEOUT', { cause })` に変える。`claimTasks.ts` はこれを今の分類のまま `TaskClaimLockUnavailableError('TIMEOUT')` にし、`parallelExecution.ts` は5秒後に再試行する。
- これが安全な理由: `goal-execution.lock` が取れなければ `store.update` は始まらず、何も書かれない。中で `GoalStore.getSync` が失敗しても、タスクごとに捕まえて pending のまま残す。だから、`claimNextTasks` から出る `PrivateFileLockTimeoutError` は、書き込みの前に起きたものに限られる。
- #91 はこの時間切れをわざと対象の外にした（`it-task-store-process-lock.test.ts` の試験で固定した）が、issue に理由は書かれていない。#91 の「期待する振る舞い」は「一時的なロックの時間切れで、その run の claim を止めない」なので、`goal-execution.lock` にもそのまま当てはまる。このロックを取るのは claim、`GoalStore.update`、`autoRun`、`reconcileLostRun` で、どれも短く持つ。
- `task.test.ts` の「keeps goal-execution.lock timeouts outside the recoverable claim classification」は、tasks.yaml の store が同じ文面の普通の `Error` を投げる場合の試験で、型で見分ける今回の形でも分類されない。この試験は変えない。

### 4. 公開 API の非互換と扱い（親1 との比べ）

takt-dash（`j5ik2o/takt-dash` の main、`8fb0658`、2026-11-26 に読んだ）の呼び出しを確かめたうえで、次のように扱う。

| 非互換 | takt-dash の使い方 | 扱い |
|---|---|---|
| `TaskRunner.claimNextTasks` の第2・第3引数、`GoalTaskSetupGuard` の型 | 使わない（TaskRunner はリポジトリの中だけ） | 1節のとおり親1 の形に戻す。 |
| 旧4ツール `takt_list_goal_registration_proposals`、`takt_get_goal_registration_proposal`、`takt_approve_goal_registration`、`takt_reject_goal_registration` が無い（上流 #2083 で `*_goal_proposal*` に改名） | 本番のコード `backend/src/mcp/tools/goal_registration.rs` が4つとも呼ぶ。今のままでは `Tool not found` になり、ゴール登録案の一覧・本文・承認・却下が全部止まる。 | **旧名を別名として残す。** |
| 持ち主が違うときのエラーの文面が「does not own the pending registration proposal」から「does not own the pending goal proposal」に変わった | `backend/src/grpc/writes.rs:308` の `is_stale_registration` がこの文面で「登録案が作り直された」を見分ける。今のままでは、画面を読み込み直す案内が出ず、ただの書き込みの失敗になる。 | **親1 の文面に戻す。** |
| `takt_list_runtime_assignments` が `state` を拒否する（親1 は受け付けて使わなかった） | 呼ばない | 上流の形を取る（下に理由）。 |

旧名の別名の作り方:

- 4つの旧名を、新しい名前と同じ入力の schema、同じ処理でサーバーに登録する。入力の形（`cwd`・`conversationId`・`revision`・`path`・`textOffset` など）と応答の形（`proposals`・`proposal`・`fields`・`revision`）は、親1 と今の版で同じであることを確かめた（処理のファイルは名前の置き換えだけの差だった）。
- 登録する道具の組は親1 と同じにする（親1 の `server.ts` で確かめた）。一覧と本文は `read-only`・`manager`・`all` のすべて、承認と却下は既定の組（`toolSet` なしか `all`）だけ。takt-dash は既定（`all`）、常駐の HTTP サーバー、`--tool-set manager` の3通りでつなぎ、書き込み（承認・却下）は既定の組の stdio の子プロセスから送る。
- 旧名は `TAKT_MCP_READ_ONLY_TOOL_NAMES` と `TAKT_MCP_MANAGER_TOOL_NAMES` には入れず、別の一覧（`TAKT_MCP_DEPRECATED_ALIAS_TOOL_NAMES`）にする。この2つの一覧は、manager と task state のエージェントに渡す道具の許可にも使われる（`turnExecutor.ts`、`taskStateMcp.ts`）。エージェントには新しい名前だけを見せ、同じ道具が2つ並ばないようにする。許可リストを確かめる試験（`it-assistant-mcp-cli-args.test.ts` など）は、今の版のままで変えない。
- 旧名の description は「Deprecated alias of `takt_list_goal_proposals`. Kept for MCP clients written against the earlier name.」のように、新しい名前を指す。
- 持ち主が違うときの文面は、旧名・新名のどちらから呼んでも親1 の「The conversationId … does not own the pending registration proposal of …」にする。上流の試験はこの文面を確かめていない（上流の `goal-proposal-operations.test.ts` は 84 行で、この確かめは無い）。今の版の 833 行目の確かめは、親1 の試験を改名したときに書き換えたものなので、親1 の文面に戻す。

知らせと移り方:

- PR 本文に、「旧名の4つは別名として残す。新しい名前に移ってほしい」「`takt_list_runtime_assignments` は `state` を受け付けない」と書く。`docs/CHANGELOG.ja.md` は上流のファイルなので触らない（次の取り込みで競合する）。
- takt-dash へ、新しい名前に移ることと、持ち主の食い違いを文面ではなく安定したコードで見分けることの issue を出す（宛先と出すかどうかは元帥に聞く。今回は takt-dash には何も書かない）。
- 別名を消すのは、takt-dash が新しい名前に移って公開された後の、別の PR にする。この PR では消さない。

`state` について上流の形を取る理由: `state` はゴールの一覧（`takt_list_goals`）の絞り込みで、`takt_list_runtime_assignments` は親1 でも受け取って捨てていた。schema に載っていたのは、ゴールの一覧の schema から `errorOffset` だけを外して流用した結果で、意図した引数ではない。リポジトリの中（試験・builtins のプロンプト・docs）にも takt-dash にも、`state` を渡す呼び出しは無い。今の版では schema にも載らないので、schema を読むクライアント（LLM を含む）は渡さない。取り込みの決まり1は「不具合の直し」についての決まりで、これは意図しない引数を外す変更なので、上流に合わせて次の取り込みの競合を減らす。設計レビューで「残すべき」となれば、`omit({ errorOffset: true })` に戻すだけで済む。

### 範囲の外（変えていない）

- ロックの解放が書き込みの後で失敗する場合。生きている自分のプロセスが持ち主のロックが残り、以後 store に触れなくなる。claim の知らせとは別の壊れ方なので、別件にする。
- 1回目の読みで pending が無いときの ENOSPC（上流 #1857 の設計のまま、claim を止める）。
- claim の後にプロセスが死ぬ場合（今までどおり `failInterruptedRunningTasks` が拾う）。
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
2. テストは消さない・弱めない: 消えた試験は戻す。書き換えられた試験は親1 の形に戻し、書き換え後の試験が親1 より強いもの（`it-task-finish-hook.test.ts` の本物の claim を通す試験）は、別の試験として足す。期待を変える試験は1件だけで（`it-task-store-process-lock.test.ts`）、何も書かないことの確かめは残す。旧名の改名で書き換えられた試験（下の「改名で書き換えられた試験」）は、新しい名前の確かめとして残し、旧名の確かめを別に足す。
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
5. `noMissedSetupReport`: setup の失敗を書いた claim が終わったら、終了フックはちょうど1回出ている。完了の知らせは書けたか、書けなかったことがログに残っている。
6. `claimingNeverStops`: ロックの失敗と知らせの書き込みの失敗では、その run の claim は止まらない。
7. `noFalseCleanEnd`: `takt run` は、自分が running と書いたタスクが実行されないまま、正常に終わらない。

実装の側では、さらに次を守る。

- claim の再試行に回すのは、tasks.yaml にまだ何も書いていない失敗だけ。
- `claimTasksWithGoalCompletions` は `listTaskStateItems` を1回だけ呼ぶ。
- `claimNextTasks` の第2引数に匿名の関数は渡せない（型の契約テストで確かめる）。
- 親1 の MCP クライアントが呼んでいた4つの旧名は、同じ入力で同じ応答を返す。持ち主が違うときの文面は「does not own the pending registration proposal」を含む。
- エージェントに渡す道具の許可リストには、旧名を入れない。

## Quint

`specs/quint/goal-task-claim/`（`goalTaskClaim.qnt`、`goalTaskClaim_test.qnt`、`README.md`）。同じモデルの `DESIGN` を `Merged`（`d2bd16a30`）、`ForkP1`（PR #50 のまま）、`Fixed`（この設計）に切り替えて比べる。プロセス2つ、タスク3つ（実行できるもの1つ、setup の失敗になるもの2つ、うち1つは途中で足される）。各プロセスは `takt run` として、`runWithWorkerPool` の終わりの条件（実行中が無い、`claimRetryAt` が無い、キューが空、claim を試した後）で正常に終われる（`endRun`）。`takt watch` は終わらないので、`noOrphanRunning` だけが当たる。MCP の別名は状態遷移ではないので、Quint には入れず、試験で確かめる。

| 検査 | 結果 |
|---|---|
| `quint run`（各不変条件 × 各設計、3,000 標本、12 ステップ、seed 0x2a） | `merged` は `noOrphanRunning`・`noDuplicateSetupReport`・`noMissedSetupReport`・`claimingNeverStops`・`noFalseCleanEnd` が破れる。`forkP1` は `noOrphanRunning`・`noMissedSetupReport`・`claimingNeverStops` が破れる（`noFalseCleanEnd` は、取り残す経路で claim も止まり、正常ではなく失敗で終わるので破れない）。`fixed` は7つとも違反なし。 |
| `quint run --main fixed --invariant safety`（10,000 標本、15 ステップ、witness 9つ） | 違反なし。witness はすべて到達（最少は `wOtherProcReported` の 1,895 本、`takt run` が正常に終わる `wRunEnded` は 5,119 本、タスクを実行してから終わる `wRunEndedAfterWork` は 2,822 本）。15 ステップより短い跡は、2つのプロセスがどちらも終わった状態で、設計どおりの終わり。 |
| `quint verify --main fixed --invariant safety --max-steps 8` | 違反なし（87 秒）。 |
| `quint test` | `mergedTest` 6件、`forkP1Test` 3件、`fixedTest` 9件、すべて通る。`mergedTest.rereadTimeoutEndsRunAsCleanTest` が、afterClaim の失敗の後に `takt run` が running を残して正常に終わる跡。`fixedTest.runDoesNotEndWithQueuedTaskTest`・`runDoesNotEndWhileRetryingTest` は、キューにタスクがあるときと再試行を待っているときに終われないことを確かめる。 |

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
- `mcpSchemas.test.ts`（schema 名）、`mcp-entrypoint.test.ts`・`it-goal-mcp-stdio.test.ts`・`runtime-mcp.integration.test.ts`（道具名の一覧）
- `it-assistant-mcp-cli-args.test.ts`・`it-conversation-task-state-mcp.test.ts`・`it-opencode-task-state-mcp.test.ts`・`it-opencode-v2-assistant-mcp.test.ts`（エージェントに渡す道具の許可リスト。旧名を入れないので、このままが正しい）
- `manager-conversation-client.integration.test.ts`・`manager-conversation-turn-service.test.ts`（関数名と試験の名前の「registration proposal」→「goal proposal」）

### 書き換える試験（1件）

- `src/__tests__/it-task-store-process-lock.test.ts`「does not convert another process holding the goal-execution lock into a recoverable claim timeout」: 期待を逆にする。別のプロセスが `goal-execution.lock` を持っているとき、claim は `TaskClaimLockAcquisitionError`（`code: 'TIMEOUT'`）を投げ、タスクは pending のまま、`tasks.yaml.lock` は残らない。理由は上の3節（Medium の直し）。書き込みが無いこと（pending のまま・ロックが残らない）の確かめは、そのまま残す。

### 足す回帰テスト（直す前に `d2bd16a30` で落ちるのを確かめる）

1. Critical: 本物の `TaskRunner`（一時ディレクトリ）で、`claimNextTasks` の後の `listTaskStateItems` がロックの時間切れ（`File lock: timed out waiting for lock`）を投げるようにする。`claimTasksWithGoalCompletions` が claim したタスクを返すこと、tasks.yaml の running のタスクが戻り値に入っていることを確かめる。ENOSPC（`PrivateFileLockAcquisitionError` の `ENOSPC`）でも同じものを1件。`d2bd16a30` では `TaskClaimLockUnavailableError` が投げられて落ちる。
2. High 2a: 同じディレクトリの `TaskRunner` を2つ使い、A の1回目の読みと A の claim の間に、B の claim を入れる（A の `claimNextTasks` に spy を付け、本物を呼ぶ前に B を動かす）。setup の失敗を知らせるのは B だけで、`saveManagerEvent` は1回。
3. High 2b: A の1回目の読みと A の claim の間に、setup の失敗になるゴールのタスクを足す。A の `setupFailedTaskNames` にそのタスクが入る。
4. 知らせの書き込みの失敗: `saveManagerEvent` が投げても、claim したタスクが返り、`setupFailedTaskNames` に名前が入り、警告が出る。
5. Medium: `withGoalExecutionLock` が `PrivateFileLockTimeoutError` を投げると、`claimNextTasks` は `TaskClaimLockAcquisitionError('TIMEOUT')` を投げる（ユニット）。上の書き換える試験（heavy IT）も直す前に落ちる。
6. Critical の続き（`takt run` の誤った正常終了）: 本物の `TaskRunner` と `runWithWorkerPool(..., 'run')` で、pending のタスク1つを置き、claim の後の1回目の `listTaskStateItems` だけを時間切れにする（実行は stub）。結果が `success 1`・`executedTaskNames` にそのタスク、tasks.yaml で `completed` になることを確かめる。`d2bd16a30` では `{ success: 0, fail: 0, executedTaskNames: [] }` で終わり、tasks.yaml に running が残って落ちる（レビューの実物での再現と同じ条件）。待ちは `CLAIM_RETRY_INTERVAL_MS`（5秒）を1回含むので、heavy IT に置く。
7. MCP の旧名: `listTools()` で、`all`・`read-only`・`manager` の各組に親1 と同じ旧名が出ること（一覧と本文は3つとも、承認と却下は `all` だけ）。旧名と新名を同じ入力で呼んで同じ応答になること（一覧・本文・承認・却下。承認と却下は、既存の `goal-proposal-operations.test.ts` の会話の stub を使う）。持ち主が違うとき、旧名・新名のどちらでも文面に「does not own the pending registration proposal」が入ること。`TAKT_MCP_READ_ONLY_TOOL_NAMES`・`TAKT_MCP_MANAGER_TOOL_NAMES` に旧名が入っていないこと。`d2bd16a30` では旧名が無いので落ちる。

### 性質の試験（PBT）

このブランチには fast-check が無い（#160 の revert で外れた）ので、全部の組み合わせを流す表の試験にする（light IT、本物の `TaskRunner` を一時ディレクトリで2つ）。

- 入力の集合: A の2手（1回目の読み・claim）と B の2手と「タスクを足す」1手の、各プロセスの順序を保った並べ方すべて（30 通り）× 失敗の入れ方 {なし, A の claim の後の読みが時間切れ, `saveManagerEvent` が投げる, A の `goal-execution.lock` が時間切れ}（4 通り）= 120 通り。タスクは、実行できるもの1つ、setup の失敗になるもの1つ、途中で足すもの（setup の失敗になる）1つ。
- 性質: (a) tasks.yaml で running のタスクは、ちょうど1つのプロセスの戻り値に入っている（戻り値がキューに入るので、`takt run` の正常な終わりは、そのタスクを実行した後にしか来ない。終わりそのものは上の回帰テスト6で確かめる）。(b) setup の失敗として failed になったタスクは、2つのプロセスの `setupFailedTaskNames` を合わせてちょうど1回出る。(c) `saveManagerEvent` の呼び出しと、書き込みの失敗のログを合わせて、そのタスクについてちょうど1回。(d) setup の失敗でないタスクは知らせない。(e) 失敗を入れた手が投げたなら、それは `TaskClaimLockUnavailableError` で、そのとき tasks.yaml は手の前と同じ。
- 除外: ロックの解放の失敗とプロセスの死（範囲の外。後者は `failInterruptedRunningTasks` の既存の試験が確かめる）。
- `d2bd16a30` では (a)(b) が落ちる組み合わせがあるはず。直す前に流して、落ちる組み合わせの数を報告に残す。

## 壊しうる入力

- 境界: `count` より pending が多い／少ない、`count = 0`、pending が0件、claim するタスクも setup の失敗も無い回。
- 並行: 2つのプロセスが同じ pending を読む（2a）、読みと claim の間にタスクが足される（2b）、読みと claim の間にほかのプロセスがタスクを消す（`deletion` の印。`claimNextTasks` が飛ばす）。
- 失敗の場所: 1回目の読み（時間切れ・ENOSPC）、`goal-execution.lock` の取得（時間切れ・ENOSPC）、`tasks.yaml.lock` の取得（時間切れ・ENOSPC）、tasks.yaml の書き込み（ENOSPC。書けなければ何も変わらない）、`saveManagerEvent`（ENOSPC・goal.json が読めない）、ロックの解放（範囲の外）。
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

## 進め方と残り

1. この設計と Quint を設計レビューに出す（今ここ）。判断してほしい点: `goal-execution.lock` の時間切れを再試行に入れること（3節）、`state` を上流の形にすること（4節）、MCP の旧名を別の一覧にしてエージェントには見せないこと（4節）、ロックの解放の失敗を別件にすること（範囲の外）。
2. 通ったら、試験を戻し、回帰テストと表の試験を足し、`d2bd16a30` で落ちるのを確かめて、その出力を残す。
3. 直す。PR #168 は今 `integration/takt-mcp` と競合している（#164・#167 が先に入った）。直した後に `integration/takt-mcp` を枝へマージして解く（force-push はしない）。
4. 競合を解いた箇所の一覧と、戻した・書き換えた試験の理由、MCP の非互換の知らせを PR 本文に書く。CI・Quint・レビューボットで確かめる。
5. takt-dash への issue（新しい名前に移る、食い違いを文面ではなくコードで見分ける）は、出すかどうかと宛先を元帥に聞く。

大きさ: 8。前の見積もり（5）に、MCP の旧名4つの別名と文面の戻し、その試験、`takt run` の終わり方の heavy IT が加わった。直すコードは claim の4ファイル、lock の1ファイル、MCP の2ファイル（`server.ts`・`goalProposalOperations.ts`）と小さいが、戻す試験6件、書き換え1件、回帰テスト7種、120 通りの表の試験、`integration/takt-mcp` との競合の解消がある。

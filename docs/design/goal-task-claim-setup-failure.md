# 上流の取り込み（#168）で戻った、claim の setup の失敗の知らせ方を直す（項目201）

PR: https://github.com/j5ik2o/takt/pull/168 ／ 枝 `sync/upstream-main-20261125`（先端 `d2bd16a30`）に追加コミットで直す。

レビュー: `~/.orca/bots/sub-marshal/audit/takt-168-merge-review/REPORT.md`（結論「だめ」）。

Quint: `specs/quint/goal-task-claim/`。

## 何が起きているか

取り込みのマージ `d2bd16a30` は、`claimTasks.ts` の競合を上流 #2084 の形で解いた。claim の後に `listTaskStateItems()` で tasks.yaml を読み直し（`afterClaim`）、1回目に読んだ pending と突き合わせて setup の失敗を探す形である。フォーク側 PR #50（`bddbe7b66`）の `GoalTaskSetupGuard` と `onSetupFailed` は落ちた。さらに、フォーク側の時間切れの再試行（#91）に合わせて、`claimNextTasks` と `afterClaim` を同じ `try` に入れた。

このため次のことが起きる（Quint の反例と、レビューの実物での再現の両方で確かめた）。

| 重さ | 何が起きるか | Quint の反例 |
|---|---|---|
| Critical | `claimNextTasks` が running を書いた後、`afterClaim` がロックの時間切れか ENOSPC で失敗すると、`catch` が再試行できる失敗として投げ直し、claim したタスクがキューに入らない。持ち主は生きている自分のプロセスなので、以後どの経路でも拾われない。同じ回の setup の失敗の知らせも消える。 | `mergedTest.rereadTimeoutOrphansClaimedTaskTest`、`orphanIsNotReclaimedTest` |
| High（2a） | 2つのプロセスが同じ pending を読み、B の claim が setup の失敗を書くと、A の読み直しもそれを自分の失敗として知らせる。完了の知らせ・終了フック・`failCount` が2回出る。 | `mergedTest.duplicateReportTest` |
| High（2b） | 1回目の読みの後に足されたゴールのタスクを自分の claim が setup の失敗にしても、1回目の pending に無いので知らせない。 | `mergedTest.lateTaskReportMissedTest` |
| High | 公開のポート `GoalTaskSetupGuard`、型の契約テスト、`onSetupFailed` と「`listTaskStateItems` は1回だけ」を確かめる試験が、消えたか上流の形に書き換えられた。 | — |
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

### 範囲の外（変えていない）

- ロックの解放が書き込みの後で失敗する場合。生きている自分のプロセスが持ち主のロックが残り、以後 store に触れなくなる。claim の知らせとは別の壊れ方なので、別件にする。
- 1回目の読みで pending が無いときの ENOSPC（上流 #1857 の設計のまま、claim を止める）。
- claim の後にプロセスが死ぬ場合（今までどおり `failInterruptedRunningTasks` が拾う）。
- 対象1（秘密を伏せる処理）と対象2（保存済みのデータ）。レビューで問題なしとされた。

## 守る不変条件

Quint の `safety` は次の6つの連言で、`fixed` で違反が無い。

1. `noOrphanRunning`: running と書いたタスクは、必ず持ち主のキューに入る。入るまでの間は、同じ呼び出しの中にある。
2. `queuedByOwnerOnly`: タスクをキューに入れるのは、claim したプロセスだけ。
3. `noDuplicateSetupReport`: setup の失敗の終了フックと完了の知らせは、それぞれ多くとも1回。
4. `noFalseSetupReport`: 知らせるのは、claim が setup の失敗として書いたタスクだけ。
5. `noMissedSetupReport`: setup の失敗を書いた claim が終わったら、終了フックはちょうど1回出ている。完了の知らせは書けたか、書けなかったことがログに残っている。
6. `claimingNeverStops`: ロックの失敗と知らせの書き込みの失敗では、その run の claim は止まらない。

実装の側では、さらに次を守る。

- claim の再試行に回すのは、tasks.yaml にまだ何も書いていない失敗だけ。
- `claimTasksWithGoalCompletions` は `listTaskStateItems` を1回だけ呼ぶ。
- `claimNextTasks` の第2引数に匿名の関数は渡せない（型の契約テストで確かめる）。

## Quint

`specs/quint/goal-task-claim/`（`goalTaskClaim.qnt`、`goalTaskClaim_test.qnt`、`README.md`）。同じモデルの `DESIGN` を `Merged`（`d2bd16a30`）、`ForkP1`（PR #50 のまま）、`Fixed`（この設計）に切り替えて比べる。プロセス2つ、タスク3つ（実行できるもの1つ、setup の失敗になるもの2つ、うち1つは途中で足される）。

| 検査 | 結果 |
|---|---|
| `quint run`（各不変条件 × 各設計、3,000 標本、12 ステップ、seed 0x2a） | `merged` は `noOrphanRunning`・`noDuplicateSetupReport`・`noMissedSetupReport`・`claimingNeverStops` が破れる。`forkP1` は `noOrphanRunning`・`noMissedSetupReport`・`claimingNeverStops` が破れる。`fixed` は6つとも違反なし。 |
| `quint run --main fixed --invariant safety`（10,000 標本、15 ステップ、witness 7つ） | 違反なし。witness はすべて到達（最少は `wOtherProcReported` の 1,900 本）。 |
| `quint verify --main fixed --invariant safety --max-steps 8` | 違反なし（107 秒）。 |
| `quint test` | `mergedTest` 5件、`forkP1Test` 3件、`fixedTest` 6件、すべて通る。 |

## 試験

### 戻す試験（取り込みで消えたか、書き換えられたもの）

| ファイル | 何をしたか | 戻し方 |
|---|---|---|
| `src/__tests__/type-contracts/goal-task-setup-guard.ts` | 消えた | `337062193` の内容に戻す。 |
| `src/__tests__/manager-task-events.test.ts`「publishes task setup failures once when claiming changes their state」 | 上流の形（`claimNextTasks` の後の状態を読み直す mock）に書き換えられ、`listTaskStateItems` が1回だけであることと `onSetupFailed` の確かめが消えた | `337062193` の形に戻す。上流のこの試験は読み直しの形を前提にしているので、置き換える。 |
| `src/__tests__/it-task-finish-hook.test.ts`（418〜431 行） | `onSetupFailed` を通す mock の試験が、`runtime_assignment: 'gone'` で本物の claim を通す試験に書き換えられた | `337062193` の試験を戻す。書き換え後の試験も本物の経路を通す点で強いので、別の試験として残す（このファイルは上流に無く、フォーク側のもの）。 |
| `src/__tests__/workerPool.test.ts`「claim で失敗として保存されたゴールのタスクを run の失敗に数える」 | `onSetupFailed` を呼ぶ mock が、読み直しの結果を変える mock に書き換えられた | `337062193` の形に戻す。 |
| `src/__tests__/daemon-storage.integration.test.ts`「restores legacy summary approvals and dismissals saved without a conversation id」 | 消えた（上流 #2060 のもの） | 上流 `5d7581a85` の内容を戻す。 |

### 書き換える試験（1件）

- `src/__tests__/it-task-store-process-lock.test.ts`「does not convert another process holding the goal-execution lock into a recoverable claim timeout」: 期待を逆にする。別のプロセスが `goal-execution.lock` を持っているとき、claim は `TaskClaimLockAcquisitionError`（`code: 'TIMEOUT'`）を投げ、タスクは pending のまま、`tasks.yaml.lock` は残らない。理由は上の3節（Medium の直し）。書き込みが無いこと（pending のまま・ロックが残らない）の確かめは、そのまま残す。

### 足す回帰テスト（直す前に `d2bd16a30` で落ちるのを確かめる）

1. Critical: 本物の `TaskRunner`（一時ディレクトリ）で、`claimNextTasks` の後の `listTaskStateItems` がロックの時間切れ（`File lock: timed out waiting for lock`）を投げるようにする。`claimTasksWithGoalCompletions` が claim したタスクを返すこと、tasks.yaml の running のタスクが戻り値に入っていることを確かめる。ENOSPC（`PrivateFileLockAcquisitionError` の `ENOSPC`）でも同じものを1件。`d2bd16a30` では `TaskClaimLockUnavailableError` が投げられて落ちる。
2. High 2a: 同じディレクトリの `TaskRunner` を2つ使い、A の1回目の読みと A の claim の間に、B の claim を入れる（A の `claimNextTasks` に spy を付け、本物を呼ぶ前に B を動かす）。setup の失敗を知らせるのは B だけで、`saveManagerEvent` は1回。
3. High 2b: A の1回目の読みと A の claim の間に、setup の失敗になるゴールのタスクを足す。A の `setupFailedTaskNames` にそのタスクが入る。
4. 知らせの書き込みの失敗: `saveManagerEvent` が投げても、claim したタスクが返り、`setupFailedTaskNames` に名前が入り、警告が出る。
5. Medium: `withGoalExecutionLock` が `PrivateFileLockTimeoutError` を投げると、`claimNextTasks` は `TaskClaimLockAcquisitionError('TIMEOUT')` を投げる（ユニット）。上の書き換える試験（heavy IT）も直す前に落ちる。

### 性質の試験（PBT）

このブランチには fast-check が無い（#160 の revert で外れた）ので、全部の組み合わせを流す表の試験にする（light IT、本物の `TaskRunner` を一時ディレクトリで2つ）。

- 入力の集合: A の2手（1回目の読み・claim）と B の2手と「タスクを足す」1手の、各プロセスの順序を保った並べ方すべて（30 通り）× 失敗の入れ方 {なし, A の claim の後の読みが時間切れ, `saveManagerEvent` が投げる, A の `goal-execution.lock` が時間切れ}（4 通り）= 120 通り。タスクは、実行できるもの1つ、setup の失敗になるもの1つ、途中で足すもの（setup の失敗になる）1つ。
- 性質: (a) tasks.yaml で running のタスクは、ちょうど1つのプロセスの戻り値に入っている。(b) setup の失敗として failed になったタスクは、2つのプロセスの `setupFailedTaskNames` を合わせてちょうど1回出る。(c) `saveManagerEvent` の呼び出しと、書き込みの失敗のログを合わせて、そのタスクについてちょうど1回。(d) setup の失敗でないタスクは知らせない。(e) 失敗を入れた手が投げたなら、それは `TaskClaimLockUnavailableError` で、そのとき tasks.yaml は手の前と同じ。
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

## 影響

- 上流（nrslib/takt）: 何も流さない。上流の `claimNextTasks(count, fn)` の形とは違うままなので、次の取り込みでも同じ場所が競合する。そのときは、この設計と Quint の仕様を見て解く。
- 保存済みのデータ: tasks.yaml・manager の inbox の形式は変えない。setup の失敗のレコードは今までどおり `buildSetupFailedTaskRecord` で作る。
- 公開 API: `TaskRunner.claimNextTasks` の形を PR #50 の形に戻す。`GoalTaskSetupGuard` の型を `infra/task/index.ts` から出す。`PrivateFileLockTimeoutError` を足す（文面は変えない）。リポジトリの外の呼び出し元は無い。
- 守りの仕組み: claim の再試行の対象に `goal-execution.lock` の時間切れが加わる。何も書いていない失敗だけを再試行する、という条件は変えない。ロックの順序（`goal.json.lock` → `goal-execution.lock` → `tasks.yaml.lock`）は変えない。

## 進め方と残り

1. この設計と Quint を副元帥の設計レビューに出す（今ここ）。
2. 通ったら、試験を戻し、回帰テストと表の試験を足し、`d2bd16a30` で落ちるのを確かめて、その出力を残す。
3. 直す。PR #168 は今 `integration/takt-mcp` と競合している（#164・#167 が先に入った）。直した後に `integration/takt-mcp` を枝へマージして解く（force-push はしない）。
4. 競合を解いた箇所の一覧と、戻した・書き換えた試験の理由を PR 本文に書く。CI・Quint・レビューボットで確かめる。

大きさ: 5。直すのは claim の4ファイルと lock の1ファイルで小さいが、戻す試験5件、書き換え1件、回帰テスト5種、120 通りの表の試験、`integration/takt-mcp` との競合の解消がある。

# #193 に入れる worker pool の直しの頼み（試験と本番）

[#193](https://github.com/j5ik2o/takt/pull/193) に入れる 3 つの設計の、試験（Sonnet）と本番（muse）への頼みを 1 件 1 行で並べる。設計の中身と理由は、各設計の文書にある。

- #195・#196・#197：`docs/design/worker-pool-completion-publication.md`
- #209：`docs/design/worker-pool-local-resume-routing.md`
- #211：`docs/design/worker-token-source.md`

試験の決まり（3 つに共通）：

- 新しい試験のファイルは `tsconfig.tests.json` に足す。`it-*.test.ts` は heavy の並列 IT になるので、足したら `releaseVerificationWiring.test.ts` を単独で流し、その IT も単独で流す。
- 既存の試験は、S5・S6 の 2 件を除いて変えない。S5・S6 は元帥の決定（11/28）で期待を変える。名前と意図を「失敗しても外へ投げず、印が付き、出し直される」に改め、今ある assert は厳密なまま残し、新しい期待の assert を足す。
- 作り物の秘密や token は、実行時に部品をつないで作る（`Zq` + 数字 + `Zq`、`EXAMPLE_NOT_A_VALID_TOKEN` + 乱数）。

## #195・#196・#197（試験）

新しい試験は `src/__tests__/it-worker-pool-completion-publication.test.ts` に置く。fixture は `it-worker-pool-runtime.test.ts`（`order.md` を消したゴールタスク、403 行の群の `'failed claim'` の起こし方、`vi.mock('../infra/goals/events.js')`）と `worker-pool-remote-task.test.ts`（遠隔の claim）と同じ形を使う。

| # | ファイル | 試験の名前 | 何を確かめるか | 本番のどこを外せば落ちるか |
|---|---|---|---|---|
| S1 | `it-worker-pool-completion-publication.test.ts` | `marks an unreadable goal task failure for resend when the worker pool notification hits ENOSPC` | `saveManagerEvent` を 1 回 ENOSPC にして `runtime.start(name, 'builtin')`。保存は `failed` で `completion_publication_pending: true`、`readPendingGoalTaskCompletions(cwd)` がその 1 件を返す | M1（`buildUnreadableGoalTask` の印） |
| S2 | 同上 | `marks a remote terminal record for resend when its manager notification fails` | 遠隔の claim のあと `request({ kind: 'fail', ... })` を `saveManagerEvent` が投げる状態で呼ぶ。保存に印が付き、`readPendingGoalTaskCompletions` がそれを返す | M6（遠隔の終わりの印） |
| S3 | 同上 | `clears the completion mark after the worker pool notifies a failed claim` | claim の setup 失敗のあと、保存に印が無い。`readManagerEvents(cwd)` は 1 件、`readPendingGoalTaskCompletions` は空 | M5（`publishSetupFailure` を通す置き換え） |
| S4 | 同上 | `calls the task finish hook exactly once for each worker pool terminal save` を `it.each(['unreadable task', 'failed claim', 'remote finish', 'remote fail', 'builtin completion'])` | フックのファイル（`it-lock-release-finish-hook.test.ts:79` と同じ `task_finish_hook: { command: [process.execPath, script, out] }`）にタスク名がちょうど 1 回書かれる。遠隔の 2 行は、同じ `finish` / `fail` をもう一度送ったあとも 1 回のまま | M5（ローカルのフック）、M6（`onTerminal` の呼び出し。外すと遠隔の 2 行が 0 回で落ちる）。2 回呼ぶ変更でも落ちる |
| S5 | `src/__tests__/worker-pool-runtime.test.ts`（既存を改める） | 「propagates %s completion notification failures outside acquisition retry」を「keeps a %s completion notification failure inside the runtime so its marked record is resent」に改める（`it.each(['recheck', 'claim'])` はそのまま） | 今の `doubles.event` の `toHaveBeenCalledExactlyOnceWith(...)`、`execute` と `finished` が呼ばれないことの assert は残す。`rejects.toBe(failure)` を `resolves.toEqual({ kind: 'declined' })` に替え、`claim_retry` を返さないこと、runtime の `failed` が呼ばれないこと、警告の 1 行にタスク名があること、印のある `saved`（fixture に `completionPublicationPending: true` を足す）の印を消しに行かないこと（`clearCompletionPublicationPending` が呼ばれない）を足す | M5（捕まえる `try/catch`） |
| S6 | 同上（既存を改める） | 「rechecks unreadable remote input after the claim and publishes the saved terminal result」の後半を「... and keeps a failed notification inside the runtime so its marked record is resent」に改める | 前半の assert は残す。後半の `await expect(runtime.remote(claim)).rejects.toBe(failure)` を `resolves.toEqual({ kind: 'claim', assignment: null })` に替え、`doubles.event` がもう 1 回呼ばれたことと警告の 1 行を足す。そのあとの「Git or storage failed」で reject する assert は残す（通知でない失敗は今までどおり外へ出る） | M5 |
| S7 | `it-worker-pool-completion-publication.test.ts` | `keeps A running when a worker pool setup failure notification hits ENOSPC` を `it.each(['unreadable task', 'failed claim'])` | `TaskDispatcher` で A を走らせたまま、B の失敗の通知を ENOSPC にする。A の `signal.aborted` は偽、host の `close` は呼ばれない、B は `failed` で印が付く。警告の 1 行に B の名前がある | M5（`try/catch`） |
| S8 | 同上 | `keeps the remote request result when its manager notification fails` | S2 と同じ状態で、`request()` が保存した記録の返事を返す（reject しない）。警告の 1 行にタスク名がある | M6（`try/catch`） |

## #195・#196・#197（本番）

| # | ファイル | 関数 | 変えること |
|---|---|---|---|
| M1 | `src/infra/task/taskLifecycleService.ts` | `buildUnreadableGoalTask` | `completion_publication_pending: true` を足す |
| M2 | 同上 | `clearCompletionPublicationPending` | 本体を `(store, taskName, identity)` の関数に切り出し、メソッドはそれを呼ぶ |
| M3 | `src/infra/task/goalCompletionPublication.ts`（新規） | `publishGoalCompletion`、`publishAndClearPendingMark` | `claimTasks.ts:83-112` から移す。印を消す関数を引数で受け取る |
| M4 | `src/features/tasks/execute/claimTasks.ts` | `publishSetupFailure`、`failInterruptedTasksWithGoalEvents` | M3 を呼ぶ。`publishSetupFailure` を export する。文面と振る舞いは変えない |
| M5 | `src/features/workerPool/builtinProjectRuntime.ts` | `saveCompletion`、`remote`、`startTask`、コンストラクタ | `saveCompletion` を `publishSetupFailure` + `await runTaskFinishHooksForStates(this.cwd, [task])` にし、呼び出し側で `await` する。`RemoteTaskLifecycle` に `onTerminal` として `(task) => runTaskFinishHooksForStates(this.cwd, [task])` を渡す |
| M6 | `src/infra/task/remoteTaskLifecycle.ts` | コンストラクタ、`request` | 4 つめの省ける引数 `onTerminal?: (task: TaskState) => Promise<void>` を足す。終わりの記録に印を足し、通知を M3 + `try/catch` の警告にし、新しく保存したときだけ `onTerminal` を 1 回呼ぶ |
| M7 | 遠隔の記録を `pending` に戻す書き込み | （洗う） | `buildRetryTaskRecord` を通るか、通らないなら印を外すことを確かめる |
| M8 | `docs/worker-pool.md`（ja・zh-CN も） | — | 通知が失敗しても印から出し直されることを 1 文足す |

## #209（試験）

新しい試験は `src/__tests__/worker-pool-local-resume-routing.test.ts`（単体）に置く。

| # | ファイル | 試験の名前 | 何を確かめるか | 本番のどこを外せば落ちるか |
|---|---|---|---|---|
| S9 | `worker-pool-local-resume-routing.test.ts` | `keeps a local resume retry off remote workers in the pool schedule` | `scheduleWorkerPool` に `builtinOnly: true` のタスクと遠隔の worker（`origin` あり）だけを渡すと割り当てが空。組み込みの worker を足すと組み込みに割り当たる | M11（`eligible` の `builtinOnly`） |
| S10 | 同上 | `marks a pending retry that resumes a local run as builtin only` を `it.each(['source_run_slug', 'start_step', 'resume_point'])` | `remote_assignment` が無く、その欄を持つ `pending` のゴールタスクで `inspect()` を呼ぶと、返るタスクに `builtinOnly: true` があり `remoteOnly` が無い。`remote_assignment` を持つ再試行には `builtinOnly` が無い | M9・M12（`resumesLocalRun` と `inspect` の付与） |
| S11 | 同上 | `does not assign a local resume retry to a remote claim` | `source_run_slug` と `resume_mode` を持ち `remote_assignment` の無い `pending` の記録に遠隔の claim を送ると `{ kind: 'claim', assignment: null }`。記録は `pending` のまま `remote_assignment` が付かない | M13（claim の判定） |
| S12 | 同上 | `explains that a local resume retry waits for the builtin worker when its concurrency is 0` | `workerPoolAvailability` に `builtinOnly: true` のタスクと、concurrency 0 の組み込み + 遠隔の worker を渡すと、`reason` が `BUILTIN_RESUME_WAITING_REASON` と同じ文。`builtinOnly` でないタスクは今の「No executable worker is available ...」のまま | M11（理由の文） |
| S13 | 同上 | `shows and warns once that a local resume retry waits for the builtin worker` | `BuiltinProjectRuntime.setWaitingReasons` に、そのタスクと `BUILTIN_RESUME_WAITING_REASON` を 2 回渡す。`tasks.yaml` の記録の `waiting_reason` がその文になり、警告の 1 行（タスク名と `daemon.builtin_worker.concurrency` を含む）がちょうど 1 回出る | M12（警告と、1 回にする覚え） |

## #209（本番）

| # | ファイル | 関数 | 変えること |
|---|---|---|---|
| M9 | `src/infra/task/taskRecordMutations.ts`（または同じ層の小さなモジュール） | `resumesLocalRun`（新規） | `remote_assignment` が無く、6 つの欄のどれかを持つ |
| M10 | `src/core/worker-pool/types.ts` | `PoolTask` | `builtinOnly?: boolean` を足す |
| M11 | `src/core/worker-pool/scheduler.ts` | `workerPoolAvailability` | `eligible` を `(!task.mergeTask && !task.builtinOnly \|\| worker.kind === 'builtin')` にし、`builtinOnly` で候補が空なら `BUILTIN_RESUME_WAITING_REASON` を返す |
| M12 | `src/features/workerPool/builtinProjectRuntime.ts` | `inspect`、`setWaitingReasons` | `resumesLocalRun` のタスクに `builtinOnly: true` を付ける。理由が `BUILTIN_RESUME_WAITING_REASON` になったタスクに、runtime ごとに 1 回警告する |
| M13 | `src/infra/task/remoteTaskLifecycle.ts` | `claim` | `merge_task` と並べて `resumesLocalRun(record)` なら割り当てを返さない |
| M14 | `docs/worker-pool.md`（ja・zh-CN も） | — | 「Verification and operational limits」の枠 0 の段落に、元の run から再開する再試行も進まないことと、待ちの理由の文を足す |

## #211（試験）

R1〜R4 にあたる S14〜S17 は実際の子プロセスを起動するので `src/__tests__/it-worker-token-source.test.ts`（heavy の並列 IT）に置く。S18 は単体。

| # | ファイル | 試験の名前 | 何を確かめるか | 本番のどこを外せば落ちるか |
|---|---|---|---|---|
| S14 | `it-worker-token-source.test.ts` | `keeps the worker token out of the started process arguments` を `it.each(['TAKT_WORKER_TOKEN', '--token-file'])` | `bin/takt worker --url http://127.0.0.1:<port>` を、試験が立てて接続を保留する HTTP サーバーへ向けて起動する。サーバーが接続を受けたあと、起動したプロセスの引数（Linux は `/proc/<pid>/cmdline`、macOS は `ps -o args= -p <pid>`）に token の値が無く、サーバーが受けた `Authorization` は `Bearer <token>` | M15・M16（環境変数とファイルを読まないと起動が止まり、接続が来ない） |
| S15 | 同上 | `warns that --token is visible to ps and still connects` | `--token` で起動すると接続が来て、stderr に `--token` の警告の 1 行がある。stderr にも stdout にも token の値が無い | M16（警告） |
| S16 | 同上 | `refuses a token file that group or others can read` | 権限 644 のファイルで起動すると、接続の前に 0 以外の終了コードで終わる。stderr にパスと `644` があり、ファイルの中身が無い（Windows では飛ばす） | M15（権限の確かめ） |
| S17 | 同上 | `stops when the worker token is given in more than one way and names only the ways` を `it.each` で `TAKT_WORKER_TOKEN` + `--token-file`、`--token-file` + `--token`、3 つとも | 接続の前に 0 以外で終わる。stderr の 1 行に、重なった渡し方の名前がその順で並ぶ（例「(TAKT_WORKER_TOKEN, --token-file)」）。stderr にも stdout にも、どの token の値も、ファイルのパスも無い（渡す値は渡し方ごとに別の値にする） | M15（重なりの判定と文） |
| S18 | `src/__tests__/worker-token-source.test.ts`（単体） | `keeps the worker token out of task process arguments and environment` | `TAKT_WORKER_TOKEN` で `startWorker` を呼んだとき、`createRemoteTaskExecutor` に渡す環境に token の値を持つ変数が無く、`spawnManagedProcess` の引数にも token が無い。今の本番でも通る守りの試験 | `workerCommands.ts:29` の値の除外。子の引数に token を足す変更 |

## #211（本番）

| # | ファイル | 関数 | 変えること |
|---|---|---|---|
| M15 | `src/features/workerPool/workerToken.ts`（新規） | `resolveWorkerToken` | 設計の 1〜3・5 節のとおりに 1 つの渡し方を選び、ファイルなら権限を確かめて読み、重なりなら渡し方の名前だけの文で止める |
| M16 | `src/app/cli/commands.ts:63-70` | `takt worker` | `--token-file <path>` を足し、`--url` だけを今の文で求め、token は M15 に任せる。警告を stderr に書く。説明文を直す |
| M17 | `docs/worker-pool.md:72-79`（ja・zh-CN も）、`docs/cli-reference.md:133`（ja・zh-CN も）、`docs/design/worker-pool.md:87` | — | 起動スクリプトと表を、`TAKT_WORKER_TOKEN` / `--token-file` の形に直す |

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
- 上流から入った「retains project ownership after an unsaved %s failure until cleanup finishes」（`it.each(['execution', 'completion notification'])`）から、`'completion notification'` の行を外し、新しい試験「keeps the runtime running when a completion notification fails and settles the task like a normal completion」に移した（8 番目のコミット、takt中将の答え）。`'execution'` の行は名前も assert もそのまま（`'completion notification'` のための分岐だけを消した）。
  - 外した行の元の assert：`saveManagerEvent` が `PrivateFileLockAcquisitionError('cannot notify completion', 'ENOSPC')` を投げ、実行は `{ runSlug: 'run-a', completion: { success: true, interrupted: false } }` で終わる。runtime の `failed` がその失敗でちょうど 1 回呼ばれ、`close()` の片付けが終わるまで `finished` は呼ばれず、所有（`release`）も手放さず、片付けのあとに `release` が 1 回。
  - 理由：元帥の段7 の決め（通常の完了の通知の失敗は外へ投げず、host を閉じない。設計の M18）。M18 は失敗を捕まえて `settled = true` にし `finished(taskName)` を呼ぶので、`finished` が呼ばれず所有を保つという元の期待は、この行では成り立たない。
  - 新しい試験の assert：`saveManagerEvent` は今と同じ引数でちょうど 1 回、`failed` は呼ばれない、`finished` はタスク名で 1 回、`release` は `close()` の前に 1 回（通常の完了と同じ）で `close()` のあとも 1 回のまま、タスク名・ゴールの id・`run_slug` を含む `[WARN]` の行が 1 行、失敗の文に混ぜた `api_token=` の作り物の値がどの警告の行にも無い。

## #209（S9〜S13）

### 足した試験

- S9 `worker-pool-local-resume-routing.test.ts` › keeps a local resume retry off remote workers in the pool schedule
- S10 同 › marks a pending retry that resumes a local run as builtin only: %s（source_run_slug / start_step / resume_point）
- S11 同 › does not assign a local resume retry to a remote claim
- S12 同 › explains that a local resume retry waits for the builtin worker when its concurrency is 0
- S13 同 › shows and warns once that a local resume retry waits for the builtin worker

`PoolTask.builtinOnly` と `BUILTIN_RESUME_WAITING_REASON` はまだ無いので、試験は import しない。`builtinOnly` は変数を経由して `PoolTask` に渡し、待ちの理由の文は設計の文字列をそのまま書き、S12 で `scheduler` の export がその文と同じであることを確かめる。tasks.yaml は `TaskStore.prototype` の `read` / `update` を手元の状態に向けて差し替え、実のファイルに触らない（単体の層のまま）。

### 直す前の本番で流した結果

7 件走り、7 件落ちた。

| 試験 | 落ちた理由（期待 → 実際） |
|---|---|
| S9 | 遠隔の worker だけのときの割り当てが空 → 遠隔の worker に 1 件割り当たる |
| S10 source_run_slug | `inspect()` の再試行のタスクに `builtinOnly: true` → 欄が無い |
| S10 start_step | 同上 |
| S10 resume_point | 同上 |
| S11 | 遠隔の claim が `{ kind: 'claim', assignment: null }` → 割り当てを返す |
| S12 | `scheduler` の `BUILTIN_RESUME_WAITING_REASON` が設計の文 → `undefined` |
| S13 | タスク名と `daemon.builtin_worker.concurrency` を含む `[WARN]` の行が 1 行 → 0 行（`waiting_reason` の書き込みは今も通る） |

### 本番のどこを外せば落ちるか

| 設計の行 | 当たる試験 |
|---|---|
| M9（`resumesLocalRun`） | S10（3 行）、S11 |
| M11（`eligible` の `builtinOnly`） | S9、S12（割り当てが遠隔に行く） |
| M11（理由の文） | S12 |
| M12（`inspect` の付与） | S10。`remote_assignment` のある再試行に `builtinOnly` を付けても S10 が落ちる |
| M12（警告と、1 回にする覚え） | S13（0 回でも 2 回でも落ちる） |
| M13（claim の判定） | S11 |

## #211（S14〜S18）

### 足した試験

- S14 `it-worker-token-source.test.ts` › keeps the worker token out of the started process arguments: %s（TAKT_WORKER_TOKEN / --token-file）
- S15 同 › warns that --token is visible to ps and still connects
- S16 同 › refuses a token file that group or others can read（Windows では飛ばす）
- S17 同 › stops when the worker token is given in more than one way and names only the ways: $named（(TAKT_WORKER_TOKEN, --token-file) / (--token-file, --token) / (TAKT_WORKER_TOKEN, --token-file, --token)）
- S18 `worker-token-source.test.ts`（単体） › keeps the worker token out of task process arguments and environment

S14〜S17 は `bin/takt`（`dist/` を読む）を起動するので、流す前に `npm run build` が要る。この記録は、3bcae5cc9 の src で build した `dist/` で流した。worker は接続の前に token の見出し（base64url の identity）を手元で読むので、作り物の token は `<見出し>.Zq<8 桁>Zq` を実行時に組み立てる。試験のサーバーは要求を返さずに保留し、そのあいだに起動したプロセスの引数（macOS は `ps -o args= -p <pid>`、Linux は `/proc/<pid>/cmdline`）を読む。この読み方が token を拾えることは、`--token` で起動したプロセスの引数に token が出ることで一度確かめた（試験の外）。

### 直す前の本番で流した結果

`it-worker-token-source.test.ts`：7 件走り、7 件落ちた。

| 試験 | 落ちた理由（期待 → 実際） |
|---|---|
| S14 TAKT_WORKER_TOKEN | サーバーに接続が来る → 接続の前に終わる（`--url and --token` を求めて止まる） |
| S14 --token-file | 同上（`error: unknown option '--token-file'`） |
| S15 | `--token` と `ps` を含む stderr の行が 1 行 → 0 行（接続は来る） |
| S16 | stderr にファイルのパスと `644` → `error: unknown option '--token-file'` だけ |
| S17 (TAKT_WORKER_TOKEN, --token-file) | stderr に重なった渡し方の名前の行が 1 行 → 0 行（`unknown option` で止まる） |
| S17 (--token-file, --token) | 同上 |
| S17 (TAKT_WORKER_TOKEN, --token-file, --token) | 同上 |

`worker-token-source.test.ts`（S18）：1 件走り、緑。設計のとおり今の本番でも通る守りの試験で、red の件数に入れない。守りが効くことは、作業ツリーの外の写しで、`startWorker` を通さずに `createRemoteTaskExecutor({ ...process.env })` を渡すと、子の環境に token を持つ変数（`TAKT_TEST_TOKEN_COPY` ほか）が残って落ちることで確かめた。

### 本番のどこを外せば落ちるか

| 設計の行 | 当たる試験 |
|---|---|
| M15・M16（環境変数とファイルを読む） | S14（読まないと起動が止まり、接続が来ない） |
| M16（`--token` の警告） | S15 |
| M15（権限の確かめ） | S16 |
| M15（重なりの判定と文） | S17（文に値やパスを書いても落ちる） |
| `workerCommands.ts:29` の値の除外、子の引数に token を足す変更 | S18 |

## #198（it-worker-pool-runtime.test.ts の ENOSPC の当て先）

### 改めた試験

- `it-worker-pool-runtime.test.ts` › preserves A and delivers the saved result through $operation with $stage ENOSPC, restore=$restore（paused claim / failed claim の create の 2 行の当て先を直し、注入が起きたことの assert を足した）
- 同 › preserves A through continuing $stage ENOSPC in $operation and rechecks $change on recovery（stage に `candidate open` を足し、claim / waiting / recovery read / candidate read / start read の 5 行を足した）

### 差分の要点

- 403 行の群：tasks.yaml の lock の当て先を `path === taskLock` から、ファイルの頭の `isLockOpenTarget(path, taskLock)`（候補の `${lockPath}.<pid>.<uuid>.tmp`）にした。本番の経路は `store.ts:128`（`withFileLock(..., directCreate: true)`）→ `file-lock.ts:191`（候補の `openSync`）→ `:194`（候補の fd への `writeFileSync`）で、`tasks.yaml.lock` そのものは `openSync` で開かれない。前の当て先では paused claim と failed claim の create は一度も失敗を起こさず、緑のまま何も確かめていなかった。足した assert：その 2 行で `failures` が 1 件以上あり、どれも tasks.yaml の lock の候補であること。既存の expect はそのまま。
- 270 行の群：595d6a826 のあと `create` と `metadata` の行は同じ失敗（候補の fd への `writeFileSync`）を起こしている（`quint-193-review.md` の「試験との食い違い」）。`candidate open` の行は、同じ数え方で選んだ回の候補の `openSync` そのものを ENOSPC にする。どの行がどちらの失敗を起こしたかを、最初の `failures` の形（`open` か `fd=`）で確かめる assert を足した。既存の expect と既存の行はそのまま。

### 流した結果

60 件走り、60 件緑（足した candidate open の 5 行を含む）。#198 は試験の当て先の直しで、本番の red は無い。

足した assert が効くことは、作業ツリーの外の写しで当て先を `path === taskLock` に戻して流し、paused claim と failed claim の create の 2 行が `expected 0 to be greater than 0`（注入が 0 回）で落ちることで確かめた。

候補の `openSync` の ENOSPC も、今の本番は書き込みの ENOSPC と同じく `claim_retry` に変え、A を止めずに次の試みで直る。`quint-193-review.md` の「試験との食い違い」の 1 つめは、この試験で閉じる（設計の文書そのものは変えていない）。

## #207（遠隔の実行の runtime の割り当て）

### 足した試験

- `worker-pool-transfer.integration.test.ts`（light IT） › transfers the task runtime assignment $runtimeAssignment into the runtime configuration of the remote task process（cost / undefined）

daemon の `prepareRemoteExecutionInput` が書く `execution.json` の `runtime` は、遠隔の子が `setExecutionRuntimeProviderConfiguration(remoteRuntimeConfiguration(...))` でそのまま使う runtime.yaml の中身である。子は渡された runtime だけを使い、タスクの `runtime_assignment` で選び直さない（`resolveInvocationRuntimeProviderFileWithOrigins` が `suppliedRuntime` を先に返す）。試験は、プロジェクトの `.takt/runtime.yaml` に `assignments.cost` を置き、`runtime_assignment: cost` のタスクの入力を作って、`remoteRuntimeConfiguration(input)` の `provider.defaults` と `assignmentOrigins` を見る。割り当ての無いタスクの行は対照で、今も緑。

### 直す前の本番で流した結果

ファイルの 86 件が走り、1 件落ちた（足した 2 行のうち cost の行。ほかの 85 件は緑）。

| 試験 | 落ちた理由（期待 → 実際） |
|---|---|
| cost | 子の runtime の `provider.defaults` が `{ profile: 'cost' }` → `{ profile: 'base' }`（`taskConfig.runtime_assignment` は `cost` のまま運ばれるが、runtime の解決に効いていない） |

### 本番のどこを外せば落ちるか

`prepareRemoteExecutionInput`（`remoteExecutionInput.ts:73`）の `resolveInvocationRuntimeProviderFileWithOrigins` を、タスクの `runtime_assignment` の中（組み込みの実行の `withTaskRuntimeAssignment` と同じ）で呼ばないと cost の行が落ちる。割り当ての無いタスクにまで割り当てを付けると undefined の行が落ちる。

## #208（組み込みの worker の git の provider）

### 足した試験

- `it-worker-pool-git-provider.test.ts` › selects the $setting git provider of the project before the builtin worker executes a task (origin $origin)（gitlab と判定できない origin / 設定なしで github.com の origin）

直しの置き場所は takt中将の答えのとおり `BuiltinProjectRuntime`（コンストラクタか、`startTask` の実行の前のプロジェクトの設定を読む所）とする。試験は `runtime.start()` の実行の中（`executeRunTaskAndCompleteWithDetails` の差し替えの中）で `getGitProvider()` を読み、その型を見る。子の入口（`src/app/worker-pool-project/index.ts`）にだけ置く直しでは、この試験は緑にならない。

### 直す前の本番で流した結果

2 件走り、1 件落ちた。

| 試験 | 落ちた理由（期待 → 実際） |
|---|---|
| gitlab（`vcs_provider: gitlab`、origin は `git.example.test`） | 実行の中の `getGitProvider()` が `GitLabProvider` → GitHub の provider（`initGitProvider` を通らず、`getGitProvider()` が自動判定の既定の github に落ちる） |

対照の行（`vcs_provider` なし、origin が github.com）は今も緑で、直したあとも GitHub のままであることを守る。

### 本番のどこを外せば落ちるか

`BuiltinProjectRuntime` の実行の前に `initGitProvider(cwd)` を呼ばないと gitlab の行が落ちる。設定を読まずに GitLab に決め打ちすると対照の行が落ちる。

## #210（tsconfig.tests.json に足す 3 本）

### 足したもの

- `tsconfig.tests.json` に `src/__tests__/manager-workspace-access-realpath.test.ts`、`src/__tests__/opencode-readonly-directory-guard.test.ts`、`src/__tests__/usageEventLogger.test.ts` を、名前の順の位置に足した。試験の設定なので、このコミットが直しそのもの。

### 流した結果

足す前（このコミットの 1 つ前、#208 のコミットのあと）も、足したあとも、`npx tsc -p tsconfig.tests.json --noEmit` は型の誤り 0 件で終わった（終了コード 0）。3 本とも今の本番の型に合っている。本番は変えていない。

並びは `releaseVerificationWiring.test.ts` の決まり（文字コードの順。`-` は `.` より前なので `manager-workspace-access-realpath` が `manager-workspace-access.test.ts` の前）に合わせ、その試験を単独で流して 74 件緑を確かめた。

## #195・#196・#197 の残り（S19〜S23）

### 足した・改めた試験

- S19 `it-worker-pool-completion-publication.test.ts` › replies to a remote finish before its finish hook ends
- S20 同 › waits for a scheduled finish hook when the runtime closes
- S21 同 › keeps the project open when the notification of a normal completion fails
- S22 `worker-pool-remote-post-save.test.ts`（単体） › updates the remote records and releases the assignment when a step after the save fails: %s（notification / intervention terminal）
- S23 `it-worker-pool-completion-publication.test.ts` › names the task whose finish hook the project host cuts off when it stops the builtin worker（**設計の追記待ち（元帥の決め）**）
- M18 の既存試験の行の移し替え：`worker-pool-runtime.test.ts` › keeps the runtime running when a completion notification fails and settles the task like a normal completion（S5・S6 の節に書いた）

S19・S20・S23 のフックは、試験が置くファイル（`hook-gate`）ができるまで終わらない。始まったことは `hook-started.txt` に、終わったことは `hook-calls.txt` にタスク名を書いて見る。S21 は通常の完了の通常の通知に印を付けない前提（元帥の答えのまま）。S22 は `worker-pool-remote-runtime.test.ts` の fixture の形に、本物の `RemoteTaskLifecycle`（tasks.yaml は手元の状態）をつないだ。S22 の後半の assert（`completed`、`release`、`records`、接続を切らない）は、作業ツリーの外の写しで失敗を入れずに流して通ることを確かめた。

S23 は takt中将の答え（11/28）のとおり、host の層（`BuiltinProjectHost.close()` の 5 秒の打ち切り）を試す。S20 は runtime の層のまま（runtime の `close()` は打ち切らない）。警告をどちら（子の終わり際か host の側）で出すかは本番で決めるので、子の stderr（`spawnManagedProcess` の子に耳を付ける）、daemon 側の stderr（`reportDaemonError` の出口）、`[WARN]` の出口（`console.log`）を合わせて見て、タスク名と `hook` を含む行がちょうど 1 行あること、フックのコマンドに混ぜた `--api-token=` の作り物の値がどの行にも無いことを確かめる。

### 直す前の本番で流した結果

`it-worker-pool-completion-publication.test.ts`：15 件走り、14 件落ちた（S1〜S8 の 10 件は 1 つめの節のまま。足した 4 件はすべて落ちた）。

| 試験 | 落ちた理由（期待 → 実際） |
|---|---|
| S19 | 遠隔の `finish` の返事は 5 秒より前に返る（今は通る）。そのあとフックが始まる → 始まらない（`hook-started.txt` が `[]`） |
| S20 | フックが始まり、ファイルを置くまで `close()` が解決しない → フックが始まらない |
| S21 | B の通常の完了の通知が ENOSPC でも `finished` が B で呼ばれる → 呼ばれない（runtime が `failed` に進み、A も中断される） |
| S23 | host の子で読めないタスクのフックが始まる → 始まらない |

`worker-pool-remote-post-save.test.ts`：2 件走り、2 件落ちた。

| 試験 | 落ちた理由（期待 → 実際） |
|---|---|
| S22 notification | 遠隔の `complete` に返事を返す → `disk full`（`saveManagerEvent`）で `receive` が reject し、`completed` も `release` も無い |
| S22 intervention terminal | 同上（`recordTerminal` の `disk full`） |

`worker-pool-runtime.test.ts`：13 件走り、4 件落ちた（S5 の 2 件・S6 は 1 つめの節のまま、足した M18 の 1 件）。

| 試験 | 落ちた理由（期待 → 実際） |
|---|---|
| keeps the runtime running when a completion notification fails ... | `finished('notified-task')` が 1 回 → 呼ばれない（通知の失敗で runtime が `failed` に進む） |

### 本番のどこを外せば落ちるか

| 設計の行 | 当たる試験 |
|---|---|
| M5・M6（返事の前にフックを待つ形に戻す） | S19（返事が 5 秒の内に返らない） |
| M5（`close()` が `pendingHooks` を待つ所） | S20（`close()` がファイルを置く前に解決する） |
| M18 | S21、M18 の単体の試験（`failed` を呼ぶ、`finished` を呼ばない、警告を出さない、警告に秘密を出す、のどれでも落ちる） |
| M6（各段の `try/catch`） | S22 の 2 行 |
| S23（設計の追記待ち） | host の 5 秒の打ち切りでフックを切ったときに、タスク名つきの 1 行を出さない（0 行でも 2 行でも落ちる）、またはその行に秘密を出す |

## 見直しの直し（8 番目のあと）

8 番目までのコミットは muse の基点なので付け替えず、このコミットで試験を直した。件数は変わらない（`it-worker-pool-completion-publication.test.ts` 15 件中 14 件、`it-worker-token-source.test.ts` 7 件中 7 件、`worker-pool-runtime.test.ts` 13 件中 4 件が落ちる）。

- S23：タスク名を `host hook cut` から `stopping work` にした（名前に `hook` が入ると、`/hook/i` の条件が名前だけで満たされる）。数え方を、出口（子の stderr、daemon 側の stderr、`[WARN]`）ごとに数え、どの出口も 1 行まで、少なくとも 1 つの出口に 1 行、に改めた。host は子が 0 以外（シグナルを含む）で終わると子の stderr の末尾を自分の報告（`reportDaemonError`、daemon 側の stderr）に写すので、本番が子の stderr に警告を出すと、同じ行が 2 つの出口に出る。出口を足し合わせて 1 行と数えると、直したあとも落ちていた。
- S5・S6・S7・S21：警告の行をタスク名で拾う試験で、タスク名が `a`・`b` だった。`manager was not notified` の文そのものに `a` と `b` が入っているので、名前の条件が空振りしていた。S5・S6 は `saved` の記録の名前だけを `setup-failed`・`unreadable-remote` に変えた（`start('a')` や `recheck('a')` の既存の assert はそのまま）。S7 の B を `blocked setup`、S21 の B を `notify failure` にした。
- S15：接続の直後に stderr の警告を数えていたので、パイプの到着と競る。`vi.waitFor` で待つ形にした。

### 確かめたこと（試験は変えていない）

- **#211 のエラーの出口**：今の CLI は、`action` が投げたエラーを stdout の `[ERROR]` の行に書き、stderr には何も書かない（`TAKT_WORKER_TOKEN` だけで起動して、stdout が `[ERROR] Worker startup requires --url and --token`、stderr が空）。S16・S17 は設計（`worker-token-source.md` 1・2 節）のとおり stderr を見るので、M15・M16 が素直に `throw` するだけでは S16・S17 は red のまま残る。止める文（権限、重なり）は stderr へ明示して書く必要がある。
- **S20 と `terminateManagedProcesses`**：終了フックは `runBoundedCommand`（`bounded-command-runner.ts`）が `node:child_process` の `spawn`（`detached`）で起こし、`spawnManagedProcess` の管理には入らない。runtime の `close()` が先に呼ぶ `terminateManagedProcesses()` はフックを止めない。試験はそこを mock しているが、本番との食い違いは無い。同じ理由で、S23 で host が子のプロセス群を止めても、フックのプロセスは残る（試験の後片付けで門のファイルを置いて終わらせる）。
- **単体の mock のもとの終了フック**：`worker-pool-runtime.test.ts` は `infra/config/index.js` を丸ごと差し替えているが、`taskFinishHook.ts` は `loadProjectConfig` を `infra/config/project/projectConfig.js` から読む。作業ツリーの外の写しで、その mock のもとで `runTaskFinishHooksForStates('/project', [state])` を読み込んで呼び、stderr に何も書かずに解決することを確かめた。M5 のあとも、この mock で S5・S6 が別の理由で落ちることは無い。

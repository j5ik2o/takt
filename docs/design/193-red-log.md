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

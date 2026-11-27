# task_finish_hook の取りこぼしを、タスク名つきの警告 1 回で見えるようにする（#171）

- Issue: [j5ik2o/takt#171](https://github.com/j5ik2o/takt/issues/171)（[j5ik2o/takt#168](https://github.com/j5ik2o/takt/pull/168) の設計レビューから切り出した別件。`docs/design/goal-task-claim-setup-failure.md` の『別件』の 3）
- 基点ブランチ: `integration/takt-mcp`（`c485ffab9`）
- Quint 仕様: `specs/quint/task-finish-hook/`（#148 の `taskFinishHook.qnt` はそのまま。読みと設定の前置きを `taskFinishHookNotice.qnt` で足した）
- 上流: `nrslib/takt` の `main`（`bba6f2315`）と開いている PR（#2110 の 1 件）を確認した。上流に `task_finish_hook` と `runTaskFinishHooks` は無く、同じ直しも無い。上流へは何も流さない。
- 設計レビュー: 別会話の敵対的レビューで出た 15 件と、その再確認で出た追加 6 件をすべて反映した改訂版。採否は takt中将が決める。

## 何が起きているか

`task_finish_hook` は、終端状態が `tasks.yaml` に保存された後に 1 回だけ外部コマンドを呼ぶ。呼ぶ側は 4 つある。

| 呼ぶ側 | 入口 | 状態の渡し方 |
|---|---|---|
| queued のタスク実行（completed / failed / interrupted / exceeded / pr_failed / merge タスク） | `withTaskFinishHook`（`src/features/tasks/execute/taskExecution.ts:126`） | 実行の前後に `TaskRunner.listTaskStateItems()` を読み、終端状態の印（status と completedAt）が変わったときだけ呼ぶ（`runHook`、`taskFinishHook.ts:107-119`）。実行前の読みが失敗したときは §2 の at-least-once |
| `takt merge` の直接実行 | `withTaskFinishHook`（`src/features/merge/index.ts:98`） | 同上 |
| `pr_failed` のタスクを PR 公開後に `completed` へ保存 | `runTaskFinishHooks`（`src/features/tasks/list/taskPullRequestActions.ts:269`） | タスク名だけを受け取り、自分で `listTaskStateItems()` を読む（`taskFinishHook.ts:126-143`） |
| claim の setup 失敗、中止したゴールの pending タスク | `runTaskFinishHooksForStates`（`src/features/tasks/execute/parallelExecution.ts:351`、`taskFinishHook.ts:163-174`） | 保存した `TaskState[]` をそのまま受け取る（#169 で追加）。`tasks.yaml` は読み直さない |

`runTaskFinishHooks` と `runTaskFinishHooksForStates` は、設定 `loadProjectConfig(projectCwd).taskFinishHook` を読む。設定が無ければ何もしない（これは取りこぼしではない）。設定が読めない、または `listTaskStateItems()` が失敗すると、`catch` が `log.error` を 1 行残して戻る（`taskFinishHook.ts:140-142`、`157-159`）。`runHook` の失敗も `withTaskFinishHook` の `finally` の `catch` が `log.error` だけを残す（`taskFinishHook.ts:200-204`）。`callHook` の中で `runBoundedCommand` が予期せず投げた場合も、`Promise.all` が拒否されて同じ `catch` に落ちる（`taskFinishHook.ts:139`、`156`）。

`log.*` は `DebugLogger.writeLog` に渡り、既定では `DebugLogger` が無効なのでファイルにも console にも残らない（`src/shared/utils/debug.ts:166-174`）。ただし `--verbose` のときは `initDebugLogger` が有効になり、`setVerboseConsole(true)` で `writeLog` が stderr にも書く（`src/app/cli/initialization.ts:52-60`、`src/shared/utils/debug.ts:167-170`）。したがって正確には「既定では見えない（`--verbose` では stderr に出る）」である。`warn()` は `LogManager` の既定レベル `info` で表示される（`src/shared/ui/LogManager.ts:69-72`、`103-105`）。つまり、既定では次の経路でフックが呼ばれないことが利用者にもログにも残らない。

1. `runTaskFinishHooks`（`pr_failed` の公開後）で、`tasks.yaml` の読みがロックの時間切れになる。`file-lock.ts` は `TIMEOUT_MS = 5_000` のあいだ `RETRY_MS = 25` ms ごとに取り直し、`acquireLock` の待ちループの各回で `recoverStaleLock` も呼ぶ（`file-lock.ts:179-204`）。時間切れになるのは、他のプロセスが 5 秒以上保持したか、取得が 5 秒間進まなかったときだけである。短い書き込みは待つだけで成功する。
2. 同じ経路で `tasks.yaml` が壊れている（`Invalid tasks.yaml`）、読めない（EACCES / EIO など）、または `config.yaml` が壊れている／読めない。
3. `runTaskFinishHooksForStates`（claim の setup 失敗、ゴールの中止）で `config.yaml` が読めない。状態は手元にあるのに、設定が読めないだけでフックを呼ばない。
4. `withTaskFinishHook` / `runHook` の実行後の読み、または設定の読みが失敗する。実行の結果（成功・失敗・中断・上限超過・PR 失敗）は保存されているのに、フックだけが黙って落ちる。
5. `callHook` が予期せず投げる。`Promise.all` の拒否が上の `catch` に落ち、どのタスクのフックが落ちたか残らない。

`runTaskFinishHooks` が読み直す理由は、呼び出し元がタスク名しか持っていないためである。`pr_failed` の公開後は、`completePublishedTask` が保存した後の別の呼び出しなので、状態を渡す形に変えるには呼び出し元の変更が要る。この設計では、その変更はしない（#169 が終了フックの読み直しを減らした範囲の外である）。

`runHook` の実行前の読み（`taskFinishHook.ts:190-196`）も失敗すると `log.error` だけを残す。この失敗は「フックを呼び損ねた」ではないが、`stampBefore` は非終端のときも `undefined` になるため、実行後の読みが終端を見つけたときに、この実行が保存した状態かどうかを区別できない。実装では読みの失敗を別のフラグ（`beforeReadFailed`）で覚える。実行前の読みは、実行を遅らせないために再試行しない。代わりに、`beforeReadFailed` のときは **at-least-once** とし、実行後の読みが終端ならフックを 1 回呼び、その呼び出しと同じ実行で「前の状態を読めなかったので、この実行が保存した状態でないのにフックが走ることがある」と 1 回警告する（§2 の最後）。

### #170 と #169 との線

- #170（`docs/design/goal-task-completion-publication.md`）は、manager への完了通知が失敗したときに `tasks.yaml` の `completion_publication_pending` の印を残し、daemon が受信箱へ出し直す。保存するデータと daemon の仕事を増やす。**#171 はこの印を使わない。** フックは外部コマンドの副作用で、二重に走らせると害があるため、印を付けて後から出し直す形にはしない。役割は「manager の完了通知の到達」と「終了フックの取りこぼしの可視化」で分ける。この作業ツリーには #170 の設計書が無いので、`j5ik2o/takt-fix-170-setup-notice` の設計書を読んで線を引いた。
- #169（`docs/design/claim-lock-release-failure.md`）は、書き込みの直後の終了フックに保存した `TaskState[]` を渡す `runTaskFinishHooksForStates` を入れた。これで claim の setup 失敗とゴールの中止は `tasks.yaml` を読み直さない。**#171 は、読み直す経路（`pr_failed` の公開後と `withTaskFinishHook` の実行後）に残る取りこぼしを扱う。**
- #169 の「外し損ねた自分のロック」は、次の取得まで待たず、同じ `acquireLock` の 5 秒の待ちループの中で 25 ms ごとに `recoverStaleLock` が呼ばれて外れる（`file-lock.ts:199`）。記録と一致し、読めるファイルなら 1 回目の待ちの間に既に外れている。したがって #171 の 2 回目の取得が助けるのは、「1 回目の待ちの間に記録したファイルを読めず、250 ms 後に読めるようになった」場合や、「持ち主が 5 秒の期限の直後に放した」場合など、狭い範囲だけである。これを再試行の主な根拠にはしない。

### #170 との重なり

#170 と #171 は、同じ保存（たとえば claim の setup 失敗）に対して、別の種類の「失われた」通知を出しうる。

- #170 の `publishSetupFailure` は、manager への完了通知 `saveManagerEvent` が失敗したときに `warn()` を出す。
- #171 の `runTaskFinishHooksForStates` は、同じ保存の後に、`config.yaml` が読めない、またはフックの起動が例外で落ちたときに `warn()` を出す。

したがって、1 回の保存で 2 つの警告が並ぶことがある。それぞれの「1 回」は自分の範囲内の 1 回であり、互いに重複排除しない。利用者には「manager に通知できなかった」と「終了フックを実行できなかった」が別々に見えるので、原因を取り違えない。この重なりは [j5ik2o/takt#188](https://github.com/j5ik2o/takt/issues/188)「同じ保存で、manager 通知の失敗とタスク終了フックの失敗の警告が 2 種類並ぶ」として起票されている（解決の案は 1 本にまとめる／文面で互いを参照／そのまま。決めるのは #170・#171 の着地後）。今回の範囲では 2 つを統合しない（#188 の範囲）。#170 の `completion_publication_pending` の印は #171 では使わず、#171 は再送もしない。両方が成功したときは、どちらの警告も出ない。

## 何をどう変えるか

### 1. 取りこぼしを、タスク名つきの `warn()` で 1 回だけ出す

`taskFinishHook.ts` に、フックを呼べなかったことを知らせる小さな関数を 1 つ置く（仮に `reportLostHook`）。

```ts
function reportLostHook(
  taskNames: readonly string[],
  reason: unknown,
  phase: 'config-read' | 'named-read' | 'execution-read' | 'hook-call',
): void {
  // 実装の形は設計。名前は sanitizeTerminalText、理由は sanitizeSensitiveText を通す。
}
```

- **1 回の呼び出しにつき 1 回だけ** `warn()` を呼ぶ。`runTaskFinishHooks` が 3 つのタスク名を受け取って読みに失敗したら、1 つの警告に 3 つの名前を入れる。`withTaskFinishHook` の 1 タスクなら 1 つの名前を入れる。
- **「1 回」の単位は 1 回の呼び出し**（`runTaskFinishHooks` の 1 回、`runTaskFinishHooksForStates` の 1 回、`withTaskFinishHook` の 1 回）。時間をおいた別の実行、同じタスクの再実行、同じ失敗の再発をまたいだ「1 回」は保証しない。`runTaskFinishHooks` は印を持たないので、呼び出し元が同じタスクで何度も呼べば、そのたびに警告する。
- タスク名は `sanitizeTerminalText`（`src/shared/utils/text.ts:45`）を通し、重複を除く。`tasks.yaml` のタスク名は制御文字や ANSI を含みうるので、端末にそのまま出さない。
- 理由（例外の文面）は `sanitizeSensitiveText`（`src/shared/utils/sensitive-text.ts:544`）を通し、組み立てた文面も `sanitizeSensitiveText` に通す。秘密の伏せ方そのものは変えない。`src/shared/utils/sensitiveText.ts` は再エクスポートなので、参照先は実体のファイルにする。
- 名前が大量にあるとき（ゴールの中止で何百もの pending タスクを failed にした場合など）は、先頭 10 件と「and N more」に丸める。1 回の警告を巨大にしないため。丸めた件数は警告に残す。
- `log.error` はデバッグ用に残す。`warn()` は既定で見えるが、`log.error` は既定では見えず、`--verbose` のときは stderr にも出る（`logging.debug` が有効ならファイルにも残る）。
- **新しい警告は `emitStatusLog` では抑えない。** `emitStatusLog` はフックの通常の失敗表示（非 0 終了・時間切れ・起動失敗）を静かにするためのもので、フックが呼ばれなかったことは通常の状態表示ではない。`parallelOptions.outputMode === 'silent'` の実行でも、取りこぼしは 1 回出す。
- **`--quiet` でも `--pipeline` でも出す。** `warn()` は `LogManager.warn` が `console.log` で stdout に書く（`src/shared/ui/LogManager.ts:68-72`、`103-105`）。`isQuietMode()`（`src/shared/context.ts`）も `minimalOutput` も見ない。失われた通知を隠さないことを優先する。`--pipeline` の stdout を機械が読む用途では警告が混ざるが、これは「影響」に書き、必要なら将来の別件にする（この設計では統合しない）。
- `warn()` が同期で投げた場合（閉じた stdout への書き込みなど）は握りつぶし、`log.error` を試みて、呼び出し元へは投げない。console のストリームエラーが非同期になる場合の扱いは `console.log` に任せ、この設計の対象外とする。
- 文面の例（英語。既存の `callHook` の警告に合わせる）:

```text
Task finish hook was not run for "task-a", "task-b": reading .takt/tasks.yaml timed out after 2 attempts. The saved task state is unchanged; the hook is not retried later.
```

`loadProjectConfig` の失敗は phase `'config-read'` にして「reading .takt/config.yaml failed」、`callHook` の予期しない例外は phase `'hook-call'` にして「the hook command could not be started」のように、どこで落ちたかを入れる。文面の細部は実装時に決めてよい（決めずに残したこと）。

### 2. `tasks.yaml` の読みの時間切れだけ、上限つきで 1 回再試行する

- **対象**: `runTaskFinishHooks` の `listTaskStateItems()` と、`runHook` の実行後の `readTaskState()`。どちらも同じヘルパー（仮に `readTaskStateItemsWithRetry`）を通す。
- **再試行する条件**: `isFileLockTimeoutError(error)`（`src/infra/fs/file-lock.ts:16-18`）のときだけ。`Invalid tasks.yaml`、EACCES、EIO、ENOSPC などは再試行しない。壊れたファイルや権限は待っても直らないため。
- **上限**: 初回 + 1 回の計 2 回まで。間隔は 250 ms。定数は `TASK_FINISH_HOOK_READ_MAX_ATTEMPTS = 2`、`TASK_FINISH_HOOK_READ_RETRY_INTERVAL_MS = 250` のように名前を付ける。
- **再試行の根拠**: 1 回の読みは `file-lock.ts` の待ちループで 5 秒・25 ms ごとに取り直し、その間に `recoverStaleLock` も走る（`file-lock.ts:179-204`）。それでも取れなかった、または読めなかったときにだけ、250 ms 空けて 1 回だけ取り直す。5 秒の期限の直後に持ち主が放した場合や、記録した自分のロックが 1 回目の待ちの間に読めず、250 ms 後に読めるようになった場合にだけ助かる。短い競合を根拠にはしない。
- **待ちの上限**: 再試行すると、最悪で「5 秒 + 250 ms + 5 秒」の約 10.25 秒を余分に待ってから警告になる。呼び出し元は元々フックを待つ（フック自体は最大 60 秒）ので、これは上限のある追加コストとして受け入れる。待ち続けるループにはしない。
- **フックを二重に走らせない**: 再試行するのは読みだけである。読みが成功するまでフックは 1 回も呼ばれない。読みが成功したら、その 1 回の呼び出しで終端状態ごとに 1 回だけ呼ぶ。読みの再試行がフックの呼び出しを増やすことはない。
- **#169 との関係**: #169 の外し損ねロックは、同じ `acquireLock` の 5 秒の待ちループの中で 25 ms ごとに `recoverStaleLock` が呼ばれて外れる（`file-lock.ts:199`）。2 回目の取得が助けるのは、1 回目の待ちの間に読めなかった記録が後で読める場合など、狭い範囲だけである。これを主な根拠にしない。
- **実行前の読みは再試行しない**: `withTaskFinishHook` の実行前の `readTaskState`（`taskFinishHook.ts:190-196`）は、フックの取りこぼしではなく、実行を遅らせないことを優先する。保存後（`runTaskFinishHooks`）と実行後（`runHook`）の読みだけを再試行する。Quint も実行前の読みはモデルに含めない（「モデルが表していないこと」）。
- **実行前の読みが失敗したときは at-least-once にする**: 実行前の `readTaskState` が失敗したことを `beforeReadFailed = true` で覚える（`stampBefore` が `undefined` なだけでは、非終端だった場合と区別できない）。`beforeReadFailed` で、実行後の読みが終端を見つけたら、フックを 1 回呼ぶ。同時に、`reportUnconfirmedPreRead(taskName, reason)`（`reportLostHook` と同じ整形・サニタイズを使う別の関数）で「実行前の状態を読めなかったので、この実行が保存した状態でないのにフックが走ることがある」と 1 回警告する。フックを呼ばない（実行後が非終端、設定なし、設定読み失敗、実行後の読み失敗）ときは、この警告は出さない。二重実行を防ぐより、取りこぼさないことを優先するという判断である。
- **設定の読みは再試行しない**: `loadProjectConfig` は `config.yaml` を読む。壊れた YAML やスキーマ違反は決定的で、待っても直らない。ロック待ちも無い。失敗したら `reportLostHook` を 1 回だけ呼ぶ（phase は `'config-read'`。`runTaskFinishHooks` は受け取った名前、`runHook` はそのタスク名、`ForStates` は濾した後の終端状態の名前）。設定が無い場合は警告しない。
- **`runTaskFinishHooksForStates` は読み直さない**: 状態は呼び出し元が渡す（#169）。設定だけを読み、失敗したら `'config-read'` で警告する。

### 3. `callHook` の予期しない例外も、1 回の警告にまとめる（3 つの呼び出し経路すべて）

対象は 3 つある。`runTaskFinishHooks`（`taskFinishHook.ts:126-143`）、`runTaskFinishHooksForStates`（`taskFinishHook.ts:146-160`）、`withTaskFinishHook` / `runHook`（`taskFinishHook.ts:107-119`、`183-206`）である。

- **`runTaskFinishHooks` と `runTaskFinishHooksForStates`**: `Promise.all`（`taskFinishHook.ts:139`、`156`）を `Promise.allSettled` に変え、どのタスクの `callHook` が拒否されたかを集める。全件が終わってから、落ちたタスク名をまとめて 1 回 `reportLostHook(..., 'hook-call')` で警告する。成功したフックはそのまま実行される。非 0 終了・時間切れ・起動失敗は今までどおり `callHook` がタスクごとに警告する（`emitStatusLog !== false` のとき）。
- **`withTaskFinishHook` / `runHook`**: `runHook` の中で、実行後の読み（再試行後）の失敗を `reportLostHook([taskName], reason, 'execution-read')`、設定の読みの失敗を `reportLostHook([taskName], reason, 'config-read')`、`callHook` の例外を `reportLostHook([taskName], reason, 'hook-call')` として、それぞれ 1 回呼んで、投げ直さない。`withTaskFinishHook` の `finally` の `catch`（`taskFinishHook.ts:199-204`）は、`runHook` から漏れた予期しない例外だけを拾い、`reportLostHook([taskName], reason, 'hook-call')` を 1 回呼ぶ。`runHook` が報告済みの例外を投げ直さないので、ここで二重に警告しない。この形で、キュー実行（`taskExecution.ts:126`）と `takt merge` の直接実行（`merge/index.ts:98`）の両方で、フックの例外が既定で見える。
- **二重警告を避ける**: 各関数で「報告する場所」を 1 つに決める。`runTaskFinishHooks` / `ForStates` は `allSettled` の結果をまとめる 1 か所、`runHook` は `callHook` の catch 1 か所、`withTaskFinishHook` は `runHook` の外の catch 1 か所だけが `warn()` を呼ぶ。`reportLostHook` は呼び出し側で「報告済み」を持たない。`runHook` が報告したら投げない規約で重複を防ぐ。
- この変更は、例外で落ちたフックが `log.error` だけになる経路を塞ぐためのものである。保存済みの状態と実行の戻り値は変えない。

### 3-1. `runTaskFinishHooksForStates` の契約: 渡すのは終端状態だけ

`runTaskFinishHooksForStates` は、呼び出し元が「保存した終端状態」を渡す契約にする。実装では関数の先頭で `const terminal = states.filter(isTerminal)` と濾し、フックの呼び出しにも、設定読み失敗の警告に入れる名前にも、**濾した後の `terminal` だけ**を使う（`taskFinishHook.ts:155` の `states.filter(isTerminal)` を、警告の名前を作る前に行う）。非終端の state は警告にも名前を出さない。呼び出し元が契約を外して非終端を混ぜても、「フックを失った」と誤って表示しない。`invalidatePendingGoalTasksWithFinishHook` が集める `invalidated` と、`claimTasksWithGoalCompletions` が返す `setupFailedTasks` は、どちらも保存した終端状態だけである。

### 4. 終端状態が読めた後の「非終端・見つからない」は、この設計では警告しない

`runTaskFinishHooks` が読みに成功したのに、渡された名前のタスクが見つからない、または終端でない場合、今もフックは呼ばれない。これは読みの失敗ではなく、別のプロセスがそのタスクを再キュー・削除・再実行した状態である。ここでフックを呼ぶと、別の試行のためのフックを古い状態で走らせることになり、二重実行に近い害がある。この設計では警告も出さない（範囲の外）。Quint の `ReadNotTerminal` はこの状態を表し、`loss = false`、`notices = 0` としてある。

## 範囲の外（変えないもの）

- フックコマンドの非 0 終了・時間切れ・起動失敗の扱い（`callHook` の既存の警告と `emitStatusLog`）。フックは呼ばれているので、この設計の「呼ばれなかった」取りこぼしとは別である。
- 実行前の `readTaskState` の再試行（`withTaskFinishHook` の印の取得）。実行を遅らせないため再試行しない。失敗したときの at-least-once のフック呼び出しと 1 回の警告は §2 のとおり（範囲の外ではない）。
- 読みに成功した後の「非終端・見つからない」（上の 4 節）。
- フックの副作用の永続的な再送。印を付けたり daemon に出し直させたりしない（#170 の範囲）。
- フックに渡す環境変数（`buildHookEnv`）と `MAX_FAILURE_REASON_CHARS`。
- `tasks.yaml` のスキーマ、`config.yaml` のキー、`TaskRunner` の公開 API、MCP の道具。
- #169 のロックの記録・回収そのもの。再試行がその仕組みに乗るだけである。

## 守る不変条件

Quint の `safety` は次の 7 つの連言で、`noticeFixed` で違反が無い（詳細は「Quint の仕様と検査結果」）。6 は Quint では実行前の読みを持たないため `noHookOnLoss` としてモデル化し、実行前の読みの at-least-once を含めた形をここに書く。

1. `noUnnoticedLoss`: 設定または読みの失敗でフックを諦めた呼び出しは、ちょうど 1 回の警告を出す。
2. `noFalseNotice`: 1 回の呼び出しの中で、フックを失っていないのに取りこぼしの警告を出さない（設定なし、読み成功、非終端は警告しない）。実行前の読みの at-least-once 警告は別の警告で、6 で扱う。
3. `noticeAtMostOnce`: 1 回の呼び出しの警告は多くとも 1 回。
4. `retryBounded`: 読みの試行は 2 回まで、間隔の待ちは 1 回まで。無限に待たない。
5. `retriesTimeouts`: 再試行する読みは 3 つに分けて扱う。(a) `runTaskFinishHooks`（`NamedHook`）の保存後の読みは、ロック時間切れだけ上限まで再試行する。**Quint の `retriesTimeouts` が表すのはこれだけである。** (b) `runHook` の実行後の読みは、同じ回数・間隔で再試行するが Quint のモデル外で、PBT 4 で確かめる。(c) `withTaskFinishHook` の実行前の読みは再試行しない（Quint のモデル外）。`runTaskFinishHooksForStates` は `tasks.yaml` を読まない。
6. `noSilentLossOrUnconfirmedRun`（Quint では実行前の読みを持たないため `noHookOnLoss` としてモデル化）: 読み・設定の失敗でフックを諦めたときはフック 0 回で警告 1 回。実行前の読みが失敗して実行後が終端のときは、フックを 1 回呼び、そのことを警告 1 回で知らせる（at-least-once）。実行前の読みが成功して印が変わらないときはフックを呼ばない。
7. `atMostOnceHook`: 1 回の呼び出しでフックは多くとも 1 回。再試行はフックの回数を増やさない。実行前の読みが失敗した場合のフックも 1 回までである。

1〜7 の「1 回」は、すべて 1 回の呼び出しの中の回数である。別の呼び出し・別の実行・同じ失敗の再発をまたいだ重複排除はしない。

実装の側では、さらに次を守る。

- 警告のタスク名は `sanitizeTerminalText`、理由と文面は `sanitizeSensitiveText` を通す。秘密とタスク名の生の値を漏らさない。
- `runTaskFinishHooks`・`runTaskFinishHooksForStates`・`withTaskFinishHook` のフック経路は投げない。実行の結果・保存済みの状態・再開点を変えない（#148 の `savedStateUntouched` は状態の不変条件として保つ）。
- 8. `hookExceptionVisible`: キュー実行（`taskExecution.ts:126`）と `takt merge` の直接実行（`merge/index.ts:98`）の両方で、`callHook` の例外は 1 回の `warn()` に出る（`log.error` だけにしない）。
- 9. `noticeNotSuppressed`: 取りこぼしの警告は `emitStatusLog`・`outputMode: 'silent'`・`--quiet`・`--pipeline` で抑えない。通常のフック失敗の表示だけを `emitStatusLog` に従わせる。
- 10. `forStatesTerminalOnly`: `runTaskFinishHooksForStates` は `isTerminal` で濾した後の状態だけをフックにも警告の名前にも使う（§3-1）。
- 再試行するのは `isFileLockTimeoutError` の**実行後の読み**だけ。設定、フックの起動、`runTaskFinishHooksForStates` の状態、実行前の読みは再試行しない。
- 読みの再試行は、フックの呼び出しより前に行う。フックを呼んだ後に読みをやり直さない。
- 大量のタスク名でも警告は 1 回で、先頭 10 件と残り件数に丸める。

## Quint の仕様と検査結果

`specs/quint/task-finish-hook/` は 2 つのモデルを持つ。

| ファイル | 内容 |
|---|---|
| `taskFinishHook.qnt` / `taskFinishHook_test.qnt` | #148 のモデル。終了フックを付ける位置（`AtEntryPoints` / `AtNormalEnd` / `AtEverySave`）と、フックが保存済みの状態を変えないこと。**変更していない。** |
| `taskFinishHookNotice.qnt` / `taskFinishHookNotice_test.qnt` | #171 で足したモデル。`runTaskFinishHooks` / `runTaskFinishHooksForStates` の設定と読みの前置き、上限つき再試行、警告の回数。 |

`taskFinishHookNotice.qnt` は 1 回の呼び出しと 1 つのタスクを表す。`NOTICE` は `Silent`（旧: `log.error` だけ）と `Fixed`（1 回の `warn()`）、`RETRY` は `None`（再試行なし）、`Bounded`（2 回まで、待ち 1 回）、`Unbounded`（待ち続ける）を切り替える。`Read` は `ReadOk`、`ReadNotTerminal`、`ReadTimeout`、`ReadBroken`。`ReadTimeout` だけが再試行の対象である。`sawNotTerminal` は `ReadNotTerminal` を通ったことを記録し、`wReadNotTerminalNoNotice` が `ConfigMissing` でも成り立つという過大な見せ方を避ける。

### 実行したコマンドと結果

Quint 0.32.0。`specs/quint/task-finish-hook/` で実行した。

```sh
quint typecheck taskFinishHookNotice.qnt
quint typecheck taskFinishHookNotice_test.qnt
quint test taskFinishHookNotice_test.qnt --main noticeFixedTest
quint test taskFinishHookNotice_test.qnt --main noticeBeforeTest
quint test taskFinishHookNotice_test.qnt --main noticeNoRetryTest
quint test taskFinishHookNotice_test.qnt --main noticeUnboundedTest
```

| 検査 | 結果 |
|---|---|
| `quint typecheck`（本体・テスト） | どちらも成功 |
| `quint test noticeFixedTest` | 9 件すべて通る（`timeoutThenSuccessTest`、`exhaustedWarnsOnceTest`、`brokenWarnsOnceTest`、`readNotTerminalDoesNotWarnTest`、`configMissingDoesNotWarnTest`、`configUnreadableWarnsTest`、`statesPathSkipsReadTest`、`statesConfigErrorWarnsTest`、`noSecondCallTest`） |
| `quint test noticeBeforeTest` | 2 件通る（`silentTimeoutTest`、`silentConfigErrorTest`） |
| `quint test noticeNoRetryTest` | 1 件通る（`timeoutNotRetriedTest`） |
| `quint test noticeUnboundedTest` | 1 件通る（`retryExceedsBoundTest`） |

`quint run`（`--max-steps 8 --max-samples 1000 --seed 0x2a`）で、直す前の形と採らない形の反例を確かめた。

表は 1 行 1 trace にする。同じ main でも、破れる不変条件ごとに別の trace である。

| main | 破れる不変条件 | その trace の状態 |
|---|---|---|
| `noticeBefore`（`Silent` + `None`） | `noUnnoticedLoss` | `config = ConfigUnreadable`、`path = StatesHook`、`phase = Done`、`loss = true`、`notices = 0`、`readAttempts = 0` |
| `noticeBefore`（`Silent` + `None`） | `retriesTimeouts` | `config = ConfigOk`、`path = NamedHook`、`phase = Done`、`loss = true`、`notices = 0`、`readAttempts = 1`、`retries = 0`、`timedOut = true`（`ReadTimeout` を再試行しない） |
| `noticeNoRetry`（`Fixed` + `None`） | `retriesTimeouts` | `config = ConfigOk`、`path = NamedHook`、`phase = Done`、`loss = true`、`notices = 1`、`readAttempts = 1`、`retries = 0`、`timedOut = true` |
| `noticeUnbounded`（`Fixed` + `Unbounded`） | `retryBounded` | `config = ConfigOk`、`path = NamedHook`、`phase = Waiting`、`loss = false`、`notices = 0`、`readAttempts = 2`、`retries = 2`、`timedOut = true` |
| `noticeUnbounded`（`Fixed` + `Unbounded`） | `retriesTimeouts` | `config = ConfigOk`、`path = NamedHook`、`phase = Done`、`loss = true`、`notices = 1`、`readAttempts = 3`、`retries = 2`、`timedOut = true` |

`noticeFixed`（`Fixed` + `Bounded`）は `[ok]` で、反例の行は無い。

`noticeFixed` の無作為シミュレーション:

```sh
quint run taskFinishHookNotice.qnt --main noticeFixed --invariant safety \
  --witnesses wRetriedThenCalled wExhaustedWarned wBrokenWarned \
    wReadNotTerminalNoNotice wConfigMissingNoNotice wStatesConfigErrorWarned \
  --max-samples 20000 --max-steps 8 --seed 0x2a
```

結果: 20,000 標本、max-steps 8、seed `0x2a`、`[ok]`（違反なし、約1.4秒）。witness はすべて到達した。以下は到達した跡の本数で、網羅率ではない。

| witness | 本数 / 20,000 |
|---|---|
| `wRetriedThenCalled` | 197 |
| `wExhaustedWarned` | 452 |
| `wBrokenWarned` | 843 |
| `wReadNotTerminalNoNotice` | 1,025 |
| `wConfigMissingNoNotice` | 6,693 |
| `wStatesConfigErrorWarned` | 3,344 |

追加で `--max-samples 50000 --max-steps 10` を seed `0x1` と `0x2a` で流し、どちらも `[ok]`（約3.3秒 / 約3.3秒）。シミュレーションであり、証明ではない。`wReadNotTerminalNoNotice` は `sawNotTerminal` を要求するので、1,025 本は `ReadNotTerminal` を通った跡だけを数えている。`wConfigMissingNoNotice` の 6,693 本とは別の跡である。

#148 のモデルが壊れていないことも、同じ版で確かめた。

```sh
quint run taskFinishHook.qnt --main entryPoints --invariant safety \
  --witnesses hookRanForExceeded hookRanForPrFailed hookRanForDirectMerge \
    hookRanForInterrupted returnedWithoutSave \
  --max-samples 10000 --max-steps 12 --seed 0x2a
quint run taskFinishHook.qnt --main normalEndOnly --invariant safety --max-steps 12 --seed 0x8d
quint run taskFinishHook.qnt --main everySave --invariant safety --max-steps 12 --seed 0x224
quint test taskFinishHook_test.qnt --main entryPointsTest
quint test taskFinishHook_test.qnt --main normalEndOnlyTest
quint test taskFinishHook_test.qnt --main everySaveTest
```

`entryPoints` は 10,000 標本・12 ステップで違反なし。witness は `hookRanForExceeded` 188、`hookRanForPrFailed` 204、`hookRanForDirectMerge` 1,258、`hookRanForInterrupted` 1,424、`returnedWithoutSave` 2,082。`normalEndOnly` は `noMissedExit`、`everySave` は `atMostOnce` で `[violation]`（README の記録と同じ）。シナリオテストは `entryPointsTest` 9 件、`normalEndOnlyTest` 1 件、`everySaveTest` 1 件が通る。

### モデルが表していないこと

- 1 回の呼び出しと 1 つのタスクだけ。実際の `runTaskFinishHooks` は複数の名前を受け取り、警告は 1 回にまとめる。複数名の丸め（先頭 10 件）はモデルに無く、試験で確かめる。
- `withTaskFinishHook` の実行前後の読み、`terminalStamp`、実行そのもの、`runHook` の経路。**この設計ではモデル化していない。** #148 のモデルにも stamp と読みは無い（#148 が表すのはフックの位置と保存済み状態の不変条件である）。
- 実行前の読みが失敗したときの at-least-once のフック呼び出しと、その 1 回の警告。
- フックコマンドの結果（非 0・時間切れ・起動失敗）と `callHook` の reject。前者は #148 の `HookOutcome` が表すが、reject は #148 にも `taskFinishHookNotice.qnt` にも無い（§3 の `Promise.allSettled` と例外の警告はモデル外）。
- 設定の読みの失敗の phase 分岐、ロックの実際の待ち時間、`tasks.yaml` の壊れ方の種類。モデルでは `ConfigUnreadable` / `ReadTimeout` / `ReadBroken` の 3 つに抽象化した。設定の読みは再試行しない。
- 複数プロセスの同時実行、再キュー・retry の競合、フックの副作用の一部実行。`ReadNotTerminal` は「別のプロセスが状態を進めた」ことだけを表す。
- 警告の文面と秘密の伏せ方。`sanitizeSensitiveText` / `sanitizeTerminalText` の性質は PBT で確かめる。

## PBT・試験の計画

実装は別の担当。ここには、実装時に先に red を置く回帰テストと、性質の試験を書く。テストコードはこの設計には含めない。

### 先に red を置く回帰テスト

新しいユニットテスト `src/__tests__/task-finish-hook-notice.test.ts` を置く。`TaskRunner` は `listTaskStateItems` の結果と失敗を差し替えた偽物、`warn` は `vi.mock('../shared/ui/index.js')` で spy する。フックの起動は `runBoundedCommand` を spy するか、`callHook` の代わりに偽の `TaskRunner` と設定で観測する。

1. `runTaskFinishHooks` が `listTaskStateItems` のロック時間切れを 2 回受け取ると、`warn` が 1 回、タスク名 2 つを含み、フックは 0 回。直す前は `warn` 0 回（`log.error` だけ）。
2. `runTaskFinishHooks` が 1 回目にロック時間切れ、2 回目に成功すると、フックがちょうど 1 回。直す前は 0 回（再試行が無い）。
3. `runTaskFinishHooks` が `Invalid tasks.yaml` を受けると、再試行せず（読みは 1 回）、`warn` 1 回、フック 0 回。
4. `runTaskFinishHooks` が `loadProjectConfig` の例外を受けると、`warn` 1 回、`listTaskStateItems` は呼ばない、フック 0 回。文面が `config.yaml` を指し、phase が `'config-read'` であること（`tasks.yaml` の読み失敗と取り違えない）。
5. `runTaskFinishHooksForStates` が `loadProjectConfig` の例外を受けると、`warn` 1 回に終端タスクの名前、フック 0 回。文面が `config.yaml` を指し、phase が `'config-read'` であること。直す前は `warn` 0 回。
6. `runTaskFinishHooksForStates` に終端 1 件と非終端 1 件を渡し、設定読みが例外になると、`warn` の名前は終端の 1 件だけで、非終端の名前を含まない（§3-1 の契約）。
7. `runTaskFinishHooksForStates` で 1 件の `callHook` が投げ、別の 1 件が成功すると、成功したフックは 1 回、`warn` は投げたタスク名を含めて 1 回。直す前は `warn` 0 回で `Promise.all` が拒否される。
8. `withTaskFinishHook` の実行後の読みがロック時間切れを 2 回受けると、`warn` 1 回、実行の戻り値は変わらない。直す前は `warn` 0 回。
9. `withTaskFinishHook` の実行後の読みが 1 回目に時間切れ、2 回目に成功すると、フックが 1 回。直す前は 0 回。
10. **実行前の読みが失敗**し（`beforeReadFailed = true`）、実行後が終端になる。フックは 1 回呼ばれ、`warn` は「前の状態を読めなかったので、この実行が保存した状態でないのにフックが走ることがある」を 1 回出す。実行前の読みが成功して印が変わらない場合（非終端だった場合を含む）は、フック 0 回・`warn` 0 回（既存の `terminalStamp` の回帰）。
11. 設定が無いプロジェクトでは、`listTaskStateItems` を呼ばず、`warn` 0 回、フック 0 回（設定なしは取りこぼしではない）。設定はあるが `tasks.yaml` の読みが時間切れの場合は、別の試験で `warn` 1 回・フック 0 回を確かめる。
12. `withTaskFinishHook` の `callHook` が拒否するとき、キュー実行（`taskExecution.ts:126`）と `takt merge` の直接実行（`merge/index.ts:98`）の両方で `warn` 1 回。直す前は `log.error` だけで `warn` 0 回。
13. `setQuietMode(true)` と `--pipeline` の両方で、取りこぼしの `warn` が 1 回出る（stdout に混ざることを含めて確かめる）。
14. 警告のタスク名に改行・ANSI・引用符・Unicode を入れ、理由に既知の秘密（`sk-...`、URL の userinfo、`Bearer ...`）を入れる。`warn` の文面に生の制御文字と秘密が無く、`sanitizeTerminalText` / `sanitizeSensitiveText` を通した値だけがある。
15. 1,000 個のタスク名で読みが失敗すると、`warn` は 1 回で、先頭 10 件と「and 990 more」を含む。1,000 行の警告にしない。
16. 既存の `src/__tests__/it-task-finish-hook.test.ts` の「calls the command once after a completed task is saved」「runs again when a pr_failed task is saved as completed」「runs for each pending task that an aborted goal saves as failed」が、直した後も同じ回数・同じ環境変数で通る（回帰）。

旧 test 9（設定なしで読み失敗を作る）は空振りだったので、設定なしを確かめる test 11 と、設定あり＋読み時間切れを確かめる test 1 に分けた。設定なしでは `listTaskStateItems` を呼ばないこと自体を test 11 で確かめる。

試験はすべて **1 回の呼び出し** だけを見る。時間をおいた別の実行、同じタスクの再実行、同じ失敗の再発をまたいだ警告の重複排除は、この設計の保証外なので試験しない（`runTaskFinishHooks` は印を持たない）。

新しいユニットテスト `src/__tests__/task-finish-hook-notice.test.ts` は `tsconfig.tests.json` の `include` に**昇順で**登録する（同ファイルの規則。`test:types` が `tsconfig.tests.json` を読む）。登録したら `npm test -- src/__tests__/releaseVerificationWiring.test.ts` を単独で流す。新しい IT を足す場合は、`src/__tests__/it-task-finish-hook-notice.test.ts` に、本物の `TaskRunner` と `tasks.yaml.lock` を別プロセスが持つ状況を作り、1 回目の読みを時間切れにし、持ち主が放した後に再試行で成功してフックが 1 回呼ばれることを置く。5 秒の実時間待ちを含むので heavy IT になりうる。追加するなら `scripts/test-classification.mjs` と `tsconfig.tests.json` に登録し、`npm test -- src/__tests__/releaseVerificationWiring.test.ts` を流す。ユニットテストだけで足りるなら、この IT は足さない（実装時に判断する）。

### 性質の試験（fast-check）

`package.json` に `fast-check`（`^4.11.0`）がある。除外する入力集合は設けない。

1. **実行後の読みの結果の列**: `ReadTimeout` / `ReadBroken` / `ReadOk` / `ReadNotTerminal` の任意の列（長さ 1〜4）と、`Config` の任意の値、`Path` の任意の値から、呼び出しの結果を計算する。性質: (a) `ReadTimeout` は 2 回までしか試さず、3 回目を読まない。(b) フックは 0 回か 1 回。(c) `loss` のときはフック 0 回、`notices` 1 回。(d) `loss` でないときは `notices` 0 回。(e) `ReadBroken` の後は再試行しない。(f) `ConfigMissing` は `loss` でない。(g) `ReadNotTerminal` は `loss` でない。実行前の読みはこの性質の対象外（モデル外）。
2. **警告の回数と内容**: 任意のタスク名の配列（空、重複、制御文字、ANSI、引用符、Unicode、長い名前）と任意のエラー文面から、**1 回の呼び出しで** `reportLostHook` の警告を 1 回だけ出し、タスク名は `sanitizeTerminalText`、理由は `sanitizeSensitiveText` を通したものだけを含む。先頭 10 件と残り件数の丸めが正しい。既知の秘密（`sanitizeSensitiveText` の既存の PBT が使う既知の漏れ）が生で出ない。呼び出しをまたぐ重複排除は対象外。
3. **状態を変えない**: 任意の `TaskState` の配列と読みの失敗の入れ方で、`runTaskFinishHooks` / `runTaskFinishHooksForStates` の前後で `tasks.yaml` の内容と `TaskState` のオブジェクトが変わらない。フックの起動回数は、1 回の呼び出しでタスクごとに 0 か 1。
4. **再試行の待ちの上限**: 偽のタイマーで、`runTaskFinishHooks` と `runHook` の実行後の読みについて、時間切れが続くときに `setTimeout` が 1 回だけ 250 ms で呼ばれ、2 回目の失敗で終わる。設定の失敗と実行前の読みでは `setTimeout` を呼ばない。Quint は前者（`NamedHook`）だけを表す。
5. **実行前の読みの失敗（at-least-once）**: 実行前の `readTaskState` が失敗するか成功するか、実行後の状態が終端か非終端か、印が同じかを任意に作る。実行前が失敗して実行後が終端なら、フックは 1 回、`warn` は「前の状態を読めなかった」を 1 回。実行前が成功して印が同じなら、フック 0 回・`warn` 0 回。実行後が非終端なら、フック 0 回・`warn` 0 回。`warn` の回数は 1 回を超えない。
6. **出力モード**: `quietMode` と `pipelineMode` の任意の組み合わせで、`reportLostHook` の `warn` 呼び出し回数は 1 回のまま（0 回に落ちない）。

除外: 無し。実時間の 5 秒待ちは偽の `TaskRunner` と偽のタイマーで作る（heavy IT にしない）。

## 壊しうる入力・状況の一覧

| 区分 | 入力・状況 | 設計上の扱い |
|---|---|---|
| 時間切れ | `tasks.yaml.lock` を別のプロセスが 5 秒以上持つ | `isFileLockTimeoutError` なら 250 ms 後に 1 回だけ再試行。2 回目も時間切れなら 1 回警告し、フックは呼ばない。 |
| 時間切れ | #169 の「外し損ねた自分のロック」が残っている | 同じ取得の 5 秒の待ちループの中で 25 ms ごとに `recoverStaleLock` が走り、記録と一致して読めれば 1 回目の間に外れる。1 回目の間に読めなかった記録が 250 ms 後に読める場合だけ、再試行が助ける。外れなければ 2 回目も時間切れで警告。 |
| 破損 | `tasks.yaml` が壊れた YAML・スキーマ違反 | 再試行しない（`Invalid tasks.yaml` は決定的）。1 回警告。ファイルは触らない。 |
| 破損 | `config.yaml` が壊れた YAML・スキーマ違反 | 再試行しない。1 回警告。設定なしとは区別する。 |
| 権限・IO | `tasks.yaml` / `config.yaml` の EACCES・EIO・ENOSPC | 再試行しない。1 回警告。 |
| 設定なし | `task_finish_hook` が無い | 何もしない。警告も出さない（取りこぼしではない）。 |
| 同時実行 | 2 つのプロセスが同じ `tasks.yaml` を読み書きする | 読みはロックの下で行う。時間切れだけ再試行する。書き込みはしない。 |
| 再開・retry | 読みの間にタスクが再キューされ、非終端になる | フックは呼ばない。警告も出さない（範囲の外。別の試行の状態を古いフックで走らせない）。 |
| 再開・retry | 同じ終端状態で `runTaskFinishHooks` が 2 回呼ばれる | 1 回の呼び出しの中では 1 回。呼び出しをまたぐと 2 回警告しうる。既存の呼び出し元の責任。この設計は再送を追加しない。`withTaskFinishHook` は `terminalStamp` で同じ状態を弾く。 |
| 実行前の読み | 実行前の `readTaskState` が時間切れ・破損で失敗する | 再試行しない。実行後の読みが終端ならフックを 1 回呼び、at-least-once の警告を 1 回出す（二重に走る可能性を隠さない）。 |
| フック自体の失敗 | 非 0 終了・時間切れ・起動失敗 | 既存の `callHook` の警告（`emitStatusLog !== false`）。保存済みの状態は変えない。この設計では変えない。 |
| フック自体の失敗 | `callHook` が予期せず投げる | `runTaskFinishHooks` / `ForStates` は `Promise.allSettled` で集め、`withTaskFinishHook` は `runHook` の catch で 1 回報告し、外側の catch は漏れた例外だけを報告する。キュー実行と `takt merge` の両方で `warn` に出る。 |
| 大量のタスク | ゴールの中止で数百の pending を failed にし、設定が読めない | 警告は 1 回。先頭 10 件と「and N more」。フックは 0 回。 |
| 大量のタスク | 1,000 個のタスク名で読みが失敗 | 同上。名前の整形でメモリを食い尽くさない。 |
| 端末 | タスク名に制御文字・ANSI・改行・引用符 | `sanitizeTerminalText` を通す。 |
| 端末 | 例外文面に秘密（API キー、URL の userinfo、トークン） | `sanitizeSensitiveText` を通す。既存の伏せ方を変えない。 |
| 端末 | `warn()` が同期で投げる（閉じた stdout など） | 握りつぶし、`log.error` を試み、呼び出し元へは投げない。非同期のストリームエラーは対象外。 |
| 出力モード | `outputMode: 'silent'` / `emitStatusLog: false` | 通常のフック失敗の表示は今までどおり抑える。取りこぼしの警告は抑えない。 |
| 出力モード | `--quiet` / `minimalOutput` / `--pipeline` | `warn()` は `console.log` で stdout に出て quiet を見ないので、取りこぼしの警告は出す。`--pipeline` の stdout に混ざることは「影響」に書く。 |
| #170 との重なり | claim の setup 失敗で、manager 通知（#170）とフック設定（#171）が両方失敗する | 2 種類の警告が並ぶ。それぞれの「1 回」は自分の範囲内で、統合は別件。 |
| 並行 | `runTaskFinishHooks` が同じタスク名で同時に 2 回呼ばれる | 1 回の呼び出しごとに 1 回警告するので、2 回の呼び出しで 2 回出る。既存の呼び出し元の責任。この設計は追加の重複排除をしない（フックの二重実行を避けるため、再送はしない）。 |
| 時刻 | 再試行の 250 ms 待ちの間にプロセスが終わる | 待ちは上限つき。終了すれば警告は出ないが、プロセスの終了なので許容する。 |

## 影響

- **上流（`nrslib/takt`）**: 何も流さない。上流の `main` には `task_finish_hook` と `runTaskFinishHooks` が無い（`bba6f2315` で確認）。次の取り込みで `taskFinishHook.ts` が競合する可能性は低いが、フォーク側の機能なので、競合したらこの設計と Quint を見て解く。
- **保存されるデータ**: `tasks.yaml` のスキーマ、`config.yaml` のキー、`manager-inbox` の形式を変えない。フックの経路は `tasks.yaml` を読むだけで、書き込まない。再送の印も付けない。警告は端末（stdout）に出て、`--verbose` のときはデバッグログ（stderr）にも残る。
- **公開 API**: `runTaskFinishHooks` / `runTaskFinishHooksForStates` / `withTaskFinishHook` の引数と戻り値、`TaskFinishHookOptions`、`TaskRunner` の形を変えない。MCP の道具、`takt` のコマンド、環境変数を変えない。追加するのは `taskFinishHook.ts` の中の非公開のヘルパーと定数だけ。
- **守りの仕組み**: 秘密の伏せ方（`sensitive*.ts`）は変えず、新しい警告を `sanitizeSensitiveText` に通すだけ。タスク名は `sanitizeTerminalText`。ロックの順序（`epics.lock` → `goal.json.lock` → `goal-execution.lock` → `tasks.yaml.lock`）と排他は変えない。読みの再試行は新しい取得を 1 回増やすだけで、待ち続けない。
- **利用者に見えるもの**: フックが呼ばれなかったときに、既定で 1 回の警告が stdout に出る。`--quiet` でも `--pipeline` でも出る（`warn()` は `console.log` で、quiet を見ない）。manager の自動 run では、その stdout/stderr が `.takt/manager-logs/run-<uuid>.log` に向くため、そのファイルに残る（#168 の設計と同じ限界）。`--verbose` のときは `log.error` も stderr に出る。
- **`--pipeline` の stdout**: 取りこぼしの警告が、パイプラインの stdout を機械が読む出力に混ざりうる。失われた通知を隠さないことを優先して受け入れる。出力を分ける必要が出たら、将来の別件で stderr へ逃がすことを検討する（この設計では変えない）。
- **遅延**: ロック時間切れのときだけ、最悪で約 10.25 秒（5 秒 + 250 ms + 5 秒）を余分に待つ。フックの最大 60 秒に比べれば小さく、上限がある。

## 相対見積もり

| 範囲 | 大きさ | 基準と根拠 |
|---|---|---|
| 設計と Quint（本作業） | 2 | #170 の設計 + Quint を 3（daemon・スキーマ・複数経路）とした。本件は設計書 1 つと Quint のモデル 1 つ（約 180 行）で、保存するデータと公開 API を変えない。 |
| 実装と試験（設計レビュー後） | 3 | 変えるのは `taskFinishHook.ts` の 1 ファイルと新しいユニットテスト 1 ファイルだが、3 つの呼び出し経路、実行前の読みの at-least-once、`--quiet`/`--pipeline`、試験 16 件を含む。既存の `it-task-finish-hook.test.ts` は回帰としてそのまま使う。 |
| 全体（設計レビュー・CI を含む） | 3 | #169 の 8、#170 の設計 3 + 実装 5 より小さい。複数の呼び出し経路と警告の秘密の扱いがあるので 1 ではない。 |

## 決めずに残したこと

- 警告の文面の細部（英語の言い回し、どこまで理由を書くか）。実装時に既存の `callHook` の警告に合わせる。
- 再試行の回数と間隔（2 回・250 ms）は初期値。設計レビューで変えるなら、Quint の `MAX_READ_ATTEMPTS` / `MAX_RETRIES` と一緒に変える。
- 読みに成功した後の「非終端・見つからない」を警告するか。この設計では範囲の外にした（別の試行の状態を古いフックで走らせないため）。警告だけなら害は少ないが、自動再キューのたびに警告が出る可能性がある。
- フックの副作用を後から出し直す仕組み（印・daemon）を足すか。#170 の `completion_publication_pending` とは別の印が必要になり、二重実行の危険があるので、この設計では足さない。
- `--pipeline` の stdout に混ざる警告を stderr へ逃がすか。この設計では `warn()` の既存の出力先（stdout）を変えず、将来の別件にする。
- 同じタスク名で `runTaskFinishHooks` が時間をおいて何度も呼ばれたときに、警告をまとめるか。この設計ではまとめない（呼び出しごとに 1 回。印を持たないので、呼び出し元の責任）。
- 実時間のロック時間切れを使う heavy IT を足すか。ユニットテストで足りるなら足さない。

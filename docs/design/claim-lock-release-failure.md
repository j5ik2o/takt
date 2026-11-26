# 書き込みの後にロックの解放が失敗しても、書いた結果を捨てない（項目417）

issue: https://github.com/j5ik2o/takt/issues/169 （https://github.com/j5ik2o/takt/pull/168 の設計 `docs/design/goal-task-claim-setup-failure.md` の「別件」の1）

基点: `integration/takt-mcp`（`ce641a0ce`）。上流 nrslib/takt の main（`bba6f2315`）と開いている PR（7件）に、同じ直しは無い。上流の `file-lock.ts`・`private-file-lock.ts`・`claimNextTasks` も、解放の失敗をそのまま投げる。

Quint: `specs/quint/claim-lock-release/`。

設計レビュー: `~/.orca/bots/takt/memory/reports/2026-11-27-169-design-review.md`（1回目、結論「条件つき」、高2・中3・低3）と `~/.orca/bots/takt/memory/reports/2026-11-27-169-design-review-2.md`（再レビュー、結論「条件つき」、高0・中2・低7。1回目の高・中は閉じた）。指摘ごとの扱いは末尾の「設計レビューの指摘と扱い」に書いた。

再レビューを受けて変えた節: 3-1（解放の action の例外、回収の分け方）、3-3、4節、「守る不変条件」、「Quint」、「PBT の性質」の3、「壊しうる入力」、「試験」の7・10、「設計レビューの指摘と扱い」（再レビューの表を足した）。

## 何が起きているか

tasks.yaml の書き込みは、`goal-execution.lock`（`private-file-lock.ts`）と `tasks.yaml.lock`（`file-lock.ts`）の下で行う（`failInterruptedRunningTasks` だけは `tasks.yaml.lock` だけを取る）。書き込みが済んだ後に、どちらかのロックの解放がうまくいかないことがある。

- `tasks.yaml.lock`: `withFileLock` の `finally` の `unlinkSnapshot`（`file-lock.ts:167`）。`unlink` の EIO・EACCES・EPERM・EBUSY は例外になる。ところが、ロックのファイルを開くときの EACCES・EPERM と、読むときの例外（EIO など）は、`readSnapshot`（`file-lock.ts:61-84`）が握りつぶして `content: undefined` を返す。`unlinkSnapshot` はそれを「中身が違う＝自分のものではない」とみなし、`unlink` も例外もなしに戻る（`file-lock.ts:88-89`）。ロックのファイルは残り、誰にも知らされない（設計レビュー 高-2）。
- `goal-execution.lock`: `releasePrivateFileLock`（`private-file-lock.ts:200`）。読み直しか `unlink` の失敗、またはロックのファイルが消えたか置き換わっていたときの「Private file lock ownership changed before release」。`readPrivateFileState` は読みの失敗を投げるので、`file-lock.ts` のような握りつぶしは無い。両方の解放が失敗すると `AggregateError` になる。

解放の例外は、書いた結果を使う処理より先に、呼び出し元へ出る。同じ形の処理が4つある。

| 処理 | 書いた後に失われるもの |
|---|---|
| `TaskLifecycleService.claimNextTasks` | claim したタスクが返らない。自分を持ち主とする running のまま、どのキューにも入らない。setup の失敗の `onSetupFailed`（終了フックと manager の知らせ）も呼ばれない。claim は `preparationFailure` で止まり、run は失敗で終わる。 |
| `failInterruptedRunningTasks`（run と watch の始め） | failed（interrupted）にしたタスクの `onRecovered`（manager の知らせ）が呼ばれない。次の回には、もう running ではないので拾われない。run の始めが失敗する。 |
| `invalidatePendingGoalTasks`（ゴールの中止。MCP と manager） | failed にした pending のタスクの終了フックが呼ばれない（`invalidatePendingGoalTasksWithFinishHook` の `runTaskFinishHooks` に届かない）。 |
| `reconcileLostRun`（daemon） | failed にしたタスクの `saveManagerEvent` が呼ばれず、manager が起きない。次の観測では、もう running ではないので拾われない。 |

さらに、issue に書かれていない問題が2つある。

1. 解放に失敗して残ったロックのファイルは、生きている自分のプロセスを持ち主として名指しする。自分が次に同じロックを取ろうとすると、自分を待って時間切れになる（`recoverStaleLock` も `recoverUnchangedDeadHolder` も、持ち主が生きていれば外さない）。ほかのプロセスも、自分が終わるまで待たされる。
   - `takt run` では、今は claim が止まってプロセスが終わるので、待ちは長く続かない。ただし、上の握りつぶしで黙ってファイルが残ったときは、claim が止まらないので、次の claim から自分を待ち続ける。
   - daemon や MCP のサーバーのように長く生きるプロセスでは、そのプロセスが生きている間ずっと、自分もほかのプロセスも `goal-execution.lock` か `tasks.yaml.lock` を取れない。
   - issue の案 (a)（claim したタスクを返して `warn()` する）だけを入れると、`takt run` も止まらずに生き続け、次の claim で自分を待つ。2つのロックの時間切れは再試行の対象（#91・#168）なので、`claimRetryAt` が毎回立ち、`takt run` が終わらなくなる（Quint の `returnOnly` の `noSelfWait` の反例）。
2. 終了フックは、名前を受け取って tasks.yaml を読み直してから呼ぶ（`runTaskFinishHooks` → `listTaskStateItems` → `TaskStore.read`、`taskFinishHook.ts:137`）。この読みも `tasks.yaml.lock` を取る。解放に失敗したファイルが残っていると、この読みが自分を待つか、外せずに例外になり、`runTaskFinishHooks` はそれを `log.error` に残すだけで、フックは1回も呼ばれない（`taskFinishHook.ts:140-141`。既定では画面に出ない）。claim の setup の失敗と中止の両方が、この経路を通る（設計レビュー 高-1）。

このため、(a) に加えて、外し損ねたロックを自分で外す仕組み（3節）と、終了フックに保存した状態をそのまま渡す形（2節）を、いっしょに入れる。

## 何をどう変えるか

### 1. 書き込みが済んだことを呼び出し元が知る

- `TaskStore.update` の options に `onWritten?: () => void` を足す。`writeUnsafe` が返った直後、`tasks.yaml.lock` を持ったまま呼ぶ。`mutator` が `undefined` を返して何も書かないときは呼ばない（4か所のうち、そうなりうるのは `failInterruptedRunningTasks` と `reconcileLostRun` だけ。`claimNextTasks` と `invalidatePendingGoalTasks` は対象が0件でも `{ tasks }` を返して書く）。
- 書き込みの確定点は `writeAtomic` の `renameSync`。今は rename の後にも、後片付けで一時ファイルの `unlinkSync` を呼ぶ（`private-file.ts:162-164`。rename の後なので ENOENT になり、無視される）。NFS や FUSE が ENOENT ではない例外を返すと、書いたのに `writeUnsafe` が例外を出す。後片付けの条件を `created && (!published || rejectExisting)` に変え、rename が済んだ一時ファイルには `unlinkSync` を呼ばない（設計レビュー 低-3）。`rejectExisting`（`linkSync` の経路）では、今までどおり一時ファイルを消す。これで「`writeUnsafe` が返った」と「書いた」が一致する。
- `onWritten` の後に呼び出し元へ出る例外は、2つのロックの解放から出たものだけになる（`store.update` の `return`、`withFileLock` の `finally`、`runWithAcquiredLock` の解放）。下の4か所は、この印が立った後の例外を「書いた後の解放の失敗」として扱う。
- #168 の `writeStarted`（`mutator` に入った印。時間切れを再試行に回すかを決める）は残す。`writeStarted` が立っていて `written` が立っていない失敗（`mutator` か書き込みの中の失敗）は、今と同じく投げる。

### 2. 4か所で、書いた結果を捨てない

| 処理 | 書いた後に解放が失敗したとき |
|---|---|
| `claimNextTasks` | 警告してから、`onSetupFailed` を各タスクに呼び、claim したタスクを返す。再試行には回さない。 |
| `failInterruptedRunningTasks` | 警告してから、`onRecovered` を各タスクに呼び、件数を返す。 |
| `invalidatePendingGoalTasks(goalId, onInvalidated?)` | 第2引数を足す。書いた後に、failed にした各タスクの `TaskState` で `onInvalidated` を呼び、そのあと解放の例外を投げる。 |
| `reconcileLostRun` | 書いた後なら `saveManagerEvent` を出してから、解放の例外を投げる。`saveManagerEvent` も失敗したら、両方を `AggregateError([saveError, releaseError])` にして投げる（設計レビュー 低-2）。 |

警告（`claimNextTasks` と `failInterruptedRunningTasks`）は、`TaskLifecycleService` の1つの関数 `warnLockReleaseAfterWrite` で出す。`onWarning` に渡し、あわせて `log.warn` にも残す（`TaskLifecycleService` に `createLogger('task-lifecycle')` を足す。`onWarning` を渡さない呼び出しでも、debug のログには残る。設計レビュー 低-1）。`onWarning` が例外を投げたら握りつぶし、書いた結果は返す（#168 の `warnSetupFailureReport` と同じ）。文面は `sanitizeSensitiveText` を通し、`AggregateError` は中の例外ごとに並べる。

```text
Saved .takt/tasks.yaml, but releasing a lock afterwards failed: <detail>. This process removes the lock file the next time it takes that lock; until then other TAKT processes wait for it.
```

知らせ方を2つに分ける理由:

- claim と run の始めの回復は、返した値を run がそのまま使う。`takt run`・`takt watch`・`selectAndExecute` はどれも `TaskRunner` に `onWarning: warn` を渡しているので、警告は端末に出る。
- 中止と daemon の回復は、1回きりの操作で、例外は今も呼び出し元に届いて見える（MCP の道具のエラー、manager のコマンドのエラー、daemon のターンの失敗）。これらの `TaskRunner` は `onWarning` を持たない。知らせと終了フックを済ませてから投げれば、何も失わずに、今と同じ形で見える。中止はもう一度呼んでも同じ結果になる（pending がもう無い）ので、呼び出し元がやり直しても害は無い。

`claimNextTasks` の今の `catch` は次の形になる。

```ts
} catch (error) {
  if (written) {
    this.warnLockReleaseAfterWrite(error);
  } else if (!writeStarted && error instanceof PrivateFileLockTimeoutError) {
    throw new TaskClaimLockAcquisitionError(error.message, 'TIMEOUT', { cause: error, lock: 'goal-execution' });
  } else {
    throw error;
  }
}
```

終了フックには、保存した状態をそのまま渡す（設計レビュー 高-1）。

- `taskFinishHook.ts` に `runTaskFinishHooksForStates(projectCwd, states: readonly TaskState[], options?)` を足す。tasks.yaml を読み直さず、渡された状態のうち terminal のものに `callHook` を呼ぶ。`loadProjectConfig` は今と同じく1回読む（`config.yaml` で、`tasks.yaml.lock` は取らない）。例外を投げないことも、今の `runTaskFinishHooks` と同じ。
- `onSetupFailed` と `onInvalidated` に渡る `TaskState` は、どちらも書いた `TaskRecord` から `toTaskState` で作ったもので、フックの環境変数（`buildHookEnv`）に要るもの（status・completedAt・runSlug・goalId・failure など）を持つ。
- `claimTasksWithGoalCompletions` は、名前の配列 `setupFailedTaskNames` の代わりに、状態の配列 `setupFailedTasks: TaskState[]` を返す。`claimAvailableTasks`（`parallelExecution.ts:348-351`）は、それを `runTaskFinishHooksForStates` に渡し、`failCount` と `executedTaskNames` には `.name` を使う。
- `invalidatePendingGoalTasksWithFinishHook` は、`onInvalidated` で状態を集め、`finally` で `runTaskFinishHooksForStates` を呼ぶ。中止の前に pending を読んでおく今の形（`pendingNames` を作る `listTaskStateItems()`）はやめる。書き込みの前に失敗したときは、集まった状態が0件なので、フックは呼ばれない。
- 名前を受け取って読み直す `runTaskFinishHooks` は残す（`taskPullRequestActions.ts:269` の `pr_failed` の経路が使う。この経路は書き込みと別の呼び出しで、この直しの外）。

`onInvalidated` が例外を投げたときは捕まえず、そのまま投げる（解放の失敗より先に出る）。呼び出し元の `onInvalidated` は配列に積むだけで、投げない（設計レビュー 低-1。採らない）。

### 3. 自分が外し損ねたロックを、次に取るときに外す

外し損ねたロックのファイルを、プロセスの中に記録する。次に同じパスのロックを取るとき、そこにあるファイルが記録とまったく同じなら、持ち主が生きている（自分である）ことを理由に待たずに外す。

#### 3-1. `file-lock.ts`（`tasks.yaml.lock`）

- 解放で読めない自分のファイルを、黙って残さない（設計レビュー 高-2）。`readSnapshot` は、開くときの EACCES・EPERM・EIO と読むときの例外を、`content: undefined` に加えて `readError` として返す（開くときの EIO は PR #182 の CodeRabbit の指摘で足した。投げると、記録した自分のファイルを一度開けなかっただけで claim が止まり、中-B と同じ穴になる。他人のロックの扱いは今のまま。読めない他人のロックは、`STALE_MS` を過ぎてから回収する）。解放（`withFileLock` の `finally`）は、`unlinkSnapshot` の代わりに `releaseLock(path, acquired)` を呼ぶ。
  - ファイルが無い: 何もしない（今と同じ。ロックは残っていない）。
  - dev・ino が取ったときと違う: 置き換わったので、何もしない（今と同じ）。
  - dev・ino が同じで、読めない（`readError` がある）: `readError` を投げる。
  - dev・ino が同じで、中身が同じ: `unlinkSync`。ENOENT 以外の失敗は投げる（今と同じ）。
  - dev・ino が同じで、中身が違う: 自分のファイルを誰かが書き換えた。今と同じく何もしない。
- action と解放の両方が投げたとき（再レビュー 低-4）: 今は `finally` から投げた解放の例外が、action の例外を上書きする（`file-lock.ts:164-168`）。解放が `readError` を投げる場面が増えるので、`private-file-lock.ts` の `combineLockActionErrors` と同じく、`AggregateError([actionError, releaseError])` にして投げる。action だけが投げたときと、解放だけが投げたときは、今と同じくその例外をそのまま投げる。書き込みの前の失敗の分類は変わらない（どちらにしても投げる。`AggregateError` は再試行に分類されない）。
- 記録: モジュールの中に `orphanedLocks: Map<string, LockSnapshot>` を置く。キーは `withFileLock` の冒頭で作る `resolve(lockPath)`（`file-lock.ts:152`）。`releaseLock` が例外を出したら、取ったときの `acquired`（dev・ino・中身）を記録してから投げる。
- 回収: `recoverStaleLock` は、そのパスに記録があれば、`removeRecordedLock(path, record)` を呼ぶ。これは `unlinkSnapshot` を使わない。`unlinkSnapshot` は読み直しに失敗すると黙って戻るので、外せたかが分からない（再レビュー 中-A）。`removeRecordedLock` は1回読み、`releaseLock` と同じ場合分けで決め、「外した」「待つ」「記録と違う」のどれかを返す。
  - ファイルが無い: 記録を消し、「外した」を返す（すぐ取り直す）。
  - dev・ino・中身が記録と一致する: 持ち主の生死を見ずに `unlinkSync` を呼ぶ。成功したか ENOENT なら、記録を消し、「外した」を返す。ENOENT 以外の失敗は、記録を残したまま投げる（3-3）。
  - dev・ino が一致して読めない（`readError` がある）: 投げない。記録を残し、「待つ」を返す（再レビュー 中-B）。`recoverStaleLock` は、読めないロックの今の規則に戻る（`STALE_MS` を過ぎるまで待ち、過ぎたら `unlinkSnapshot` で外そうとする。`file-lock.ts:103-108`）。待ちのループの次の回（25 ミリ秒後）に読めれば、記録と照合して外す。`STALE_MS` は回収を試み始めるしきい値で、回収が済むことは保証しない（3-3）。
  - それ以外（置き換わった、中身が違う）: 記録を消し、「記録と違う」を返す。`recoverStaleLock` は今の回収の判定に進む。
  - 外せたかどうかは `unlinkSync` が成功したかだけで決める。記録を消すのは、外せたときと、ファイルが無いか別のものになったと読めたときだけで、読めなかったときは消さない。
  - `unlinkSnapshot` の黙った振る舞いは、死んだ持ち主と古いロックの回収（他人のファイル）で今までどおり使う。
- 直接取れたら記録を消す（設計レビュー 中-1 の2）。`acquireLock` の `linkSync` が成功したら、そのパスの記録を消す。外し損ねた後に人がファイルを消し、次の取得が `EEXIST` なしで取れた場合に、古い記録が残らない。`file-lock.ts` の中身は同じプロセスなら毎回同じ（`{ pid, processIdentity }`）なので、古い記録が残ると、消した後に同じ inode で作られた次のファイルと一致しうる。取得の成功のたびに消せば、自分の中身を書いたファイルが記録と並んで存在するのは、自分が外し損ねたときだけになる（自分の中身を書くのは、このプロセスの取得だけ）。
- 外した直後は待たない（設計レビュー 中-1 の3）。`acquireLock` の待ちのループで、`recoverStaleLock` が「自分のものを外した」と返したら、期限の判定（`file-lock.ts:129-134`）と `Atomics.wait` の前に、1回だけすぐ取り直す。`timeoutMs: 0` や期限の際でも、外した直後に時間切れにならない。2回目以降は今のループに戻る。

#### 3-2. `private-file-lock.ts`（`goal-execution.lock` ほか）

- 記録: モジュールの中に `orphanedLocks: Map<string, AcquiredPrivateFileLock>` を置く。キーは `resolve(lockPath)` で、記録と照合の両方で同じ関数を通す（設計レビュー 中-1 の1。今は `readPrivateFileState` の中でだけ `resolve` している）。
- 解放の分け方（設計レビュー 中-1 の4）: `releasePrivateFileLock` を次の形に分ける。
  - `removeLockIfUnchanged` が `true`: 外せた。
  - `false`（ファイルが無いか、置き換わった）: 自分のものではないので記録せず、今と同じ「ownership changed before release」を返す。
  - 例外のうち `PrivateArtifactPublicationConflictError`（読む間にファイルが変わった）: 置き換わりとみなし、記録せずに返す。
  - それ以外の例外（読みか `unlink` の失敗）: 記録してから返す。
- `readPrivateFileState` は読みの失敗を投げるので、3-1 の握りつぶしにあたるものは無い。
- 回収: `recoverUnchangedDeadHolder` は、そのパスに記録があり、読んだ状態（dev・ino・中身の SHA-256）と中身が記録と一致すれば、`removeLockIfUnchanged` を呼ぶ。外せたら記録を消し、「自分のものを外した」と返す。失敗はそのまま投げる。ファイルが無いか置き換わっていれば、記録を消す。
- 直接取れたら記録を消す: `tryAcquirePrivateFileLock` が取れたら、そのパスの記録を消す。中身には取得ごとにランダムな `token` が入るので、同じ inode で誤って一致することはもともと無いが、記録を残さないために消す。
- 外した直後は待たない: `acquirePrivateFileLock` と `runPrivateFileExclusiveAsync` のループで、自分のものを外したときは、`assertLockDeadline`・`waitForLock`・`onWait`・`setTimeout` の前に、1回だけすぐ取り直す。

#### 3-3. 共通

- 記録と一致したファイルの `unlink` が失敗したら、その例外をそのまま取得の失敗として投げる（今の死んだ持ち主の回収と同じ扱い）。claim では分類されない例外なので `preparationFailure` になり、run は失敗で終わる。何度やっても外せないロックのファイルを、時間切れの再試行で待ち続けることはなくなる。
- 記録と一致するかを読んで確かめられないときは、投げずに待つ（3-1）。一度読めなかっただけで claim を止めない。待ちのループの1回には読みが2つある（`recoverStaleLock` の最初の読みと、外す直前の読み直し）。両方とも読めた回は、記録と照合して外す。`STALE_MS` を過ぎた後は、両方とも読めなかった回も、記録の無いファイルと同じ規則（`unlinkSnapshot`）で外す。片方だけが読めなかった回は外さない。最初の読みが失敗して読み直しが通ると、`unlinkSnapshot` は中身が違うとみなして戻る（PR #182 の CodeRabbit の指摘）。だから `STALE_MS` は回収を試み始めるしきい値で、待ちの上限ではない。毎回どちらか片方だけが読めない状態が続けば、取得は時間切れ（再試行の対象）を繰り返す。確かめられない自分のファイルを外さないための待ちで、`noSelfWait` の例外（`UnreadableWait`）はこの待ちを指す。
- `private-file-lock.ts` の `removeLockIfUnchanged` は真偽を返し、読みの失敗を投げる。3-1 の中-A の穴は無い。読みの失敗は今と同じく投げる（`private-file-lock.ts` の取得は、今も読みの失敗を投げる。これを待ちに変えるのは、記録の有無にかかわらない別の話なので、この直しの外）。
- 解放と回収は、同期の `runPrivateFileExclusive` と非同期の `runPrivateFileExclusiveAsync` で共通なので、両方に効く。

これで守れること:

- 外すのは、自分が作って外し損ね、記録したファイルだけ。記録はプロセスのメモリにしかない。別のプロセスや別のスレッドのロック、自分の pid を書いた他人のファイル（試験の fixture）、外し損ねた後に置き換わったファイルは、どれも一致しないので外さない。
- 記録したファイルは、その時点で誰も持っていない（取った本人が手放した後のもの）。`file-lock.ts` は同期で、同じパスを入れ子で取れない（`heldLocks`）。`private-file-lock.ts` の非同期の取得は、取得ごとにランダムな `token` を中身に書くので、同じプロセスの別の取得のファイルとは中身が違う。
- 生きている別の持ち主のロックを外さないこと、死んだ持ち主のロックを回収すること、ロックを取る順の階層（`epics.lock` → `goal.json.lock` → `goal-execution.lock` → `tasks.yaml.lock`）、ロックのファイルの書式は、どれも変えない。

### 4. 範囲の外（変えないもの）

- 読み取り（`TaskStore.read`・`listTaskStateItems`）の後の解放の失敗。`unlink` の失敗は今と同じく投げる。解放のときに自分のファイルを読めない場合（`Unseen`）は、今は黙って戻るが、3-1 の後は `readError` を投げるようになる（再レビュー 低-1）。claim の最初の読み（`claimTasks.ts:38`）で起きると、一時的な失敗でも claim は止まる。黙ってファイルを残し、自分を待ち続ける今よりはよい。何も書いていないので失われるものは無く、3節の記録で、次の取得からは自分を待たない。読みの後の解放の失敗を、止めずに警告にするのは別件にする。Quint の `stopsOnlyWhenUnlinkFails` が守るのは書き込みの経路だけである（設計レビュー 低-2）。
- 上の4つ以外の書き込み（`GoalStore.update`、`autoRun`、merge のタスクの作成、タスクの完了の書き込みなど）の解放の失敗。今と同じく投げる。3節の記録で、プロセスが自分を待ち続けることはなくなる。ただし `file-lock.ts` の `Unseen` は、今は黙って戻るので、これらの書き込みでも新たに投げるようになる。そのうち、書いた後の例外で書いた結果を捨てる次の2か所は、PR #182 のレビュー（Devin）を受けて範囲に入れ、2節と同じ形で直す。
  - タスクの追加（`saveEnqueuedTaskFile` の `publish`、`enqueuedTaskFile.ts`）: `addTask` が投げると、指示書のディレクトリを消す（`cleanupTaskSpecDirectory`）。書いた後なら消さずに投げる。tasks.yaml のタスクは実行できるまま残る。
  - ゴールの中止・再開（`setGoalExecutionStatus`、`goals/execution.ts`）と呼び出し元（`goalExecutionOperations.ts` の `changeGoalExecution`、`conversationService.ts` の `pause_goal`・`resume_goal`・`abort_goal`）: `goal.json` を保存した後に投げると、`deleteGoalEvents`・`resumed` の知らせ・pending の無効化と終了フック・manager の起動が呼ばれない。中止はもう一度呼んでも遷移が済んでいるので取り返せない。保存した後なら、これらを済ませてから解放の例外を投げる（`reconcileLostRun` と同じ）。
- 自分が外し損ねたロックを、自分が次に取るまでは、ほかのプロセスが待つこと。自分が終われば、死んだ持ち主のロックとして回収される。待ちの長さは、自分の次の取得か終了までになる（Quint の `otherWaitsUntilOwnerRecoversTest`）。claim を止めた `takt run` は、実行中のタスクが終わるまで生きている（`parallelExecution.ts:257-259`）ので、その間はほかのプロセスが待つ。
- 外し損ねた直後に、すぐもう一度外してみること。次の取得で外すので、足さない。長く生きて、しばらくロックを取らないプロセス（道具の呼び出しを待つ MCP のサーバーなど）が外し損ねると、ほかのプロセスはその間ずっと待ち、`takt run` は時間切れの再試行を続ける（再レビュー 低-7）。今のコード（そのプロセスが終わるまで外れない）より悪くはならない。直後に1回だけ試しても、EIO や EACCES はすぐには直らないことが多く、待ちを縮める確かな手にならない。持ち主が生きているロックの待ちに上限を設けるのは、排他の規則を変えるので別件にする。
- `writeAtomic` の link の経路（`rejectExisting`。`goal-execution.lock` の取得で使う）で、link が成功した後の一時ファイルの後片付けが ENOENT 以外で失敗すると、自分の token を書いたロックが公開されたまま取得が例外になり、記録もされない（`private-file.ts:146-149` と `:162-164`、`private-file-lock.ts:122-129`）。次の取得は生きている自分を待つ。取得の側の穴で、解放の失敗とは別の経路なので、別件にする（再レビュー 低-6）。
- 同じロックを、symlink を通した別のパス（macOS の `/var/...` と `/private/var/...` など）で取ること。キーは `resolve` だけで、`realpath` は取らない。どちらのロックも呼び出し元は同じ `cwd` から作ったパスを渡す。取得のたびに `realpath` を呼ぶ費用に見合わない（設計レビュー 低-3。採らない）。
- `runTaskFinishHooks` の中の読みの失敗が `log.error` だけになること（#168 の「別件」の3）。2節で、書き込みの直後の終了フックはこの読みを通らなくなる。読み直す経路として残るのは、`pr_failed` の経路（`taskPullRequestActions.ts:269`）と、タスクの完了の後の `withTaskFinishHook` の `runHook`（`taskFinishHook.ts:114` の `readTaskState`）で、どちらも別件のまま（再レビュー 低-1）。
- #168 の「別件」の2（失われた知らせの出し直し）。

## 守る不変条件

Quint の `safety` は次の9つの連言で、`fixed` で違反が無い。

1. `noOrphanRunning`: p が running と書いたタスクは、p のキューに入っている。例外は、ロックのファイルが外せずに p が止まった場合だけ（何も書けないので、p が終わった後に interrupted として回収される）。
2. `queuedByOwnerOnly`: タスクをキューに入れるのは、claim したプロセスだけ。
3. `noLostNotice`: 処理が failed と書いたタスクは、解放の成否にかかわらず、終了フック（claim の setup の失敗と中止）と manager の完了の知らせ（claim の setup の失敗と回復）が、それぞれちょうど1回出る。
4. `noDuplicateNotice`・`noFalseNotice`: どちらも多くとも1回で、それを要する処理が failed と書いたタスクにだけ出る。
5. `releaseFailureReported`: 書いた後にロックがきれいに外れなかったこと（読めない自分のファイルを含む）は、警告か呼び出し元への例外で必ず出る。黙って捨てない。
6. `noSelfWait`: どのプロセスも、自分が外し損ねたロックのファイルを待たない。例外は、記録したファイルが読めない間の待ちだけ（モデルの `UnreadableWait`）。`STALE_MS` を過ぎると回収を試みるが、回収が済むのは、待ちの1回の2つの読みが両方とも通るか、両方とも失敗した回である（3-3）。
7. `stopsOnlyWhenUnlinkFails`: 書き込みの経路で claim が止まるのは、ロックのファイルが外せないときだけ。一度読めなかっただけでは止まらない。
8. `noFalseCleanEnd`: `takt run` は、自分が running と書いたタスクを実行しないまま、正常には終わらない。

実装の側では、さらに次を守る。

- 書き込みの前の失敗は、今のまま扱う（時間切れと ENOSPC は再試行、ほかは投げる。tasks.yaml は変わらない）。`mutator` の中で出た `PrivateFileLockTimeoutError` は、再試行に回さず、警告にもせず、そのまま投げる（`writeStarted` かつ `written` でない）。
- 書き込みの後の例外は、どの型でも再試行に回さない（#168）。
- 書いた結果（返すタスク、`onSetupFailed`・`onRecovered`・`onInvalidated` に渡るタスク、manager の知らせ、終了フックに渡る状態）は、解放の成否で変わらない。
- 書き込みの直後の終了フックは、`tasks.yaml.lock` を取らない。
- ロックのファイルを外すのは、生きていない持ち主のものか、このプロセスが記録したものと dev・ino・中身がすべて一致するものだけ。記録は、`unlinkSync` で外せたとき、無かったとき、置き換わっていたと読めたとき、同じパスを直接取れたときに消える。読めなかったときは消さない。

## Quint

`specs/quint/claim-lock-release/`。2つの `takt run`（A・B）と、長く生きる manager／daemon（M）が、tasks.yaml とロックを共有する。2つのロックは同じ書き込みを囲んで同じ形で解放するので、モデルでは1つにまとめた。何をモデルにして何を外したかは README に書いた。

この版で足したもの（設計レビュー 高-1・高-2）:

- 解放の結果に `Unseen`（解放が自分のロックのファイルを開けないか読めず、ファイルが残る。後で読めるようになる）を足した。`Fixed` より前の版では、例外も記録もなしに戻る。
- 終了フックと manager の知らせを分け（`hooks`・`events`、要るものは `needHook`・`needEvent`）、`Fixed` より前の版の終了フックは、書いた直後に tasks.yaml を読み直す（その時点のロックの状態で取得を試み、取れなければフックは落ちる）。
- 版 `firstDesign`（レビューを受けた最初の設計、`237703e8e`）を足した。

再レビューで足したもの（再レビュー 中-A・中-B）:

- 記録した自分のファイルを回収するときの、一時的な読みの失敗（`Glitch`）。`FirstReadFails` は `recoverStaleLock` の最初の読み、`SecondReadFails` は外す直前の読み直しで、次の読みは成功する。
- 取得の結果に、`UnreadableWait`（記録を残して待つ。読めない間だけの待ちなので自分待ちに数えない。`STALE_MS` からは回収を試みる）、`RecordLost`（外さずに記録を消し、以後は自分を待つ）、`ReadFailed`（読みの例外を投げ、claim が止まる。止まった理由は `ReadStop`）を足した。
- 版 `secondDesign`（1回目のレビューを反映した設計、`b82a56d2a`）を足した。`FirstReadFails` で `ReadFailed`、`SecondReadFails` で `RecordLost`（`unlinkSnapshot` が黙って戻り、外せたとみなす）になる。`firstDesign` は、どちらでも `RecordLost`（読めないファイルを「中身が違う」とみなして記録を消す）になる。`fixed` は、どちらでも `UnreadableWait` になる。

| 版 | 中身 |
|---|---|
| `current` | 今のコード（`ce641a0ce`）。#168 の `fixedReleaseFails` にあたる。 |
| `returnOnly` | issue の案 (a) だけ。書いた結果は捨てないが、外し損ねたロックのファイルは残る。 |
| `firstDesign` | 最初の設計。外し損ねたファイルを記録して外すが、読めない自分のファイルは黙って残り、終了フックは tasks.yaml を読み直す。 |
| `secondDesign` | 1回目のレビューを反映した設計。回収の読みが一度失敗すると、claim が止まるか（中-B）、記録を失って自分を待つ（中-A）。 |
| `fixed` | この設計。 |

| 検査 | 結果 |
|---|---|
| `quint test`（`currentTest` 7件、`returnOnlyTest` 3件、`firstDesignTest` 4件、`secondDesignTest` 4件、`fixedTest` 14件） | 32件すべて通る。 |
| `quint run`（9つの不変条件 × 5つの版、3,000 標本、12 ステップ、seed 0x2a） | `current` は `noOrphanRunning`・`noLostNotice`・`releaseFailureReported`・`noSelfWait`・`stopsOnlyWhenUnlinkFails` が破れる（`noFalseCleanEnd` は保たれる。run は失敗で終わる）。`returnOnly` と `firstDesign` は `noLostNotice`・`releaseFailureReported`・`noSelfWait` が破れる。`secondDesign` は `noOrphanRunning`・`noSelfWait`・`stopsOnlyWhenUnlinkFails` が破れる（`noOrphanRunning` は、読みの失敗で止まった run の claim したタスクが残るため）。`fixed` は9つとも違反なし。 |
| `quint run --main fixed --invariant safety`（10,000 標本、15 ステップ、witness 13個） | 違反なし。witness はすべて到達（最少は `wRunEndedAfterReleaseFailure` の 671 本、`wTaskRanAfterReleaseFailure` 1,844 本、`wSelfRecovered` 3,101 本、`wUnseenReported` 4,223 本、`wWaitedOnUnreadableOwn` 4,641 本、`wHookAfterStuckForGood` 4,855 本）。`wTaskRanAfterReleaseFailure`・`wRunEndedAfterReleaseFailure` は、解放に失敗した claim がキューに入れたタスク（ghost の `heldAfterReleaseFailure`）の実行と、その run の正常終了に結び付けた。`wUnseenReported` は、最後の解放（ghost の `lastRelease`）が `Unseen` で、報告され、残したファイルが記録された状態に結び付けた（PR #182 の Devin・CodeRabbit の指摘）。 |
| `quint verify --main fixed --invariant safety --max-steps 5` | 違反なし（118 秒）。下の反例はどれも3手以内。`Glitch` で分岐が増えたので、6手（前の版は 282 秒）は流していない。 |
| `quint verify --max-steps 4` で反例が出ることの確かめ | `secondDesign` の `noSelfWait`・`stopsOnlyWhenUnlinkFails`、`firstDesign` の `noLostNotice` で反例が出る（各7〜8秒）。前の版では `firstDesign` の `releaseFailureReported`・`noSelfWait`、`current` の `noOrphanRunning`、`returnOnly` の `noSelfWait` でも確かめた。verify が空振りでない。 |

直す前の形での反例:

- `currentTest.claimReleaseFailureOrphansClaimTest`: claim が t1 を running、t2 を failed と書いた後に解放が失敗する。t1 はキューに入らず、t2 は知らされず、claim が止まる。
- `currentTest.unreadableReleaseIsSilentTest`: 解放が自分のロックのファイルを読めずに黙って戻る。何も知らされず、t2 の終了フックは読み直しが自分を待って落ち、次の claim は自分を待つ。
- `currentTest.managerWaitsOnItsOwnLockTest`: manager がゴールを中止し、解放がロックのファイルを残す。終了フックは呼ばれず、manager の次の `goal-execution.lock` の取得は自分を待つ。
- `currentTest.recoverReleaseFailureDropsEventTest`: run の始めの回復で、t3 を failed にした後の知らせが落ち、run の始めが失敗する。
- `firstDesignTest.hookLostWhenLockStaysForGoodTest`・`invalidateHookLostWhenLockStaysForGoodTest`（高-1）: 外せないファイルが残ると、終了フックの読み直しが外せずに失敗し、フックが落ちる。
- `firstDesignTest.unreadableReleaseIsSilentTest`（高-2）: 読めない自分のファイルは記録されず、知らされず、次の claim は自分を待つ。
- `secondDesignTest.silentRecoveryLosesRecordTest`（再レビュー 中-A）: 回収の読み直しが一度失敗し、`unlinkSnapshot` が黙って戻る。記録は外せたとして消え、ファイルは残り、以後は自分を待つ。
- `secondDesignTest.oneFailedReadStopsClaimingTest`（再レビュー 中-B）: 回収の最初の読みが一度失敗し、`readError` が投げられて claim が止まる。

直した形（`fixedTest`）では、`firstReadGlitchWaitsThenRecoversTest`・`secondReadGlitchKeepsRecordTest`・`managerGlitchKeepsRecordTest` で、読みが一度失敗しても記録を残して待ち、次の読みで外し、run が正常に終わることを確かめる。

## PBT の性質

fast-check（`^4.11.0`）で書く。除外は無い。

1. claim の結果は解放で変わらない: tasks.yaml のタスクの並び（pending・running・failed、ゴールのタスクと普通のタスク、setup の失敗になるもの、止めたゴールのもの）、`count`、解放の失敗の入れ方（無し、`tasks.yaml.lock` の `unlink` の EIO・EACCES、`tasks.yaml.lock` を開くときの EACCES、読むときの EIO、`goal-execution.lock` の `unlink` の EIO、`goal-execution.lock` の持ち主の変化、両方）を任意に作る。どの入れ方でも、返るタスクの名前、`onSetupFailed` に渡る状態、終了フックに渡る状態、書いた後の tasks.yaml が、失敗を入れない場合と同じになる。警告は、失敗を入れたときにちょうど1回出る。
2. 書き込みの前の失敗では何も変わらない: 同じ並びで、取得の時間切れか ENOSPC をどちらかのロックに入れるか、`mutator` の中で `PrivateFileLockTimeoutError` を投げる。tasks.yaml は変わらず、コールバックは呼ばれず、警告は出ず、例外は今と同じ分類になる（`mutator` の中のものは再試行に分類されない）。
3. ロックの記録と回収（`withFileLock` と `runPrivateFileExclusive`・`runPrivateFileExclusiveAsync` のそれぞれ。`timeoutMs` は 0 を含めて任意）: 操作の列を任意に作る。操作は、ふつうに取って放す、放すときに k 回だけ失敗する（`unlink` の失敗、`file-lock.ts` では開くか読むときの失敗も）、放すときにずっと失敗する、生きている別のプロセスが持っている、死んだプロセスが持っている、自分の pid を書いた記録に無いファイルがある、外し損ねた後にファイルが置き換わる、外し損ねた後にファイルが消される、の8つ。
   - 生きている持ち主のファイルと、記録に無いファイルは外さない（排他は今のまま）。
   - k 回の失敗の後、次の取得は待たずに取れる（`timeoutMs: 0` でも時間切れにならない）。ただし、回収のときの読みも失敗するように入れた場合（回収の最初の読み、外す直前の読み直し）は、その間は記録を残して待ち、読めた最初の回で外す。記録が消えるのは `unlinkSync` が成功したとき（か、無いか置き換わったと読めたとき）だけ。
   - `unlink` がずっと失敗するときは、次の取得がその例外を投げ、action を呼ばない。時間切れにはならない。読みがずっと失敗するときは、`STALE_MS` を過ぎるまで待ち（時間切れになる）、過ぎたら今の規則で外れる。
   - 記録は、外せたとき、消えていたとき、置き換わっていたとき、直接取れたときに消える。そのパスを次に取った後には、ディスクに無いファイルや別のファイルの記録は残らない（再レビュー 低-3。そのパスを二度と取らなければ、記録は残る）。
   - 解放が失敗したら、必ず例外が出る（黙って残さない）。
4. 回復と中止の知らせは解放で変わらない: running と pending のタスクの並びと、解放の失敗の入れ方を任意に作る。入れ方は1と同じだが、`failInterruptedRunningTasks` は `tasks.yaml.lock` の分だけ（`goal-execution.lock` を取らない。設計レビュー 低-2）。`failInterruptedRunningTasks` の `onRecovered`、`invalidatePendingGoalTasks` の `onInvalidated` と終了フック、`reconcileLostRun` の `saveManagerEvent` に渡るタスクは、失敗を入れない場合と同じになる。例外は、中止と `reconcileLostRun` で失敗を入れたときにだけ出て、`failInterruptedRunningTasks` と claim では出ない。

## 壊しうる入力

| 入力 | 扱い |
|---|---|
| 自分の pid を書いた、記録に無いロックのファイル（`it-task-store-process-lock.test.ts`「does not steal a lock held by a live process」、`private-file-lock-acquisition.test.ts` の `pid: process.pid` の fixture） | 記録と一致しないので、今と同じく外さずに待つ。試験は変えない。 |
| 外し損ねた後に、別のプロセスが（死んだ持ち主として）回収して取り直したファイル | dev・ino・中身が違うので外さない。記録は消す。 |
| 外し損ねた後に、人が消したファイル | 次の取得は直接取れる。そこで記録を消す。 |
| 外し損ねた後に人が消し、同じ inode で別のファイルができる | 中身が自分のものと同じになるのは、自分が取ったときだけで、そのとき記録は消える。ほかのファイルは中身が違うので外さない。 |
| 解放のときに自分のロックのファイルを開けない（EACCES・EPERM）か読めない（EIO） | `file-lock.ts` は今は黙って戻る。直した後は例外を投げて記録する。次の取得で読めれば外し、読めなければ記録を残して待つ（`STALE_MS` を過ぎれば今の規則で回収を試みる。3-3）。 |
| 記録と一致した後の、外す直前の読み直しが一時的に EIO になる | 外せたとみなさない。記録を残して待ち、次の回で外す（再レビュー 中-A）。 |
| 記録した自分のファイルを、回収のときに一度だけ読めない | 投げずに待つ。claim は止まらない（再レビュー 中-B）。 |
| action と解放の両方が投げる（`tasks.yaml.lock`） | `AggregateError([actionError, releaseError])` にする。今は解放の例外が action の例外を上書きする（再レビュー 低-4）。 |
| 何度やっても `unlink` が EACCES になるディレクトリ | 次の取得が EACCES を投げる。今は 5 秒（`tasks.yaml.lock`）か 10 秒（`goal-execution.lock`）待ってから時間切れになり、claim では再試行が続いていた。claim は `preparationFailure` で止まり、run は失敗で終わる。 |
| `timeoutMs: 0` や期限の際の取得 | 自分のものを外した直後は、期限を見ずに1回だけ取り直す。 |
| 2つのロックの両方の解放が失敗する（`AggregateError`） | 書いた後なので、ほかの解放の失敗と同じに扱う。警告には中の例外を並べる。記録は2つのモジュールにそれぞれ残る。 |
| `mutator` が `undefined` を返す（何も書かない）ときの解放の失敗（`failInterruptedRunningTasks`・`reconcileLostRun`） | `onWritten` が呼ばれないので、今と同じく投げる。失うものは無い。 |
| `mutator` の中の別のロック（`GoalStore.getSync` など）から出た例外、`mutator` の中の `PrivateFileLockTimeoutError` | 書き込みの前なので、今と同じ扱い。`written` は立たない。 |
| rename の後に一時ファイルの後片付けが ENOENT 以外で失敗する（NFS・FUSE） | 1節の条件の変更で、rename が済んだ一時ファイルの `unlinkSync` を呼ばない。 |
| 例外を投げる `onWarning` | 握りつぶし、書いた結果は返す（claim と `failInterruptedRunningTasks`）。 |
| `onWarning` を渡さない `TaskRunner` | 警告は `log.warn` に残る。 |
| `reconcileLostRun` で `saveManagerEvent` も失敗する | 両方を `AggregateError` にして投げる。 |
| 終了フックの設定が無いプロジェクト | `runTaskFinishHooksForStates` は設定を読んで何もしない（今と同じ）。 |
| `takt run` の同時実行（2つ以上のプロセス） | 外すのは自分の記録と一致するファイルだけなので、排他は変わらない。 |
| worker のスレッド（`goalReaderWorker.ts`） | 今このロックを使う worker は無い（`goalReaderWorker.ts` はロックを使わない）。`private-file-lock.ts` は取得ごとに `token` を書くので、スレッドが違っても記録が他人のファイルと一致しない。`file-lock.ts` の中身は同じプロセスのどのスレッドでも同じ（`{ pid, processIdentity }`）なので、スレッド T1 が外し損ねて記録した後に、人がファイルを消し、T2 が同じ inode で取ると、T1 の次の取得は T2 の生きているロックを外しうる（再レビュー 低-2）。worker がこのロックを使うようになったら、`file-lock.ts` の中身に取得ごとの `token` を足す（`parseOwner` は `pid` と `processIdentity` しか見ないので、直す前の版と互換のまま足せる）。今は足さない。中身を完全一致で確かめる `file-lock.test.ts` の試験（118・138・153・164 行など）を書き換えることになり、今の使い手には効かない。 |
| pid の使い回し（プロセスが終わって同じ pid が別のプロセスに付く） | 記録はメモリにしかないので、新しいプロセスには無い。今の死んだ持ち主の判定（`processIdentity`）はそのまま。 |

## 上流・保存済みのデータ・公開 API・守りの仕組みへの影響

- 上流: 何も流さない。次の取り込みで `file-lock.ts`・`private-file-lock.ts`・`private-file.ts`・`taskLifecycleService.ts`・`store.ts`・`reconcileLostRun.ts`・`taskFinishHook.ts`・`claimTasks.ts`・`parallelExecution.ts` が競合しうる。上流もこの4か所で同じ問題を持つが、流すかどうかはこの直しの外で決める。
- 保存済みのデータ: tasks.yaml のスキーマとロックのファイルの書式は変えない。直す前の版と直した後の版のプロセスが、同じプロジェクトで同時に動いても、互いのロックを今までどおり扱う（直した後の版も、記録に無いファイルは外さない）。
- 公開 API: MCP の道具、`takt` のコマンド、設定のキー、終了フックに渡す環境変数は変えない。中止の道具のエラーの文面も変えない。リポジトリの中の型が変わる: `TaskRunner.invalidatePendingGoalTasks` に省略できる第2引数、`TaskStore.update` の options の `onWritten`、`claimTasksWithGoalCompletions` の戻り値の `setupFailedTaskNames` → `setupFailedTasks`、`runTaskFinishHooksForStates` の追加（どれもリポジトリの中だけで使う。takt-dash は呼ばない）。
- 守りの仕組み: ロックの排他は弱めない。外す条件に足すのは「このプロセスが作って外し損ね、記録したファイルと、dev・ino・中身がすべて一致する」だけ。`file-lock.ts` が解放のときに読めない自分のファイルを投げるようになるのは、黙って残していたものを知らせるだけで、外す条件は変えない（確かめられないファイルは今までどおり外さない）。警告の中身は `sanitizeSensitiveText` を通す。秘密の伏せ方そのものは変えない。

## 試験

回帰テストは、直す前に失敗するのを見てから直す。

### 期待を変える既存の試験

| ファイル | 今の期待 | 変え方と理由 |
|---|---|---|
| `it-goal-task-claim.test.ts`「does not classify an error after the write as retryable」（#168 の回帰テスト8） | claim から例外が出て、再試行に分類されない | 例外は出ずに claim したタスクが返る形にする。#168 の設計が「別件で直す形を試験の名前で示す」としたもの。「再試行に回さない」は、例外が出ないことと、tasks.yaml の running が返したタスクと一致することで、引き続き確かめる。名前は「keeps the claim when a lock release fails after the write: %s」に直し、4つの入れ方は残す。`new TaskRunner(dir, { onWarning })` で警告を受け、ちょうど1回出ることを足す（設計レビュー 中-2）。 |
| `file-lock.test.ts`「keeps an unreadable fresh record and recovers it only after the stale threshold」（225-239 行） | 読みがずっと EIO のとき、`STALE_MS` の後の2回目の `withFileLock` が値を返し、自分の中身のファイルが残る（235-238 行） | 2回目の `withFileLock` は、action の後の解放で EIO を投げる形にする（3-1。黙って残すのが高-2 そのもの）。ファイルが外されずに残ること（確かめられないファイルは外さない）は、そのまま確かめる。前半（他人の読めないロックは `STALE_MS` まで待つ）は変えない。 |
| `goal-execution-operations.test.ts:60-62` | `invalidate` が `goalId` だけで1回呼ばれ、`list` が `invalidate` より先に呼ばれる | `invalidate` は `(goalId, expect.any(Function))` で1回呼ばれる、に変える。`list` の順の確かめは、事前の読みをやめるので消し、代わりに「`list` は呼ばれない」と「`invalidate` の第2引数に渡した状態が終了フックに渡る」を確かめる（設計レビュー 中-3）。 |
| `manager-conversation-turn-service.test.ts:517` | `abort_goal` で `list` が `invalidate` より先に呼ばれる | 同じく、`invalidate` の第2引数が関数であることと、`list` が呼ばれないことに変える（設計レビュー 中-3）。 |
| `setupFailedTaskNames` を確かめる試験（`it-goal-task-claim.test.ts` 5か所、`it-task-finish-hook.test.ts` 4か所、`runtime-assignment-missing-goal-task.integration.test.ts` 4か所、`manager-task-events.test.ts` 1か所） | 名前の配列 | 戻り値が状態の配列になるので、`setupFailedTasks.map((task) => task.name)` で同じ名前を確かめる。確かめる中身は変えない。 |

### 足す試験

1. `it-goal-task-claim.test.ts`: `mutator` の中（`writeStarted` かつ `written` でない）で `PrivateFileLockTimeoutError` が出たとき、`claimNextTasks` からその例外がそのまま出て、`TaskClaimLockAcquisitionError` にも `TaskClaimLockUnavailableError` にもならず、警告も出ず、tasks.yaml が変わらない（`!writeStarted` のガードの試験。設計レビュー 中-2）。
2. `claimTasksWithGoalCompletions`: 解放が失敗した回の setup の失敗が `setupFailedTasks` に入り、manager の知らせが出る（light IT、本物の tasks.yaml）。
3. `claimAvailableTasks` 経由の終了フック: `tasks.yaml.lock` の解放がずっと失敗する（`unlink` が EACCES のまま）とき、setup の失敗の終了フックが呼ばれる。直す前は呼ばれない（高-1）。
4. `failInterruptedRunningTasks`: 書いた後に解放が失敗しても、`onRecovered` が呼ばれ、件数が返る。`onWarning` が投げても同じ。`onWarning` なしでも `log.warn` に残る。
5. `invalidatePendingGoalTasksWithFinishHook`: 書いた後に解放が失敗しても（ずっと失敗する場合を含む）終了フックが呼ばれ、そのあと例外が出る。書き込みの前に失敗したときは、フックが呼ばれない。
6. `reconcileLostRun`: 書いた後に解放が失敗しても `saveManagerEvent` が出て、そのあと例外が出る。`saveManagerEvent` も失敗したら `AggregateError`。
7. `file-lock.test.ts`: 外し損ねた自分のロックを、次の取得で待たずに外す（`timeoutMs: 0` でも）。記録と一致した後の読み直しが EIO のとき、記録が残り、取得は外したと誤らない（再レビュー 中-A）。記録した自分のファイルを回収の最初の読みで一度だけ読めないとき、例外を出さずに待ち、次の回で外して取る（再レビュー 中-B）。ずっと読めないときは `STALE_MS` まで待ち、時間切れ（`isFileLockTimeoutError`）になる。action と解放の両方が投げたら `AggregateError` になる（再レビュー 低-4）。記録に無い自分の pid のファイルは外さない。置き換わったファイルは外さない。ずっと外せないときは、次の取得が `unlink` の例外を投げる。解放のときに開けない（EACCES）か読めない（EIO）自分のファイルで例外が出て、次の取得で読めれば外す。外し損ねた後にファイルが消され、次の取得が直接取れたら記録が消える（同じパスと同じ ino のモックを使う後の試験に、記録が漏れないことも、この規則で守る）。
8. `private-file-lock-acquisition.test.ts`: 7と同じ組み合わせを同期と非同期で。加えて、「ownership changed」（`false`）と `PrivateArtifactPublicationConflictError` のときは記録しないこと、`lockPath` の書き方が違っても（相対と絶対）同じ記録に当たること。
9. `private-file.test.ts`（またはその試験のファイル）: rename の経路で、後片付けの `unlinkSync` を呼ばない。`linkSync` の経路では今までどおり呼ぶ。
10. heavy IT（本物の子プロセス）: 子プロセスの `takt run` が、claim の後の `tasks.yaml.lock` の解放の失敗（`unlink` を一度だけ失敗させる）を受けても、claim したタスクを実行して正常に終わる。直す前は失敗で終わり、タスクが running のまま残る。失敗の入れ方（再レビュー 低-5）: ディレクトリの権限を落とすと、書き込み（rename）とロックの取得（link）が先に失敗するので使わない。子プロセスを `node --import <preload>` で起動し、preload が `fs.unlinkSync` を差し替える。差し替えは、パスが `tasks.yaml.lock` で終わり、tasks.yaml に running のタスクが書かれた後の最初の1回だけ EIO を投げ、ほかは元の関数に渡す。`module.syncBuiltinESMExports()` を呼んで、`file-lock.ts` の名前付きの import（`import { unlinkSync } from 'node:fs'`）に反映させる。本番のコードに試験のための環境変数や分岐は足さない。
11. PBT の1〜4。

足した試験と変えた試験は、`tsconfig.tests.json` に載せ、`scripts/test-classification.mjs` で層を決める。

## 設計レビューの指摘と扱い

### 1回目（`2026-11-27-169-design-review.md`）

| 指摘 | 扱い | 反映した節 |
|---|---|---|
| 高-1 `runTaskFinishHooks` が `tasks.yaml.lock` を取り直し、外せないファイルで終了フックが落ちる | 直す。書き込みの直後の終了フックには保存した状態を渡し、読み直さない（`runTaskFinishHooksForStates`、`setupFailedTasks`） | 何が起きているか、2節、守る不変条件、Quint（`firstDesign`、`hooks`）、試験 |
| 高-2 `file-lock.ts` の `readSnapshot`・`unlinkSnapshot` が、解放のときの EACCES・EPERM・EIO を握りつぶす | 直す。解放のときに dev・ino が同じで読めない自分のファイルは、例外にして記録する。`file-lock.test.ts:235-238` の期待を変える | 何が起きているか、3-1、Quint（`Unseen`）、壊しうる入力、試験 |
| 中-1 の1 `private-file-lock.ts` のパスの正規化 | 直す。記録と照合の両方で `resolve(lockPath)` をキーにする | 3-2 |
| 中-1 の2 直接取れたときに記録が消えない | 直す。取得の成功のたびに、そのパスの記録を消す | 3-1、3-2、試験の7 |
| 中-1 の3 自分のものを外した直後に時間切れになる | 直す。外した直後は、期限の判定と待ちの前に1回だけ取り直す | 3-1、3-2、PBT の3 |
| 中-1 の4 `releasePrivateFileLock` の例外の分け方 | 直す。`false` と `PrivateArtifactPublicationConflictError` は記録せず、ほかの例外だけ記録する | 3-2 |
| 中-2 `!writeStarted` のガードの試験が無くなる、回帰テスト8に `onWarning` が要る | 直す。ガードの試験を1件足し、回帰テスト8に `onWarning` を渡す | 守る不変条件、試験 |
| 中-3 事前の `listTaskStateItems` をやめると壊れる既存の試験2件 | 直す。2件の変え方を書いた | 試験 |
| 低-1 `onWarning` が無いと無音になる | 直す。`log.warn` にも残す | 2節 |
| 低-1 `failInterruptedRunningTasks` で `onWarning` が投げる | 直す。claim と同じ警告の関数で握りつぶす | 2節 |
| 低-1 `onInvalidated` が投げたとき | 採らない。呼び出し元は配列に積むだけで投げない。投げたらそのまま出す（解放の失敗より先） | 2節 |
| 低-2 `failInterruptedRunningTasks` は `goal-execution.lock` を取らない | 直す（記述） | 何が起きているか、PBT の4 |
| 低-2 `mutator` が `undefined` を返すのは2か所だけ | 直す（記述） | 1節、壊しうる入力 |
| 低-2 `reconcileLostRun` で `saveManagerEvent` も失敗したとき | 直す。`AggregateError` にする | 2節、試験の6 |
| 低-2 Quint の Stopped を死んだとみなす抽象化 | 直す（記述）。安全性には効かず、ほかのプロセスの待ちが実物では長いことを書いた | 4節、README |
| 低-2 claim の最初の読みの解放の失敗では止まる | 直す（記述）。`stopsOnlyWhenUnlinkFails` は書き込みの経路だけの保証と書いた | 4節、守る不変条件、README |
| 低-3 rename の後の後片付けの `unlinkSync` | 直す。rename が済んだ一時ファイルには呼ばない | 1節、試験の9 |
| 低-3 symlink の別名のパス | 採らない。呼び出し元は同じ `cwd` から作ったパスを渡し、取得のたびの `realpath` に見合わない | 4節 |

### 再レビュー（`2026-11-27-169-design-review-2.md`）

| 指摘 | 扱い | 反映した節 |
|---|---|---|
| 中-A 回収で `unlinkSnapshot` を使うと、読み直しの一時的な失敗で黙って戻り、外せたかが分からない | 直す。記録と一致したファイルは `removeRecordedLock` で外し、`unlinkSync` が成功したときだけ「外した」とする。読めなければ記録を残す | 3-1、守る不変条件、Quint（`SecondReadFails`・`RecordLost`）、PBT の3、壊しうる入力、試験の7 |
| 中-B 記録と一致して読めないファイルで `readError` を投げると、一度読めなかっただけで claim が止まる | 直す。投げずに記録を残し、読めないロックの今の規則（`STALE_MS` まで待つ）に戻る | 3-1、3-3、守る不変条件、Quint（`FirstReadFails`・`UnreadableWait`・`ReadFailed`）、PBT の3、壊しうる入力、試験の7 |
| 低-1 4節の「読み取りの後の解放の失敗は今と同じく投げる」は `Unseen` では違う | 直す（記述）。`Unseen` は新たに投げると書き分けた。読みの後の解放の失敗を警告にするのは別件 | 4節 |
| 低-1 書き込みの後に読み直す経路として `withTaskFinishHook` の `runHook` も残る | 直す（記述）。残る経路として名前を挙げた。直すのは別件のまま | 4節 |
| 低-2 worker スレッドの記述は `file-lock.ts` に当てはまらない | 直す（記述）。`file-lock.ts` の中身に `token` を足すのは採らない（今の使い手に効かず、中身を完全一致で確かめる試験を書き換えることになる）。worker が使うようになったら足す | 壊しうる入力 |
| 低-3 PBT 3 の「どの列の後にも記録は残らない」は成り立たない | 直す。「そのパスを次に取った後には」と条件を付けた | PBT の3 |
| 低-4 `withFileLock` の `finally` で解放が投げると action の例外が消える | 直す。両方が投げたら `AggregateError` にする | 3-1、壊しうる入力、試験の7 |
| 低-5 heavy IT で `unlink` を一度だけ失敗させる方法が無い | 直す（記述）。`--import` の preload で `fs.unlinkSync` を差し替え、`syncBuiltinESMExports()` で反映する方法を書いた | 試験の10 |
| 低-6 link の経路の後片付けの失敗で、自分のロックが記録されずに残る | 別件。取得の側の穴で、解放の失敗とは別の経路 | 4節 |
| 低-7 しばらく取得しない長く生きるプロセスが外し損ねると、ほかのプロセスが長く待つ | 別件。今のコードより悪くはならない。直後の1回の再試行は確かな手にならず、持ち主が生きているロックの待ちに上限を設けるのは排他の規則を変える | 4節 |

### PR #182 のレビューボット（Devin 5件、CodeRabbit 8件）

| 指摘 | 扱い | 反映した先 |
|---|---|---|
| Devin `file-lock.ts:106` タスクの追加で、保存後の解放の失敗が指示書を消す | 直す（実装）。書いた後なら指示書を消さずに投げる | 4節 |
| Devin `file-lock.ts:245` ゴールの中止・再開で、保存後の解放の失敗が後続の処理を止める | 直す（実装）。後続を済ませてから投げる | 4節 |
| Devin `claimLockRelease.qnt:415`、CodeRabbit `:406`・`:415` witness が対象の障害に結び付いていない | 直す。ghost の `heldAfterReleaseFailure`・`lastRelease` で、解放に失敗した claim のタスクと `Unseen` の報告に結び付けた | Quint、README |
| CodeRabbit `claimLockRelease.qnt:151` `Gone` が置き換えた持ち主のロックを残さない | 採らない。各操作は1手で、置き換えた持ち主のロックはその持ち主の手の中で終わる。その間の待ちは `Timeout` で表している。コメントと README に書いた | Quint、README |
| Devin `it-claim-lock-release-run.test.ts:78` 試験の期限が `TEST_TIME_FACTOR` に従わない | 直す。`scaledMs` にした（`it-lock-release-finish-hook.test.ts` も） | 試験 |
| Devin `reconcileLostRun.ts:56` PR 説明が、投げる2か所を書いていない | 直す（PR 説明） | PR 説明 |
| CodeRabbit 設計 132 行 `STALE_MS` を待ちの上限と書いている | 直す。回収を試み始めるしきい値と書き分けた | 3-1、3-3、守る不変条件、Quint、README |
| CodeRabbit `private-file-lock-acquisition.test.ts:245` 置き換えの試験が、元のロックを誤って記録しても通る | 直す。元のロックを退避して戻し、記録が無いことを確かめる | 試験 |
| CodeRabbit `private-file-lock-acquisition.test.ts:257` 置き換えで inode が再利用されうる | 直す。元のロックを退避したまま置き換える。CI の失敗（`13d200306` の前）の原因はこれ | 試験 |
| CodeRabbit `file-lock.ts:143` 開くときの EIO が取得から生のまま出る | 直す（実装）。EACCES・EPERM と同じく `readError` にする | 3-1 |
| CodeRabbit `private-file-lock.ts:115` 照合と `unlink` の間に別の回収と取得が入りうる | 別件。上流からある死んだ持ち主の回収の窓で、`file-lock.ts` のコメントのとおり受け入れている。この直しの記録の回収は、自分しか書けない中身のファイルだけを外すので、窓を広げない | — |
| `13d200306` の `hasMatchingSnapshot`（size・mtimeMs・ctimeMs の照合） | 戻す（実装）。同じ inode の stat を比べるので、変わっていないファイルを誤って競合にはしない。ただし共有の読み（`readPrivateFileState`・`readRegularFileNoFollow`、呼び出し約20か所）で、追記されたファイルを競合にする。ロックを取らずに追記のファイルを読む `live-intervention-store.ts` の `read`（engine の各 runner が呼ぶ）は、`takt` の別のプロセスの追記と重なると、今までは返していたのに例外になる。CI の失敗の原因は試験の inode の再利用で、試験を直せば要らない | — |

## 進め方

1. 最初の設計と Quint を1コミットにした（`237703e8e`）。1回目の設計レビューの指摘を反映した版（`b82a56d2a`）と、再レビューの指摘を反映した版を、それぞれ1コミットにする（push はまだしない）。
2. 変えた点を、レビューの担当にもう一度見てもらう。
3. 回帰テストを書いて、直す前に失敗するのを見る。
4. 実装する。`npm run build`・`npm run lint`・`npm test`・`npm run test:it`・足した heavy IT の単体の実行・`releaseVerificationWiring.test.ts` を通す。
5. PR を `integration/takt-mcp` に出す。

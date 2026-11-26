# 書き込みの後にロックの解放が失敗しても、書いた結果を捨てない（項目417）

issue: https://github.com/j5ik2o/takt/issues/169 （https://github.com/j5ik2o/takt/pull/168 の設計 `docs/design/goal-task-claim-setup-failure.md` の「別件」の1）

基点: `integration/takt-mcp`（`ce641a0ce`）。上流 nrslib/takt の main（`bba6f2315`）と開いている PR（7件）に、同じ直しは無い。上流の `file-lock.ts`・`private-file-lock.ts`・`claimNextTasks` も、解放の失敗をそのまま投げる。

Quint: `specs/quint/claim-lock-release/`。

## 何が起きているか

tasks.yaml の書き込みは、`goal-execution.lock`（`private-file-lock.ts`）と `tasks.yaml.lock`（`file-lock.ts`）の下で行う。書き込みが済んだ後に、どちらかのロックの解放が例外を出すことがある。

- `tasks.yaml.lock`: `withFileLock` の `finally` の `unlinkSnapshot`（`file-lock.ts:167`）。ロックのファイルを開く・`fstat` する・`unlink` するところで、EIO・EACCES・EPERM・EBUSY などが出る。
- `goal-execution.lock`: `releasePrivateFileLock`（`private-file-lock.ts:200`）。読み直しか `unlink` の失敗、またはロックのファイルが消えたか置き換わっていたときの「Private file lock ownership changed before release」。両方が失敗すると `AggregateError` になる。

この例外は、書いた結果を使う処理より先に、呼び出し元へ出る。同じ形の処理が4つある。

| 処理 | 書いた後に失われるもの |
|---|---|
| `TaskLifecycleService.claimNextTasks` | claim したタスクが返らない。自分を持ち主とする running のまま、どのキューにも入らない。setup の失敗の `onSetupFailed`（終了フックと manager の知らせ）も呼ばれない。claim は `preparationFailure` で止まり、run は失敗で終わる。 |
| `failInterruptedRunningTasks`（run と watch の始め） | failed（interrupted）にしたタスクの `onRecovered`（manager の知らせ）が呼ばれない。次の回には、もう running ではないので拾われない。run の始めが失敗する。 |
| `invalidatePendingGoalTasks`（ゴールの中止。MCP と manager） | failed にした pending のタスクの終了フックが呼ばれない（`invalidatePendingGoalTasksWithFinishHook` の `runTaskFinishHooks` に届かない）。 |
| `reconcileLostRun`（daemon） | failed にしたタスクの `saveManagerEvent` が呼ばれず、manager が起きない。次の観測では、もう running ではないので拾われない。 |

さらに、issue に書かれていない問題が1つある。解放に失敗したロックのファイルは、生きている自分のプロセスを持ち主として名指しする。そのため、自分が次に同じロックを取ろうとすると、自分を待って時間切れになる（`recoverStaleLock` も `recoverUnchangedDeadHolder` も、持ち主が生きていれば外さない）。ほかのプロセスも、自分が終わるまで待たされる。

- `takt run` では、今は claim が止まってプロセスが終わるので、待ちは長く続かない。
- daemon や MCP のサーバーのように長く生きるプロセスでは、そのプロセスが生きている間ずっと、自分もほかのプロセスも `goal-execution.lock` か `tasks.yaml.lock` を取れない。
- issue の案 (a)（claim したタスクを返して `warn()` する）だけを入れると、`takt run` も止まらずに生き続け、次の claim で自分を待つ。`goal-execution.lock` と `tasks.yaml.lock` の時間切れは再試行の対象（#91・#168）なので、`claimRetryAt` が毎回立ち、`takt run` が終わらなくなる（Quint の `returnOnly` の `noSelfWait` の反例）。

このため、(a) と、自分が外し損ねたロックを自分で外す仕組みを、いっしょに入れる。

## 何をどう変えるか

### 1. 書き込みが済んだことを呼び出し元が知る

- `TaskStore.update` の options に `onWritten?: () => void` を足す。`writeUnsafe` が返った直後、`tasks.yaml.lock` を持ったまま呼ぶ。`mutator` が `undefined` を返して何も書かないときは呼ばない。
- 書き込みの確定点は `writeAtomic` の `renameSync` で、その後は一時ファイルの `unlink`（rename の後は ENOENT で、無視される）だけが残る。そのため、`writeUnsafe` が返ったことを「書いた」とみなしてよい。
- `onWritten` の後に呼び出し元へ出る例外は、2つのロックの解放から出たものだけになる（`store.update` の `return`、`withFileLock` の `finally`、`runWithAcquiredLock` の解放）。下の4か所は、この印が立った後の例外を「書いた後の解放の失敗」として扱う。
- #168 の `writeStarted`（`mutator` に入った印。時間切れを再試行に回すかを決める）は残す。`writeStarted` が立っていて `written` が立っていない失敗（`mutator` か書き込みの中の失敗）は、今と同じく投げる。

### 2. 4か所で、書いた結果を捨てない

| 処理 | 書いた後に解放が失敗したとき |
|---|---|
| `claimNextTasks` | `onWarning` で知らせてから、`onSetupFailed` を各タスクに呼び、claim したタスクを返す。再試行には回さない。 |
| `failInterruptedRunningTasks` | `onWarning` で知らせてから、`onRecovered` を各タスクに呼び、件数を返す。 |
| `invalidatePendingGoalTasks(goalId, onInvalidated?)` | 第2引数を足す。書いた後に、failed にした各タスクで `onInvalidated` を呼び、そのあと解放の例外を投げる。`invalidatePendingGoalTasksWithFinishHook` は `onInvalidated` で名前を集め、`finally` で `runTaskFinishHooks` を呼ぶ。中止の前に pending を読んでおく今の形（`pendingNames`）はやめる。 |
| `reconcileLostRun` | 書いた後なら `saveManagerEvent` を出してから、解放の例外を投げる。 |

知らせ方を2つに分ける理由:

- claim と run の始めの回復は、返した値を run がそのまま使う。`takt run`・`takt watch`・`selectAndExecute` はどれも `TaskRunner` に `onWarning: warn` を渡しているので、警告は端末に出る。
- 中止と daemon の回復は、1回きりの操作で、例外は今も呼び出し元に届いて見える（MCP の道具のエラー、manager のコマンドのエラー、daemon のターンの失敗）。これらの `TaskRunner` は `onWarning` を持たない。知らせと終了フックを済ませてから投げれば、何も失わずに、今と同じ形で見える。中止はもう一度呼んでも同じ結果になる（pending がもう無い）ので、呼び出し元がやり直しても害は無い。

警告の文面（`sanitizeSensitiveText` を通す。`AggregateError` は中の例外ごとに並べる）:

```text
Saved .takt/tasks.yaml, but releasing a lock afterwards failed: <detail>. This process removes the lock file the next time it takes that lock; until then other TAKT processes wait for it.
```

`onWarning` が例外を投げても、claim したタスクは返す（#168 の `warnSetupFailureReport` と同じく握りつぶす）。

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

### 3. 自分が外し損ねたロックを、次に取るときに外す

外し損ねたロックのファイルを、プロセスの中に記録する。次に同じパスのロックを取るとき、そこにあるファイルが記録とまったく同じなら、持ち主が生きている（自分である）ことを理由に待たずに外す。

- `file-lock.ts`: モジュールの中に `orphanedLocks: Map<string, LockSnapshot>`（キーは解決済みのパス）を置く。`withFileLock` の `finally` で `unlinkSnapshot` が例外を出したら、取ったときの `acquired`（dev・ino・中身）を記録してから、今と同じく投げる。`recoverStaleLock` は、読んだロックの dev・ino・中身が記録と一致すれば、持ち主の生死を見ずに `unlinkSnapshot` を呼ぶ。外せたか、ファイルが無いか、別のファイルに変わっていれば、記録を消す。
- `private-file-lock.ts`: 同じく `orphanedLocks: Map<string, AcquiredPrivateFileLock>` を置く。`releasePrivateFileLock` で `removeLockIfUnchanged` が例外を出したら記録する。`false` を返した（ロックが消えたか置き換わった、つまり自分のものではない）ときは記録しない。`recoverUnchangedDeadHolder` は、読んだ状態（dev・ino・中身の SHA-256）と中身が記録と一致すれば、`removeLockIfUnchanged` を呼ぶ。
- 外すのに失敗したら、その例外をそのまま取得の失敗として投げる（今の死んだ持ち主の回収と同じ扱い）。claim では分類されない例外なので `preparationFailure` になり、run は失敗で終わる。何度やっても外せないロックのファイルを、時間切れの再試行で待ち続けることはなくなる。
- 解放と回収は、同期の `runPrivateFileExclusive` と非同期の `runPrivateFileExclusiveAsync` で共通なので、両方に効く。

これで守れること:

- 外すのは、自分が作って外し損ね、記録したファイルだけ。記録はプロセスのメモリにしかない。別のプロセスや別のスレッドのロック、自分の pid を書いた他人のファイル（試験の fixture）、外し損ねた後に置き換わったファイルは、どれも一致しないので外さない。
- 記録したファイルは、その時点で誰も持っていない（取った本人が手放した後のもの）。`file-lock.ts` は同期で、同じパスを入れ子で取れない（`heldLocks`）。`private-file-lock.ts` の非同期の取得は、取得ごとにランダムな `token` を中身に書くので、同じプロセスの別の取得のファイルとは中身が違う。
- 生きている別の持ち主のロックを外さないこと、死んだ持ち主のロックを回収すること、ロックを取る順の階層（`epics.lock` → `goal.json.lock` → `goal-execution.lock` → `tasks.yaml.lock`）、ロックのファイルの書式は、どれも変えない。

### 範囲の外（変えないもの）

- 読み取り（`TaskStore.read`・`listTaskStateItems`）の後の解放の失敗。今と同じく投げる。claim の最初の読みで起きると claim は止まるが、何も書いていないので失われるものは無い。3節の記録で、次の取得からは自分を待たない。
- 上の4つ以外の書き込み（`GoalStore.update`、`autoRun`、merge のタスクの作成、タスクの完了の書き込みなど）の解放の失敗。今と同じく投げる。3節の記録で、プロセスが自分を待ち続けることはなくなる。
- 自分が外し損ねたロックを、自分が次に取るまでは、ほかのプロセスが待つこと。自分が終われば、死んだ持ち主のロックとして回収される。待ちの長さは、自分の次の取得か終了までになる（Quint の `otherWaitsUntilOwnerRecoversTest`）。
- 外し損ねた直後に、すぐもう一度外してみること。次の取得で外すので、足さない。
- `writeAtomic` が rename の後に投げる場合。tasks.yaml の書き込み（rename の経路）では、rename の後に残るのは ENOENT を無視する一時ファイルの `unlink` だけで、起きない。
- #168 の「別件」の2（失われた知らせの出し直し）と3（終了フックの取りこぼしの警告）。

## 守る不変条件

Quint の `safety` は次の9つの連言で、`fixed` で違反が無い。

1. `noOrphanRunning`: p が running と書いたタスクは、p のキューに入っている。例外は、ロックのファイルが外せずに p が止まった場合だけ（何も書けないので、p が終わった後に interrupted として回収される）。
2. `queuedByOwnerOnly`: タスクをキューに入れるのは、claim したプロセスだけ。
3. `noLostNotice`: 処理が failed と書いたタスクは、解放の成否にかかわらず、知らせ（終了フックか manager の完了の知らせ）がちょうど1回出る。
4. `noDuplicateNotice`・`noFalseNotice`: 知らせは多くとも1回で、failed と書いたタスクにだけ出る。
5. `releaseFailureReported`: 書いた後の解放の失敗は、警告か呼び出し元への例外で必ず出る。黙って捨てない。
6. `noSelfWait`: どのプロセスも、自分が外し損ねたロックのファイルを待たない。
7. `stopsOnlyWhenUnlinkFails`: claim が止まるのは、ロックのファイルが外せないときだけ。
8. `noFalseCleanEnd`: `takt run` は、自分が running と書いたタスクを実行しないまま、正常には終わらない。

実装の側では、さらに次を守る。

- 書き込みの前の失敗は、今のまま扱う（時間切れと ENOSPC は再試行、ほかは投げる。tasks.yaml は変わらない）。
- 書き込みの後の例外は、どの型でも再試行に回さない（#168）。
- 書いた結果（返すタスク、`onSetupFailed`・`onRecovered`・`onInvalidated` に渡るタスク、manager の知らせ）は、解放の成否で変わらない。
- ロックのファイルを外すのは、生きていない持ち主のものか、このプロセスが記録したものと dev・ino・中身がすべて一致するものだけ。

## Quint

`specs/quint/claim-lock-release/`。2つの `takt run`（A・B）と、長く生きる manager／daemon（M）が、tasks.yaml とロックを共有する。2つのロックは同じ書き込みを囲んで同じ形で解放するので、モデルでは1つにまとめた。何をモデルにして何を外したかは README に書いた。

| 版 | 中身 |
|---|---|
| `current` | 今のコード（`ce641a0ce`）。#168 の `fixedReleaseFails` にあたる。 |
| `returnOnly` | issue の案 (a) だけ。書いた結果は捨てないが、外し損ねたロックのファイルは残る。 |
| `fixed` | この設計。 |

| 検査 | 結果 |
|---|---|
| `quint test`（`currentTest` 6件、`returnOnlyTest` 3件、`fixedTest` 8件） | 17件すべて通る。 |
| `quint run`（9つの不変条件 × 3つの版、3,000 標本、12 ステップ、seed 0x2a） | `current` は `noOrphanRunning`・`noLostNotice`・`noSelfWait`・`stopsOnlyWhenUnlinkFails` が破れる（`noFalseCleanEnd` は保たれる。run は失敗で終わる）。`returnOnly` は `noSelfWait` だけが破れる。`fixed` は9つとも違反なし。 |
| `quint run --main fixed --invariant safety`（10,000 標本、15 ステップ、witness 10個） | 違反なし。witness はすべて到達（最少は `wTaskRanAfterReleaseFailure` の 1,708 本、`wSelfRecovered` 2,727 本、`wUnlinkStop` 5,372 本、`wRunEndedAfterReleaseFailure` 3,588 本）。 |
| `quint verify --main fixed --invariant safety --max-steps 8` | 違反なし（752 秒）。下の反例はどれも3手以内。 |
| `quint verify --max-steps 4` で反例が出ることの確かめ | `current` の `noOrphanRunning`・`noLostNotice`・`noSelfWait`・`stopsOnlyWhenUnlinkFails`、`returnOnly` の `noSelfWait` で、どれも反例が出る（各5秒前後）。verify が空振りでない。 |

直す前の形での反例（`currentTest`）:

- `claimReleaseFailureOrphansClaimTest`: claim が t1 を running、t2 を failed と書いた後に解放が失敗する。t1 はキューに入らず、t2 は知らされず、claim が止まる。
- `managerWaitsOnItsOwnLockTest`: manager がゴールを中止し、解放がロックのファイルを残す。終了フックは呼ばれず、manager の次の `goal-execution.lock` の取得は自分を待つ。
- `recoverReleaseFailureDropsEventTest`: run の始めの回復で、t3 を failed にした後の知らせが落ち、run の始めが失敗する。

## PBT の性質

fast-check（`^4.11.0`）で書く。除外は無い。

1. claim の結果は解放で変わらない: tasks.yaml のタスクの並び（pending・running・failed、ゴールのタスクと普通のタスク、setup の失敗になるもの、止めたゴールのもの）、`count`、解放の失敗の入れ方（無し、`tasks.yaml.lock` の `unlink` の EIO・EACCES、`goal-execution.lock` の `unlink` の EIO、`goal-execution.lock` の持ち主の変化、両方）を任意に作る。どの入れ方でも、返るタスクの名前、`onSetupFailed` に渡る名前、書いた後の tasks.yaml が、失敗を入れない場合と同じになる。警告は、失敗を入れたときにちょうど1回出る。
2. 書き込みの前の失敗では何も変わらない: 同じ並びで、取得の時間切れか ENOSPC をどちらかのロックに入れる。tasks.yaml は変わらず、コールバックは呼ばれず、例外は今と同じ分類になる。
3. ロックの記録と回収（`withFileLock` と `runPrivateFileExclusive`・`runPrivateFileExclusiveAsync` のそれぞれ）: 操作の列を任意に作る。操作は、ふつうに取って放す、放すときに k 回だけ失敗する、放すときにずっと失敗する、生きている別のプロセスが持っている、死んだプロセスが持っている、自分の pid を書いた記録に無いファイルがある、外し損ねた後にファイルが置き換わる、の7つ。
   - 生きている持ち主のファイルと、記録に無いファイルは外さない（排他は今のまま）。
   - k 回の失敗の後、次の取得は待たずに取れる。
   - ずっと失敗するときは、次の取得が `unlink` の例外を投げ、action を呼ばない。時間切れにはならない。
   - 記録は、外せたとき、消えていたとき、置き換わっていたときに消える。
4. 回復と中止の知らせは解放で変わらない: running と pending のタスクの並びと、1と同じ解放の失敗の入れ方を任意に作る。`failInterruptedRunningTasks` の `onRecovered`、`invalidatePendingGoalTasks` の `onInvalidated`、`reconcileLostRun` の `saveManagerEvent` に渡るタスクは、失敗を入れない場合と同じになる。例外は、中止と `reconcileLostRun` で失敗を入れたときにだけ出て、`failInterruptedRunningTasks` と claim では出ない。

## 壊しうる入力

| 入力 | 扱い |
|---|---|
| 自分の pid を書いた、記録に無いロックのファイル（`it-task-store-process-lock.test.ts`「does not steal a lock held by a live process」、`private-file-lock-acquisition.test.ts` の `pid: process.pid` の fixture） | 記録と一致しないので、今と同じく外さずに待つ。試験は変えない。 |
| 外し損ねた後に、別のプロセスが（死んだ持ち主として）回収して取り直したファイル | dev・ino・中身が違うので外さない。記録は消す。 |
| 外し損ねた後に、人が消したファイル | 無いので、記録を消して取る。 |
| 何度やっても `unlink` が EACCES になるディレクトリ | 次の取得が EACCES を投げる。今は 5 秒（`tasks.yaml.lock`）か 10 秒（`goal-execution.lock`）待ってから時間切れになり、claim では再試行が続いていた。claim は `preparationFailure` で止まり、run は失敗で終わる。 |
| 2つのロックの両方の解放が失敗する（`AggregateError`） | 書いた後なので、ほかの解放の失敗と同じに扱う。警告には中の例外を並べる。記録は2つのモジュールにそれぞれ残る。 |
| `mutator` が `undefined` を返す（何も書かない）ときの解放の失敗 | `onWritten` が呼ばれないので、今と同じく投げる。失うものは無い。 |
| `mutator` の中の別のロック（`GoalStore.getSync` など）から出た例外 | 書き込みの前なので、今と同じ扱い。`written` は立たない。 |
| 例外を投げる `onWarning` | 握りつぶし、claim したタスクは返す。 |
| `takt run` の同時実行（2つ以上のプロセス） | 外すのは自分の記録と一致するファイルだけなので、排他は変わらない。 |
| worker のスレッド（`goalReaderWorker.ts`） | このロックを使わない。使ったとしても、モジュールの記録はスレッドごとに別なので、互いのファイルを外さない。 |
| pid の使い回し（プロセスが終わって同じ pid が別のプロセスに付く） | 記録はメモリにしかないので、新しいプロセスには無い。今の死んだ持ち主の判定（`processIdentity`）はそのまま。 |

## 上流・保存済みのデータ・公開 API・守りの仕組みへの影響

- 上流: 何も流さない。次の取り込みで `file-lock.ts`・`private-file-lock.ts`・`taskLifecycleService.ts`・`store.ts`・`reconcileLostRun.ts`・`taskFinishHook.ts` が競合しうる。上流もこの4か所で同じ問題を持つが、流すかどうかはこの直しの外で決める。
- 保存済みのデータ: tasks.yaml のスキーマとロックのファイルの書式は変えない。直す前の版と直した後の版のプロセスが、同じプロジェクトで同時に動いても、互いのロックを今までどおり扱う（直した後の版も、記録に無いファイルは外さない）。
- 公開 API: MCP の道具、`takt` のコマンド、設定のキーは変えない。中止の道具のエラーの文面も変えない。`TaskRunner.invalidatePendingGoalTasks` に省略できる第2引数が増え、`TaskStore.update` の options に `onWritten` が増える（どちらもリポジトリの中だけで使う。takt-dash は呼ばない）。
- 守りの仕組み: ロックの排他は弱めない。外す条件に足すのは「このプロセスが作って外し損ね、記録したファイルと、dev・ino・中身がすべて一致する」だけ。警告の中身は `sanitizeSensitiveText` を通す。秘密の伏せ方そのものは変えない。

## 試験

回帰テストは、直す前に失敗するのを見てから直す。

1. `it-goal-task-claim.test.ts`「does not classify an error after the write as retryable」（#168 の回帰テスト8）の期待を変える。今は「claim から例外が出て、それが再試行に分類されない」ことを確かめている。#168 の設計が「別件で直す形を試験の名前で示す」としたもので、この直しで、例外は出ずに claim したタスクが返る形になる。「再試行に回さない」は、例外が出ないことと、tasks.yaml の running が返したタスクと一致することで、引き続き確かめる。名前は「keeps the claim when a lock release fails after the write: %s」に直し、4つの入れ方（`tasks.yaml.lock` の解放、`goal-execution.lock` の持ち主の変化、`goal-execution.lock` の EIO、書いた後の `PrivateFileLockTimeoutError`）は残す。警告が1回出ることを足す。
2. `claimTasksWithGoalCompletions`: 解放が失敗した回の setup の失敗が、`setupFailedTaskNames` に入り、manager の知らせが出る（light IT、本物の tasks.yaml）。
3. `failInterruptedRunningTasks`: 書いた後に解放が失敗しても、`onRecovered` が呼ばれ、件数が返る。
4. `invalidatePendingGoalTasksWithFinishHook`: 書いた後に解放が失敗しても終了フックが呼ばれ、そのあと例外が出る。書き込みの前に失敗したときは、フックが呼ばれない。
5. `reconcileLostRun`: 書いた後に解放が失敗しても `saveManagerEvent` が出て、そのあと例外が出る。
6. `file-lock.test.ts`・`private-file-lock-acquisition.test.ts`: 外し損ねた自分のロックを、次の取得で待たずに外す。記録に無い自分の pid のファイルは外さない。置き換わったファイルは外さない。ずっと外せないときは、次の取得が `unlink` の例外を投げる。
7. heavy IT（本物の子プロセス）: 子プロセスの `takt run` が、claim の後の `tasks.yaml.lock` の解放の失敗（`unlink` を一度だけ失敗させる）を受けても、claim したタスクを実行して正常に終わる。直す前は失敗で終わり、タスクが running のまま残る。
8. PBT の1〜4。

足した試験と変えた試験は、`tsconfig.tests.json` に載せ、`scripts/test-classification.mjs` で層を決める。

## 進め方

1. この設計と Quint を1コミットにする（push はまだしない）。
2. 設計の独立レビュー（別の系統の担当）を受ける。
3. 回帰テストを書いて、直す前に失敗するのを見る。
4. 実装する。`npm run build`・`npm run lint`・`npm test`・`npm run test:it`・足した heavy IT の単体の実行・`releaseVerificationWiring.test.ts` を通す。
5. PR を `integration/takt-mcp` に出す。

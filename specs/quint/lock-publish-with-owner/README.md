# 所有者の記録とともにロックを公開する

直したあとのロックの公開を Quint にしたもの。いまの不具合の記録ではない。守る性質は
「殺された書き手は、所有者の記録が無いロックを公開しない」。

| ファイル | 内容 |
|---|---|
| `lockPublishWithOwner.qnt` | 状態、遷移。候補のファイル（パスの外）、所有者の記録、公開、強制終了、公開後の操作を持つ。 |
| `lockPublishWithOwner_test.qnt` | 14 個の `run`。`--main lockPublishWithOwnerTest` で 14 件走る。 |
| `lockPublishWithOwnerCheck.qnt` | 乱択の検査。全遷移の `step`、下の性質を不変条件にした `val`、遷移ごとの witness。モデルは import するだけで変えない。 |

quint は 0.32.0（`~/.local/bin/quint`）。`quint typecheck`、`quint test`、`quint run` を流した
（`quint verify` はしていない）。`quint test` は 14 件通過。通過数が 0 ではない。乱択の結果は
末尾の「確かめ」に書く。

```
cd specs/quint/lock-publish-with-owner
~/.local/bin/quint typecheck lockPublishWithOwner.qnt
~/.local/bin/quint typecheck lockPublishWithOwner_test.qnt
~/.local/bin/quint test lockPublishWithOwner_test.qnt --main lockPublishWithOwnerTest
~/.local/bin/quint run lockPublishWithOwnerCheck.qnt --main lockPublishWithOwnerCheck \
  --init initCheck --step stepCheck --invariant safety --max-samples 50000 --max-steps 12 --seed 0x2a
```

## モデルの範囲

書き手は 1 人、run は 1 回。書き手が 2 人同時に居る展開は無い。run を 2 回試す展開も無い。
`Writer` は、run でも enqueue でも中断でもない、素の取得を行うプロセス。

## 状態

| 名前 | とる値 | 意味 |
|---|---|---|
| `lock` | `Absent` / `Ownerless` / `Owned` | ロックのパスに在るもの。`Ownerless` は所有者の記録が無い空のファイル。 |
| `origin` | `NoOrigin` / `Leftover` / `Published` | パスに在るものの由来。`Leftover` はこの公開より前から在るもの。`Published` は公開の遷移が置いたもの。 |
| `candidate` | `NoCandidate` / `Unwritten` / `Written` | 書き手が排他で作ったファイル。パスには無い。`Unwritten` は記録がまだ無い。 |
| `owner` / `candidateOwner` | pid または `NO_OWNER` | パスの記録 / 候補の記録の中の pid。 |
| `writerPid` | pid または `NO_OWNER` | 候補を作った書き手の pid。 |
| `writerAlive` / `writerKilled` | bool | 書き手が生きているか、殺されたか。 |
| `op` | `NoOp` / `Writer` / `Enqueue` / `Abort` | 候補を作った操作。run はこの値を取らず、どの遷移も run で上書きしない。run の進みは `acquire` だけが持つ。 |
| `failedBeforeWrite` | bool | 書き込みの前の失敗があったか。この試行はそこで終わる。 |
| `acquire` | `NotTried` / `Acquired` / `FailedEmpty` | run の取得の結末。`NotTried` 以外は、run がパスを取ったことを表す。`FailedEmpty` は記録の無いロックが在って失敗。 |
| `enqueueOutcome` | `NotRun` / `Succeeded` / `Rejected` | enqueue の結末。run や中断の結末とは別の変数。 |
| `abortOutcome` | `NotRun` / `ResolvedUndefined` / `Rejected` | 中断の結末。`ResolvedUndefined` は戻りが undefined で解決したこと。これも別の変数。 |
| `hook` | `NotCalled` / `Called` | 終了フックを呼んだか。 |
| `taskState` | `Pending` / `Enqueued` / `Invalidated` | 対象のゴールタスクの状態。 |

`origin` を持つのは、`Ownerless` が「この公開が置いたもの」か「前から在るもの」かを分けるため。
`Leftover` の `Ownerless` は在り得るが、`Published` の `Ownerless` は無い。

run、enqueue、中断の結末は 3 つの変数に分かれている。run の取得が成功しても、それが
`enqueueOutcome` や `abortOutcome` の結末として読まれることはない。逆も同じ。

`op` は候補を作った操作だけを表す。run は `Op` に値を持たず、`runAttempt` は `op` を書かない。
だから run が走ったあとも、素の書き手であることは `op == Writer` のまま分かる。run がパスを
取ったかは `acquire` が持ち、取得のあとの公開・enqueue の成功・中断の成功は `acquire` で閉じる。

## 遷移

- `leftoverEmptyLock`: この公開より前にパスへ在った、記録の無い空のファイル。由来は `Leftover`。
- `directCreate`: 書き手が候補のファイルを排他で作る。**残す。** 候補はパスの外に在り、この時点
  では何も公開されていない。run は候補を作らない（run には `runAttempt` がある）。引数の pid が
  `NO_OWNER` のときは候補を作らない。run がパスを取ったあとと、書き込みの前の失敗のあとは、
  新しい候補を作らない。
- `createFails` / `writeOwnerRecordFails`: 書き込みの前の失敗。候補は残らず、パスにも何も
  公開されない。ロックを取れたことにしない。enqueue も中断も拒否し、フックは呼ばず、task は
  `Pending` のまま。拒否はその操作の結末の変数に入る。この失敗のあとは、run の取得も新しい
  候補の作成も公開も通らない。
- `writeOwnerRecord`: 候補に所有者の記録を書く。run がパスを取る前、書き込みの前の失敗の前に
  だけ通る。
- `publish`: 記録の書かれた候補をパスへ一度だけ公開する。本体は `owner' = candidateOwner` で、
  候補の記録をそのまま置く。殺された書き手では `writerAlive` が偽なので enabled にならない。
  書き込みの前の失敗のあとも公開できない。run がパスを取ったあとは `acquire` が `NotTried` で
  ないことで閉じる。
- `killWriter`: 素の書き手を、生きているあいだのどこでも殺す（記録の前、記録と公開のあいだ、
  公開のあと）。`op == Writer` で判定し、run は `op` を上書きしないので、`runAttempt` のあとでも
  殺せる。候補もパスもそのまま残る。公開より前なら、パスに書き手の置いたものは無い。公開の
  あとなら、パスには書き手の記録つきのロックが残る（`e2e/specs/run-recovery.e2e.ts` の
  `linkSync` のあとの SIGKILL がこれに当たる）。
- `runAttempt`: run の取得。パスが空なら取得し、記録の無いロックが在れば失敗して、そのファイル
  を残す。結末は `acquire` に入る。run は 1 回だけ。`op` は読まず、書き換えもしない。取得した
  あとは、公開も enqueue の成功も中断の成功も通らない。
- `enqueueSucceeds`: 公開のあとの enqueue の書き込みと解放。成功し、task は `Enqueued`。run が
  パスを取っていないときだけ通る。
- `abortSucceeds`: 公開のあとの中断の無効化。フックを呼び、task は `Invalidated`、戻りは
  undefined で解決する。run がパスを取っていないときだけ通る。

`publish`、`enqueueSucceeds`、`abortSucceeds`、`runAttempt`、`directCreate` のガードは
`...Enabled` の `val` / `def` に切り出してある。これは性質ではなく遷移のガードである。テストの
`no...` は `fail(...Enabled)` を書いた stutter で、その遷移が書けないことを、その時点の状態に
対して示す。`publishEnabledHolds` はその逆で、ガードが成り立つことだけを示す stutter。

## 書いていないこと

- 空のファイルを 30 秒で捨てる遷移は無い。その待ち時間に当たる定数も置いていない。空の
  ファイルがパスに在るあいだは、run はすぐに失敗して、ファイルをそのまま残す。
- 記録の無いロックがパスに残っているとき、run は失敗する。それを消して成功する遷移も、
  空のロックが残ったまま成功する `run` も無い。run 3 は、失敗したあとの状態で公開、enqueue の
  成功、中断の成功がどれも書けないことを示す。
- 公開の失敗（EEXIST、ENOSPC）の遷移は無い。解放が所有者を検査する遷移も無い。
- 生きている持ち主のロックに対する run の扱いは対象外（`runAttempt` は `Owned` を取らない）。
- 書き手を同時に 2 人にする展開は無い。
- 実装の手順は書いていない。候補をどこに置くか、どの順でどの呼び出しを使うかは、この仕様の
  外にある。
- 検証の主張はしない。モデルの本体では性質を `val` にせず、14 個の `run` の中で、その時点の
  状態に対して具体的に書く。`...Enabled` はガードであって性質ではない。乱択の検査では同じ性質を
  `lockPublishWithOwnerCheck.qnt` の `val` にした。ガードだけで恒真になっていないことは、ガードを
  外した版で違反が出ることで確かめた（末尾の「確かめ」）。どれも乱択の結果である。

## 性質

| 名前 | 内容 | 読む run |
|---|---|---|
| `killedWriterPublishesNoOwnerlessLock` | 殺された書き手は、記録の無いロックを公開しない。 | 1、2、12 |
| `publishedLockHasOwner` | 公開されたロックには所有者の記録がある。 | 4、14 |
| `preWriteFailurePublishesNothing` | 書き込みの前の失敗は、パスに何も公開しない。 | 5、6、7、8、9 |
| `rejectedKeepsTaskPendingWithoutHook` | 拒否したときは、フックを呼ばず、task を `Pending` のままにする。 | 5、6、7、8、9 |
| `noSuccessWithEmptyLock` | 記録の無いロックがパスに在るとき、成功した run は無い。 | 3 |
| `runTakeClosesSuccess` | run がパスを取ったあと、enqueue の成功も中断の成功も公開も通らない。 | 3、12 |
| `preWriteFailureIsNotAcquisition` | 書き込みの前の失敗と、ロックを取れた状態は同居しない。 | 5、6、7、8、9 |
| `directCreateRequiresPid` | `directCreate` の pid が `NO_OWNER` のときは候補を作らない。 | 13 |

run 2 と run 14 は、記録を書いたあとの同じ前置きから分かれる。run 2 はそこで書き手を殺し、
公開を書けない。run 14 は殺さずに、記録つきで公開する。run 1 は記録の前に殺す。パスは空の
ままで、そのあとの取得は成功する。run 12 は、記録があり、書き手が生きていて、パスが空で、
失敗も無い状態で、`acquire` だけが公開のガードを閉じていることを示す。

## run（14 個）

| run | 読むもの |
|---|---|
| `runKilledBeforeOwnerRecordTest` | 記録の前に殺される。公開の遷移が書けないことを示したあと、run は空のパスを取得する。 |
| `runKilledAfterOwnerRecordTest` | 記録の後、公開の前に殺される。殺す前は公開が enabled で、殺したあとは書けない。 |
| `runLeftoverEmptyLockFailsTest` | 記録の無いロックが前から在る。run は失敗し、ファイルはそのまま残る。公開、enqueue の成功、中断の成功が書けないことを同じ run で示す。 |
| `publishWithOwnerTest` | 公開に所有者の記録が付く。 |
| `writerPreWriteFailureIsNotAcquisitionTest` | 素の書き手の記録の書き込みが失敗する。公開も run の取得も新しい候補も通らない。フックは呼ばず、`Pending`。 |
| `enqueuePreWriteFailureRejectsTest` | enqueue は記録の書き込みの失敗で拒否する。公開も run の取得も通らない。フックは呼ばず、`Pending`。 |
| `abortPreWriteFailureRejectsTest` | 中断も同じく拒否する。公開も run の取得も通らない。フックは呼ばず、`Pending`。 |
| `enqueueCreateFailureRejectsTest` | 候補を作れないときも enqueue は拒否する。公開も run の取得も通らない。フックは呼ばず、`Pending`。 |
| `abortCreateFailureRejectsTest` | 候補を作れないときも中断は拒否する。公開も run の取得も通らない。フックは呼ばず、`Pending`。 |
| `enqueuePublishedWithOwnerSucceedsTest` | 記録とともに公開した enqueue は成功する。結末は enqueue の変数にだけ入る。 |
| `abortPublishedWithOwnerCallsHookTest` | 記録とともに公開した中断はフックを呼ぶ。結末は中断の変数にだけ入る。 |
| `runTakeThenKillBeforePublishTest` | run がパスを取る。記録があり書き手が生きている状態で、`acquire` だけが公開を閉じる。enqueue の成功も新しい候補も通らない。そのあとで公開前の書き手を殺せて、公開はやはり書けない。 |
| `directCreateWithoutPidCreatesNoCandidateTest` | pid が `NO_OWNER` の `directCreate` は候補を作らない。状態は `init` のまま。 |
| `writerPublishCarriesOwnerRecordTest` | run 2 と同じ前置きで殺さない。公開が enabled で、ロックの所有者は候補の記録である。 |

## 確かめ（2026-11-28、595d6a826 に対して）

[#193](https://github.com/j5ik2o/takt/pull/193) の Quint の見直しで行った確かめ。5 つのモデル全体の
結果は `docs/design/quint-193-review.md` にある。

### 直したこと

`killWriter` のガードから `origin != Published` を外した。前の形では、書き手を殺せるのは
「公開より前」だけだった。直す前の本番（b86f10c49 より前。`openSync(tasks.yaml.lock, 'wx')` で
空のファイルをパスに置いてから記録を書く）をこのモデルに入れると、パスに空のファイルが出た
時点で `origin` が `Published` になり、殺す遷移が閉じる。そのため
`killedWriterPublishesNoOwnerlessLock` は、守るはずの不具合の形でも違反を返さなかった（下の M1）。
また `e2e/specs/run-recovery.e2e.ts` は `linkSync` で公開したあとに SIGKILL を送るので、前の形
ではこの試験の展開を書けなかった。直したあとも 14 個の `run` はすべて通る。

### (a) 不変条件が恒真でない

`lockPublishWithOwnerCheck.qnt` の `safety` は 50,000 サンプル、max-steps 12、seed 0x2a で違反
なし（乱択であって証明ではない）。モデルを 1 か所ずつ壊した版では、次のとおり。

| 版 | 壊したところ | 見た不変条件 | 結果 |
|---|---|---|---|
| M1 | `directCreate` が空のファイルをパスに公開する（b86f10c49 より前の形） | `killedWriterPublishesNoOwnerlessLock` | 違反 |
| M2 | `publishEnabled` が記録の無い候補も通す（`candidate != NoCandidate`） | `publishedLockHasOwner` | 違反 |
| M3 | `runAttemptEnabled` から `not(failedBeforeWrite)` を外す | `preWriteFailurePublishesNothing` | 違反 |
| M4 | `writeOwnerRecordFails` がフックを呼ぶ | `rejectedKeepsTaskPendingWithoutHook` | 違反 |
| M5 | `runAttempt` が記録の無いロックの上でも取得する | `noSuccessWithEmptyLock` | 違反 |
| M6 | `publishEnabled` から `acquire == NotTried` を外す | `runTakeClosesSuccess` | 違反 |
| M7 | `directCreateEnabled` から `pid != NO_OWNER` を外す | `directCreateRequiresPid` | 違反 |
| M8 | `publishEnabled` から `writerAlive` を外す | `safety` 全体 | 違反なし |

M8 は違反を返さない。殺された書き手が記録つきで公開しても、どの性質も壊れないからである。
`writerAlive` は「殺されたプロセスは何もしない」を書いたガードで、7 つの性質はどれもこのガードに頼らずに成り立つ。
M1 は直す前のモデルでは違反なしだった（上の「直したこと」）。

### (b) 遷移に届く

20,000 サンプル、max-steps 12、seed 0x2a の witness。どの遷移も 1 回以上起きる。

| witness | 遷移 | 届いた trace |
|---|---|---|
| `wLeftover` | `leftoverEmptyLock` | 5358 |
| `wDirectCreate` | `directCreate` | 3830 |
| `wCreateFails` | `createFails` | 5445 |
| `wWriteOwnerRecord` | `writeOwnerRecord` | 1163 |
| `wWriteOwnerRecordFails` | `writeOwnerRecordFails` | 1198 |
| `wPublish` | `publish` | 545 |
| `wKillWriter` | `killWriter` | 925 |
| `wRunAcquired` | `runAttempt`（取得） | 7895 |
| `wRunFailedEmpty` | `runAttempt`（記録の無いロックで失敗） | 5358 |
| `wEnqueueSucceeds` | `enqueueSucceeds` | 235 |
| `wAbortSucceeds` | `abortSucceeds` | 206 |
| `wKilledAfterRecord` | 記録のあと、公開の前に殺す | 206 |
| `wKilledAfterPublish` | 公開のあとに殺す | 104 |

### (c) 本番との対応（595d6a826）

| モデル | 本番 | 備考 |
|---|---|---|
| `candidate`（`Unwritten`） | `src/infra/fs/file-lock.ts:190-191` `openSync(temporaryPath, 'wx', 0o600)`（`temporaryPath` は `<lock>.<pid>.<uuid>.tmp`） | `directCreate: true` は `src/infra/task/store.ts:128` の `TaskStore.withLock` だけが渡す |
| `writeOwnerRecord` | `file-lock.ts:194` `writeFileSync(descriptor, content)`。中身は `:261` の `{ pid, processIdentity }` | |
| `writeOwnerRecordFails` | `file-lock.ts:196-199`（閉じて一時ファイルを消し、投げ直す）→ `:265-267` `onAcquisitionError` | 拒否は呼び出し元へ例外として届く |
| `createFails` | `file-lock.ts:191` の `openSync` が投げる（try の外）→ `:265-267` | 試験は `src/__tests__/helpers/lock-release-faults.ts:133` で一時ファイルの `'wx'` を EACCES にする |
| `publish` | `file-lock.ts:203` `linkSync(temporaryPath, lockPath)`、`:214` 一時ファイルを消す | link は排他。在れば EEXIST |
| `killWriter` | 本番のコードは無い（SIGKILL） | 殺された書き手の一時ファイルを片づけるコードは無い。モデルでも候補は残る |
| `leftoverEmptyLock` | 本番のコードは無い（前から在る空のファイル） | b86f10c49 より前の版や、外のプロセスが残したもの |
| `runAttempt`（`FailedEmpty`） | `file-lock.ts:206-212` の EEXIST → `recoverStaleLock`（`:149-184`）。`parseOwner` が `undefined`、mtime が `STALE_MS` 以内なので消さず、`TIMEOUT_MS`（5 秒）で時間切れ | **違い**：mtime が `STALE_MS`（30 秒、`:11`、`:177`）を過ぎた空のファイルは `:182` で消され、取得は成功する。モデルにこの遷移は無い |
| `runAttempt`（`Acquired`） | `file-lock.ts:203` の link が通る | |
| `enqueueSucceeds` | `src/infra/task/enqueuedTaskFile.ts:54` `saveEnqueuedTaskFile` → `releaseLock`（`file-lock.ts:109-120`） | |
| `abortSucceeds` | `src/features/tasks/execute/taskFinishHook.ts:312-323` `invalidatePendingGoalTasksWithFinishHook` | 取得に失敗したときも `finally` で `runTaskFinishHooksForStates` を呼ぶが、渡す状態は空なのでフックは走らない。モデルの `NotCalled` と同じ |
| `taskState` / `hook` | `tasks.yaml` の状態と `task_finish_hook` | |

### (d) 範囲

- 書き手は 1 人、run は 1 回。どの遷移も 1 回しか起きないので、到達できる trace は 6 状態以下で
  行き止まる。max-steps 12 はそれより長い。
- 生きている持ち主・死んだ持ち主の `Owned` に対する run（`recoverStaleLock` の `:174-176`）は
  見ていない。`run-recovery.e2e.ts` の 2 回目の `takt run` はこの回収に当たり、モデルの外にある。
- 30 秒を過ぎた空のファイルの回収、公開の EEXIST・ENOSPC、解放の所有者検査、2 人の書き手の
  競合は見ていない。
- 乱択（`quint run`）であって、`quint verify` による全探索はしていない。

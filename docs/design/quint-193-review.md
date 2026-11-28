# #193 の Quint の見直し

[#193](https://github.com/j5ik2o/takt/pull/193) の作業ツリーに未追跡で置かれていた 5 つの Quint
モデルを、595d6a826 に対して見直した結果。どれを枝に入れるかは
[#205](https://github.com/j5ik2o/takt/issues/205) の答えとして決めた。

見た点は 4 つ。

- (a) 不変条件が恒真でない：モデルを 1 か所壊した版で、その不変条件が違反を返すか。
- (b) 遷移に届く：どの action も、実行の中で 1 回以上起きるか。
- (c) 実物と合う：状態と action が、本番と試験のどこに当たるか。
- (d) 範囲：サンプル数とステップ数、それで見られないもの。

壊した版は作業ツリーの外（scratchpad）で作って流し、モデルの本体には残していない。quint は
0.32.0。`quint verify` は使っていない。結果はどれも乱択か、決めた手順の run で、証明ではない。

## 結論

| モデル | 誤り | 枝に入れるか |
|---|---|---|
| `lock-publish-with-owner` | 1 件（書き手を公開の前にしか殺せない）。直した | 入れる |
| `lock-unpublished-without-owner` | 直す前の本番（b86f10c49 より前）の形で、いまの本番と合わない | 入れない |
| `worker-pool-acquisition-enospc` | `Current` / `Fixed` の名前が、のちのコミットで実物と食い違った。success の行が無い | 入れない |
| `worker-pool-runtime-fourteen` | 「14件」と言いながら success の行が無い。行ごとに同じ中身の action を写している | 入れない |
| `worker-pool-runtime-rows` | create の行の失敗の場所が、595d6a826 の試験と食い違う | 入れない |

入れない 4 つは作業ツリーに残してあり、消していない。

## lock-publish-with-owner（入れる）

直したあとのロックの公開（一時ファイルに所有者の記録を書いてから `linkSync` で公開する）を
書いたモデル。b86f10c49 の本番と同じ形を書いている。4 点の詳しい表は
`specs/quint/lock-publish-with-owner/README.md` の「確かめ」にある。

- 誤り：`killWriter` のガードに `origin != Published` があり、書き手を殺せるのは公開の前だけ
  だった。直す前の本番の形（空のファイルを先にパスへ置く）をこのモデルに入れると、パスに空の
  ファイルが出た時点で殺す遷移が閉じ、守るはずの性質
  `killedWriterPublishesNoOwnerlessLock` が違反を返さなかった。`e2e/specs/run-recovery.e2e.ts` は
  公開のあとに SIGKILL を送るので、この試験の展開も書けなかった。ガードを外して直した。
  14 個の `run` はすべて通る。
- (a) 乱択の検査 `lockPublishWithOwnerCheck.qnt` を足し、README の 7 つの性質を不変条件に
  した。7 つとも、壊した版で違反を返す。`publish` の `writerAlive` を外した版だけは違反が
  出ない。これは「殺されたプロセスは何もしない」を書いたガードで、7 つの性質はどれもこのガードに頼らずに成り立つ。
- (b) 10 の遷移すべて（`runAttempt` は取得と失敗の 2 つ）と、「記録のあとに殺す」「公開のあとに殺す」に、20,000 サンプル中で
  104〜7,895 の trace が届く。
- (c) すべての遷移に `src/infra/fs/file-lock.ts` などの行が当たる。違いは 1 つで、本番は
  mtime が 30 秒を過ぎた空のロックを消して取得を通す（`file-lock.ts:177`、`:182`）。モデルには
  この遷移が無く、空のロックの上の run は必ず失敗する。
- (d) 書き手 1 人、run 1 回。到達できる trace は 6 状態以下で行き止まり、max-steps 12 で足りる。
  死んだ持ち主のロックの回収、30 秒の回収、公開の EEXIST・ENOSPC、2 人の書き手は見ていない。

## lock-unpublished-without-owner（入れない）

b86f10c49 より前の `directCreate`（`openSync(tasks.yaml.lock, 'wx')` で空のファイルを公開して
から記録を書く）と、その形で観測された 3 件を書いたモデル。

- (a) `killedWriterPublishesNoOwnerlessLock` は run 1 で、`armedFaultObserved` は run 2・3 で
  違反する（run の中で `not(...)` を確かめている）。`preWriteFailureIsNotAcquired` は、どの run
  でも差し込んだ失敗が観測されないので、前提が偽のまま成り立つだけで、何も確かめていない。
- (b) `step` が無い。`linkCreate`、`linkPublish` はどの run からも通らない（README にもそう
  書いてある）。
- (c) 合わない。いまの `file-lock.ts:189-216` の `directCreate` は一時ファイルと `linkSync` を
  使い、モデルの `Direct` に当たる本番はもう無い。試験の差し込み
  （`src/__tests__/helpers/lock-release-faults.ts:133`、一時ファイルの `'wx'`）は、いまの
  `directCreate` が開く一時ファイルに当たるので、run 2・3 の「失敗が観測されない」も成り立たない。
- (d) 3 件の run だけ。
- 入れない理由：書いているのは、もう無い本番の形である。不具合の形を確かめる役は、
  lock-publish-with-owner の壊した版 M1 が受け持つ。

## worker-pool-acquisition-enospc（入れない）

`src/__tests__/it-worker-pool-runtime.test.ts` の ENOSPC の行を、`DESIGN = "Current"` /
`"Fixed"` の 2 つで書いたモデル。

- (a) `Current` で `everyFaultObserved` と `faultDefersClaim` が 1 ステップで違反する（README）。
  `Fixed` を壊した版では、`recover` が world を見ずに claim する版で `recheckHonorsWorld`、A の
  実行識別子を変える版で `preservesRunningTask` が違反する。`recover` の `not(full)` を外した
  版は違反しない（`releaseA` が先に `not(full)` を求めるので、外しても届く状態が変わらない）。
- (b) README の witness 7 つが 936〜9,990 / 10,000 で届く。
- (c) 合わない。`Current` は「試験の差し込みが、いまの取得に当たらない」状態を書いている。
  524f42803 と 595d6a826 で試験の差し込みが一時ファイルに移り、いまの試験では差し込みが観測
  される。`Fixed` は上流の `'wx'` でロックのパスを開く取得を名指しているが、この枝はその形を
  採らなかった。どちらの名前も、いまの実物を指していない。
- (d) 試験の 14 行のうち success の行が無い。
- 入れない理由：2 つの名前が実物と食い違い、直すと rows と同じものになる。

## worker-pool-runtime-fourteen（入れない）

同じ試験を、行ごとに別の action（72 個）で書いたモデル。

- (a) `claimCreateNoneThird` で失敗を数えない版にすると、run 1 が落ちる。不変条件の `val` は
  run の `expect` の中でしか確かめていない。
- (b) `step` が無い。どの action も自分の行の run で 1 回使われる。
- (c) 合わない所がある。名前は「14件」だが、試験の `it.each`（270〜275 行）の 14 行のうち success
  の行が無く、13 行と handler の試験を数えている。create の行は rows と同じ食い違いを持つ。
- (d) 14 個の run だけ。
- 入れない理由：行ごとに名前だけ違う同じ中身の action を写していて、rows が同じ範囲をより
  正しく書いている。

## worker-pool-runtime-rows（入れない）

同じ試験の 14 行と handler の試験を、行の値を状態に持つ 1 組の action で書いたモデル。3 つの
worker pool のモデルの中では、いちばん試験に近い。

- (a) 乱択の検査を作業ツリーの外で作って流した（全 action の `step`、13 の不変条件）。20,000
  サンプル、max-steps 20、seed 0x2a で違反なし。壊した版では、失敗を `storeFaults` に数えない版、
  空きの枠を concurrency と無関係にする版、所有者の記録の書き込みに失敗しても一時ファイルを
  残す版が、それぞれ不変条件の違反を返す。回復の dispatch が goal の状態を見ない版と、中断した
  goal の完了を manager に記録する版は、不変条件では違反が出ず、run（paused・aborted の 2 件、
  aborted の 1 件）が落ちる。world の再確認と manager の件数は、不変条件ではなく run が守っている。
- (b) 乱択で、14 の phase すべてと、B が消える・中断した goal で件数 0 になる状態に、
  20,000 サンプル中 711〜10,083 の trace が届く。
- (c) 合わない所がある。create の行は「候補の `openSync` が失敗する」と書いているが、595d6a826
  の試験は create でも metadata でも、候補の fd への `writeFileSync` で失敗させる
  （`it-worker-pool-runtime.test.ts:301-317`）。モデルの `lockOpenFailures` は試験の中で一度も
  起きない。README の行番号（258 行、548 行）も、いまは 270 行と 558 行である。
- (d) 1 つのプロジェクト、A と B の 2 件。B の workflow の実行、`tasks.yaml` 本体の書き込みの
  ENOSPC、完了の書き込み、ほかの書き手は見ていない。
- 入れない理由：直すには、create の 7 行の run を書き直すことになる。直しても、書いている
  ことは試験 1 本の写しで、試験が言っていない性質を足さない。worker pool の経路の約束は、
  `docs/design/worker-pool-completion-publication.md` の新しいモデルで書く。

## 試験との食い違い（試験は直していない）

- `src/__tests__/it-worker-pool-runtime.test.ts:270-275` の `stage` は、595d6a826 のあとは
  `'success'` かどうかしか効かない。`create` と `metadata` の行は同じ失敗（候補の fd への
  `writeFileSync` の ENOSPC）を起こす。行の名前は「create ENOSPC」のままで、候補の `openSync` が
  失敗する経路（`file-lock.ts:191`）はこの群では確かめていない。
- `e2e/specs/run-recovery.e2e.ts` の SIGKILL は公開のあとに当たる。lock-publish-with-owner の
  直す前のモデルは、この展開を書けなかった（直した）。

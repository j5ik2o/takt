# worker pool の経路の完了の通知

`docs/design/worker-pool-completion-publication.md` の不変条件 I1〜I5 を書いたモデル。ゴールタスクの
失敗の 1 回の試みについて、保存から通知、印の消し込み、終了フック、daemon の出し直しまでを持つ。

| ファイル | 内容 |
|---|---|
| `workerPoolCompletionPublication.qnt` | 状態、遷移、不変条件、witness。末尾の `current`（595d6a826）と `design`（設計のあと）が `DESIGN` を選ぶ。 |

quint は 0.32.0。流したのは `quint typecheck` と `quint run`（`quint verify` はしていない）。

```
cd specs/quint/worker-pool-completion-publication
~/.local/bin/quint typecheck workerPoolCompletionPublication.qnt
~/.local/bin/quint run workerPoolCompletionPublication.qnt --main design --invariant safety \
  --max-samples 50000 --max-steps 16 --seed 0x2a
~/.local/bin/quint run workerPoolCompletionPublication.qnt --main current --invariant deliveredOrMarked \
  --max-samples 20000 --max-steps 12 --seed 0x2a
```

`design` は違反なし、`current` は I1〜I4 で違反を返す。壊した版の結果、witness の数、本番との
対応、範囲は、設計の文書の「Quint」の節にある。

## 遷移

| 遷移 | 意味 |
|---|---|
| `save(k)` | 失敗の記録を保存する。`k` は読めない内容、claim の setup 失敗、遠隔の終わりのどれか。印は同じ書き込みで付く。 |
| `publish` / `publishFails` | runtime の `saveManagerEvent` が通る / ENOSPC で投げる。 |
| `clearMark` / `clearFails` | 通知のあとで印を消す / 消すのに失敗して警告する。 |
| `finishAttempt(lost)` | ローカルの保存なら終了フックを呼ぶ（`lost` ならフックを失って警告する）。runtime が返る。 |
| `kill` | 保存のあと、runtime のプロセスが死ぬ。 |
| `daemonResend` | daemon が印のある記録を受信箱へ書き、印を消す。 |
| `diskFills` / `diskFrees` | ディスクが埋まる / 空く。 |

## 不変条件

| 名前 | 内容 |
|---|---|
| `deliveredOrMarked`（I1） | 保存した完了は届いたか、印が残っている。 |
| `notificationFailureStaysInside`（I2） | 通知の失敗でプロジェクトの host が閉じない。 |
| `localSaveCallsHook`（I3） | ローカルの保存で runtime が返るとき、フックが走ったか警告が出ている。 |
| `publishedClearsMark`（I4） | runtime が通知したあと、印を消すのに失敗した場合を除いて印は残らない。 |
| `unpublishedIsWarned`（I5） | 通知できずに返るときは警告が出ている。 |

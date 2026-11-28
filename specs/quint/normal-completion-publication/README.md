# normal-completion-publication（#216）

ゴールタスクの通常の完了を 1 回の試みとして書いたモデル。保存、呼び出し側（takt run、worker pool の W5、通知しない instruct）の通知、読み直しの失敗、印の消し込み、run の数え方、daemon の出し直し、受信箱の `eventId`、古い記録の読みを持つ。設計は `docs/design/issue-216-normal-completion-publication.md`。

保存の形は 3 つある。`Normal`（記録にも結果にも `run_slug`）、`PausedBeforeWorkflow`（ワークフローの前の一時停止。記録には `run_slug` が無く、結果には有る）、`NoResult`（結果に `completion` が無い）。受信箱は、この試みの `eventId`（`RunId`・`ExecId`）の集合として持つ。

## 版

- `sameWrite`：案 A（この設計）。頼まれた保存と同じ書き込みで印を付け、通知の成功で消し、失敗は警告する。
- `current`：e626fcce3。印なし、通知は `try` なし。
- `markOnFailure`：案 B。通知に失敗したときだけ 2 回目の書き込みで印を付ける。
- `broken*`：案 A を 1 か所ずつ壊した版（`NoClear`、`NoCatch`、`NoWarn`、`ResendUnmarked`、`MarkOnSchema`、`MarkUnrequested`、`SilentReadBack`、`CallerForgetsRequest`）。

## 流し方

```sh
quint typecheck normalCompletionPublication.qnt
# 全部の状態を TLC で調べる（版ごと・不変条件ごと。同時に流すと TLC の作業ファイルがぶつかるので 1 本ずつ）
quint verify normalCompletionPublication.qnt --main sameWrite --backend tlc --invariant safety
quint verify normalCompletionPublication.qnt --main brokenMarkOnSchema --backend tlc --invariant oneEventPerAttempt
# 呼び出し側が試みから抜けること（弱い公平性のもと）。公平性を外した版は違反する
quint verify normalCompletionPublication.qnt --main sameWrite --backend tlc --temporal callerSettles
quint verify normalCompletionPublication.qnt --main sameWrite --backend tlc --temporal callerSettlesUnfair
# 乱択と witness
quint run normalCompletionPublication.qnt --main sameWrite --max-samples 50000 --max-steps 16 --seed 0x2a --invariant safety
quint run normalCompletionPublication.qnt --main sameWrite --max-samples 20000 --max-steps 16 --seed 0x2a --invariant safety \
  --witnesses wSave wSkip wInstruct wReadBackFails wPublish wPublishFails wClear wClearFails wKill wResend \
  wJ1OnlyMark wJ1Delivered wJ2AfterFailure wJ3PoolFailure wJ4Cleared wJ5Warned wJ7Instruct wJ7Paused wJ8Overlap \
  wPausedLost wResendAfterFailure wResendAfterKill wPoolReturnedAfterFailure
```

結果の表（どの版がどの不変条件に違反するか、witness の数）は設計の文書の「Quint」の節にある。quint 0.32.0、TLC は quint の同梱のもの。`quint verify` が作る `_apalache-out/` はコミットしない。

## 見ていないもの

- 2 回目以降の試み（再キュー・再 claim で印が外れる展開）と、別の試みの記録との取り違え（設計では読み直しを `execution_id` で絞ってふさぐ）。
- 2 つのタスクの同時の保存。
- daemon が印を消し切ること（#170 のモデル `goal-task-completion-publication/` の範囲）。
- 保存そのものの失敗。

コードを変えるときは、先にこのモデルと設計を直し、同じ検査を流し直す。

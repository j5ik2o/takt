# normal-completion-publication（#216）

ゴールタスクの通常の完了を 1 回の試みとして書いたモデル。保存、呼び出し側（takt run、worker pool の W5、通知しない instruct）の通知、読み直しの失敗、印の消し込み、run の数え方、daemon の出し直し、古い記録の読みを持つ。設計は `docs/design/issue-216-normal-completion-publication.md`。

## 版

- `sameWrite`：案 A（この設計）。保存と同じ書き込みで印を付け、通知の成功で消し、失敗は警告する。
- `current`：e626fcce3。印なし、通知は `try` なし。
- `markOnFailure`：案 B。通知に失敗したときだけ 2 回目の書き込みで印を付ける。
- `broken*`：案 A を 1 か所ずつ壊した版（`NoClear`、`NoCatch`、`NoWarn`、`ResendUnmarked`、`MarkOnSchema`、`MarkUnrequested`、`SilentReadBack`）。

## 流し方

```sh
quint typecheck normalCompletionPublication.qnt
quint run normalCompletionPublication.qnt --main sameWrite --max-samples 50000 --max-steps 16 --seed 0x2a --invariant safety
quint run normalCompletionPublication.qnt --main current --max-samples 10000 --max-steps 12 --seed 0x2a --invariant deliveredOrMarked
quint run normalCompletionPublication.qnt --main sameWrite --max-samples 20000 --max-steps 16 --seed 0x2a --invariant safety \
  --witnesses wSave wSkip wInstruct wReadBackFails wPublish wPublishFails wClear wClearFails wKill wResend wResendAfterFailure wResendAfterKill \
  wSuccessCountedAfterFailure wWorkerPoolReturnedAfterFailure
```

結果の表（どの版がどの不変条件に違反するか、witness の数）は設計の文書の「Quint」の節にある。quint 0.32.0。

## 見ていないもの

- 2 回目以降の試み（再キュー・再 claim で印が外れる展開）。
- 受信箱の写しの数（`eventId` で 1 回にまとまる）。daemon が印を消し切ること（#170 のモデル `goal-task-completion-publication/` の範囲）。
- 保存そのものの失敗。

コードを変えるときは、先にこのモデルと設計を直し、同じ検査を流し直す。

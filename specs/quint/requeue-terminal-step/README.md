# 失敗通知だけの終端工程からの再投入（j5ik2o/takt#117）

`requeueTerminalStep.qnt` は、失敗したタスクを開始位置の指定なしで再投入したときの状態遷移を表す。

## 対象のコード

- `src/features/tasks/list/taskRetryStartSelection.ts`（既定の開始位置は保存済みの再開位置）
- `src/features/tasks/taskRetryStartPath.ts`（保存済みの再開位置の解決）
- `src/features/mcp/goalTaskRetryOperations.ts`（`startStep` を省略すると既定の開始位置を使う）
- `src/core/workflow/abort-only-step.ts`（ABORT にしか進めない step の判定）

## モデルの範囲

workflow は次の形に縮めている。`merge-review` の `caccia` → `caccia_failed` → ABORT、`merge-prepare` の `review` → `review_failed` → ABORT と同じ形である。

```text
Work   --成功--> COMPLETE
Work   --失敗--> Notify      （Notify は失敗の通知だけを行う）
Notify --常に--> ABORT
```

`guardAbortOnly` で挙動を切り替える。`current` は修正前（false）、`fixed` は修正後（true）。

扱っていないもの：`workflow_call` の入れ子、並列 step、自動の再投入（`autoRequeueFailedTask`）、実行上限に達したタスクの再投入。

## 不変条件

`noBlindAbort`：開始位置を指定しない再投入が、失敗の通知しか実行しないまま ABORT で終わることはない。

## 結果（quint 0.32.0）

修正前のモデルで反例が出る。

```sh
quint run requeueTerminalStep.qnt --main=current --invariant=noBlindAbort \
  --max-steps=12 --max-samples=10000 --seed=0x117
```

出力は `[violation] Found an issue`、再現用の seed は `0x1d0`。反例は5状態。

| 状態 | 起きたこと | status | current | savedPosition | startedBy | didWork |
|---|---|---|---|---|---|---|
| 0 | 初回の実行を開始 | Running | Work | Work | Explicit(Work) | false |
| 1 | Work が失敗し Notify へ | Running | Notify | Notify | Explicit(Work) | true |
| 2 | Notify が ABORT | Failed | Notify | Notify | Explicit(Work) | true |
| 3 | 開始位置なしで再投入 | Running | Notify | Notify | SavedPosition | false |
| 4 | Notify が再び ABORT | Failed | Notify | Notify | SavedPosition | false |

修正後のモデルでは、同じ不変条件で反例が出なかった。

```sh
quint run requeueTerminalStep.qnt --main=fixed --invariant=noBlindAbort \
  --witnesses="status == Completed and cause == WorkFailed" "refusals > 0" \
  --max-steps=12 --max-samples=10000 --seed=0x117
```

10,000 サンプル、max-steps 12、seed 0x117 で反例なし。到達の確認（witness）は、「失敗のあと開始位置を指定して完了する」が 3,913 件、「開始位置なしの再投入を断る」が 3,276 件。trace の最短は2（初回の Work が成功して終わる経路）で、Completed は終端である。

仕様とコードは機械的にはつながっていない。コードの回帰テストは `src/__tests__/taskRetryStartSelection.test.ts` と `src/__tests__/it-goal-task-retry.test.ts` にある。

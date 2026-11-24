# 失敗通知だけの終端工程からの自動の再投入（j5ik2o/takt#127）

`autoRequeueTerminalStep.qnt` は、失敗したタスクを自動で再投入したときの状態遷移を表す。手動の再投入（j5ik2o/takt#117）は `../requeue-terminal-step/` にある。

## 対象のコード

- `src/infra/task/taskRetryService.ts`（`autoRequeueFailedTask`。開始位置は `failure.step`）
- `src/features/tasks/execute/taskResultHandler.ts`（`failure.step` には最後に実行した step が入る）
- `src/features/tasks/execute/parallelExecution.ts`（`attemptAutoRequeueTask`、`isAutoRequeueCandidate`）
- `src/features/tasks/execute/autoRequeueRestart.ts`（再開する位置が ABORT にしか進めないかの判定）
- `src/core/workflow/abort-only-step.ts`（ABORT にしか進めない step の判定）

## モデルの範囲

workflow は次の形に縮めている。

```text
Work   --成功-->   COMPLETE
Work   --失敗-->   Notify      （Notify は失敗の通知だけを行う）
Work   --エラー--> タスクが Work で失敗（再実行で結果が変わりうる）
Notify --常に-->   ABORT
```

`guardAbortOnly` で挙動を切り替える。`current` は修正前（false）、`fixed` は修正後（true）。再投入の上限（`maxAttempts`）はどちらも 3。

扱っていないもの：「ほかの step から進んでこない step は、ABORT にしか進めなくても見送らない」という条件（モデルの Notify は常に Work から進んでくる。この条件と `workflow_call` の階層の扱いはコードのテストで確かめている）、`workflow_call` の入れ子、並列 step、保存済みの `resume_point` と `restart_point`（モデルでは開始位置を `failure.step` だけで表す）、ゴールに属するタスク（`goal_owned` で自動の再投入から外れる）、手動の再投入、実行上限に達したタスクの再投入。

## 不変条件

- `noBlindAbort`：自動の再投入が、失敗の通知しか実行しないまま ABORT で終わることはない。
- `attemptsBounded`：再投入の回数は上限を超えない。

## 結果（quint 0.32.0）

修正前のモデルで反例が出る。

```sh
quint run autoRequeueTerminalStep.qnt --main=current --invariant=noBlindAbort \
  --max-steps=12 --max-samples=10000 --seed=0x127
```

出力は `[violation] Found an issue`。反例は5状態。

| 状態 | 起きたこと | status | current | failedStep | autoRequeueCount | startedBy | didWork |
|---|---|---|---|---|---|---|---|
| 0 | 初回の実行を開始 | Running | Work | Work | 0 | FirstRun | false |
| 1 | Work が失敗し Notify へ | Running | Notify | Work | 0 | FirstRun | true |
| 2 | Notify が ABORT | Failed | Notify | Notify | 0 | FirstRun | true |
| 3 | 自動で再投入（Notify から再開） | Running | Notify | Notify | 1 | AutoRequeue | false |
| 4 | Notify が再び ABORT | Failed | Notify | Notify | 1 | AutoRequeue | false |

修正後のモデルでは、同じ不変条件で反例が出なかった。

```sh
quint run autoRequeueTerminalStep.qnt --main=fixed --invariants noBlindAbort attemptsBounded \
  --witnesses="status == Completed and autoRequeueCount > 0" "skips > 0" "autoRequeueCount == 3" \
  --max-steps=12 --max-samples=10000 --seed=0x127
```

10,000 サンプル、max-steps 12、seed 0x127 で反例なし。到達の確認（witness）は、「Work で失敗したタスクが自動の再投入のあと完了する」が 1,642 件、「Notify からの再投入を見送る」が 4,845 件、「上限の3回まで再投入する」が 387 件。trace の最短は2（初回の Work が成功して終わる経路）で、Completed は終端である。

仕様とコードは機械的にはつながっていない。コードの回帰テストは `src/__tests__/watcher.test.ts`（「再開位置（…）が ABORT にしか進めない step の失敗タスクは自動で再投入せず…」ほか）にある。

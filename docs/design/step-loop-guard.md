# Step loop guard（max_visits と stop_on_repeated_verdict）

[j5ik2o/takt#164](https://github.com/j5ik2o/takt/pull/164) の、出来上がった時点の設計。仕様は `specs/quint/step-loop-guard/`。

## 変えたこと

- step に `max_visits`（正の整数）と `stop_on_repeated_verdict`（真偽値）を足した。parallel の sub-step では schema が拒否する。
- `StepLoopGuard`（`src/core/workflow/engine/step-visit-guard.ts`）は engine ごとに 1 つあり、step 名ごとに数える。
  - `checkEntry`：run loop が step を始める前に呼ぶ。遷移まで終わった visit が `max_visits` に達していれば、理由の 1 行を返し、run は `loop_detected` で止まる。
  - `recordCompletion`：step の遷移が決まったところで呼ぶ。終わった visit を 1 つ数え、終端でない遷移なら rule の番号を前回と比べる。
  - 同じ visit のやり直し（blocked のあとのユーザー入力、quality gate の失敗、rate-limit の fallback）は `recordCompletion` の前に `continue` するので数えない。
- 上限は `state.stepIterations` から作らない。stepIterations の鍵は workflow_call の積み方で変わり、再開すると、やり直す visit の番号に戻るため。
- config の `workflow_overrides.steps.<step>.max_visits` が YAML の値を置き換える（project が global より優先）。保存し直しても残る。
- builtin（ja/en）：`replan`・`fix-replan`・`verification-replan` に `max_visits: 4`。`development-core` の `[replan, peer-review]` monitor に `ignore_steps: [implement]` を付け、`threshold` を 3 から 1 にした（`plan` から始まる初回の `peer-review` は 0 周なので、2 回続けて再計画を求めた時点で 1 周に達し judge が動く）。peer-review には `stop_on_repeated_verdict` を付けない（独立レビューの指摘 1。理由の中身を比べる役は judge に任せる）。

### 範囲の外

- `CycleDetector` の数え方は変えていない。3 つの step の往復は `ignore_steps` で数える。
- `[replan, implement]` の monitor と、remediation 側の monitor は変えていない。
- 再開した run の数を引き継ぐこと、合計の上限（remediation を何度も呼ぶ run の verification-replan の合計）は持たない。
- step の schema は strict でなく、知らないキーは黙って通る。前からの動きで、この PR では変えていない。

## 守る不変条件

1. 1 つの engine で、同じ step を `max_visits` を超えて始めない。
2. 上限で止まるのは、`max_visits` 回の visit が遷移まで終わったときだけ。やり直しは数えない。
3. `stop_on_repeated_verdict` で止まるのは、終端でない同じ判定が 2 回続いたときだけ。違う判定が続くかぎり止めない。
4. 止めたときは、step 名を含む理由が 1 行だけ残る。止まらない run には残らない。
5. 新しいキーの無い workflow と config の動きは変わらない。

1〜4 は Quint の `safety`（`visitsBounded`・`retriesFree`・`stopOnRepeatNeedsRepeat`・`noRepeatWhileRunning`・`oneReasonPerStop`）と PBT で確かめる。5 は既存の unit・IT と、キーの無い step を回すプローブで確かめた。

## PBT の性質と除外

`src/__tests__/step-visit-guard.pbt.test.ts`。run loop が出す出来事（始める・やり直す・終端でない判定で終わる・終端で終わる）の列を、`max_visits`（無し、または 1〜6）、`stop_on_repeated_verdict`（真偽）、判定 3 種で作る。

- 始めた visit は `max_visits` を超えない。上限で止まったときは、終わった visit がちょうど `max_visits`。
- 繰り返しで止まるのは、最後の 2 つの判定が等しく、それより前に等しい並びが無いときだけ。設定が有効で止まらなかったなら、等しい並びは無い。
- 止めたときの理由は改行を含まず、step 名を含む。

除外は無い。今の phase で起こらない出来事（visit の外でのやり直しなど）は捨てて先へ進む。これは除外ではなく、run loop が出さない列を作らないための整形。

## 壊しうる入力

| 入力 | 扱い | 確かめたもの |
|---|---|---|
| `max_visits: 0`・負の数・小数・文字列・`null`・safe integer を超える数 | schema が拒否 | unit（0・-1・1.5）、独立レビューのプローブ |
| config の override に同じ値 | 拒否 | `projectConfig.test.ts` |
| `max_visits: 1` | 1 回目は通り、2 回目を始めずに止まる | unit |
| やり直しが何回続いても | 数えない | unit・PBT・Quint |
| 判定が交互に続く | 繰り返しでは止めない | unit・PBT・Quint |
| 終端の遷移 | 比べない | unit・Quint |
| workflow_call の子 engine | 呼び出しごとに 0 から | IT（root と子の両方） |
| 再開・retry・requeue・instruct | engine を作り直すので 0 から | docs に記載 |
| parallel の sub-step | YAML では拒否。config の override は付くが効かない | 独立レビューのプローブ |
| step 名に Unicode や区切り文字 | step 名を Map の鍵にそのまま使うだけ | （特別な扱い無し） |
| 並行 | 1 つの engine は step を 1 つずつ進める。engine 間で guard を共有しない | IT（共有させる変異で落ちる） |

## 影響

- 上流：なし。nrslib/takt へは何も出さない。
- 保存済みのデータ：run の `meta.json` と再開の記録は変えない。数は engine の中だけに持つ。
- 公開の設定：workflow YAML に 2 つのキー、config.yaml の `workflow_overrides.steps.<step>` に `max_visits` が増える。新しいキーより前の TAKT は黙って無視し、その版で config を保存し直すと `max_visits` が消える（docs に記載）。
- builtin の動き：replan 系の step は 5 回目を始めずに止まる。独立レビューが 2 回続けて再計画を求めると、judge が呼ばれる（これまでは呼ばれなかった）ので、judge の分の provider 呼び出しが 1 回増える。
- 守りの仕組み：秘密・権限・伏せ字には触れない。止める理由の文に、run の中身は入れない（step 名と数だけ）。

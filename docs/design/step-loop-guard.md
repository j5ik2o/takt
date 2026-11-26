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

---

## 追いの PR（#164 後追いレビュー指摘 1〜4 の修正）

[j5ik2o/takt#164](https://github.com/j5ik2o/takt/pull/164) の後追い設計レビューで見つかった 4 点を閉じるための差分設計。

### 何をどう変えるか

1. **指摘 1：`[replan, peer-review]`（`threshold: 1`）の初回 `peer-review` 誤発火を止める**
   - `loop_monitors[]` の schema（`src/core/models/workflow-schemas.ts`）・型（`src/core/models/workflow-types.ts`）・正規化（`src/infra/config/loaders/workflowLoopMonitorNormalizer.ts`）・inspect（`src/features/workflowAuthoring/inspect.ts`）に、任意の正の整数 `min_trigger_visits`（正規化後 `minTriggerVisits`）を追加する。
   - `CycleDetector`（`src/core/workflow/engine/cycle-detector.ts`）に、engine 単位の完了回数 `completedCounts: Map<string, number>` を持たせる。`recordAndCheck(stepName, nextStep)` で `stepName` の完了回数を +1 する。`reset()` はこれまでどおり `history` だけを空にし、`completedCounts` は消さない（judge が続行を選んだあとの次周回で `peer-review` 3 回目・4 回目も比較できるようにするため）。
   - `checkMonitor` で、`monitor.minTriggerVisits !== undefined` かつ `(this.completedCounts.get(lastStep) ?? 0) < monitor.minTriggerVisits`（`lastStep = cycle[cycle.length - 1]`）なら `{ triggered: false, cycleCount: 0 }` を返す。`stepName` ではなく `lastStep` を見ることで、間に `ignore_steps` が挟まる構成でも正しく判定できる。
   - `builtins/{ja,en}/workflows/development-core.yaml` の `[replan, peer-review]` monitor に `min_trigger_visits: 2` を付ける（コメントと `docs/workflows.{ja,en,zh-CN}.md`・`builtins/skill*/references/yaml-schema.md` も更新する）。
   - `min_trigger_visits` を書かない既存 monitor（既存の `threshold: 1` テストを含む）の挙動は変えない。

2. **指摘 2：`nextStep` がすでに `max_visits` 到達済みなら judge を呼ばずに上限停止へ進める**
   - `WorkflowRunLoop.ts`（`runWorkflowToCompletionCore`）の `stepVisitRecordCompletion` の直後・`cycleDetectorRecordAndCheck` の直前で、非終端が確定した遷移先 `nextStep` に対して `deps.stepVisitCheckEntry(deps.getStep(nextStep))` を確認する（読み取り専用で副作用なし）。
   - 戻り値が `undefined` でない（すでに `max_visits` 到達済み）なら、`cycleDetectorRecordAndCheck`・`step:cycle_detected`・メトリクス記録・`runLoopMonitorJudge` を呼ばずに `commitTransition` と `advanceActiveStep(deps, nextStep, deps.state.iteration)` へ進む。
   - 次反復の入口（既存の `stepVisitCheckEntry(step)`）で `loop_detected`（`Visit limit reached: ...`）として止まる。`commitTransition` と `state.currentStep`（再開位置）は loop monitor が無い場合と同じまま保たれ、余分な LLM 呼び出し・`state.iteration` 消費・`step_transition` への理由すり替わりが起きない。

3. **指摘 3：非終端の `matchedRuleIndex === undefined`（`system` step `wait.on_timeout`）で `lastRuleIndex` を消す**
   - `StepLoopGuard.recordCompletion(step, matchedRuleIndex)`（`src/core/workflow/engine/step-visit-guard.ts`）で、`completedVisits` を加算した直後に `matchedRuleIndex === undefined` なら `this.lastRuleIndex.delete(step.name)` してから `return undefined` する。
   - `rule 0 → wait.on_timeout → rule 0` の非連続一致で `stop_on_repeated_verdict` が誤停止しなくなる。`wait.on_timeout` も完了 visit なので `completedVisits`（`max_visits`）には引き続き数える。

4. **指摘 4：Quint の `visitsBounded` を締め、相互作用モデルを追加する**
   - `specs/quint/step-loop-guard/stepLoopGuard.qnt` の `visitsBounded` を `completedVisits <= startedVisits and startedVisits <= MAX_VISITS` に締め、非終端 rule なし遷移 `completeWithoutRule` を追加する。
   - `specs/quint/step-loop-guard/replanMonitor.qnt` と `replanMonitor_test.qnt` を追加し、`development-core` の遷移グラフ + `CycleDetector` + `StepLoopGuard` + `LoopMonitorJudge` の相互作用をモデル化する。

#### 変えないこと・範囲の外

- `CycleDetector` の `min_trigger_visits` 未指定時の既定挙動（`cycle: [A, B], threshold: 1` が `A → B → A` で発火する既存契約）。
- parallel sub-step への `workflow_overrides.steps.<subName>.max_visits` 付着の除去（別件）。
- `runSingleWorkflowIteration` の試験追加および終端遷移カウント差分の統一（別件）。
- 実運用ログ（takt-dash）での judge 発火率・偽陽性率の観測（別件）。
- `quality gate` 失敗・`rate-limit` fallback・`requiresUserInput` の `WorkflowEngine` 結合テスト追加（別件）。

### 追加・更新する不変条件

6. **初回 `peer-review` で誤発火しない（指摘 1）**：`development-core` の `[replan, peer-review]` monitor は、`plan` 開始・`implement → replan` 経由・`replan` 再開・やり直しを含むいずれの経路でも、その engine 内で `peer-review` が 2 回以上完了するまで judge を発火しない。
7. **上限到達済みの遷移先に対して余分な judge を呼ばない（指摘 2）**：遷移先 `nextStep` がすでに `max_visits` 回の完了に達している周回では、`runLoopMonitorJudge` を呼ばず、`loop_detected`（`Visit limit reached`）で止まる。
8. **rule なし非終端遷移は連続判定を切る（指摘 3）**：`matchedRuleIndex === undefined` の完了（`wait.on_timeout`）を挟んだ前後で同じ rule 番号が出ても `stop_on_repeated_verdict` で止めない。
9. **完了数の上界（指摘 4）**：1 つの engine 内で `completedVisits <= startedVisits <= max_visits` を常に満たす。

### PBT の性質と除外（追加分）

- `src/__tests__/step-visit-guard.pbt.test.ts` のイベント列に `{ kind: 'completeWithoutRule' }`（非終端の `matchedRuleIndex === undefined`、`wait.on_timeout` 相当）を追加する。
  - `verdicts` を `(number | undefined)[]` として記録し、連続一致の判定を `verdicts[i] !== undefined && verdicts[i] === verdicts[i - 1]` に更新する。
  - `completedVisits <= startedVisits <= max_visits` を明示的に検証する。
  - 除外は無し（従来どおり phase 外イベントのみスキップして run loop が生成可能な列に整形する）。
- `CycleDetector` の `min_trigger_visits` についても、`src/__tests__/cycle-detector.test.ts`（または PBT）で任意のステップ列と `reset()` に対して「`minTriggerVisits` が設定された monitor は、`lastStep` の完了回数が `minTriggerVisits` 未満のあいだ一度も `triggered: true` を返さない」「`minTriggerVisits` 未指定時は既存仕様どおり」を検証する。

### Quint の仕様と不変条件

`specs/quint/step-loop-guard/` に配置・検証済み（Quint `0.32.0`）。

- `stepLoopGuard.qnt` / `stepLoopGuard_test.qnt`：
  - `visitsBounded` を `completedVisits <= startedVisits and startedVisits <= MAX_VISITS` に締め、`completeWithoutRule` を追加。
  - 修正前モデル `pr164Version` で `stopOnRepeatNeedsRepeat` の反例（`verdicts = [1, -1, 1]` で `StoppedOnRepeat`）が出ることを確認。修正後 `currentCode` / `currentCodeWithoutRepeat` は各 20,000 samples で違反なし、全 witness（`witnessStoppedAtLimit`, `witnessStoppedOnRepeat`, `witnessFinished`, `witnessWithoutRuleSeen`）到達。
- `replanMonitor.qnt` / `replanMonitor_test.qnt`：
  - 不変条件 `noJudgeOnFirstPeerReview`・`noJudgeWhenNextAtVisitLimit`・`replanVisitsBounded`・`limitAbortHasExactVisits` の連言 `safety`。
  - 修正前モデル `beforeFollowup` / `beforeFollowupFromPlan` で、`noJudgeOnFirstPeerReview`（`replan` 再開経路および `Plan → WriteTests → Implement → Replan → PeerReview(1)` 経路の両方）と `noJudgeWhenNextAtVisitLimit`（`replanCompleted == MAX_VISITS` での余分な judge）の反例が出ることを確認。
  - 修正後モデル `fixedMonitor`（`MAX_VISITS = 4`）・`fixedMonitorMax1`（`MAX_VISITS = 1`）で各 20,000 samples 違反なし、全 witness（`witnessJudgeFired`, `witnessAbortedAtLimit`, `witnessJudgeAfterImplementReplan`, `witnessJudgeAfterResumeAtReplan`, `witnessCompleted`）到達、シナリオテスト全通過。

### 壊しうる入力（追加分）

| 入力 | 扱い | 検証手段 |
|---|---|---|
| `min_trigger_visits` に `0`・負数・小数・`NaN`・`Infinity`・safe integer 超・文字列・`null` | `LoopMonitorSchema` が拒否 | unit（`cycle-detector.test.ts`） |
| `min_trigger_visits: 1` | 1 回完了から従来どおり発火 | unit |
| `min_trigger_visits` 省略 | 既存 monitor と完全同一の挙動 | 既存 unit / IT |
| `ignore_steps` が `cycle` 末尾と先頭の間に挟まる構成での `min_trigger_visits` | `stepName` ではなく `cycle[cycle.length - 1]` の完了回数を見る | unit |
| `implement → replan` 経由、`replan → peer-review` 直遷移、`replan` 再開、初回 `peer-review` のやり直し | いずれも初回 `peer-review` 完了数は 1 < 2 なので発火せず、2 回目で発火 | Quint・結合テスト |
| `max_visits: 1`（`config.yaml` 上書き）での 2 回目 `peer-review → replan` | `replan` 上限到達済みのため judge 0 回で `Visit limit reached`（`loop_detected`）停止 | Quint・結合テスト |
| `max_visits: 4`（既定）で judge が続行を返し続けた 5 回目 `peer-review → replan` | judge は 2・3・4 回目の計 3 回のみ。5 回目は judge せず `Visit limit reached` 停止 | Quint・結合テスト |
| `system` step `wait.on_timeout`（`matchedRuleIndex === undefined`）を挟む `rule 0 → timeout → rule 0`、および連続 timeout | `lastRuleIndex` を消すため誤停止しない。`completedVisits` は加算 | unit・PBT・Quint |
| `workflow_call` 子 engine・再開（新 engine） | `CycleDetector` ごとに `completedCounts` は 0 から開始 | Quint・結合テスト |
| step 名に Unicode・区切り文字を含む場合 | `Map<string, number>` の鍵としてそのまま扱う | （特別な加工なし） |

### 影響（追いの PR 分・訂正を含む）

- **上流**：なし。`nrslib/takt` の `main` および開いている PR に同等の実装・修正が無いことを確認済み（`nrslib/takt` へは出さない）。
- **保存済みのデータ**：変更なし。`completedCounts` は engine メモリ内のみで、`meta.json` や再開記録の形式は変えない。
- **公開 API / YAML 設定**：`loop_monitors[]` に任意キー `min_trigger_visits`（正の整数）が 1 つ増える。未指定時の既存動作は変わらない。非 strict schema のため、このキーより前の TAKT が読んでも strip されてエラーにならない。
- **builtin の動きと費用（#164 設計書の記載訂正）**：`development-core` の `[replan, peer-review]` monitor は `threshold: 1` かつ `min_trigger_visits: 2` で動く。judge が `ABORT` すれば 1 回で止まり、続行を返し続けた場合は 2・3・4 回目の `peer-review` の後で最大 `max_visits - 1` 回（既定 `max_visits: 4` なら最大 3 回。5 回目は上限到達済みのため呼ばない）呼ばれる。旧設計書の「judge の分の provider 呼び出しが 1 回増える」は過小評価であり、最大 3 回（`max_visits - 1` 回）に訂正する。また `implement → replan` 経由や `replan` 再開時の初回 `peer-review` での誤発火（誤 `ABORT` リスクと不要な judge 呼び出し 1 回）が消える。
- **守りの仕組み**：秘密・権限・伏せ字には触れない。止める理由の文言と `loop_detected` の `abortKind` を上限到達時に正しく保つ（judge の `ABORT` による `step_transition` への上書きを防ぐ）。


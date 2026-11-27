# Step loop guard（max_visits と stop_on_repeated_verdict）

[j5ik2o/takt#164](https://github.com/j5ik2o/takt/pull/164) の、出来上がった時点の設計。仕様は `specs/quint/step-loop-guard/`。

この節から「影響」までは #164 のマージ時点の記述で、追いの PR で変わる所には **（追いの PR で変更）** と書き添え、新しい記述の場所を示した。今の設計は「追いの PR」の節が正しい。

## 変えたこと

- step に `max_visits`（正の整数）と `stop_on_repeated_verdict`（真偽値）を足した。parallel の sub-step では schema が拒否する。
- `StepLoopGuard`（`src/core/workflow/engine/step-visit-guard.ts`）は engine ごとに 1 つあり、step 名ごとに数える。
  - `checkEntry`：run loop が step を始める前に呼ぶ。遷移まで終わった visit が `max_visits` に達していれば、理由の 1 行を返し、run は `loop_detected` で止まる。
  - `recordCompletion`：step の遷移が決まったところで呼ぶ。終わった visit を 1 つ数え、終端でない遷移なら rule の番号を前回と比べる。
  - 同じ visit のやり直し（blocked のあとのユーザー入力、quality gate の失敗、rate-limit の fallback）は `recordCompletion` の前に `continue` するので数えない。
- 上限は `state.stepIterations` から作らない。stepIterations の鍵は workflow_call の積み方で変わり、再開すると、やり直す visit の番号に戻るため。
- config の `workflow_overrides.steps.<step>.max_visits` が YAML の値を置き換える（project が global より優先）。保存し直しても残る。
- builtin（ja/en）：`replan`・`fix-replan`・`verification-replan` に `max_visits: 4`。`development-core` の `[replan, peer-review]` monitor に `ignore_steps: [implement]` を付け、`threshold` を 3 から 1 にした（`plan` から始まる初回の `peer-review` は 0 周なので、2 回続けて再計画を求めた時点で 1 周に達し judge が動く）。**（追いの PR で変更）** この説明は `plan` から始まり `implement → replan` を通らない経路でしか成り立たず、初回の `peer-review` で誤発火した。追いの PR では `min_trigger_visits: 2` を足し、engine の中で `peer-review` が 2 回終わるまで judge を呼ばない（追いの PR の 1.）。peer-review には `stop_on_repeated_verdict` を付けない（独立レビューの指摘 1。理由の中身を比べる役は judge に任せる）。

### 範囲の外

- `CycleDetector` の数え方は変えていない。3 つの step の往復は `ignore_steps` で数える。**（追いの PR で変更）** 追いの PR で `CycleDetector` に `completedCounts` と `min_trigger_visits` を足し、遷移先が上限に達した周回では `CycleDetector` を呼ばない（追いの PR の 1. と 2.）。
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
- 保存済みのデータ：run の `meta.json` と再開の記録は変えない。数は engine の中だけに持つ。**（追いの PR で変更）** 実行時の束（workflow execution bundle）の `loopMonitors` に `minTriggerVisits` が 1 つ増える（追いの PR の「影響」）。
- 公開の設定：workflow YAML に 2 つのキー、config.yaml の `workflow_overrides.steps.<step>` に `max_visits` が増える。新しいキーより前の TAKT は黙って無視し、その版で config を保存し直すと `max_visits` が消える（docs に記載）。
- builtin の動き：replan 系の step は 5 回目を始めずに止まる。独立レビューが 2 回続けて再計画を求めると、judge が呼ばれる（これまでは呼ばれなかった）ので、judge の分の provider 呼び出しが 1 回増える。**（追いの PR で変更）** 実際は judge が続行を返し続けると最大 `max_visits - 1` 回（既定で 3 回）呼ばれる。また、遷移先が上限に達していれば judge を呼ばずに止まる（追いの PR の 2. と中-1）。
- 守りの仕組み：秘密・権限・伏せ字には触れない。止める理由の文に、run の中身は入れない（step 名と数だけ）。

---

## 追いの PR（#164 後追いレビュー指摘 1〜4 の修正）

[j5ik2o/takt#164](https://github.com/j5ik2o/takt/pull/164) の後追い設計レビューで見つかった 4 点を閉じるための差分設計。

### 何をどう変えるか

1. **指摘 1：`[replan, peer-review]`（`threshold: 1`）の初回 `peer-review` 誤発火を止める**
   - `loop_monitors[]` の schema（`src/core/models/workflow-schemas.ts`）・型（`src/core/models/workflow-types.ts`）・正規化（`src/infra/config/loaders/workflowLoopMonitorNormalizer.ts`）・inspect（`src/features/workflowAuthoring/inspect.ts`）に、任意の正の整数 `min_trigger_visits`（正規化後 `minTriggerVisits`）を追加する。
   - `CycleDetector`（`src/core/workflow/engine/cycle-detector.ts`）に、engine 単位の完了回数 `completedCounts: Map<string, number>` を持たせる。`recordAndCheck(stepName, nextStep)` で `stepName` の完了回数を +1 する。`reset()` はこれまでどおり `history` だけを空にし、`completedCounts` は消さない（judge が続行を選んだあとの次周回で `peer-review` 3 回目・4 回目も比較できるようにするため）。
   - `checkMonitor` で、`monitor.minTriggerVisits !== undefined` かつ `(this.completedCounts.get(lastStep) ?? 0) < monitor.minTriggerVisits`（`lastStep = cycle[cycle.length - 1]`）なら `{ triggered: false, cycleCount: 0 }` を返す。`stepName` ではなく `lastStep` を見ることで、間に `ignore_steps` が挟まる構成でも正しく判定できる。
   - `builtins/{ja,en}/workflows/development-core.yaml` の `[replan, peer-review]` monitor に `min_trigger_visits: 2` を付ける（コメントと `docs/workflows.md`・`docs/workflows.ja.md`・`docs/workflows.zh-CN.md`・`builtins/skill/references/yaml-schema.md`・`builtins/skill-codex/references/yaml-schema.md` も更新する。書く中身は「docs と CHANGELOG に書くこと」）。
   - `min_trigger_visits` を書かない既存 monitor（既存の `threshold: 1` テストを含む）の挙動は変えない。

2. **指摘 2：`nextStep` がすでに `max_visits` 到達済みなら judge を呼ばずに上限停止へ進める**
   - `WorkflowRunLoop.ts`（`runWorkflowToCompletionCore`）の `stepVisitRecordCompletion` の直後・`cycleDetectorRecordAndCheck` の直前で、非終端が確定した遷移先 `nextStep` に対して `deps.stepVisitCheckEntry(deps.getStep(nextStep))` を確認する（読み取り専用で副作用なし）。
   - 戻り値が `undefined` でない（すでに `max_visits` 到達済み）なら、`cycleDetectorRecordAndCheck`・`step:cycle_detected`・メトリクス記録・`runLoopMonitorJudge` を呼ばずに `commitTransition` と `advanceActiveStep(deps, nextStep, deps.state.iteration)` へ進む。
   - 次反復の入口（既存の `stepVisitCheckEntry(step)`）で `loop_detected`（`Visit limit reached: ...`）として止まる。`commitTransition` と `state.currentStep`（再開位置）は loop monitor が無い場合と同じまま保たれ、余分な LLM 呼び出し・`state.iteration` 消費・`step_transition` への理由すり替わりが起きない。
   - 飛ばすのは、どの monitor が発火するかに関わらず、遷移先が上限に達したときすべて。judge の rule に別の step への逃げ道があっても、judge を呼ばずに止める。これは #164 マージ時点の動きから結末を変える。この契約（「上限は judge より強い」）を選んだ理由と、docs・CHANGELOG・試験は「中-1：上限と judge の逃げ道」に書く。

3. **指摘 3：非終端の `matchedRuleIndex === undefined`（`system` step `wait.on_timeout`）で `lastRuleIndex` を消す**
   - `StepLoopGuard.recordCompletion(step, matchedRuleIndex)`（`src/core/workflow/engine/step-visit-guard.ts`）で、`completedVisits` を加算した直後に `matchedRuleIndex === undefined` なら `this.lastRuleIndex.delete(step.name)` してから `return undefined` する。
   - `rule 0 → wait.on_timeout → rule 0` の非連続一致で `stop_on_repeated_verdict` が誤停止しなくなる。`wait.on_timeout` も完了 visit なので `completedVisits`（`max_visits`）には引き続き数える。

4. **指摘 4：Quint の `visitsBounded` を締め、相互作用モデルを追加する**
   - `specs/quint/step-loop-guard/stepLoopGuard.qnt` の `visitsBounded` を `completedVisits <= startedVisits and startedVisits <= MAX_VISITS` に締め、非終端 rule なし遷移 `completeWithoutRule` を追加する。
   - `specs/quint/step-loop-guard/replanMonitor.qnt` と `replanMonitor_test.qnt` を追加し、`development-core` の遷移グラフ + `CycleDetector` + `StepLoopGuard` + `LoopMonitorJudge` の相互作用をモデル化する。

#### 変えないこと・範囲の外

- `CycleDetector` の `min_trigger_visits` 未指定時の既定挙動（`cycle: [A, B], threshold: 1` が `A → B → A` で発火する既存契約）。
- 遷移先に `max_visits` が無い、または上限に達していない遷移での judge の動き（逃げ道の rule もこれまでどおり効く）。
- parallel sub-step への `workflow_overrides.steps.<subName>.max_visits` 付着の除去（別件）。
- `runSingleWorkflowIteration` の試験追加および終端遷移カウント差分の統一（別件）。
- 実運用ログ（takt-dash）での judge 発火率・偽陽性率の観測（別件）。
- `quality gate` 失敗・`rate-limit` fallback・`requiresUserInput` の `WorkflowEngine` 結合テスト追加（別件）。

### 追加・更新する不変条件

6. **初回 `peer-review` で誤発火しない（指摘 1）**：`development-core` の `[replan, peer-review]` monitor は、`plan` 開始・`implement → replan` 経由・`replan` 再開・やり直しを含むいずれの経路でも、その engine 内で `peer-review` が 2 回以上完了するまで judge を発火しない。
7. **上限到達済みの遷移先に対して余分な judge を呼ばない（指摘 2）**：遷移先 `nextStep` がすでに `max_visits` 回の完了に達している周回では、`runLoopMonitorJudge` を呼ばず、`loop_detected`（`Visit limit reached`）で止まる。
8. **rule なし非終端遷移は連続判定を切る（指摘 3）**：`matchedRuleIndex === undefined` の完了（`wait.on_timeout`）を挟んだ前後で同じ rule 番号が出ても `stop_on_repeated_verdict` で止めない。
9. **完了数の上界（指摘 4）**：1 つの engine 内で `completedVisits <= startedVisits <= max_visits` を常に満たす。
10. **上限は judge より強い（中-1）**：遷移先が `max_visits` に達している非終端の遷移は、どの monitor の judge にも渡らず、必ず `loop_detected`（`Visit limit reached`）で終わる。judge の `ABORT`（`step_transition`）にも、逃げ道の rule にも変わらない。
11. **発火しなさすぎない（低-2）**：`development-core` の `[replan, peer-review]` monitor は、`replan` が上限に達していない `peer-review → replan` で、`implement` を除いた履歴の末尾が `[replan, peer-review]`、かつその engine で `peer-review` が 2 回以上終わっていれば、必ず judge を呼ぶ。

### PBT の性質と除外（追加分）

- `src/__tests__/step-visit-guard.pbt.test.ts` のイベント列に `{ kind: 'completeWithoutRule' }`（非終端の `matchedRuleIndex === undefined`、`wait.on_timeout` 相当）を追加する。
  - `verdicts` を `(number | undefined)[]` として記録し、連続一致の判定を `verdicts[i] !== undefined && verdicts[i] === verdicts[i - 1]` に更新する。
  - `completedVisits <= startedVisits <= max_visits` を明示的に検証する。
  - 除外は無し（従来どおり phase 外イベントのみスキップして run loop が生成可能な列に整形する）。
- `CycleDetector` の `min_trigger_visits` についても、`src/__tests__/cycle-detector.test.ts`（または PBT）で任意のステップ列と `reset()` に対して「`minTriggerVisits` が設定された monitor は、`lastStep` の完了回数が `minTriggerVisits` 未満のあいだ一度も `triggered: true` を返さない」「`minTriggerVisits` 未指定時は既存仕様どおり」を検証する。
- 同じ試験で逆向きも確かめる（低-2）：「`lastStep` の完了回数が `minTriggerVisits` 以上で、`minTriggerVisits` を外した monitor が発火する列では、付けた monitor も発火する」。
- `completedCounts` を増やすのは `recordAndCheck` だけで、`reset()` では減らないことを unit で固定する（低-5）。

### Quint の仕様と不変条件

`specs/quint/step-loop-guard/` に配置・検証済み（Quint `0.32.0`）。

- `stepLoopGuard.qnt` / `stepLoopGuard_test.qnt`：
  - `visitsBounded` を `completedVisits <= startedVisits and startedVisits <= MAX_VISITS` に締め、`completeWithoutRule` を追加。
  - 修正前モデル `pr164Version` で `stopOnRepeatNeedsRepeat` の反例（`verdicts = [1, -1, 1]` で `StoppedOnRepeat`）が出ることを確認。修正後 `currentCode` / `currentCodeWithoutRepeat` は各 20,000 samples で違反なし、全 witness（`witnessStoppedAtLimit`, `witnessStoppedOnRepeat`, `witnessFinished`, `witnessWithoutRuleSeen`）到達。
- `replanMonitor.qnt` / `replanMonitor_test.qnt`：
  - `development-core` の 3 つの monitor を YAML の順にすべて持つ（`[plan, write_tests]`・`[replan, implement]` は `threshold: 3`、`[replan, peer-review]` は `ignore_steps: [implement]`・`threshold: 1`・`min_trigger_visits: 2`）。最初に発火した monitor の judge だけが動き、どの judge の後も `reset()` で履歴を共有して消す。
  - 始める・再開する step は 5 つのどれでもよい（`ALLOW_RESUME`）。
  - judge の選び方は「続行（cycle の先頭へ）」「`ABORT`」「逃げ道」の 3 つ。逃げ道は builtin には無いので、`JUDGE_HAS_ESCAPE = true` の module（独自の workflow を表す）でだけ選べる。
  - 不変条件は `noJudgeOnFirstPeerReview`・`noJudgeWhenNextAtVisitLimit`・`limitBeatsJudge`（中-1）・`judgeFiresWhenDue`（低-2）・`replanVisitsBounded`・`limitAbortHasExactVisits` の連言 `safety`。`judgeFiresWhenDue` の「呼ぶべき」は `MIN_TRIGGER_VISITS` を使わず、builtin の値 2 で書く。こうすると、数を変えた変異を捉えられる。
  - 結果は `specs/quint/step-loop-guard/README.md` の Record に残す。要点は次のとおり。
    - 直した版（`fixedMonitor` は MAX 4、`fixedMonitorMax1`・`fixedMonitorMax3`、逃げ道ありの `fixedMonitorWithEscape` は MAX 2）は、どれも 2 万標本で `safety` に違反なし。witness はすべて届いた。
    - 直す前の版は反例が出る。`beforeFollowup`・`beforeFollowupFromPlan` は `noJudgeOnFirstPeerReview` と `noJudgeWhenNextAtVisitLimit`、`beforeFollowupMax3` は `[replan, implement]` の judge で `noJudgeWhenNextAtVisitLimit`。
    - 案 (a) の動き（`judgeBeforeLimitWithEscape`）は `limitBeatsJudge` で反例が出る。結末が変わることを、モデルの上でも示した。
    - 変異 `mutantMinTrigger1` は `noJudgeOnFirstPeerReview` で、`mutantMinTrigger3` は `judgeFiresWhenDue` で反例が出る。
  - シナリオテストは 17 件（`replanMonitor_test.qnt`）。逃げ道が上限の手前では効き、上限では効かないことを `escapeBelowLimitCompletesTest`・`limitBeatsEscapeTest` で、#164 の動きを `escapeAtLimitCompletesTest` で固定した。

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
| 5 つのどの step からの再開（`peer-review` からを含む） | 再開した visit も 1 回と数える。`peer-review` から再開すると、2 回目の `peer-review` で初めて発火 | Quint |
| `max_visits: 3` 以下で `[replan, implement]` が 3 周に達した `implement → replan` | `replan` が上限なら judge を呼ばず `Visit limit reached` で止まる | Quint |
| 遷移先が上限に達していて、judge の rule に逃げ道（例：`escalate` → COMPLETE）がある独自の workflow | judge を呼ばず `Visit limit reached`（`loop_detected`）で止まる。上限の手前では逃げ道が効く | Quint・結合テスト（中-1） |
| step 名に Unicode・区切り文字を含む場合 | `Map<string, number>` の鍵としてそのまま扱う | （特別な加工なし） |

### 影響（追いの PR 分・訂正を含む）

- **上流**：なし。`nrslib/takt` の `main` および開いている PR に同等の実装・修正が無いことを確認済み（`nrslib/takt` へは出さない）。
- **保存済みのデータ**：`meta.json` と再開の記録の形式は変えない。`completedCounts` は engine のメモリの中だけに持つ。実行時の束（workflow execution bundle）の `loopMonitors` には `minTriggerVisits` が 1 つ増える。束は `structuredClone` で写し、再開のときは今の config から作り直すので、古い束が残っていても害は無い。
- **公開 API / YAML 設定**：`loop_monitors[]` に任意キー `min_trigger_visits`（正の整数）が 1 つ増える。未指定時の既存動作は変わらない。非 strict schema のため、このキーより前の TAKT が読んでも strip されてエラーにならない。
- **workflow の結末（中-1）**：遷移先が `max_visits` に達した遷移では、judge の逃げ道があっても run は `Visit limit reached` で止まる。#164 のマージ時点では judge が先に動き、逃げ道へ進めた。`max_visits` はまだ release に入っていない（`CHANGELOG.md` の Unreleased にも載っていない。0.76.1 は 2026-11-17、#164 のマージは 2026-11-26（JST））ので、release 済みの版を使う利用者の結末は変わらない。
- **builtin の動きと費用（#164 設計書の記載訂正）**：`development-core` の `[replan, peer-review]` monitor は `threshold: 1` かつ `min_trigger_visits: 2` で動く。judge が `ABORT` すれば 1 回で止まり、続行を返し続けた場合は 2・3・4 回目の `peer-review` の後で最大 `max_visits - 1` 回（既定 `max_visits: 4` なら最大 3 回。5 回目は上限到達済みのため呼ばない）呼ばれる。旧設計書の「judge の分の provider 呼び出しが 1 回増える」は過小評価であり、最大 3 回（`max_visits - 1` 回）に訂正する。また `implement → replan` 経由や `replan` 再開時の初回 `peer-review` での誤発火（誤 `ABORT` リスクと不要な judge 呼び出し 1 回）が消える。
- **守りの仕組み**：秘密・権限・伏せ字には触れない。止める理由の文言と `loop_detected` の `abortKind` を上限到達時に正しく保つ（judge の `ABORT` による `step_transition` への上書きを防ぐ）。


---

## 設計の再レビュー（2 回目）の扱い

再レビューの結論は「条件つきでよい」（高 0・中 1・低 6）。それぞれの扱いを下にまとめる。

| # | 指摘 | 扱い | どこに反映したか |
|---|---|---|---|
| 中-1 | 指摘 2 の直し方は、judge が別の step へ逃がす workflow の結末を変えるのに、設計にも docs にも書いていない | 直す：案 (b) を選ぶ | 下の「中-1：上限と judge の逃げ道」。不変条件 10、Quint の `limitBeatsJudge`、結合テストの計画 |
| 低-1 | Quint が 3 つの monitor のうち 1 つしか持たず、再開も `plan`・`replan` からだけ | 直す | `replanMonitor.qnt` に 3 つの monitor と、5 つのどの step からの再開も入れた。`[replan, implement]` が上限で judge を呼ぶ反例（`beforeFollowupMax3`）と、直した版で消えること（`fixedMonitorMax3`）も残した |
| 低-2 | Quint の不変条件が「発火しすぎ」しか見ず、「発火しなさすぎ」を見ない | 直す | 不変条件 11、Quint の `judgeFiresWhenDue`。変異 `mutantMinTrigger3` で反例が出る。unit にも逆向きの性質を足す（「PBT の性質と除外（追加分）」） |
| 低-3 | `min_trigger_visits` の docs と CHANGELOG | 直す | 下の「docs と CHANGELOG に書くこと」。英語版のファイル名も `docs/workflows.md` に正した |
| 低-4 | 設計書の中で、マージ時点の記述と追いの PR の記述が食い違う | 直す | 冒頭の節の 4 か所（初回 `peer-review` の説明、`CycleDetector` を変えない、保存済みのデータ、judge の費用）に **（追いの PR で変更）** と書き添えた。追いの PR の「影響」の保存済みのデータも、実行時の束に `minTriggerVisits` が増えると書き直した |
| 低-5 | `min_trigger_visits` のための数が、`StepLoopGuard` の数と重なる | 採らない（unit で固定する） | 下の「低-5 を採らない理由」 |
| 低-6 | `_apalache-out` が `.gitignore` に入っていない | 採らない（対応済み） | `.gitignore:57-58` に `_apalache-out/` がある（コミット `7ae40db81`）。レビューの `git check-ignore` が何にも当たらなかったのは、ディレクトリが無い状態で、ディレクトリ専用の型（末尾 `/`）と照らしたため。`specs/quint/step-loop-guard/_apalache-out/x` を作ると `.gitignore:58:_apalache-out/` に当たることを確かめた |

### 中-1：上限と judge の逃げ道

#### 2 つの案

- (a) judge は呼び、judge が選んだ先が上限の step なら止める。
- (b) 遷移先が上限なら judge を飛ばしたまま止める。結末が変わることを、設計・docs・CHANGELOG に書く。

#### 選ぶのは (b)

1. **builtin の結末は変わらず、指摘 2 が閉じたまま残る。** `development-core` の judge の行き先は、cycle の先頭（`replan`）か `ABORT` だけ。上限の `replan` へ向かう遷移で judge を呼んでも、結末は「上限で止まる」か「judge の `ABORT`」のどちらか。(a) では、この judge の呼び出しが戻る。費用は既定の `max_visits: 4` で 1 回。judge が `ABORT` を選べば、止まる理由も `loop_detected` から `step_transition` に変わる。指摘 2 で閉じた 2 つの問題が、そのまま戻ってくる。
2. **結末が変わるのは、まだ release していない組み合わせだけ。** 結末が変わるのは、遷移先に `max_visits` があり、judge の rule に逃げ道がある workflow に限る。`max_visits` は #164 で入り、まだどの release にも入っていない（「影響」）。release 済みの版の利用者の結末は変わらない。
3. **契約が 1 行で言え、確かめやすい。** (b) の契約は「遷移先が上限に達していれば、loop monitor より先に止まる」。上限は決まった数なので、試験で結末を固定できる。(a) では、上限で止まるかどうかが LLM の選び方で決まる。上限を付けた step の後でも、run の結末が決まらない。
4. **逃げ道が要る workflow にも書き方が残る。** 逃げ道は上限の手前では今までどおり効く（不変条件の「変えないこと」）。上限でも逃げたい workflow は、`max_visits` を付けずに judge に任せるか、上限を judge の発火より大きくする。

(a) の利点は、judge の逃げ道を最後まで生かせること。ただしその分、builtin のすべての run で、結末を変えられない judge を呼ぶことになる。逃げ道を使う workflow は今は無い（builtin に無く、`max_visits` も未 release）。この利点は、それに見合わない。

#### docs と CHANGELOG に書くこと

`docs/workflows.md` の `max_visits` の節（`### Step \`max_visits\` and \`stop_on_repeated_verdict\`` の箇条書き）に、次の 1 項を足す。`docs/workflows.ja.md`・`docs/workflows.zh-CN.md` の同じ節にも、同じ中身を足す。

> - A visit limit wins over `loop_monitors`. When the next step has already reached its `max_visits`, the run aborts with `Visit limit reached` before any loop monitor is checked, so no judge runs and a judge rule that would route elsewhere (for example to an `escalate` step) is not used. Below the limit, judges behave as before.

`loop_monitors` の節（`docs/workflows.md` の `### loop_monitors`）に `min_trigger_visits` を足す。

> `min_trigger_visits` (optional positive integer) delays a monitor until the last step of its `cycle` has completed that many visits in this workflow engine run. A completed visit is one that ended in a non-terminal transition; retries of the same visit do not count. The count is not cleared when a judge runs, starts from zero in each subworkflow call, and starts from zero when a run is resumed. TAKT versions that predate this key ignore it.

`docs/workflows.md:1137` の builtin の説明（「the first review comes from `plan` …」）は、次のように書き直す（ja・zh-CN も同じ）。

> In `development-core`, the `[replan, peer-review]` loop monitor ignores `implement` and has `threshold: 1` and `min_trigger_visits: 2`: the judge runs only after `peer-review` has completed twice in this run, whichever step the run started or resumed from, and whether or not `implement` went straight to `replan`. When the independent review asks for a replan again, the judge compares the last two review results and stops only when the same findings repeat without a new diff.

`builtins/skill/references/yaml-schema.md` と `builtins/skill-codex/references/yaml-schema.md` の `loop_monitors` の表に、`min_trigger_visits` の行を足す（中身は上の英文の 1 文目）。

`CHANGELOG.md` と `docs/CHANGELOG.ja.md` の `[Unreleased]` に載せる。#164 の分（`max_visits`・`stop_on_repeated_verdict`）もまだ載っていないので、一緒に載せる。

> ### Added
> - Step-level `max_visits` and `stop_on_repeated_verdict` stop laps that make no progress (#164). The builtin development workflows set `max_visits: 4` on `replan`, `fix-replan`, and `verification-replan`.
> - `loop_monitors[].min_trigger_visits` delays a monitor until the last step of its cycle has completed that many visits in the run. `development-core` sets it to 2 on the `[replan, peer-review]` monitor, so the judge no longer fires on the first independent review.
>
> ### Changed
> - A visit limit wins over loop monitors: when the next step has already reached its `max_visits`, the run aborts with `Visit limit reached` without running a loop-monitor judge, even when a judge rule would route elsewhere.
>
> ### Fixed
> - `stop_on_repeated_verdict` no longer stops when a `system` step's `wait.on_timeout` sits between two equal verdicts.

#### 試験（結末を確かめる）

`WorkflowEngine` を mock の agent で回す試験を、既存の `src/__tests__/engine-loop-monitors.test.ts` に足す。このファイルは `scripts/test-classification.mjs` で分類済みなので、層の分類は変えない。workflow は `engine-test-helpers.js` の `makeStep`・`makeRule` で組む。

- 形：step `a`（`max_visits` を持つ）→ `b` → `a`。monitor は `cycle: [a, b]`、`threshold: 1`。judge の rule は、`a` へ続ける・`escalate` へ逃げる・`ABORT` の 3 つ。`escalate` は COMPLETE で終わる。judge の mock は、いつも逃げ道を選ぶ。
- 試験 1（上限では逃げ道を使わない）：`a` に `max_visits: 1`。`a → b → a` で `a` は上限に達している。judge は 0 回呼ばれ、run は `loop_detected` で中断し、理由は `Visit limit reached: step "a"` で始まる。`escalate` は始まらない。
- 試験 2（上限の手前では逃げ道が効く）：`a` に `max_visits: 2`。同じ遷移で judge が 1 回呼ばれ、`escalate` を経て COMPLETE で終わる。
- 先に、直す前のコードで試験 1 が落ちるのを見る。今のコードでは judge が呼ばれ、`escalate` で COMPLETE する。その失敗の出力を PR に残す。試験 2 は直す前も直した後も通る。
- `engine-loop-monitors.test.ts` は `tsconfig.tests.json` に入っている（型検査の対象）。
- 既存の `development-core-replan-guard.integration.test.ts:209` の `expect(judges).toHaveLength(4)` は、指摘 2 の直しで 3 になる。この変更も同じ PR で行い、理由を PR 本文に書く。

### 低-5 を採らない理由

`StepLoopGuard.completedVisits` の数を `recordAndCheck` に渡して 1 つにまとめる案は、採らない。

- ずれるのは、指摘 2 で飛ばす遷移と、`stop_on_repeated_verdict` で止まる遷移の 2 つだけ。どちらでも run はその場で止まり、ずれた数を後で読むことは無い。
- まとめると、`CycleDetector` の公開の呼び出しが `StepLoopGuard` の数に頼るようになる。`CycleDetector` は今、自分の履歴だけで閉じている。2 つの guard の順序（`recordCompletion` が先）も、呼び出しの契約に入ってしまう。
- 代わりに、`completedCounts` を増やすのは `recordAndCheck` だけで、`reset()` では減らないことを unit で固定する（「PBT の性質と除外（追加分）」）。

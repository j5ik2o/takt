# Step loop guard (j5ik2o/takt#164 and follow-up)

Quint models for:
1. Single-step `StepLoopGuard` (`max_visits` and `stop_on_repeated_verdict`), including non-terminal rule-less transitions (`system` step `wait.on_timeout`).
2. Multi-step interaction between `development-core`, `CycleDetector` (`ignore_steps`, `threshold: 1`, `min_trigger_visits`), `StepLoopGuard`, and `LoopMonitorJudgeRunner`.

| File | Content |
|---|---|
| `stepLoopGuard.qnt` | Single-step `StepLoopGuard`. `CODE = "fixed"` is the follow-up fix, `CODE = "pr164"` is merged #164 (stale `lastVerdict` across `wait.on_timeout`), `CODE = "first"` is the first version of #164 (counted retries). |
| `stepLoopGuard_test.qnt` | Scenario tests for `stepLoopGuard.qnt`. |
| `replanMonitor.qnt` | `development-core` graph + `CycleDetector` + `StepLoopGuard` + `LoopMonitorJudge`. `fixedMonitor` / `fixedMonitorMax1` are the follow-up fix; `beforeFollowup` / `beforeFollowupFromPlan` are merged #164. |
| `replanMonitor_test.qnt` | Scenario tests for `replanMonitor.qnt`. |

## What is modelled

- `StepLoopGuard` (`src/core/workflow/engine/step-visit-guard.ts`): `checkEntry` before a step starts, and `recordCompletion` once a non-terminal transition is chosen; `matchedRuleIndex === undefined` (e.g., `system` step `wait.on_timeout`) counts as a completed visit and clears `lastRuleIndex`.
- `CycleDetector` (`src/core/workflow/engine/cycle-detector.ts`): `history`, `ignore_steps: [implement]`, `threshold: 1`, `min_trigger_visits: 2` (checked against engine-wide `completedCounts`), and `reset()` (clears `history`, preserves `completedCounts`).
- `WorkflowRunLoop.ts` (`runWorkflowToCompletionCore`): retries (`blocked`, quality gate failure, rate-limit fallback, `requiresUserInput`) `continue` before `recordCompletion` and `CycleDetector`; natural terminals (`COMPLETE`, `ABORT`) end the run before both; when `nextStep` has already reached `max_visits`, `CycleDetector` and `LoopMonitorJudgeRunner` are skipped so the next iteration aborts with `Visit limit reached` (`loop_detected`).
- `development-core.yaml`: all 5 steps (`plan`, `write_tests`, `implement`, `peer-review`, `replan`), all non-terminal and terminal edges, normal start (`plan`), and resume at `replan` (`initialStep: replan`).

Not modelled: the LLM decision logic inside the judge (modelled as nondeterministic choice between continuing to `replan` or `ABORT`), the other two `development-core` monitors (`[plan, write_tests]` and `[replan, implement]`), `runSingleWorkflowIteration`, parallel sub-steps, `workflow_call` child engine internals, `max_steps` / `LoopDetector` interaction, and config load-time override precedence.

## Invariants

### `stepLoopGuard.qnt`

| Name | Meaning |
|---|---|
| `visitsBounded` | `completedVisits <= startedVisits and startedVisits <= MAX_VISITS` (tightened from `MAX_VISITS + 1`). |
| `retriesFree` | A stop at the limit means `MAX_VISITS` visits completed; retries never use the limit. |
| `stopOnRepeatNeedsRepeat` | A stop on repetition needs the setting on and two consecutive equal rule verdicts (`NO_VERDICT` breaks the streak). |
| `noRepeatWhileRunning` | With the setting on, a running engine never has two consecutive equal rule verdicts. |
| `oneReasonPerStop` | A stop writes exactly one reason line; a running or finished run writes none. |

### `replanMonitor.qnt`

| Name | Meaning |
|---|---|
| `noJudgeOnFirstPeerReview` | The `[replan, peer-review]` judge never fires until `peer-review` has completed at least 2 visits in this engine run (no false fire via `implement -> replan` or `replan` resume). |
| `noJudgeWhenNextAtVisitLimit` | The judge never runs when the proposed `nextStep` (`replan`) has already completed `MAX_VISITS` visits. |
| `replanVisitsBounded` | `replanCompleted <= replanStarted and replanStarted <= MAX_VISITS`. |
| `limitAbortHasExactVisits` | Stopping with `AbortedAtVisitLimit` implies `replanCompleted == MAX_VISITS`. |

## Record

Quint 0.32.0. Commands run from this directory.

### Scenario tests

```
$ quint test --main=fixedCodeTest stepLoopGuard_test.qnt
  5 passing
$ quint test --main=withoutRuleStreakBreakTest stepLoopGuard_test.qnt
  1 passing
$ quint test --main=alternatingTest stepLoopGuard_test.qnt
  1 passing
$ quint test --main=pr164VersionTest stepLoopGuard_test.qnt
  1 passing
$ quint test --main=firstVersionTest stepLoopGuard_test.qnt
  1 passing
$ quint test --main=fixedMonitorTest replanMonitor_test.qnt
  5 passing
$ quint test --main=fixedMonitorMax1Test replanMonitor_test.qnt
  1 passing
$ quint test --main=beforeFollowupTest replanMonitor_test.qnt
  3 passing
```

### Random simulation (fixed models)

```
$ quint run --main=currentCode --invariant=safety --witnesses witnessStoppedAtLimit witnessStoppedOnRepeat witnessFinished witnessWithoutRuleSeen --max-samples=20000 --max-steps=20 --seed=0x1 stepLoopGuard.qnt
[ok] No violation found (2260ms at 8850 traces/second).
  witnessStoppedAtLimit: 4613 / 20000 (23.06%)
  witnessStoppedOnRepeat: 1646 / 20000 (8.23%)
  witnessFinished: 13741 / 20000 (68.70%)
  witnessWithoutRuleSeen: 9168 / 20000 (45.84%)

$ quint run --main=currentCodeWithoutRepeat --invariant=safety --max-samples=20000 --max-steps=20 --seed=0x1 stepLoopGuard.qnt
[ok] No violation found (2165ms at 9238 traces/second).

$ quint run --main=fixedMonitor --invariant=safety --witnesses witnessJudgeFired witnessAbortedAtLimit witnessJudgeAfterImplementReplan witnessJudgeAfterResumeAtReplan witnessCompleted --max-samples=20000 --max-steps=45 --seed=0x1 replanMonitor.qnt
[ok] No violation found (10530ms at 1899 traces/second).
  witnessJudgeFired: 296 / 20000 (1.48%)
  witnessAbortedAtLimit: 193 / 20000 (0.97%)
  witnessJudgeAfterImplementReplan: 136 / 20000 (0.68%)
  witnessJudgeAfterResumeAtReplan: 235 / 20000 (1.18%)
  witnessCompleted: 5473 / 20000 (27.37%)

$ quint run --main=fixedMonitorMax1 --invariant=safety --witnesses witnessAbortedAtLimit witnessCompleted --max-samples=20000 --max-steps=30 --seed=0x1 replanMonitor.qnt
[ok] No violation found (5423ms at 3688 traces/second).
  witnessAbortedAtLimit: 4349 / 20000 (21.75%)
  witnessCompleted: 4895 / 20000 (24.47%)
```

### Counterexamples on pre-fix models

```
$ quint run --main=firstVersion --invariant=retriesFree --max-samples=5000 --max-steps=20 --seed=0x1 stepLoopGuard.qnt
[violation] Found an issue (12ms).

$ quint run --main=pr164Version --invariant=stopOnRepeatNeedsRepeat --max-samples=5000 --max-steps=20 --seed=0x1 stepLoopGuard.qnt
[violation] Found an issue (13ms).  # rule -> wait.on_timeout (-1) -> same rule falsely stops

$ quint run --main=beforeFollowup --invariant=noJudgeOnFirstPeerReview --max-samples=5000 --max-steps=30 --seed=0x1 replanMonitor.qnt
[violation] Found an issue (15ms).  # resume at replan or implement -> replan fires judge on 1st peer-review

$ quint run --main=beforeFollowupFromPlan --invariant=noJudgeOnFirstPeerReview --max-samples=5000 --max-steps=30 --seed=0x1 replanMonitor.qnt
[violation] Found an issue (16ms).  # Plan -> WriteTests -> Implement -> Replan -> PeerReview(1) -> Replan fires judge

$ quint run --main=beforeFollowupFromPlan --invariant=noJudgeWhenNextAtVisitLimit --max-samples=10000 --max-steps=45 --seed=0x1 replanMonitor.qnt
[violation] Found an issue (154ms). # replan already at MAX_VISITS yet judge fires before entry check
```

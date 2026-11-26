# Step loop guard (j5ik2o/takt#164, #174, and #176)

Quint models for:
1. Single-step `StepLoopGuard` (`max_visits` and `stop_on_repeated_verdict`), including non-terminal rule-less transitions (`system` step `wait.on_timeout`).
2. Multi-step interaction between `development-core` (all three loop monitors), `CycleDetector` (`ignore_steps`, `threshold`, `min_trigger_visits`), `StepLoopGuard`, and `LoopMonitorJudgeRunner`.
3. Iteration-start check ordering (`workflowInterruptRequested`, `stepVisitCheckEntry`, `max_steps`, `validateUserInputRuntime`, `loopDetectorCheck`), `exceeded` persistence, interactive `onIterationLimit` extension (`continue`), and consistency between `runWorkflowToCompletionCore` and `runSingleWorkflowIterationCore` ([j5ik2o/takt#176](https://github.com/j5ik2o/takt/issues/176)).

| File | Content |
|---|---|
| `stepLoopGuard.qnt` | Single-step `StepLoopGuard`. `CODE = "fixed"` is the follow-up fix, `CODE = "pr164"` is merged #164 (stale `lastVerdict` across `wait.on_timeout`), `CODE = "first"` is the first version of #164 (counted retries). |
| `stepLoopGuard_test.qnt` | Scenario tests for `stepLoopGuard.qnt`. |
| `replanMonitor.qnt` | `development-core` graph + `CycleDetector` + `StepLoopGuard` + `LoopMonitorJudge`. `fixedMonitor` / `fixedMonitorMax1` / `fixedMonitorMax3` / `fixedMonitorWithEscape` are the follow-up fix; `beforeFollowup` / `beforeFollowupFromPlan` / `beforeFollowupMax3` are merged #164; `judgeBeforeLimitWithEscape` is option (a) of design 中-1 (judge runs at the limit and may escape); `mutantMinTrigger1` / `mutantMinTrigger3` are mutants that `safety` must reject. |
| `replanMonitor_test.qnt` | Scenario tests for `replanMonitor.qnt`. |
| `iterationEntryOrder.qnt` | Iteration-start guard priority and `exceeded` persistence across `runWorkflowToCompletionCore` (`MODE = "full"`) and `runSingleWorkflowIterationCore` (`MODE = "single"`). `fixedFullExceeded` / `fixedFullInteractive` / `fixedFullIgnoreLimit` / `fixedSingleIteration` are the #176 fix; `beforeFullExceeded` / `beforeSingleIteration` are merged #174 (`657f16ad6`); `abortAtTransitionAlternative` is Devin's line-1214 alternative (Approach B); `mutantLoopBeforeMaxSteps` moves stateful `LoopDetector` ahead of `max_steps`. |
| `iterationEntryOrder_test.qnt` | Scenario tests for `iterationEntryOrder.qnt`. |

## What is modelled

- `StepLoopGuard` (`src/core/workflow/engine/step-visit-guard.ts`): `checkEntry` before a step starts, and `recordCompletion` once a non-terminal transition is chosen; `matchedRuleIndex === undefined` (e.g., `system` step `wait.on_timeout`) counts as a completed visit and clears `lastRuleIndex`.
- `CycleDetector` (`src/core/workflow/engine/cycle-detector.ts`): `history`, the three `development-core` monitors in YAML order (`[plan, write_tests]` and `[replan, implement]` with `threshold: 3`; `[replan, peer-review]` with `ignore_steps: [implement]`, `threshold: 1`, `min_trigger_visits: 2` checked against engine-wide `completedCounts`), first triggered monitor wins, and `reset()` after any judge (clears the shared `history`, preserves `completedCounts`).
- `WorkflowRunLoop.ts` (`runWorkflowToCompletionCore`): retries (`blocked`, quality gate failure, rate-limit fallback, `requiresUserInput`) `continue` before `recordCompletion` and `CycleDetector`; natural terminals (`COMPLETE`, `ABORT`) end the run before both; when `nextStep` has already reached `max_visits`, `CycleDetector` and `LoopMonitorJudgeRunner` are skipped for every monitor so the next iteration aborts with `Visit limit reached` (`loop_detected`).
- `WorkflowRunLoop.ts` (`runWorkflowToCompletionCore` and `runSingleWorkflowIterationCore`): iteration-start precedence (`workflowInterruptRequested`, `stepVisitCheckEntry`, `max_steps` / `onIterationLimit`, `validateUserInputRuntime`, `loopDetectorCheck`), `workflow_call` steps not consuming iteration budget, interactive extension `continue`, and non-interactive `exceeded` persistence (`workflowExecution.ts` / `iterationLimitHandler.ts` / `taskExecution.ts`).
- `LoopDetector` (`src/core/workflow/engine/loop-detector.ts`): stateful `consecutiveCount` tracking and `warn` vs `abort` action.
- `LoopMonitorJudgeRunner.ts`: `state.iteration++` during a judge run, and the judge picking continue (the cycle head), `ABORT`, an escape route (`JUDGE_HAS_ESCAPE = true`), or routing to another step already at `max_visits` (`JudgeRouteToC` in `iterationEntryOrder.qnt`).
- `development-core.yaml`: all 5 steps (`plan`, `write_tests`, `implement`, `peer-review`, `replan`), all non-terminal and terminal edges, and a start or resume at any of the 5 steps (`ALLOW_RESUME`).

Not modelled: the LLM decision logic inside the judge (modelled as a nondeterministic choice), parallel sub-steps, parallel `workflow_call` branch races, `workflow_call` child engine internals beyond `consumesBudget = false`, and config load-time override precedence.

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
| `noJudgeWhenNextAtVisitLimit` | No judge (of any monitor) runs when the proposed `nextStep` (`replan`) has already completed `MAX_VISITS` visits. |
| `limitBeatsJudge` | A transition into `replan` at its limit always ends with `AbortedAtVisitLimit`; no judge turns it into an ABORT by the judge or an escape (design 中-1, option b). |
| `judgeFiresWhenDue` | Every `peer-review -> replan` below the limit whose filtered history ends with `[replan, peer-review]`, from the 2nd `peer-review` completion on, asks the `[replan, peer-review]` judge (no under-firing; the threshold 2 is written as a literal, not `MIN_TRIGGER_VISITS`). |
| `replanVisitsBounded` | `replanCompleted <= replanStarted and replanStarted <= MAX_VISITS`. |
| `limitAbortHasExactVisits` | Stopping with `AbortedAtVisitLimit` implies `replanCompleted == MAX_VISITS`. |

### `iterationEntryOrder.qnt`

| Name | Meaning |
|---|---|
| `interruptWins` | If `interruptPending` is true when a run stops at entry, the status is `AbortedInterrupt` and `exceededSaved` is `false`. |
| `visitLimitBeatsMaxSteps` | `max_steps` never fires (neither aborts nor calls `onIterationLimit` to prompt/extend) when `currentStep` has already reached `max_visits`. |
| `exceededOnlyOnIterationLimit` | `exceededSaved` holds only when `status == AbortedIterationLimit` and `currentStep` is not at `max_visits`. |
| `visitLimitOutcomePreserved` | A natural non-terminal transition into a step at `max_visits` (which skipped loop monitors) ends only in `AbortedVisitLimit` (or `AbortedInterrupt`), never `AbortedIterationLimit` or `AbortedLoopDetector`. |
| `visitLimitSkipsLoopDetector` | When `currentStep` is already at `max_visits`, `LoopDetector.check` does not run (neither mutates/warns nor aborts), consistently across `full` and `single` modes. |
| `noLoopDetectorDoubleCount` | `loopDetectorChecks == stepEntriesPassedToLoopDetector`: interactive `onIterationLimit` extension (`continue`) never double-counts `LoopDetector`. |
| `visitsBounded` | For every step, `completedVisits <= startedVisits` and (when `max_visits > 0`) `startedVisits <= max_visits`. |
| `visitLimitAbortHasExactVisits` | Stopping with `AbortedVisitLimit` implies `completedVisits[currentStep] == max_visits` (retries do not consume visits). |
| `budgetRespected` | In `full` mode without `ignoreIterationLimit`, no budget-consuming step starts execution when `iteration >= maxSteps`. |

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
  7 passing
$ quint test --main=fixedMonitorMax1Test replanMonitor_test.qnt
  1 passing
$ quint test --main=beforeFollowupTest replanMonitor_test.qnt
  3 passing
$ quint test --main=fixedMonitorMax3Test replanMonitor_test.qnt
  1 passing
$ quint test --main=beforeFollowupMax3Test replanMonitor_test.qnt
  1 passing
$ quint test --main=fixedMonitorWithEscapeTest replanMonitor_test.qnt
  2 passing
$ quint test --main=judgeBeforeLimitWithEscapeTest replanMonitor_test.qnt
  1 passing
$ quint test --main=mutantMinTrigger3Test replanMonitor_test.qnt
  1 passing
$ quint test --main=fixedFullExceededTest iterationEntryOrder_test.qnt
  7 passing
$ quint test --main=fixedFullInteractiveTest iterationEntryOrder_test.qnt
  2 passing
$ quint test --main=fixedSingleIterationTest iterationEntryOrder_test.qnt
  1 passing
$ quint test --main=beforeFullExceededTest iterationEntryOrder_test.qnt
  1 passing
$ quint test --main=beforeSingleIterationWarnTest iterationEntryOrder_test.qnt
  1 passing
$ quint test --main=abortAtTransitionAlternativeTest iterationEntryOrder_test.qnt
  1 passing
$ quint test --main=mutantLoopBeforeMaxStepsTest iterationEntryOrder_test.qnt
  1 passing
```

### Random simulation (fixed models)

```
$ quint run --main=currentCode --invariant=safety --witnesses witnessStoppedAtLimit witnessStoppedOnRepeat witnessFinished witnessWithoutRuleSeen --max-samples=20000 --max-steps=20 --seed=0x1 stepLoopGuard.qnt
[ok] No violation found (2138ms at 9355 traces/second).
  witnessStoppedAtLimit: 4613 / 20000 (23.06%)
  witnessStoppedOnRepeat: 1646 / 20000 (8.23%)
  witnessFinished: 13741 / 20000 (68.70%)
  witnessWithoutRuleSeen: 9168 / 20000 (45.84%)

$ quint run --main=currentCodeWithoutRepeat --invariant=safety --max-samples=20000 --max-steps=20 --seed=0x1 stepLoopGuard.qnt
[ok] No violation found (1903ms at 10510 traces/second).

$ quint run --main=fixedMonitor --invariant=safety --witnesses witnessJudgeFired witnessAbortedAtLimit witnessJudgeAfterImplementReplan witnessJudgeAfterResumeAtReplan witnessJudgeAfterResumeAtPeerReview witnessOtherJudgeFired witnessCompleted --max-samples=20000 --max-steps=45 --seed=0x1 replanMonitor.qnt
[ok] No violation found (14167ms at 1412 traces/second).
  witnessJudgeFired: 682 / 20000 (3.41%)
  witnessAbortedAtLimit: 168 / 20000 (0.84%)
  witnessJudgeAfterImplementReplan: 324 / 20000 (1.62%)
  witnessJudgeAfterResumeAtReplan: 98 / 20000 (0.49%)
  witnessJudgeAfterResumeAtPeerReview: 343 / 20000 (1.71%)
  witnessOtherJudgeFired: 613 / 20000 (3.06%)
  witnessCompleted: 5377 / 20000 (26.88%)

$ quint run --main=fixedMonitorMax1 --invariant=safety --witnesses witnessAbortedAtLimit witnessCompleted --max-samples=20000 --max-steps=30 --seed=0x1 replanMonitor.qnt
[ok] No violation found (8513ms at 2349 traces/second).
  witnessAbortedAtLimit: 4237 / 20000 (21.19%)
  witnessCompleted: 4995 / 20000 (24.98%)

$ quint run --main=fixedMonitorMax3 --invariant=safety --witnesses witnessJudgeFired witnessAbortedAtLimit witnessOtherJudgeFired --max-samples=20000 --max-steps=45 --seed=0x1 replanMonitor.qnt
[ok] No violation found (10885ms at 1837 traces/second).
  witnessJudgeFired: 588 / 20000 (2.94%)
  witnessAbortedAtLimit: 526 / 20000 (2.63%)
  witnessOtherJudgeFired: 451 / 20000 (2.25%)

$ quint run --main=fixedMonitorWithEscape --invariant=safety --witnesses witnessJudgeEscaped witnessAbortedAtLimit witnessJudgeFired --max-samples=20000 --max-steps=45 --seed=0x1 replanMonitor.qnt
[ok] No violation found (11509ms at 1738 traces/second).
  witnessJudgeEscaped: 273 / 20000 (1.36%)
  witnessAbortedAtLimit: 1466 / 20000 (7.33%)
  witnessJudgeFired: 312 / 20000 (1.56%)

$ quint run --verbosity=1 --main=fixedFullExceeded --invariant=safety --witnesses witnessAbortedVisitLimit witnessAbortedIterationLimit witnessExceededSaved witnessAbortedInterrupt witnessAbortedLoopDetector witnessBothLimitsSimultaneous witnessJudgeRan witnessCompleted --max-samples=20000 --max-steps=25 --seed=0x1 iterationEntryOrder.qnt
[ok] No violation found.
  witnessAbortedVisitLimit: 385 / 20000 (1.93%)
  witnessAbortedIterationLimit: 569 / 20000 (2.84%)
  witnessExceededSaved: 569 / 20000 (2.84%)
  witnessAbortedInterrupt: 14027 / 20000 (70.14%)
  witnessAbortedLoopDetector: 232 / 20000 (1.16%)
  witnessBothLimitsSimultaneous: 182 / 20000 (0.91%)
  witnessJudgeRan: 1385 / 20000 (6.93%)
  witnessCompleted: 4314 / 20000 (21.57%)

$ quint run --verbosity=1 --main=fixedFullInteractive --invariant=safety --witnesses witnessAbortedVisitLimit witnessAbortedIterationLimit witnessAbortedInterrupt witnessAbortedUserInput witnessAbortedLoopDetector witnessBothLimitsSimultaneous witnessExtended witnessJudgeRan witnessCompleted --max-samples=20000 --max-steps=25 --seed=0x1 iterationEntryOrder.qnt
[ok] No violation found.
  witnessAbortedVisitLimit: 316 / 20000 (1.58%)
  witnessAbortedIterationLimit: 57 / 20000 (0.29%)
  witnessAbortedInterrupt: 12254 / 20000 (61.27%)
  witnessAbortedUserInput: 3502 / 20000 (17.51%)
  witnessAbortedLoopDetector: 1164 / 20000 (5.82%)
  witnessBothLimitsSimultaneous: 143 / 20000 (0.71%)
  witnessExtended: 77 / 20000 (0.39%)
  witnessJudgeRan: 567 / 20000 (2.83%)
  witnessCompleted: 2518 / 20000 (12.59%)

$ quint run --verbosity=1 --main=fixedFullIgnoreLimit --invariant=safety --witnesses witnessAbortedVisitLimit witnessAbortedInterrupt witnessAbortedLoopDetector witnessJudgeRan witnessCompleted --max-samples=20000 --max-steps=25 --seed=0x1 iterationEntryOrder.qnt
[ok] No violation found.
  witnessAbortedVisitLimit: 418 / 20000 (2.09%)
  witnessAbortedInterrupt: 14242 / 20000 (71.21%)
  witnessAbortedLoopDetector: 372 / 20000 (1.86%)
  witnessJudgeRan: 1423 / 20000 (7.12%)
  witnessCompleted: 4480 / 20000 (22.40%)

$ quint run --verbosity=1 --main=fixedSingleIteration --invariant=safety --witnesses witnessAbortedVisitLimit witnessAbortedInterrupt witnessAbortedUserInput witnessAbortedLoopDetector witnessCompleted --max-samples=20000 --max-steps=25 --seed=0x1 iterationEntryOrder.qnt
[ok] No violation found.
  witnessAbortedVisitLimit: 204 / 20000 (1.02%)
  witnessAbortedInterrupt: 12383 / 20000 (61.91%)
  witnessAbortedUserInput: 3749 / 20000 (18.75%)
  witnessAbortedLoopDetector: 1176 / 20000 (5.88%)
  witnessCompleted: 2488 / 20000 (12.44%)
```

### Counterexamples on pre-fix models, option (a), and mutants

```
$ quint run --main=firstVersion --invariant=retriesFree --max-samples=5000 --max-steps=20 --seed=0x1 stepLoopGuard.qnt
[violation] Found an issue (11ms).

$ quint run --main=pr164Version --invariant=stopOnRepeatNeedsRepeat --max-samples=5000 --max-steps=20 --seed=0x1 stepLoopGuard.qnt
[violation] Found an issue (11ms).  # rule -> wait.on_timeout (-1) -> same rule falsely stops

$ quint run --main=beforeFollowup --invariant=noJudgeOnFirstPeerReview --max-samples=5000 --max-steps=30 --seed=0x1 replanMonitor.qnt
[violation] Found an issue (16ms).  # resume or implement -> replan fires judge on 1st peer-review

$ quint run --main=beforeFollowupFromPlan --invariant=noJudgeOnFirstPeerReview --max-samples=5000 --max-steps=30 --seed=0x1 replanMonitor.qnt
[violation] Found an issue (17ms).  # Plan -> WriteTests -> Implement -> Replan -> PeerReview(1) -> Replan fires judge

$ quint run --main=beforeFollowupFromPlan --invariant=noJudgeWhenNextAtVisitLimit --max-samples=10000 --max-steps=45 --seed=0x1 replanMonitor.qnt
[violation] Found an issue (304ms). # replan already at MAX_VISITS yet judge fires before entry check

$ quint run --main=beforeFollowupMax3 --invariant=noJudgeWhenNextAtVisitLimit --max-samples=20000 --max-steps=45 --seed=0x1 replanMonitor.qnt
[violation] Found an issue (23ms).  # [replan, implement] judge fires with replan at MAX_VISITS = 3

$ quint run --main=judgeBeforeLimitWithEscape --invariant=limitBeatsJudge --max-samples=20000 --max-steps=45 --seed=0x1 replanMonitor.qnt
[violation] Found an issue (117ms). # option (a): judge at the limit escapes or aborts instead of the visit limit

$ quint run --main=mutantMinTrigger1 --invariant=noJudgeOnFirstPeerReview --max-samples=20000 --max-steps=45 --seed=0x1 replanMonitor.qnt
[violation] Found an issue (21ms).  # fires too early

$ quint run --main=mutantMinTrigger3 --invariant=judgeFiresWhenDue --max-samples=20000 --max-steps=45 --seed=0x1 replanMonitor.qnt
[violation] Found an issue (22ms).  # fires too late

$ quint run --main=mutantMinTrigger3 --invariant=noJudgeOnFirstPeerReview --max-samples=20000 --max-steps=45 --seed=0x1 replanMonitor.qnt
[ok] No violation found (10965ms at 1824 traces/second).  # the over-firing invariant alone misses it

$ quint run --verbosity=1 --main=beforeFullExceeded --invariant=visitLimitBeatsMaxSteps --max-samples=10000 --max-steps=25 --seed=0x1 iterationEntryOrder.qnt
[violation] Found an issue (42ms).  # #174 order: max_steps beats max_visits at simultaneous limit

$ quint run --verbosity=1 --main=beforeFullExceeded --invariant=exceededOnlyOnIterationLimit --max-samples=10000 --max-steps=25 --seed=0x1 iterationEntryOrder.qnt
[violation] Found an issue (65ms).  # #174 order: saves exceeded for a step already at max_visits

$ quint run --verbosity=1 --main=beforeFullExceeded --invariant=visitLimitOutcomePreserved --max-samples=10000 --max-steps=25 --seed=0x1 iterationEntryOrder.qnt
[violation] Found an issue (55ms).  # #174 order: judge skipped for max_visits yet ends in Max steps reached

$ quint run --verbosity=1 --main=beforeSingleIteration --invariant=visitLimitSkipsLoopDetector --max-samples=10000 --max-steps=25 --seed=0x1 iterationEntryOrder.qnt
[violation] Found an issue (55ms).  # #174 single-iteration order: LoopDetector runs before VisitLimit

$ quint run --verbosity=1 --main=abortAtTransitionAlternative --invariant=visitLimitBeatsMaxSteps --max-samples=10000 --max-steps=25 --seed=0x1 iterationEntryOrder.qnt
[violation] Found an issue (125ms). # Approach B: judge increments iteration and routes to StepC at max_visits

$ quint run --verbosity=1 --main=mutantLoopBeforeMaxSteps --invariant=noLoopDetectorDoubleCount --max-samples=10000 --max-steps=25 --seed=0x1 iterationEntryOrder.qnt
[violation] Found an issue (48ms).  # moving stateful LoopDetector before max_steps double-counts on extension continue
```

Note on writing the model: in Quint, `x' = a or b` parses as `(x' = a) or b`. Ghost-variable updates in `replanMonitor.qnt` are parenthesized (`x' = (a or b)`) for that reason.

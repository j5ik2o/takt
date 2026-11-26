# Step loop guard (j5ik2o/takt#164 and follow-up)

Quint models for:
1. Single-step `StepLoopGuard` (`max_visits` and `stop_on_repeated_verdict`), including non-terminal rule-less transitions (`system` step `wait.on_timeout`).
2. Multi-step interaction between `development-core` (all three loop monitors), `CycleDetector` (`ignore_steps`, `threshold`, `min_trigger_visits`), `StepLoopGuard`, and `LoopMonitorJudgeRunner`.

| File | Content |
|---|---|
| `stepLoopGuard.qnt` | Single-step `StepLoopGuard`. `CODE = "fixed"` is the follow-up fix, `CODE = "pr164"` is merged #164 (stale `lastVerdict` across `wait.on_timeout`), `CODE = "first"` is the first version of #164 (counted retries). |
| `stepLoopGuard_test.qnt` | Scenario tests for `stepLoopGuard.qnt`. |
| `replanMonitor.qnt` | `development-core` graph + `CycleDetector` + `StepLoopGuard` + `LoopMonitorJudge`. `fixedMonitor` / `fixedMonitorMax1` / `fixedMonitorMax3` / `fixedMonitorWithEscape` are the follow-up fix; `beforeFollowup` / `beforeFollowupFromPlan` / `beforeFollowupMax3` are merged #164; `judgeBeforeLimitWithEscape` is option (a) of design 中-1 (judge runs at the limit and may escape); `mutantMinTrigger1` / `mutantMinTrigger3` are mutants that `safety` must reject. |
| `replanMonitor_test.qnt` | Scenario tests for `replanMonitor.qnt`. |

## What is modelled

- `StepLoopGuard` (`src/core/workflow/engine/step-visit-guard.ts`): `checkEntry` before a step starts, and `recordCompletion` once a non-terminal transition is chosen; `matchedRuleIndex === undefined` (e.g., `system` step `wait.on_timeout`) counts as a completed visit and clears `lastRuleIndex`.
- `CycleDetector` (`src/core/workflow/engine/cycle-detector.ts`): `history`, the three `development-core` monitors in YAML order (`[plan, write_tests]` and `[replan, implement]` with `threshold: 3`; `[replan, peer-review]` with `ignore_steps: [implement]`, `threshold: 1`, `min_trigger_visits: 2` checked against engine-wide `completedCounts`), first triggered monitor wins, and `reset()` after any judge (clears the shared `history`, preserves `completedCounts`).
- `WorkflowRunLoop.ts` (`runWorkflowToCompletionCore`): retries (`blocked`, quality gate failure, rate-limit fallback, `requiresUserInput`) `continue` before `recordCompletion` and `CycleDetector`; natural terminals (`COMPLETE`, `ABORT`) end the run before both; when `nextStep` has already reached `max_visits`, `CycleDetector` and `LoopMonitorJudgeRunner` are skipped for every monitor so the next iteration aborts with `Visit limit reached` (`loop_detected`).
- `LoopMonitorJudgeRunner.ts`: the judge picks continue (the cycle head), `ABORT`, or, in a custom workflow (`JUDGE_HAS_ESCAPE = true`), an escape route that completes the run.
- `development-core.yaml`: all 5 steps (`plan`, `write_tests`, `implement`, `peer-review`, `replan`), all non-terminal and terminal edges, and a start or resume at any of the 5 steps (`ALLOW_RESUME`).

Not modelled: the LLM decision logic inside the judge (modelled as a nondeterministic choice), `max_visits` on steps other than `replan`, `runSingleWorkflowIteration`, parallel sub-steps, `workflow_call` child engine internals, `max_steps` / `LoopDetector` interaction, and config load-time override precedence.

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
```

Note on writing the model: in Quint, `x' = a or b` parses as `(x' = a) or b`. Ghost-variable updates in `replanMonitor.qnt` are parenthesized (`x' = (a or b)`) for that reason.

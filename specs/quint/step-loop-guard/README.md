# Step loop guard (j5ik2o/takt#164)

A Quint model of `max_visits` and `stop_on_repeated_verdict` for one step in one workflow engine.

| File | Content |
|---|---|
| `stepLoopGuard.qnt` | The model. `CODE = "fixed"` is the current code, `CODE = "first"` the first version of #164, which counted every entry. |
| `stepLoopGuard_test.qnt` | Scenario tests. |

## What is modelled

- `StepLoopGuard` (`src/core/workflow/engine/step-visit-guard.ts`): `checkEntry` before a step starts, and `recordCompletion` once the step's transition is chosen.
- How `WorkflowRunLoop.ts` calls it: a retry of the same visit (user input after `blocked`, a failed quality gate, a rate-limit fallback) calls `checkEntry` again without a completion; a terminal transition completes without comparing verdicts.

Verdicts are rule indexes; two are enough to tell repetition from alternation.

Not modelled: the loop-monitor judge on `[replan, peer-review]` (an LLM, so its decision is free), several steps or engines at once (each engine owns its guard, and the counts are per step name), resume (a new engine starts from zero), and the config override (a load-time value).

## Invariants

| Name | Meaning |
|---|---|
| `visitsBounded` | The step never starts more than `MAX_VISITS` visits. |
| `retriesFree` | A stop at the limit means `MAX_VISITS` visits completed; retries never use the limit. |
| `stopOnRepeatNeedsRepeat` | A stop on repetition needs the setting on and the last two verdicts equal. |
| `noRepeatWhileRunning` | With the setting on, a running engine never has two equal verdicts in a row. Different verdicts alternating never stop it. |
| `oneReasonPerStop` | A stop writes exactly one reason line; a running or finished run writes none. |

`safety` is the conjunction of all five.

## Record

Quint 0.32.0. Commands run from this directory.

### Scenario tests

```
$ quint test --main=fixedCodeTest stepLoopGuard_test.qnt
    ok stopsAtLimitTest passed 1 test(s)
    ok retriesAreFreeTest passed 1 test(s)
    ok sameVerdictTwiceStopsTest passed 1 test(s)
    ok terminalIsNotComparedTest passed 1 test(s)
  4 passing
$ quint test --main=alternatingTest stepLoopGuard_test.qnt
    ok alternatingRunsToLimitTest passed 1 test(s)
$ quint test --main=firstVersionTest stepLoopGuard_test.qnt
    ok retryUsedTheLimitTest passed 1 test(s)
```

### Random simulation

```
$ quint run --main=currentCode --invariant=safety --max-samples=20000 --max-steps=20 --seed=0x1 stepLoopGuard.qnt
[ok] No violation found (2122ms at 9425 traces/second).
$ quint run --main=currentCodeWithoutRepeat --invariant=safety --max-samples=20000 --max-steps=20 --seed=0x1 stepLoopGuard.qnt
[ok] No violation found (2057ms at 9723 traces/second).
$ quint run --main=firstVersion --invariant=retriesFree --max-samples=20000 --max-steps=20 --seed=0x1 stepLoopGuard.qnt
[violation] Found an issue (76ms at 79 traces/second).
error: Invariant violated
```

The first version's counterexample: one visit completes, the next visit is retried once, and the guard stops at the limit (3) with only 1 completed visit.

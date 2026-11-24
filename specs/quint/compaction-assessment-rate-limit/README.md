# Compaction assessment rate limit (issue j5ik2o/takt#86)

A Quint model of what the Phase 1 caller receives from the compaction loop of `AgentRunner` when a
provider call is rate limited.

| File | Content |
|---|---|
| `compactionAssessmentRateLimit.qnt` | The model. `currentCode` is the code before the fix, `fixedCode` the code after it. |
| `compactionAssessmentRateLimit_test.qnt` | Scenario tests for the case named in the issue and its neighbours. |

## What is modelled

- The compaction loop of `AgentRunner` (`src/agents/runner.ts`): turn, assessment, recovery, and
  the limit of three recoveries without a tool call.
- `assessCompactedResponse` (`src/infra/providers/codex.ts`): how the assessor's response becomes a
  decision.

Each provider call is reduced to how it ends: `Done`, `PlainError`, `RateLimited` or `Threw`. The
assessor is an LLM, so the model lets it return any decision, including an invalid one.

Not modelled: usage accounting, stream events, the session ID check of the compaction event, how
Codex classifies an error text as a rate limit, and what the workflow engine does with a
`rate_limited` response. The code tests cover the first three for this change.

## Invariants

| Name | Meaning |
|---|---|
| `rateLimitReachesCaller` | When the deciding provider call was rate limited, the caller receives `rate_limited` with the rate limit metadata. |
| `noInventedRateLimit` | The loop reports a rate limit only when the deciding provider call reported one. |
| `doneNeedsDoneCall` | A response is accepted only after a provider call that ended `Done`. |
| `bounded` | At most three recoveries without progress. |

`safety` is the conjunction of all four.

## Record

Quint 0.32.0. Commands run from this directory.

### Before the fix: counterexample

```sh
quint run compactionAssessmentRateLimit.qnt --main currentCode --invariant safety \
  --max-samples 10000 --max-steps 30 --seed 0x48a
```

Result: `[violation]`. With `--invariants rateLimitReachesCaller noInventedRateLimit
doneNeedsDoneCall bounded` in place of `--invariant safety`, the violated one is
`rateLimitReachesCaller`.

| State | `phase` | `lastCallEnd` | `result` | `resultHasRateLimitInfo` |
|---|---|---|---|---|
| 0 | `Turn` | `Done` | `Pending` | `false` |
| 1 | `Assess` | `Done` | `Pending` | `false` |
| 2 | `Returned` | `RateLimited` | `RError` | `false` |

The turn completes after a compaction, the assessment call is rate limited, and the caller receives
an ordinary error without the rate limit metadata. This is the defect of the issue.

### After the fix

```sh
quint run compactionAssessmentRateLimit.qnt --main fixedCode --invariant safety \
  --max-samples 100000 --max-steps 30 --seed 0x48a \
  --witnesses assessmentRateLimited completedAfterRecovery
```

Result: 100000 samples, max-steps 30, seed 0x48a, no counterexample. Witnesses:
`assessmentRateLimited` in 4703 traces, `completedAfterRecovery` in 229 traces.

Random simulation did not reach the recovery limit in 200000 samples (seed 0x86), because it needs
four compacted turns in a row. `recoveryLimitTest` reaches it with a fixed sequence.

### Scenario tests

```sh
quint test compactionAssessmentRateLimit_test.qnt --main currentCodeTest
quint test compactionAssessmentRateLimit_test.qnt --main fixedCodeTest
```

Result: 1 passing and 9 passing.

The model and the code are not linked mechanically. The code tests are
`src/__tests__/agent-runner-compaction.test.ts` and `src/__tests__/codex-structured-output.test.ts`.

# CI failure evidence (issue j5ik2o/takt#116)

A Quint model of how the CI recovery steps of the merge workflows read failure evidence.

| File | Content |
|---|---|
| `ciFailureEvidence.qnt` | The model. `currentCode` is the code before the fix, `fixedCode` the code after it. |
| `ciFailureEvidence_test.qnt` | Scenario tests for the cases named in the issue. |

## What is modelled

- `collectPrCiFailure` (`src/infra/github/pr-ci.ts`) decides `complete`.
- The `refresh_ci` rules of `builtins/*/workflows/merge-*.yaml` route to `fix_ci`, `rerun_ci` or `ci_stopped`.
- `rerunCiEffect` (`src/infra/workflow/system/system-pr-ci.ts`) guards the rerun.

Each failed check is reduced to the kind of evidence it can give: `Diagnosable`, `NotStarted`,
`External` or `Missing`. The model keeps the set of kinds, not the individual checks.

The investigator is modelled as following the `merge-ci-recovery` policy: a `Defect` verdict needs a
log, an `ExternalCause` verdict needs a log or a job that never started.

Not modelled: how `ci.passed` is computed from the checks, HEAD changes during investigation,
evidence storage failures, timeouts, and the mapping from a check to its job. The code tests cover
those. In particular, the set of failed checks is an input of the model, so
`mergeOnlyWhenNothingFailed` says only that no routing rule bypasses the wait for a new CI result.
It cannot detect a failed check that the status code reports as passed.

## Invariants

| Name | Meaning |
|---|---|
| `mergeOnlyWhenNothingFailed` | The recovery routing never reaches the merge while a check is failed. |
| `missingEvidenceBlocksRecovery` | No fix and no rerun while evidence that should exist is missing. |
| `fixNeedsDiagnosis` | A fix needs a diagnosed log. |
| `rerunNeedsActionsJob` | A rerun needs an Actions job to rerun. |
| `incompleteStopIsJustified` | Recovery stops for incomplete evidence only when evidence is missing or no Actions job is left to judge. |
| `bounded` | At most two fix rounds and one rerun. |

`safety` is the conjunction of all six.

## Record

Quint 0.32.0. Commands run from this directory.

### Before the fix: counterexample

```sh
quint run ciFailureEvidence.qnt --main currentCode --invariant safety \
  --max-samples 10000 --max-steps 30 --seed 0x158
```

Result: `[violation]`. The violated conjunct is `incompleteStopIsJustified`.

| State | `failed` | `phase` | `verdict` | `stopReason` |
|---|---|---|---|---|
| 0 | `Diagnosable, NotStarted` | `Collect` | `NoVerdict` | `NotStopped` |
| 1 | `Diagnosable, NotStarted` | `Investigate` | `NoVerdict` | `NotStopped` |
| 2 | `Diagnosable, NotStarted` | `Refresh` | `Defect` | `NotStopped` |
| 3 | `Diagnosable, NotStarted` | `Stopped` | `Defect` | `IncompleteEvidence` |

A test failure was diagnosed as a defect, but a job cancelled before start made `complete` false,
and `refresh_ci` evaluates `complete == false` before the verdict. This is the path seen in takt #68.

The other five invariants, checked one at a time on `currentCode` with 10000 samples,
max-steps 30 and seed 0x116: no counterexample.

### After the fix

```sh
quint run ciFailureEvidence.qnt --main fixedCode --invariant safety \
  --witnesses fixReachedWithExternalBeside rerunReachedForNotStartedOnly stoppedForMissing merged \
  --max-samples 20000 --max-steps 30 --seed 0x116
```

Result: 20000 samples, max-steps 30, seed 0x116: no counterexample for `safety`. The invariants are
the same as before the fix.

| Witness | Traces out of 20000 |
|---|---|
| `fixReachedWithExternalBeside` | 911 |
| `rerunReachedForNotStartedOnly` | 715 |
| `stoppedForMissing` | 13310 |
| `merged` | 221 |

Trace lengths were 4 to 16. `Stopped` and `Merged` are terminal states with no enabled action, so
short traces are expected there and do not indicate a modelling deadlock elsewhere.

### Scenario tests

```sh
quint test ciFailureEvidence_test.qnt --main fixedCodeTest     # 5 passing
quint test ciFailureEvidence_test.qnt --main currentCodeTest   # 2 passing
```

## Limits

The model and the code are not linked mechanically. `src/__tests__/pr-status.test.ts`,
`src/__tests__/system-pr-status.test.ts` and `src/__tests__/it-merge-workflow-execution.test.ts`
hold the code-level regression tests.

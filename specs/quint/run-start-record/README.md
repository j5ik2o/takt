# Run start record

A Quint model of the start of a workflow run, from entering `executeWorkflowInternal` until the run
record (`meta.json` and logs) is on disk, and of what happens when the execution bundle cannot be
prepared (an unresolved `workflow_call`, or a rejected central credential literal).

| File | Content |
|---|---|
| `runStartRecord.qnt` | The model. `ORDER` chooses where bundle preparation sits. |
| `beginFirst.qnt` / `prepareFirst.qnt` | The model instantiated with the fixed order and the old order. |
| `runStartRecord_test.qnt` | Scenario tests for both orders. |

## What is modelled

- `executeWorkflowInternal` (`src/features/tasks/execute/workflowExecution.ts`)
- `beginRun` (`src/features/tasks/execute/workflowRunLifecycle.ts`): writes `meta.json` (`running`) and opens logs
- `prepareWorkflowExecutionBundle` (`src/features/tasks/execute/workflowExecutionBundle.ts`)
- `terminalizeBootstrapFailure`: rewrites `meta.json` as `failed` with the reason

| `ORDER` | Meaning |
|---|---|
| `PrepareFirst` | Prepare before `beginRun` (before the fix). A failure leaves nothing on disk. |
| `BeginFirst` | Prepare inside the bootstrap `try` after `beginRun` (the fix). |

Not modelled: `beginRun` itself failing, and `terminalizeBootstrapFailure` failing to write. Both
are outside this change; neither path changed.

## Invariants

- `failureIsRecorded`: a run that exits after a failed preparation has `meta.json` (`failed`) and logs.
- `unresolvedReasonExplains`: the recorded reason of an unresolved call carries the lookup explanation.
- `noStepWithoutBundle`: no step runs unless the bundle was prepared.
- `noRunningAfterExit`: `meta.json` is never left `running` after the run exits.

## Commands and results

```sh
quint test runStartRecord_test.qnt --main beginFirstTest     # 3 passing
quint test runStartRecord_test.qnt --main prepareFirstTest   # 1 passing (shows the old order leaves nothing)
quint run beginFirst.qnt --main beginFirst --invariant invariant --max-steps 8 --max-samples 10000      # no violation
quint verify beginFirst.qnt --main beginFirst --invariant invariant --max-steps 8                      # no violation
quint run prepareFirst.qnt --main prepareFirst --invariant failureIsRecorded --max-steps 8 --max-samples 10000  # violation (expected)
```

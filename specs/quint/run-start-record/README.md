# Run start record

A Quint model of a workflow run's start and terminal recording lifecycle — from entering
`executeWorkflowInternal` to the run directory, `meta.json`, and NDJSON log records on disk —
covering normal completion, preparation failures (an unresolved `workflow_call` or a rejected
central credential literal), execution failure, and resuming a failed run in a second attempt.

| File | Content |
|---|---|
| `runStartRecord.qnt` | The model (`RunId -> RunRecord` across `RUN_1` and optional resume `RUN_2`). `ORDER` chooses where bundle preparation sits. |
| `beginFirst.qnt` / `prepareFirst.qnt` | The model instantiated with the fixed order (`BeginFirst`) and the old order (`PrepareFirst`). |
| `runStartRecord_test.qnt` | Scenario tests for both orders. |

## What is modelled

- `executeWorkflowInternal` (`src/features/tasks/execute/workflowExecution.ts`)
- `beginRun` (`src/features/tasks/execute/workflowRunLifecycle.ts`): resolves a distinct run slug (`sourceRunSlug !== runSlug`) and reserves an empty run directory (`mkdirSync`); it does **not** write `meta.json` or create `logs/`.
- `prepareWorkflowExecutionBundle` (`src/features/tasks/execute/workflowExecutionBundle.ts`): resolves `workflow_call` targets and checks central credential safety.
- `createWorkflowExecutionBootstrap` (`src/features/tasks/execute/workflowExecutionBootstrap.ts`): normal path after preparation; calls `publishRunMeta` (`status: running`, `source_run_slug`) and `initNdjsonLog` (`workflow_start`).
- `terminalizeBootstrapFailure` (`src/features/tasks/execute/workflowExecution.ts`): error path after preparation failure in two stages — (1) `publishRunMeta` (`status: running`, `source_run_slug`) + `initNdjsonLog` (`workflow_start`), then (2) `activeRun.finish` (`finalizeFileRunMeta` to `status: failed` with reason + `workflow_abort`).
- `activeRun.finish` (`src/features/tasks/execute/workflowRunLifecycle.ts`, `fileWorkflowRunTerminalPublisher.ts`): single-commit terminalization (`finished` guard) for both normal completion (`status: completed`, `workflow_complete`, no failure record) and failure (`status: failed`, `workflow_abort`).
- Resume (`RUN_2` starting from a failed `RUN_1`): distinct run slug, `source_run_slug` persistence on exit (including when `RUN_2` fails bundle preparation), and immutability of `RUN_1`'s persisted record.

| `ORDER` | Meaning |
|---|---|
| `PrepareFirst` | Prepare before `beginRun` (before PR #167). A preparation failure exits with no directory, no `meta.json`, no logs, and (on resume) no `source_run_slug` record. |
| `BeginFirst` | Prepare inside the bootstrap `try` after `beginRun` (PR #167). |

## What is NOT modelled (out of scope / separate issues)

- `beginRun` itself failing (`mkdirSync` error, invalid `requestedRunSlug`, or `EEXIST` on a fixed `requestedRunSlug`).
- I/O failure or SIGKILL between `terminalizeBootstrapStart` (`publishRunMeta(running)`) and `terminalizeBootstrapFinish` (`activeRun.finish(failed)`), which can leave `meta.json` in `status: running` (pre-existing 2-stage write design; tracked separately).
- A failure inside `createWorkflowExecutionBootstrap` *after* `initNdjsonLog` (for example `No provider configured`), where `terminalizeBootstrapFailure` invokes `initNdjsonLog` a second time and appends a duplicate `workflow_start` line to the `.jsonl` log (pre-existing issue; tracked separately). `publishRunMeta` itself is cached and idempotent.
- Concurrent runs racing on `.takt/runs/` (code relies on `mkdirSync` + `EEXIST` retry in `reserveRunDirectory`).

## Invariants

- `failureIsRecorded`: a run exiting after a preparation or execution failure leaves `meta.json` (`MetaFailed`), `workflow_start` (1), terminal log (1), `finishCount == 1`, and `hasFailureRecord`.
- `unresolvedReasonExplains`: a run exiting after `CallUnresolved` records the lookup explanation (`reasonHasLookup`).
- `noStepWithoutBundle`: no step runs unless the run directory was reserved and the bundle was prepared (`PrepOk`).
- `noRunningAfterExit`: `meta.json` is never left `MetaRunning` once the run has exited.
- `beginRunLeavesNoRecordYet`: immediately after `beginRun` (and before bootstrap/terminalization), the directory is reserved while `meta.json` and logs are not created yet.
- `noFailureOnSuccess`: a run exiting with `ExecCompleted` has `MetaCompleted`, `not(hasFailureRecord)`, `not(reasonHasLookup)`, single start/terminal/finish counts, and `stepsRun > 0`.
- `noDuplicateRecords`: each run writes initial `meta.json`, `workflow_start`, terminal log, and `activeRun.finish` at most once.
- `resumePreservesIntegrity`: a resumed run uses a distinct run ID (`src != id`), records `source_run_slug` once `meta.json` exists and upon exit (even if preparation fails), and never mutates the source run's persisted record (`run1Snapshot`).

## Commands and results

Max non-stutter depth for a 2-run resume trace in `BeginFirst` is 11 steps, so simulation uses `--max-steps 16`.

```sh
quint typecheck runStartRecord.qnt
quint typecheck runStartRecord_test.qnt
quint test runStartRecord_test.qnt --main beginFirstTest     # 5 passing
quint test runStartRecord_test.qnt --main prepareFirstTest   # 2 passing (shows old order drops records & resume lineage)
quint run beginFirst.qnt --main beginFirst \
  --invariant invariant \
  --witnesses witnessedUnresolvedCallFailure witnessedCredentialFailure witnessedCompletedRun witnessedExecFailure witnessedResumedPrepFailure witnessedResumedCompletion \
  --max-steps 16 --max-samples 10000                         # No violation found; all 6 witnesses hit (13.89% - 33.62%)
quint run prepareFirst.qnt --main prepareFirst --invariant failureIsRecorded --max-steps 16 --max-samples 10000          # Invariant violated (expected)
quint run prepareFirst.qnt --main prepareFirst --invariant resumePreservesIntegrity --max-steps 16 --max-samples 10000   # Invariant violated (expected)
```

## When to update

Update this spec and re-run `quint test` and `quint run` before changing the run-start, bootstrap-failure terminalization, or resume recording order in `workflowExecution.ts`, `workflowRunLifecycle.ts`, or `workflowExecutionBootstrap.ts`.

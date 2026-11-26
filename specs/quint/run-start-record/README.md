# Run start record

A Quint model of a workflow run's start and terminal recording lifecycle — from entering
`executeWorkflowInternal` to the run directory, `reports/`, `meta.json`, and NDJSON log records on
disk — covering normal completion, preparation failures (an unresolved `workflow_call` or a rejected
central credential literal), post-preparation pre-meta bootstrap failures (including
`inheritResumeReportSnapshot` failing when the source run has no `reports/`), execution failure, and
resuming a failed run in a second attempt (both with and without available operation lineage).

| File | Content |
|---|---|
| `runStartRecord.qnt` | The model (`RunId -> RunRecord` across `RUN_1` and optional resume `RUN_2`). `ORDER` chooses where bundle preparation sits. |
| `beginFirst.qnt` / `prepareFirst.qnt` | The model instantiated with the fixed order (`BeginFirst`) and the old order (`PrepareFirst`). |
| `runStartRecord_test.qnt` | Scenario tests for both orders. |

## What is modelled

- `executeWorkflowInternal` (`src/features/tasks/execute/workflowExecution.ts`)
- `beginRun` (`src/features/tasks/execute/workflowRunLifecycle.ts`): resolves a distinct run slug and reserves an empty run directory (`mkdirSync`); it does **not** write `meta.json` or create `logs/` or `reports/`.
- `prepareWorkflowExecutionBundle` (`src/features/tasks/execute/workflowExecutionBundle.ts`): resolves `workflow_call` targets and checks central credential safety.
- Post-preparation, pre-meta steps inside the bootstrap `try` (`workflowExecution.ts:288-319`, `workflowExecutionBootstrap.ts:438-468`, `resume-report-snapshot.ts:559-563`): bundle publish/load, `validateWorkflowReportReferences`, task/goal staging, and `inheritResumeReportSnapshot`. If a resumed run's source run never created `reports/`, `inheritResumeReportSnapshot` always fails and routes to `terminalizeBootstrapFailure`.
- `resolveWorkflowExecutionResumeLineage` (`src/features/tasks/execute/workflowExecutionBootstrap.ts:284-346`): models `lineageAvailable` (`true` → `publishedResumeSource` is present and `meta.json` records `source_run_slug`; `false` → `OperationLineageUnavailableError` fallback starts a new operation journal with `publishedResumeSource = undefined` and omits `source_run_slug` from `meta.json`). Here `lineageAvailable = false` represents a legacy or corrupted source `meta.json` lacking operation lineage fields (runs created by the current code always persist `operation_journal_run_slug` and `operation_claim_token`).
- `createWorkflowExecutionBootstrap` (`src/features/tasks/execute/workflowExecutionBootstrap.ts:515-544`): normal path after preparation and pre-meta checks; calls `publishRunMeta` (`status: running`) and `initNdjsonLog` (`workflow_start`).
- `WorkflowEngineSetup.ensureRunDirsExist` (`src/core/workflow/engine/WorkflowEngineSetup.ts:172-186`): creates `reports/` before executing steps (`hasReports = true`).
- `terminalizeBootstrapFailure` (`src/features/tasks/execute/workflowExecution.ts:826-936`): error path after preparation or pre-meta bootstrap failure in two stages — (1) `publishRunMeta` (`status: running`) + `initNdjsonLog` (`workflow_start`), then (2) `activeRun.finish` (`finalizeFileRunMeta` to `status: failed` with reason + `workflow_abort`).
- `activeRun.finish` (`src/features/tasks/execute/workflowRunLifecycle.ts`, `fileWorkflowRunTerminalPublisher.ts`): single-commit terminalization (`finished` guard) for both normal completion (`status: completed`, `workflow_complete`, no failure record) and failure (`status: failed`, `workflow_abort`).
- Resume (`RUN_2` starting from a failed `RUN_1`): distinct run slug, conditional `source_run_slug` persistence according to `lineageAvailable`, `reports/` inheritance requirement, and immutability of `RUN_1`'s `meta.json` and logs.

| `ORDER` | Meaning |
|---|---|
| `PrepareFirst` | Prepare before `beginRun` (before [j5ik2o/takt#167](https://github.com/j5ik2o/takt/pull/167)). A preparation failure exits with no directory, no `meta.json`, no logs, and (on resume) no `source_run_slug` record. |
| `BeginFirst` | Prepare inside the bootstrap `try` after `beginRun` ([j5ik2o/takt#167](https://github.com/j5ik2o/takt/pull/167)). |

## What is NOT modelled (out of scope / separate issues)

- `resolveAvailableSourceLineage` throwing `OperationRecoveryError` (invalid slug, ancestry cycle, or mismatched journal) before `beginRun` — exits without creating a run directory or `meta.json` (pre-existing behavior).
- `beginRun` itself failing (`mkdirSync` error, invalid `requestedRunSlug`, `EEXIST` on a fixed `requestedRunSlug`, or `resolveRunSlug` throwing when `requestedRunSlug === resumeSource.sourceRunSlug`; in this model `isSourceDistinct` guards `beginRun` instead of modelling the throw path).
- I/O failure or SIGKILL between `terminalizeBootstrapStart` (`publishRunMeta(running)`) and `terminalizeBootstrapFinish` (`activeRun.finish(failed)`), which can leave `meta.json` in `status: running` (pre-existing 2-stage write design; tracked separately).
- A failure inside `createWorkflowExecutionBootstrap` *after* `initNdjsonLog` (for example `No provider configured`), where `terminalizeBootstrapFailure` invokes `initNdjsonLog` a second time and appends a duplicate `workflow_start` line to the `.jsonl` log (pre-existing issue; tracked separately). `publishRunMeta` itself is cached and idempotent.
- Shared operation journal appends: when resuming with available lineage, `RUN_2` appends operation-journal entries under the lineage's `operationJournalRunSlug` directory (`workflowExecutionBootstrap.ts:426-431`). `PersistedRecord` models only each run's own `meta.json`, `logs`, and `reports/` presence.
- Execution failures after `createWorkflowExecutionBootstrap` succeeds but before `WorkflowEngineSetup.ensureRunDirsExist` creates `reports/` (for example in `bindExecution`, `AbortHandler`, child-process env resolution, or the early part of the `WorkflowEngine` constructor in `workflowExecution.ts:430-460`); in code such a failed run has no `reports/` and resuming from it fails in `inheritResumeReportSnapshot`, whereas the model sets `hasReports = true` upon entering `Executing`.
- Concurrent runs racing on `.takt/runs/` (code relies on `mkdirSync` + `EEXIST` retry in `reserveRunDirectory`).

## Invariants

- `failureIsRecorded`: a run exiting after a preparation, pre-meta bootstrap, or execution failure leaves `meta.json` (`MetaFailed`), `workflow_start` (1), terminal log (1), `finishCount == 1`, and `hasFailureRecord`.
- `unresolvedReasonExplains`: a run exiting after `CallUnresolved` records the lookup explanation (`reasonHasLookup`).
- `noStepWithoutBundle`: no step runs unless the run directory was reserved, the bundle was prepared (`PrepOk`), and pre-meta bootstrap passed (`BootOk`).
- `noRunningAfterExit`: `meta.json` is never left `MetaRunning` once the run has exited.
- `beginRunLeavesNoRecordYet`: immediately after `beginRun` (and before bootstrap/terminalization), the directory is reserved while `meta.json` and logs are not created yet.
- `noFailureOnSuccess`: a run exiting with `ExecCompleted` has `MetaCompleted`, `not(hasFailureRecord)`, `not(reasonHasLookup)`, single start/terminal/finish counts, and `stepsRun > 0`.
- `noDuplicateRecords`: each run writes initial `meta.json`, `workflow_start`, terminal log, and `activeRun.finish` at most once (excluding the unmodelled post-`initNdjsonLog` failure path noted above).
- `resumePreservesIntegrity`: a resumed run uses a distinct run ID (`src != id`), records `source_run_slug` if and only if operation lineage is available (`expectedRecordedSource`, including on preparation/bootstrap failure), and never mutates the source run's `meta.json` or logs (`run1Snapshot`). Note: `isSourceDistinct`, `isSourceExited`, and `run1Snapshot` preservation hold structurally in the clean model because `RUN_2` is distinct from `RUN_1` and actions update only `runs.get(activeRunId)`, while still catching mutations that corrupt `RUN_1` or drop `recordedSource`.
- `noResumeCompletionWithoutSourceReports`: resuming from a source run with `hasReports == false` (such as a preparation-failed run) never executes steps or reaches `MetaCompleted`.

## Commands and results

Max non-stutter depth for a 2-run resume trace in `BeginFirst` is 11 steps, so simulation uses `--max-steps 16`.

```sh
quint typecheck runStartRecord.qnt
quint typecheck runStartRecord_test.qnt
quint test runStartRecord_test.qnt --main beginFirstTest     # 8 passing
quint test runStartRecord_test.qnt --main prepareFirstTest   # 2 passing (shows old order drops records, reason & resume lineage)
quint run beginFirst.qnt --main beginFirst \
  --invariant invariant \
  --witnesses witnessedUnresolvedCallFailure witnessedCredentialFailure witnessedPostPrepBootstrapFailure \
    witnessedCompletedRun witnessedExecFailure witnessedResumedPrepFailure \
    witnessedResumedInheritFailure witnessedResumedLineageUnavailable witnessedResumedCompletion \
  --max-steps 16 --max-samples 10000
# Result: No violation found; all 9 witnesses reached (percentages vary by seed; e.g. --seed=0xea3c76d41854305d: 0.59% - 45.86%).

quint run prepareFirst.qnt --main prepareFirst --invariant failureIsRecorded --max-steps 16 --max-samples 10000          # Invariant violated (expected)
quint run prepareFirst.qnt --main prepareFirst --invariant unresolvedReasonExplains --max-steps 16 --max-samples 10000   # Invariant violated (expected)
quint run prepareFirst.qnt --main prepareFirst --invariant resumePreservesIntegrity --max-steps 16 --max-samples 10000   # Invariant violated (expected)
```

Optional exhaustive bounded model check (takes several minutes; covers the 11-step maximum depth):

```sh
quint verify beginFirst.qnt --main beginFirst --invariant invariant --max-steps 12
```

## When to update

Update this spec and re-run `quint test` and `quint run` before changing the run-start, bootstrap-failure terminalization, or resume recording order in `workflowExecution.ts`, `workflowRunLifecycle.ts`, or `workflowExecutionBootstrap.ts`.

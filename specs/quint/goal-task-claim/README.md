# Goal task claim

A Quint model of claiming tasks from `tasks.yaml` and of reporting the goal tasks that the claim
saves as failed (setup failures: the task's `runtime_assignment` cannot be selected). Two
processes share one `tasks.yaml`. Design: `docs/design/goal-task-claim-setup-failure.md`.

| File | Content |
|---|---|
| `goalTaskClaim.qnt` | The model. `DESIGN` picks one of three implementations and `POST_WRITE` adds an exception after the write; the instances are at the end of the file. |
| `goalTaskClaim_test.qnt` | Scenario tests: each review finding as a trace on `merged`, the remaining gap on `forkP1`, the fix on `fixed`, and the two exceptions after the write. |

## What is modelled

- `claimTasksWithGoalCompletions` (`src/features/tasks/execute/claimTasks.ts`): the first
  `listTaskStateItems()` (`snapshot`), the claim (`claimSaved` / `claimFails`), and, in `Merged`
  only, the second read `afterClaim` (`rereadOk` / `rereadFails`).
- `TaskLifecycleService.claimNextTasks` (`src/infra/task/taskLifecycleService.ts`): one write of
  `tasks.yaml` under `goal-execution.lock` and `tasks.yaml.lock`. A runnable pending task becomes
  `running` with the claimer as owner; a goal task in `SETUP_BROKEN` becomes `failed`.
- `claimPreparedTasks` (`src/features/tasks/execute/parallelExecution.ts`): a claim error
  classified as retryable returns the process to `Idle` and sets `claimRetryAt` (`retrying`); any
  other error sets `preparationFailure` (`Stopped`), and the process never claims again. A later
  claim attempt that completes clears `claimRetryAt`.
- The end of `takt run` (`runWithWorkerPool`, mode `run`): the loop leaves as a normal end when no
  task is active, `claimRetryAt` is unset and the queue is empty after a claim attempt (`endRun`,
  phase `Ended`). `runAllTasks` then reports the counts, or "No pending tasks" when both are 0.

| `DESIGN` | Code |
|---|---|
| `Merged` | `d2bd16a30`: `claimNextTasks` and `afterClaim = listTaskStateItems()` in one `try`; setup failures are the goal tasks pending in the first read and failed in the second. |
| `ForkP1` | `337062193` (PR #50): `claimNextTasks(count, guard, onSetupFailed)` reports the setup failures it saved itself; anything thrown in the callback escapes the claim. |
| `Fixed` | `ForkP1`, plus: nothing thrown in the callback escapes (the callback catches a failed manager-event write and warns; `claimNextTasks` catches anything else around each call and warns), and a `goal-execution.lock` timeout before the write is a retryable claim failure. |

`claimSaved(p, callbackFails)`: `callbackFails` means something in `onSetupFailed` throws — the
manager completion write (`saveManagerEvent`), or anything after the name is recorded (for example
`warn()` on a closed stdout). The callback records the name first, so the finish hook still gets it.

| `POST_WRITE` | Meaning |
|---|---|
| `None` | No exception after the write. `merged`, `forkP1`, `fixed`. |
| `Stops` | An exception after the write (a lock release that fails) is an unclassified error, so claiming stops. The fix's behaviour; the claim it drops is the separate issue. `fixedReleaseFails`. |
| `Retried` | The same exception is classified as a retryable claim failure, as a timeout conversion around the write would do. Rejected. `fixedPostWriteRetried`. |

Abstractions: a claim takes every pending task (the `count` limit leaves the rest pending, which
adds no behaviour these invariants see). Claim failures are the ones that happen before the write:
`TasksLockTransient` (a `tasks.yaml.lock` timeout, or ENOSPC while a pending task exists) and
`GoalLockTimeout`. A failed first read writes nothing and is retried, so it is not an action.
`hooks` counts names handed to `runTaskFinishHooks`; the hook itself can still drop them when its
own read of `tasks.yaml` fails (existing behaviour, not modelled).

Not modelled: a process that dies (its `running` tasks are failed later by
`failInterruptedRunningTasks` or `reconcileLostRun`; a setup failure saved just before the death is
never reported, in every design); ENOSPC while the first read showed no pending task (stops
claiming, the design of upstream #1857, unchanged); "a lock is always released" and "pending tasks
are eventually claimed once lock failures stop" (the first goes to the separate issue, the second
is only shown reachable by witnesses); task execution itself (`runTask` only moves a queued task to
`Done`).

## Invariants

| Name | Meaning |
|---|---|
| `noOrphanRunning` | Every task saved as `running` is in its owner's queue, or on its way there within the same call. |
| `queuedByOwnerOnly` | A task is queued only by the process that claimed it. |
| `noDuplicateSetupReport` | The finish hook (`setupFailedTaskNames`) and the manager completion event of a setup failure fire at most once. |
| `noFalseSetupReport` | Only a task that a claim saved as a setup failure is reported. |
| `noMissedSetupReport` | Once the claim that saved a setup failure has finished, its hook has fired once, and its event was written or its write failure was warned. |
| `claimingNeverStops` | A lock failure or a failed callback never stops claiming for the rest of the run. |
| `noFalseCleanEnd` | `takt run` never ends normally while a task it saved as `running` has not run. |

`safety` is the conjunction of all seven.

Each process may end (`takt run` mode); a state where both processes have ended is a terminal
state by design, so traces shorter than `--max-steps` are expected. `takt watch` never ends and is
covered by `noOrphanRunning` alone.

## Record

Quint 0.32.0. Commands run from this directory.

### Each invariant against each instance

```sh
quint run goalTaskClaim.qnt --main <instance> --invariant <name> \
  --max-samples 3000 --max-steps 12 --seed 0x2a
```

| Invariant | `merged` | `forkP1` | `fixed` | `fixedReleaseFails` | `fixedPostWriteRetried` |
|---|---|---|---|---|---|
| `noOrphanRunning` | violation | violation | ok | violation | violation |
| `queuedByOwnerOnly` | ok | ok | ok | ok | ok |
| `noDuplicateSetupReport` | violation | ok | ok | ok | ok |
| `noFalseSetupReport` | ok | ok | ok | ok | ok |
| `noMissedSetupReport` | violation | violation | ok | violation | violation |
| `claimingNeverStops` | violation | violation | ok | violation | ok |
| `noFalseCleanEnd` | violation | ok | ok | ok | violation |

`forkP1` and `fixedReleaseFails` keep `noFalseCleanEnd` only because their orphaning path also
stops claiming (`preparationFailure`), so the run ends as an error instead of a normal end.
`fixedPostWriteRetried` shows why the timeout conversion must stay before the write: classified
as a retry, the same exception brings back the Critical normal end.

### `fixed`: simulation

```sh
quint run goalTaskClaim.qnt --main fixed --invariant safety \
  --witnesses wSetupReported wLateTaskSetupReported wTaskRan wPublishLogged wGoalLockRetried wTransientRetried wOtherProcReported wRunEnded wRunEndedAfterWork \
  --max-samples 10000 --max-steps 15 --seed 0x2a
```

Result: 10,000 samples, no violation of `safety`; traces have 9 to 16 states (the short ones end
with both processes `Ended`). Witnesses (traces out of 10,000): `wSetupReported` 9,901,
`wLateTaskSetupReported` 8,289, `wTaskRan` 5,712, `wPublishLogged` 5,941, `wGoalLockRetried`
7,855, `wTransientRetried` 7,913, `wOtherProcReported` 1,883, `wRunEnded` 5,193,
`wRunEndedAfterWork` 2,886.

```sh
quint run goalTaskClaim.qnt --main fixedReleaseFails --invariant noFalseCleanEnd \
  --witnesses wPostWriteThrew --max-samples 10000 --max-steps 15 --seed 0x2a
```

Result: no violation; `wPostWriteThrew` in 9,076 traces.

### Bounded model check

| Command | Result |
|---|---|
| `quint verify goalTaskClaim.qnt --main fixed --invariant safety --max-steps 10` | `[ok]` (281 s) |
| `quint verify goalTaskClaim.qnt --main fixedReleaseFails --invariant noFalseCleanEnd --max-steps 8` | `[ok]` (35 s) |
| `quint verify goalTaskClaim.qnt --main merged --invariant noFalseCleanEnd --max-steps 8` | `[violation]` (12 s) — the check is not vacuous |
| `quint verify goalTaskClaim.qnt --main forkP1 --invariant noOrphanRunning --max-steps 8` | `[violation]` (5 s) |
| `quint verify goalTaskClaim.qnt --main fixedPostWriteRetried --invariant noFalseCleanEnd --max-steps 8` | `[violation]` (6 s) |

Every known counterexample is at most 7 steps long. Two processes that both retry once, add a
task and end need 9 to 10 steps, which the 10-step check of `fixed` covers.

### Scenario tests

```sh
quint test goalTaskClaim_test.qnt --main mergedTest                 # 6 passing
quint test goalTaskClaim_test.qnt --main forkP1Test                 # 3 passing
quint test goalTaskClaim_test.qnt --main fixedTest                  # 9 passing
quint test goalTaskClaim_test.qnt --main fixedReleaseFailsTest      # 2 passing
quint test goalTaskClaim_test.qnt --main fixedPostWriteRetriedTest  # 1 passing
```

`mergedTest` pins the review findings: `rereadTimeoutOrphansClaimedTaskTest` (Critical),
`orphanIsNotReclaimedTest`, `rereadTimeoutEndsRunAsCleanTest` (Critical: `takt run` ends as a
normal end with the task still running), `duplicateReportTest` (High 2a),
`lateTaskReportMissedTest` (High 2b), `goalLockTimeoutStopsTest` (Medium).
`forkP1Test.publishFailureOrphansClaimedTaskTest` is the gap left in PR #50. `fixedTest` also
checks that `takt run` cannot end while a claimed task is queued or a claim retry is waiting
(`runDoesNotEndWithQueuedTaskTest`, `runDoesNotEndWhileRetryingTest`).
`fixedReleaseFailsTest` records what the separate issue must fix, and that the run does not end
normally meanwhile; `fixedPostWriteRetriedTest` is the rejected conversion.

## When to update

Change this model, and rerun the commands above, before changing how `claimNextTasks` saves a
claim, how `claimTasksWithGoalCompletions` reports setup failures, or how a claim error is
classified. The separate issue on lock release failures adds its fix as a new `POST_WRITE` value.

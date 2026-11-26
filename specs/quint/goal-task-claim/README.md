# Goal task claim

A Quint model of claiming tasks from `tasks.yaml` and of reporting the goal tasks that the claim
saves as failed (setup failures: the task's `runtime_assignment` cannot be selected). Two
processes share one `tasks.yaml`. Design: `docs/design/goal-task-claim-setup-failure.md`.

| File | Content |
|---|---|
| `goalTaskClaim.qnt` | The model. `DESIGN` picks one of three implementations; `merged`, `forkP1`, `fixed` are the instances. |
| `goalTaskClaim_test.qnt` | Scenario tests: each review finding as a trace on `merged`, the remaining gap on `forkP1`, and the fix on `fixed`. |

## What is modelled

- `claimTasksWithGoalCompletions` (`src/features/tasks/execute/claimTasks.ts`): the first
  `listTaskStateItems()` (`snapshot`), the claim (`claimSaved` / `claimFails`), and, in `Merged`
  only, the second read `afterClaim` (`rereadOk` / `rereadFails`).
- `TaskLifecycleService.claimNextTasks` (`src/infra/task/taskLifecycleService.ts`): one write of
  `tasks.yaml` under `goal-execution.lock` and `tasks.yaml.lock`. A runnable pending task becomes
  `running` with the claimer as owner; a goal task in `SETUP_BROKEN` becomes `failed`.
- `claimPreparedTasks` (`src/features/tasks/execute/parallelExecution.ts`): a claim error
  classified as retryable returns the process to `Idle`; any other error sets
  `preparationFailure` (`Stopped`), and the process never claims again.

| `DESIGN` | Code |
|---|---|
| `Merged` | `d2bd16a30`: `claimNextTasks` and `afterClaim = listTaskStateItems()` in one `try`; setup failures are the goal tasks pending in the first read and failed in the second. |
| `ForkP1` | `337062193` (PR #50): `claimNextTasks(count, guard, onSetupFailed)` reports the setup failures it saved itself; a manager-event write that throws in the callback escapes the claim. |
| `Fixed` | `ForkP1`, plus: the callback logs a failed manager-event write instead of throwing, and a `goal-execution.lock` timeout is a retryable claim failure. |

Abstractions: a claim takes every pending task (the `count` limit leaves the rest pending, which
adds no behaviour these invariants see). Claim failures are the ones that happen before the write:
`TasksLockTransient` (a `tasks.yaml.lock` timeout, or ENOSPC while a pending task exists) and
`GoalLockTimeout`. A failed first read writes nothing and is retried, so it is not an action.

Not modelled: a process that dies (its `running` tasks are failed by `failInterruptedRunningTasks`,
covered by existing tests); a lock release that fails after the write (it leaves a lock our live
process owns, which blocks every later access to the store — a different failure, out of scope);
ENOSPC while the first read showed no pending task (stops claiming, the design of upstream #1857,
unchanged); task execution itself (`runTask` only moves a queued task to `Done`).

## Invariants

| Name | Meaning |
|---|---|
| `noOrphanRunning` | Every task saved as `running` is in its owner's queue, or on its way there within the same call. |
| `queuedByOwnerOnly` | A task is queued only by the process that claimed it. |
| `noDuplicateSetupReport` | The finish hook (`setupFailedTaskNames`) and the manager completion event of a setup failure fire at most once. |
| `noFalseSetupReport` | Only a task that a claim saved as a setup failure is reported. |
| `noMissedSetupReport` | Once the claim that saved a setup failure has finished, its hook has fired once, and its event was written or its write failure was logged. |
| `claimingNeverStops` | A lock failure or a failed event write never stops claiming for the rest of the run. |

`safety` is the conjunction of all six.

## Record

Quint 0.32.0. Commands run from this directory.

### Each invariant against each design

```sh
quint run goalTaskClaim.qnt --main <merged|forkP1|fixed> --invariant <name> \
  --max-samples 3000 --max-steps 12 --seed 0x2a
```

| Invariant | `merged` | `forkP1` | `fixed` |
|---|---|---|---|
| `noOrphanRunning` | violation | violation | ok |
| `queuedByOwnerOnly` | ok | ok | ok |
| `noDuplicateSetupReport` | violation | ok | ok |
| `noFalseSetupReport` | ok | ok | ok |
| `noMissedSetupReport` | violation | violation | ok |
| `claimingNeverStops` | violation | violation | ok |

### `fixed`: simulation

```sh
quint run goalTaskClaim.qnt --main fixed --invariant safety \
  --witnesses wSetupReported wLateTaskSetupReported wTaskRan wPublishLogged wGoalLockRetried wTransientRetried wOtherProcReported \
  --max-samples 10000 --max-steps 15 --seed 0x2a
```

Result: 10,000 samples, no violation of `safety`; every trace has 16 states. Witnesses (traces out
of 10,000): `wSetupReported` 9,881, `wLateTaskSetupReported` 7,982, `wTaskRan` 5,206,
`wPublishLogged` 5,812, `wGoalLockRetried` 8,345, `wTransientRetried` 8,323, `wOtherProcReported`
1,900.

### `fixed`: bounded model check

```sh
quint verify goalTaskClaim.qnt --main fixed --invariant safety --max-steps 8
```

Result: `[ok] No violation found` (Apalache, 8 steps, 107 s).

### Scenario tests

```sh
quint test goalTaskClaim_test.qnt --main mergedTest   # 5 passing
quint test goalTaskClaim_test.qnt --main forkP1Test   # 3 passing
quint test goalTaskClaim_test.qnt --main fixedTest    # 6 passing
```

`mergedTest` pins the review findings: `rereadTimeoutOrphansClaimedTaskTest` (Critical),
`orphanIsNotReclaimedTest`, `duplicateReportTest` (High 2a), `lateTaskReportMissedTest`
(High 2b), `goalLockTimeoutStopsTest` (Medium). `forkP1Test.publishFailureOrphansClaimedTaskTest`
is the gap left in PR #50.

## When to update

Change this model, and rerun the commands above, before changing how `claimNextTasks` saves a
claim, how `claimTasksWithGoalCompletions` reports setup failures, or how a claim error is
classified.

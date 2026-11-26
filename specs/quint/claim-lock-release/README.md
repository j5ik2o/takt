# Claim lock release

A Quint model of a lock release that fails after a `tasks.yaml` write (issue
[#169](https://github.com/j5ik2o/takt/issues/169)). Two `takt run` processes (A, B) and one
long-lived manager/daemon process (M) share `tasks.yaml` and its locks. Design:
`docs/design/claim-lock-release-failure.md`. The model it grew from: `specs/quint/goal-task-claim/`
(`fixedReleaseFails` there is `current` here).

| File | Content |
|---|---|
| `claimLockRelease.qnt` | The model. `DESIGN` picks one of three implementations; the instances are at the end of the file. |
| `claimLockRelease_test.qnt` | Scenario tests: the symptoms on `current`, the hang that the issue's first idea alone leaves on `returnOnly`, and the fix on `fixed`. |

## What is modelled

- One write of `tasks.yaml` under `goal-execution.lock` and `tasks.yaml.lock`, by four operations:
  `claimNextTasks` (`claim`), `failInterruptedRunningTasks` at the start of a run or watch and
  `reconcileLostRun` in the daemon (`recover`), and `invalidatePendingGoalTasks` for an aborted
  goal (`invalidate`, by M). Each action is one call: acquisition, write, release, and the
  notifications that follow.
- The two locks are one lock in the model. Both are taken around the same write and released right
  after it, and both leave a lock file naming the process when the release fails. `orphanOf` is
  the process named by a lock file left behind; `orphanForGood` says every later unlink of it fails.
- The release outcome `r`: `Ok`; `Gone` (someone else removed or replaced the lock file: "Private
  file lock ownership changed before release"); `Stuck` (the unlink fails, the file stays, a later
  unlink succeeds); `StuckForGood` (every later unlink fails too).
- An acquisition (`acquire`) sees a lock file left behind: one naming a live process waits until
  the timeout (`Timeout`, a retryable claim failure); one naming a dead process is removed
  (dead-owner recovery). In `Fixed`, one this process recorded as its own is removed too. A removal
  that fails throws the unlink error (`UnlinkFails`), an unclassified error.
- `claimPreparedTasks` / `runWithWorkerPool` (`parallelExecution.ts`): a retryable failure sets
  `claimRetryAt` (`retrying`); an unclassified one sets `preparationFailure` (`Stopped`), and the
  process exits once its active tasks settle (it is then dead for dead-owner recovery). `endRun` is
  the normal end of `takt run`.

| `DESIGN` | Code |
|---|---|
| `Current` | `integration/takt-mcp` at `ce641a0ce`. A release error after the write leaves the operation: the claim returns nothing and stops claiming; the recovery and the invalidation drop their notifications. The lock file left behind names a live process (itself), so its own later acquisitions wait on it, and so do the other processes', until it exits. |
| `ReturnOnly` | The issue's first idea alone: after the write, the operation keeps its result and its notifications, and the release error is warned (claim, run-start recovery) or thrown after the notifications (invalidation, daemon recovery). The lock file stays. |
| `Fixed` | `ReturnOnly`, plus each process records a lock file it failed to remove and removes it at its next acquisition of that lock. If that removal fails, the acquisition throws the unlink error instead of waiting. |

Not modelled:

- The completion write of a task (`runTask` only marks it done). With a lock file that can never be
  removed, that write fails too; the model only stops the process at its next acquisition.
- Reads (`listTaskStateItems`, `TaskStore.read`) and the other writers (`GoalStore.update`,
  `autoRun`, merge tasks). Their release failures still throw, as they do now (out of scope in the
  design); the record in `Fixed` keeps them from wedging the process.
- Process death in the middle of a call (covered by `specs/quint/goal-task-claim/` and the
  existing interrupted-task recovery).

## Properties

`safety` is the conjunction of the nine below.

| Invariant | Meaning |
|---|---|
| `noOrphanRunning` | A task saved as running by p is in p's queue, unless p stopped because a lock file cannot be removed (nothing can be written then; the task is failed as interrupted after p exits). |
| `queuedByOwnerOnly` | Only the claimer queues a task. |
| `noLostNotice` | Every task an operation saved as failed is notified (finish hook or manager completion event), whatever the release did. |
| `noDuplicateNotice` / `noFalseNotice` | At most once, and only for a task saved as failed. |
| `releaseFailureReported` | A release that failed after a write is warned or thrown to the caller; never silent. |
| `noSelfWait` | No process waits on a lock file it left behind itself. |
| `stopsOnlyWhenUnlinkFails` | Claiming stops only when a lock file cannot be removed. |
| `noFalseCleanEnd` | `takt run` never ends normally while a task it saved as running has not run. |

## Results

Run from this directory. quint 0.32.0.

| Command | Result |
|---|---|
| `quint test claimLockRelease_test.qnt --main currentTest` | 6 passing |
| `quint test claimLockRelease_test.qnt --main returnOnlyTest` | 3 passing |
| `quint test claimLockRelease_test.qnt --main fixedTest` | 8 passing |
| `quint run claimLockRelease.qnt --main <m> --invariant <inv> --max-samples 3000 --max-steps 12 --seed 0x2a` (9 invariants × 3 instances) | `current`: `noOrphanRunning`, `noLostNotice`, `noSelfWait`, `stopsOnlyWhenUnlinkFails` violated; the other five hold (`noFalseCleanEnd` holds: the run fails instead). `returnOnly`: `noSelfWait` violated, the other eight hold. `fixed`: no violation. |
| `quint run claimLockRelease.qnt --main fixed --invariant safety --max-samples 10000 --max-steps 15 --seed 0x2a --witnesses …` (10 witnesses) | No violation. Every witness reached: the fewest is `wTaskRanAfterReleaseFailure` in 1,708 traces; `wSelfRecovered` 2,727, `wUnlinkStop` 5,372, `wRunEndedAfterReleaseFailure` 3,588. |
| `quint verify --main fixed --invariant safety --max-steps 8` | No violation (752 s). Every counterexample below is at most 3 steps deep. |
| `quint verify --max-steps 4` on the old shapes | `current`: `noOrphanRunning`, `noLostNotice`, `noSelfWait`, `stopsOnlyWhenUnlinkFails` each give a counterexample (about 5 s each); `returnOnly`: `noSelfWait` does too. So `verify` is not vacuous. |

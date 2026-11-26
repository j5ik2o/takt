# Claim lock release

A Quint model of a lock release that fails after a `tasks.yaml` write (issue
[#169](https://github.com/j5ik2o/takt/issues/169)). Two `takt run` processes (A, B) and one
long-lived manager/daemon process (M) share `tasks.yaml` and its locks. Design:
`docs/design/claim-lock-release-failure.md`. The model it grew from: `specs/quint/goal-task-claim/`
(`fixedReleaseFails` there is `current` here).

| File | Content |
|---|---|
| `claimLockRelease.qnt` | The model. `DESIGN` picks one of five implementations; the instances are at the end of the file. |
| `claimLockRelease_test.qnt` | Scenario tests: the symptoms on `current`, the hang that the issue's first idea alone leaves on `returnOnly`, the two high findings of the first design review on `firstDesign`, the two medium findings of the second review on `secondDesign`, and the fix on `fixed`. |

## What is modelled

- One write of `tasks.yaml` under `goal-execution.lock` and `tasks.yaml.lock`, by four operations:
  `claimNextTasks` (`claim`), `failInterruptedRunningTasks` at the start of a run or watch and
  `reconcileLostRun` in the daemon (`recover`), and `invalidatePendingGoalTasks` for an aborted
  goal (`invalidate`, by M). Each action is one call: acquisition, write, release, and the
  notifications that follow. (`failInterruptedRunningTasks` takes `tasks.yaml.lock` only; the
  lock pair of the model covers it.)
- The two locks are one lock in the model. Both are taken around the same write and released right
  after it, and both leave a lock file naming the process when the release fails. `orphanOf` is
  the process named by a lock file left behind; `orphanForGood` says every later unlink of it
  fails; `orphanRecorded` says its owner recorded it (`orphanedLocks`).
- The release outcome `r`: `Ok`; `Gone` (someone else removed or replaced the lock file: "Private
  file lock ownership changed before release"); `Stuck` (the unlink fails, the file stays, a later
  unlink succeeds); `StuckForGood` (every later unlink fails too); `Unseen` (the release cannot
  open or read its own lock file — EACCES / EPERM on open, EIO on read — and the file stays; a
  later read succeeds). Before `Fixed`, `file-lock.ts` returns silently on `Unseen`
  (`unlinkSnapshot` sees `content !== expected.content`).
- An acquisition (`acquire`) sees a lock file left behind: one naming a live process and not
  recorded waits until the timeout (`Timeout`, a retryable claim failure); one naming a dead
  process is removed (dead-owner recovery); one this process recorded is removed too. A removal
  that fails throws (`UnlinkFails`), an unclassified error.
- A transient read failure while recovering a recorded own lock file (`Glitch`): `FirstReadFails`
  (the first read in `recoverStaleLock`) or `SecondReadFails` (the re-read just before the unlink);
  the next read succeeds. The acquisition then ends as `UnreadableWait` (the record is kept and the
  acquisition waits under the rule for an unreadable lock, which removes it once older than
  `STALE_MS`; a wait that lasts only while the file cannot be read, not counted as a self-wait), `RecordLost` (the record is dropped
  without removing the file; from then on the process waits on itself), or `ReadFailed` (the read
  error is thrown; claiming stops with `ReadStop`).
- Notifications are split: the finish hook (`hooks`; needed by a claim's setup failure and an
  invalidation) and the manager completion event (`events`; needed by a setup failure and a
  recovery). Before `Fixed`, the finish hook re-reads `tasks.yaml` right after the write
  (`runTaskFinishHooks` → `listTaskStateItems` → `TaskStore.read`) under `tasks.yaml.lock`; the
  model runs that acquisition against the lock state the release left, and a failed re-read loses
  the hook (it is only logged). The re-read may remove a recorded own lock file itself.
- `claimPreparedTasks` / `runWithWorkerPool` (`parallelExecution.ts`): a retryable failure sets
  `claimRetryAt` (`retrying`); an unclassified one sets `preparationFailure` (`Stopped`). `endRun`
  is the normal end of `takt run`.

| `DESIGN` | Code |
|---|---|
| `Current` | `integration/takt-mcp` at `ce641a0ce`. A release error after the write leaves the operation: the claim returns nothing and stops claiming; the recovery and the invalidation drop their notifications. The lock file left behind names a live process (itself), so its own later acquisitions wait on it, and so do the other processes', until it exits. An unreadable own lock file at release is left silently. |
| `ReturnOnly` | The issue's first idea alone: after the write, the operation keeps its result and its notifications, and the release error is warned (claim, run-start recovery) or thrown after the notifications (invalidation, daemon recovery). The lock file stays. |
| `FirstDesign` | The design as first reviewed (`237703e8e`): `ReturnOnly`, plus each process records a lock file whose release threw and removes it at its next acquisition. An unreadable own lock file is still left silently (not recorded), and the finish hooks still re-read `tasks.yaml`. |
| `SecondDesign` | The design after the first review (`b82a56d2a`): `FirstDesign`, plus the release throws and records when its own lock file is there but cannot be read, and the finish hooks get the saved task states instead of re-reading. Its recovery throws when the first read fails (`ReadFailed`), and removes the file with `unlinkSnapshot`, which returns silently when its re-read fails, so the record is dropped as if removed (`RecordLost`). `FirstDesign` drops the record on either glitch (an unreadable file does not match the record). |
| `Fixed` | `SecondDesign`, plus the recovery keeps the record and waits (`UnreadableWait`) when either read fails, and reports "removed" only when `unlinkSync` succeeded. |

Not modelled:

- The completion write of a task (`runTask` only marks it done). With a lock file that can never be
  removed, that write fails too; the model only stops the process at its next acquisition.
- Reads (`listTaskStateItems`, `TaskStore.read`) other than the finish hook's re-read, and the
  other writers (`GoalStore.update`, `autoRun`, merge tasks). Their release failures still throw,
  as they do now (out of scope in the design); the record keeps them from wedging the process. So
  `stopsOnlyWhenUnlinkFails` is a guarantee about the write path only: the claim's first read
  (`claimTasks.ts:38`) still stops claiming on a transient release failure.
- `Stopped` and `Ended` count as dead at once. In the code, a stopped `takt run` stays alive until
  its active tasks settle (`parallelExecution.ts:257-259`), so other processes wait longer for
  dead-owner recovery than in the model. This does not change any safety property.
- How long `UnreadableWait` lasts: the rule for an unreadable lock (`STALE_MS`) is not modelled; the
  wait is a retryable timeout, as for any held lock. `STALE_MS` is when the removal attempts start,
  not a bound: a round where only one of its two reads fails removes nothing (design 3-3).
- A lock that someone else replaced (`Gone`) held by its new owner: each operation is one atomic
  step, so that owner's lock ends with its own step and its own release outcome. Waiting on it in
  between is a retryable timeout, which `Timeout` already models.
- The immediate retry after removing an own lock file (design 3-1 / 3-2) and clearing the record on
  a direct acquisition: an acquisition is one atomic step here. Unit tests cover them.
- The finish hook when the project has no `task_finish_hook` (no re-read happens then).
- Process death in the middle of a call (covered by `specs/quint/goal-task-claim/` and the
  existing interrupted-task recovery).

## Properties

`safety` is the conjunction of the nine below.

| Invariant | Meaning |
|---|---|
| `noOrphanRunning` | A task saved as running by p is in p's queue, unless p stopped because a lock file cannot be removed (nothing can be written then; the task is failed as interrupted after p exits). |
| `queuedByOwnerOnly` | Only the claimer queues a task. |
| `noLostNotice` | Every task an operation saved as failed gets each notification it needs (finish hook, manager completion event) exactly once, whatever the release did. |
| `noDuplicateNotice` / `noFalseNotice` | Each at most once, and only for a task an operation that needs it saved as failed. |
| `releaseFailureReported` | A release after a write that did not remove the lock cleanly (an unreadable own file included) is warned or thrown to the caller; never silent. |
| `noSelfWait` | No process waits on a lock file it left behind itself, except while a recorded one cannot be read (`UnreadableWait`; from `STALE_MS` on, the rule for an unreadable lock tries to remove it). |
| `stopsOnlyWhenUnlinkFails` | On the write path, claiming stops only when a lock file cannot be removed; a read that fails once does not stop it. |
| `noFalseCleanEnd` | `takt run` never ends normally while a task it saved as running has not run. |

## Results

Run from this directory. quint 0.32.0.

| Command | Result |
|---|---|
| `quint test claimLockRelease_test.qnt --main currentTest` | 7 passing |
| `quint test claimLockRelease_test.qnt --main returnOnlyTest` | 3 passing |
| `quint test claimLockRelease_test.qnt --main firstDesignTest` | 4 passing |
| `quint test claimLockRelease_test.qnt --main secondDesignTest` | 4 passing |
| `quint test claimLockRelease_test.qnt --main fixedTest` | 14 passing |
| `quint run claimLockRelease.qnt --main <m> --invariant <inv> --max-samples 3000 --max-steps 12 --seed 0x2a` (9 invariants × 5 instances) | `current`: `noOrphanRunning`, `noLostNotice`, `releaseFailureReported`, `noSelfWait`, `stopsOnlyWhenUnlinkFails` violated; the other four hold (`noFalseCleanEnd` holds: the run fails instead). `returnOnly` and `firstDesign`: `noLostNotice`, `releaseFailureReported`, `noSelfWait` violated. `secondDesign`: `noOrphanRunning`, `noSelfWait`, `stopsOnlyWhenUnlinkFails` violated (`noOrphanRunning` because a run stopped by a read failure leaves its claimed tasks). `fixed`: no violation. |
| `quint run claimLockRelease.qnt --main fixed --invariant safety --max-samples 10000 --max-steps 15 --seed 0x2a --witnesses …` (13 witnesses) | No violation. Every witness reached: the fewest is `wRunEndedAfterReleaseFailure` in 671 traces; `wTaskRanAfterReleaseFailure` 1,844, `wSelfRecovered` 3,101, `wUnseenReported` 4,223, `wWaitedOnUnreadableOwn` 4,641, `wHookAfterStuckForGood` 4,855. The two ghosts tie witnesses to their fault: `heldAfterReleaseFailure` (the tasks a claim queued when its release failed) for `wTaskRanAfterReleaseFailure` / `wRunEndedAfterReleaseFailure`, and `lastRelease` (outcome and report of the last release) for `wUnseenReported`. |
| `quint verify --main fixed --invariant safety --max-steps 5` | No violation (118 s). Every counterexample below is at most 3 steps deep. (The glitches add branching; 6 steps took 282 s before them and was not rerun.) |
| `quint verify --max-steps 4` on the old shapes | `secondDesign`: `noSelfWait`, `stopsOnlyWhenUnlinkFails`; `firstDesign`: `noLostNotice` — each gives a counterexample (7–8 s each). Earlier runs also checked `firstDesign` `releaseFailureReported` / `noSelfWait`, `current` `noOrphanRunning`, `returnOnly` `noSelfWait`. So `verify` is not vacuous. |

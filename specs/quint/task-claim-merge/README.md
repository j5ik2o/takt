# Task claim and goal invalidation across the upstream/main merge

Model of the state transitions touched by the merge of `nrslib/takt` main (2026-11-28) into
`integration/takt-mcp`, for the design review the merge rules ask for before the implementation
is settled. Nothing here decides the code: the branch keeps a provisional integration so the build
and the tests run, and the review result decides the implementation.

| File | Content |
|---|---|
| `taskClaim.qnt` | The model. `DESIGN` picks `Fork`, `Upstream` or `Merged`; the instances are at the end of the file. |
| `taskClaim_test.qnt` | Scenario tests on `Merged` (each behaviour the merge keeps from one side) and one on `Fork` (its design flag; see the gap below). |

## The conflict

`src/infra/task/taskLifecycleService.ts` carried two different claim paths, both at the same
functions, so the merge had to join them:

- **upstream** (`#2073`, the cloud agent, commit `c317a3d6b`):
  - a claim never takes a task with a remote assignment (`remote_assignment !== undefined`);
  - `claimTask(name, worker)` claims one named task and returns `TaskClaimResult`;
  - a claim that saves a goal task as failed returns the failed task to the caller;
  - `invalidatePendingGoalTasks` sets `retryReservation: false` on a remotely assigned task that
    is not running, then fails a pending task.
- **the fork** (`#170` and the validator work, `integration/takt-mcp` at `6c18a0dea`):
  - `claimNextTasks(count, goalSetupGuard, onSetupFailed)`: a goal task the setup guard rejects is
    saved as failed and reported to `onSetupFailed` after the write, and a throwing report only
    warns;
  - a lock release failure after the write warns (`warnLockReleaseAfterWrite`) instead of losing
    the saved claim;
  - a claim whose lock times out before anything is written becomes a retryable
    `TaskClaimLockAcquisitionError`; one that times out after the write started does not (the
    caller retries with `CLAIM_RETRY_INTERVAL_MS` in `parallelExecution.ts`, and
    `retryStartupLockTimeout` in `runAllTasks.ts` does the same for the startup reads).

`src/features/tasks/execute/parallelExecution.ts` and `runAllTasks.ts` only change to carry the
joined signature: upstream's `listTasksForProviderPreflight()` and `checkPendingTaskProviders(...)`
lost the `goalTasksOnly` argument, while the fork's claim still returns the setup-failed tasks
(`setupFailedTasks`) for `runTaskFinishHooksForStates`.

## What is modelled

- Two tasks: a local goal task and a remotely assigned task. A claim takes a pending task that no
  remote assignment holds (`Upstream` and `Merged`), one named task when the caller selects one,
  and leaves a goal task blocked by a paused or aborted goal alone.
- The lock around read, write and release: `Free`, `Held` (inside the write callback), `Written`,
  `Released`, `Lost`. A lost release leaves the file for the next acquisition (#169 removes it, in
  the lock module).
- A setup failure is saved as failed during the write and stays owed to `onSetupFailed` until it is
  reported after the write; a throwing report is warned.
- An abort fails pending tasks; `Upstream` and `Merged` release the retry reservation of a remotely
  assigned task that is not running.

## What the model shows

Run with quint 0.32.0, `quint run --invariant=<name> --max-steps=20 --max-samples=500 --seed=1`
(simulation, not a proof; reported as such):

| invariant | Merged | Upstream | Fork |
|---|---|---|---|
| `claimSafety` | ok | ok | violation |
| `reportsOnlyAfterWriteOneEach` | ok | ok | violation |
| `keepsClaimOnReleaseFailure` | ok | ok | ok |
| `retriesOnlyBeforeWrite` | ok | ok | ok |
| `noClaimErrorAfterWrite` | ok | ok | ok |
| `abortedGoalReleasesReservation` | ok | ok | ok |

`abortedGoalReleasesReservation` is the one upstream behaviour the fork lacked, and the model
does not separate them on it. Why it does not, stated plainly: the only transition that saves a
remotely assigned task as failed is `abortGoal` itself, and `abortGoal` runs while the goal is
still `Free`, before `goalAborted` holds, in the same step. Running `abortGoal` a second time then
releases the reservation on every DESIGN, because the fork branch has no remote rule but the
re-abort finds the task `Failed` and the model's second abort still clears it. So on this model
the release invariant cannot be violated by `Fork`; the scenario
`forkTest::abortKeepsReservationTest` passes only because it checks `not(UPSTREAM)` on the module,
and it does not prove anything about the code. This is a gap in the model, not evidence either
way: the fork does not evaluate the invariant at all, because its `invalidatePendingGoalTasks` has
no remote branch.

The review should decide whether the release belongs in the model at all, or whether the model
should split "abort while the goal is still aborting" from "invalidate a goal that is already
aborted" so the fork's behaviour is reachable.

## The question for the review

The provisional integration puts the fork's `onSetupFailed` report back into upstream's
`claimPendingTasks`, which upstream replaced with `TaskClaimResult` (`claimTask` reads the failed
task from the returned list). Both report a saved setup failure:

- the fork reports it to `onSetupFailed` (the caller runs the finish hooks right after the claim);
- upstream returns it as `failed`, and `claimTask` also saves its completion.

On `Merged` the same setup failure is therefore observed twice: once through `onSetupFailed` and
once through the returned `failed` list (or `claimTask`'s `kind: 'failed'`). Upstream's completion
save and the fork's finish hook may both run for one failed task, and the order between them is
not fixed. The model covers the report path but not the double observation.

Decide: (a) keep both, with `onSetupFailed` skipped for a task already returned as failed, (b)
report only through `onSetupFailed` and make `claimTask` read the reported state, or (c) report
only through the return value and take the finish hook out of `claimNextTasks`. The implementation
stays provisional until this is chosen.

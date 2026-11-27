# Goal task completion publication

A Quint model of durable outbox publication for goal task completion notices ([j5ik2o/takt#170](https://github.com/j5ik2o/takt/issues/170)).
Covers the three failure/recovery paths that save a goal task as `failed` with `completion` in `.takt/tasks.yaml` and then notify the manager through `manager-inbox/`:

1. Setup failures in `claimNextTasks` (`src/infra/task/taskLifecycleService.ts`, `src/features/tasks/execute/claimTasks.ts`)
2. Interrupted running task recovery in `failInterruptedRunningTasks` (`src/infra/task/taskLifecycleService.ts`, `src/features/tasks/execute/claimTasks.ts`)
3. Lost-run reconciliation in `reconcileLostRun` (`src/features/daemonTurn/reconcileLostRun.ts`)

Design: `docs/design/goal-task-completion-publication.md`.

| File | Content |
|---|---|
| `goalTaskCompletionPublication.qnt` | The model. `DESIGN` selects one of seven variants (`Before`, five single-ablation negative controls, and `Fixed`). Concrete instances are at the bottom of the file. `init`/`step` drive the `safety` checks; `initD`/`stepD` add a drain phase for `drainedDelivery`. |
| `actionAblations.sh` | Action ablations P1–P3: copies the model, edits one action body (not a `DESIGN` flag), and runs `safety`, `quiescentDelivery`, and `drainedDelivery` on `fixed`. |
| `goalTaskCompletionPublication_test.qnt` | Scenario tests: counterexamples on `before`, `fixedNoRepublisher`, `fixedNoHasWork`, `fixedStaleDeletionBlocks`, `fixedNoDedup`, and `fixedUncheckedClear`, plus recovery/dedup/idle-exit/stale-deletion scenarios on `fixed`. |

## What is modelled

- **Tasks (`.takt/tasks.yaml`)**: Two goal tasks (`t1`, `t2`), each up to `MAX_ATTEMPTS = 2` attempts across requeue. Each task tracks `status` (`Absent | Pending | Running | Failed`), `attempt`, `hasCompletion`, `pendingPub` (`completion_publication_pending`), `deletion` (`DelNone | DelAlive | DelDead`), `hasRunSlug`, and `hasExecId`.
- **Writers**:
  - `writeSetupFailure`: `Pending` -> `Failed` directly (only when `goal == Active`), sets `hasRunSlug = true`, `hasExecId = true`, and `pendingPub = usesOutbox(DESIGN)`.
  - `writeInterruptedFailure`: `Running` -> `Failed`, ensures `hasRunSlug = true`, sets `pendingPub = usesOutbox(DESIGN)`.
  - `writeReconcileFailure`: `Running` -> `Failed`, preserves `hasRunSlug` (may be `false` if the worker died before `updateRunningTaskExecution`), and in `Fixed*` ensures `hasExecId = true` when `hasRunSlug == false` (`reconcileLostRun` issues an `execution_id` for exactly that record). Reaching that shape needs `adoptLegacyRunningTask`: a `tasks.yaml` record written before the attempt ids were recorded can still be `Running` with neither id, whereas `startTask` always sets `hasExecId`.
  - Post-write steps: `writerPublishOk` (writes inbox file unless `goal == Aborted`, fails on `Deleted`), `writerPublishFails` (ENOSPC / unreadable `goal.json`), `writerCrash` (process death before publish or before clear), `writerClearOk` (via `TaskStore.update`, which clears stale `DelDead` reservations before clearing `pendingPub`), `writerClearFails`.
- **Daemon outbox republisher & idle lifecycle** (`FileDaemonWatchSource.hasWork` + `taskCompletions` + `publishPendingGoalTaskCompletions`):
  - `daemonRunning`: starts `true`; all daemon republish, inbox consumption, and deferred delivery actions require `daemonRunning == true`.
  - `daemonHasWork`: `true` when `goal == Active | Paused`, `inbox` is non-empty, any task is `Pending | Running`, or (when `usesPendingHasWork(DESIGN)`) any task has `pendingPub == true` (including tasks with a `deletion` reservation, so daemon waits for deletion finish/cancel/crash).
  - `daemonIdleExit`: when `daemonRunning`, `daemon.phase == DaemonIdle`, and `not(daemonHasWork)`, stops the daemon (`daemonRunning' = false`). The real `idle()` in `runDaemon.ts` does not wait for the `taskCompletions` loop, so `hasWork` may interleave with a republish. The model can still treat `hasWork` as one atomic check because the design orders the reads and writes: `hasWork` reads pending marks before the inbox, and the republisher writes the inbox file before it clears the mark. If the mark read misses the mark, the clear already happened, so the inbox file was written before the inbox read starts.
  - `daemonReadPending` (active when `usesRepublisher(DESIGN)`): picks a `Failed` task with `hasCompletion`, `pendingPub`, non-blocking `deletion` (`DelAlive` blocks; `DelDead` is recovered when `usesStaleDeletionRecovery(DESIGN)`), and `hasRunSlug or hasExecId`.
  - `daemonPublishOk`: checks `goal.json`; writes an inbox file when `goal == Active | Paused`, or skips inbox write when `goal == Aborted | Deleted`. A `completed` goal takes the `Aborted` branch (the design uses `isGoalFinished`).
  - `daemonPublishFails`: transient error reading `goal.json` or writing inbox; leaves `pendingPub` set.
  - `daemonClearOk`: acquires `tasks.yaml.lock` and clears `pendingPub` (and any stale `DelDead` reservation) if `status == Failed`, `pendingPub == true`, `deletion` is non-blocking, and (when `usesCheckedClear(DESIGN)`) `attempt == expectedAttempt`.
  - `daemonClearFails`: lock timeout / ENOSPC / daemon restart; leaves `pendingPub` set.
- **Inbox consumer** (`receiveInboxChange` + `FileEventStore.accept` + `conversationService`):
  - `consumeInbox`: removes one inbox file, computes `eventKeyFor(DESIGN, f)`, inserts into durable `acceptedKeys`. On a new key: increments `wakes[(task, attempt)]` if `goal == Active`, inserts into `deferred` if `goal == Paused`, discards if `goal == Aborted | Deleted`. Duplicates are ignored.
  - `deliverDeferred`: delivers a deferred completion once `goal` resumes to `Active`.
- **Concurrent lifecycle**: `startTask`, `adoptLegacyRunningTask` (adopts an older `tasks.yaml` record that is `Running` without `run_slug` or `execution_id`), `requeueTask`, `reserveDeletion` / `cancelDeletion` / `deletionOwnerCrash` / `finishDeletion`, `pauseGoal`, `resumeGoal`, `abortGoal` (clears `inbox` and `deferred`), `deleteGoal`.

| `DESIGN` | Meaning |
|---|---|
| `Before` | Current code: no `completion_publication_pending`, no daemon republisher, no pending `hasWork`, per-file random `inbox-<hash>` eventId. |
| `FixedNoRepublisher` | Full design except daemon republishing (`daemonReadPending`) is disabled through the `usesRepublisher` flag. Shows that `noUnrecoverableLoss` alone does not verify delivery. `quiescentDelivery` fails here only because the same flag also enters `republisherAccepts`, which the property reads; `drainedDelivery` fails because no action delivers. |
| `FixedNoHasWork` | Full design except `daemonHasWork` ignores `pendingPub`. Proves daemon can idle-exit while `pendingPub` remains unsettled. |
| `FixedStaleDeletionBlocks` | Full design except daemon treats `DelDead` as blocking instead of inspecting process liveness. Proves a dead deletion owner strands `pendingPub`. |
| `FixedNoDedup` | Full design except per-file random `eventId`. Proves deterministic `eventId` is required. |
| `FixedUncheckedClear` | Full design except clear ignores attempt identity. Proves attempt-matched clearing is required. |
| `Fixed` | Full design: durable `completion_publication_pending`, daemon republisher, `hasWork` covering pending marks, stale-deletion recovery, deterministic `eventId` (`runSlug` or `executionId`), attempt-matched clear, live-deletion guard, and aborted/deleted goal settlement. |

### Not modelled

- **Attempt-key uniqueness and writer/daemon key agreement**: `RunKey((task, attempt))` and `ExecKey((task, attempt))` key directly on `(task, attempt)`. The model therefore takes as a premise that (a) each attempt generates a unique `run_slug` / `execution_id` and (b) the writer and daemon derive the exact same `eventId` from the same `tasks.yaml` record. In the real implementation, these load-bearing premises are verified by PBT 1 (`eventId` determinism/injectivity) and the writer/daemon integration tests.
- **Multiple concurrent writers or multiple daemon instances**: the model has one writer state and one daemon state; tasks are independent and `.takt/tasks.yaml.lock` serializes writes, so multi-writer interleavings on different tasks reduce to the modelled transitions.
- **Goal `completed` status and direct goal deletion from `Active`**: the design settles a pending mark without writing the inbox when `isGoalFinished(goal)` is true (`executionStatus === 'aborted'` or `status === 'completed'`) or `goal.json` is missing. A `completed` goal therefore follows the same path as `Aborted`, and manual deletion directly from `Active` follows the same path as `Deleted` (skip inbox, clear `pendingPub`).
- **Deletion owner liveness `unknown`**: `DeletionState` has only `DelNone | DelAlive | DelDead`. In the design, `observeProcess` may return `unknown` (no `owner_start_time` and the PID exists). The daemon then neither clears nor counts the mark in `hasWork`, and reports it once. The mark stays in `tasks.yaml` and is retried by the next daemon start. The model does not cover this path; its premise is that an `unknown` owner is not reported as `alive` forever.
- **Invalid marks and unreadable `tasks.yaml`**: the model only has schema-valid marks (`pendingPubSchemaValid`). In the design, an invalid mark and a whole `tasks.yaml` that cannot be read are reported once (deduplicated until the content changes) and are not counted in `hasWork`.
- **Simulation file bound (`MAX_FILES = 32`)**: inbox file IDs are bounded at 32; in 25-step traces at most 12 inbox files can be created, so the bound is not hit during checked runs, though unboundedly long traces would stop publishing past 32 files.
- **Normal task execution completions** (`completeTask`, `failTask`, `exceedTask`, `prFailTask` in `parallelExecution.ts`), which are out of scope for `completion_publication_pending` in #170 (though their inbox `eventId` switches to the same `runSlug`-based deterministic key).
- **`task_finish_hook` execution** (`specs/quint/goal-task-claim/` models `hooks` for claim setup failures).
- **Low-level lock contention / timeouts** (`tasks.yaml.lock` and `goal-execution.lock` acquisition failures are abstracted as `writerClearFails` / `daemonClearFails`; `goal-task-claim` models claim lock retries).
- **Permanent disk corruption or unbounded permanent ENOSPC** (liveness premise: once transient I/O errors stop, daemon ticks retry `pendingPub`).
- **TOCTOU between daemon reading `goal.json` as `Active` and writing an inbox file while `abortGoal` runs concurrently**: the model captures the post-inbox protection (`conversationService` discards events for `Aborted`/`Deleted` goals in `consumeInbox`), while treating `daemonPublishOk`'s `goal` check and inbox write as one step.

## Invariants

| Name | Meaning |
|---|---|
| `noDuplicateManagerWake` | Each `(task, attempt)` wakes the manager at most once (`wakes <= 1`). |
| `noUnrecoverableLoss` | Under an `Active` or `Paused` goal, every task currently `Failed` with `completion` is either already woken/deferred, in `inbox`, held by a live pre-publish writer, or durably marked `pendingPub` in `tasks.yaml`. |
| `pendingPubSchemaValid` | `pendingPub == true` only holds on a `Failed` task with `completion`, `attempt > 0`, and `hasRunSlug or hasExecId`. |
| `noPhantomWake` | The manager only wakes or defers for a `(task, attempt)` that was actually saved as `Failed`. |
| `noDeferredWhenAbortedOrDeleted` | No deferred completions remain once a goal is `Aborted` or `Deleted`. |
| `noDaemonExitWithWork` | When `not(daemonRunning)`, the goal is `Aborted` or `Deleted`, `inbox` and `deferred` are empty, and no task is `Pending`, `Running`, or marked `pendingPub`. |
| `quiescentDelivery` | For every task `t` with no enabled recovery, delivery, or live-deletion guard (`not(taskRecoveryEnabled)` — without assuming `not(pendingPub)`): under `Active`, `Failed` with `completion` implies `wakes >= 1`; under `Paused`, `wakes >= 1` or `deferred`; under `Aborted`/`Deleted`, `not(pendingPub)`. |

`safety` is the conjunction of these seven. Every `DESIGN` negative control fails at least one of them (`noDuplicateManagerWake`, `noUnrecoverableLoss`, `noDaemonExitWithWork`, or `quiescentDelivery`).

`quiescentDelivery` has a limit. `taskRecoveryEnabled` copies the action guards (for example `republisherAccepts`), so it only says "if no guard holds, the notice was delivered". It does not see an action that keeps its guard but stops doing its work. Action ablations P1 (`daemonReadPending` keeps its guard but never advances) and P3 (`daemonClearOk` keeps the mark) pass all of `safety`. A separate property checks the effect of the actions:

| Name | Meaning |
|---|---|
| `drainedDelivery` | Runs with `--init initD --step stepD`. `stepD` runs `step` until it nondeterministically enters a drain phase. In the drain, failures and outside changes stop, and only forward progress actions run (`writerPublishOk`, `writerClearOk`, `daemonReadPending`, `daemonPublishOk`, `daemonClearOk`, `daemonIdleExit`, `consumeAnyInbox`, `deliverAnyDeferred`, `cancelDeletion`, `finishDeletion`, `deletionOwnerCrash`, `resumeGoal`). A stutter step is enabled only while no progress action is enabled (`drainProgressPossible`), so a step that changes nothing never counts as time while a notice could still move; a stuck drain keeps stepping and the bound then exposes it. After `DRAIN_STEPS = 40` drain steps, under an `Active` goal every `Failed` task with `completion` has `wakes >= 1` **and** no `pendingPub`; under `Aborted`/`Deleted` no `pendingPub` remains. A goal still `Paused` at the bound is not evidence of delivery (`resumeGoal` was selectable and may not have been chosen), so the bound makes no claim about `Paused`: it neither requires a wake nor forbids `pendingPub` while `Paused`. |

This is a bounded progress check under simulation, not a proof of liveness. Because a stutter does not advance the bound while a progress action is enabled, an unlucky schedule cannot launder a deliverable notice as "time passed"; the remaining risk is the opposite one: 40 steps may be too few for the work a trace still has, and a `Paused` tail at the bound is simply inconclusive. `fixed` showed no such case in the runs below.

## Record

Quint 0.32.0. Commands run from `specs/quint/goal-task-completion-publication/`.

### Each invariant against each instance

```sh
quint run goalTaskCompletionPublication.qnt --main <instance> --invariant <name> \
  --max-samples 3000 --max-steps 16 --seed 0x2a
```

Plus deeper checks on `fixedUncheckedClear` (the stale-clear race requires a 7+ step requeue interleaving):

```sh
quint run goalTaskCompletionPublication.qnt --main fixedUncheckedClear \
  --invariant noUnrecoverableLoss --max-samples 50000 --max-steps 25 --seed 0x2a
quint run goalTaskCompletionPublication.qnt --main fixedUncheckedClear \
  --invariant quiescentDelivery --max-samples 50000 --max-steps 25 --seed 0x2a
```

| Invariant | `before` | `fixedNoRepublisher` | `fixedNoHasWork` | `fixedStaleDeletionBlocks` | `fixedNoDedup` | `fixedUncheckedClear` | `fixed` |
|---|---|---|---|---|---|---|---|
| `noDuplicateManagerWake` | ok | ok | ok | ok | **violation** (34ms) | ok | ok |
| `noUnrecoverableLoss` | **violation** (35ms) | ok | ok | ok | ok | **violation** (708ms at 50k/25) | ok |
| `pendingPubSchemaValid` | ok | ok | ok | ok | ok | ok | ok |
| `noPhantomWake` | ok | ok | ok | ok | ok | ok | ok |
| `noDeferredWhenAbortedOrDeleted` | ok | ok | ok | ok | ok | ok | ok |
| `noDaemonExitWithWork` | ok | ok | **violation** (35ms) | ok | ok | ok | ok |
| `quiescentDelivery` | **violation** (32ms) | **violation** (34ms) | **violation** (35ms) | **violation** (31ms) | ok | **violation** (786ms at 50k/25) | ok |

Note the `fixedNoRepublisher` column: `noUnrecoverableLoss` passes (checking only durable marks misses a missing republisher). `quiescentDelivery` fails, but only because the `usesRepublisher` flag also enters the guard expression that the property reads (see the limit above).

### `drainedDelivery` against each instance

```sh
quint run goalTaskCompletionPublication.qnt --main <instance> --init initD --step stepD \
  --invariant drainedDelivery --max-samples 5000 --max-steps 70 --seed 0x2a
```

| `before` | `fixedNoRepublisher` | `fixedNoHasWork` | `fixedStaleDeletionBlocks` | `fixedNoDedup` | `fixedUncheckedClear` | `fixed` |
|---|---|---|---|---|---|---|
| **violation** (69ms) | **violation** (178ms) | **violation** (215ms) | **violation** (838ms) | ok | ok | ok |

`fixedNoDedup` and `fixedUncheckedClear` are expected to pass here: duplicate wakes and stale clears are caught by `noDuplicateManagerWake` and `noUnrecoverableLoss`, not by a progress check. Those `ok` cells record what the command and seed above found: they are a sample of that seed, not a proof that no violation exists (another seed or a longer trace may find one). In particular, `fixedUncheckedClear` is still expected to violate `noUnrecoverableLoss`; only its `drainedDelivery` is outside the reach of a progress check.

`fixed` with witnesses and three seeds (`--max-samples 10000 --max-steps 70`):

```sh
quint run goalTaskCompletionPublication.qnt --main fixed --init initD --step stepD \
  --invariant drainedDelivery --witnesses wDrainedWoke wDrainedDaemonOnlyWoke wDrainedSettledExit wDrainedPausedUnresolved \
  --max-samples 10000 --max-steps 70 --seed 0x2a
```

- `--seed 0x2a`: `[ok] No violation found (24377ms)`. Witnesses: `wDrainedWoke` 1,202 (12.02%), `wDrainedDaemonOnlyWoke` 191 (1.91%), `wDrainedSettledExit` 15 (0.15%), `wDrainedPausedUnresolved` 0.
- `--seed 0x1`: `[ok] No violation found (24174ms)`. Witnesses: `wDrainedWoke` 1,208 (12.08%), `wDrainedDaemonOnlyWoke` 189 (1.89%), `wDrainedSettledExit` 15 (0.15%), `wDrainedPausedUnresolved` 0.
- `--seed 0xbeef`: `[ok] No violation found (23438ms)`. Witnesses: `wDrainedWoke` 1,203 (12.03%), `wDrainedDaemonOnlyWoke` 193 (1.93%), `wDrainedSettledExit` 15 (0.15%), `wDrainedPausedUnresolved` 0.

`wDrainedPausedUnresolved` documents the `Paused` distinction: a goal still `Paused` after the bound is observed, not counted as delivery, and not a violation. It was not reached at this bound on these seeds, because once the other progress actions are exhausted `resumeGoal` is the only one left and the drain takes it.

### Action ablations (P1–P3)

These probes remove the work of one action and leave the `DESIGN` flags and guard helpers unchanged. They are not `DESIGN` variants; `actionAblations.sh` applies each one-line edit to a copy of the model. P1 removes the advance instead of the guard: with the drain clock now ticking only on progress actions, a probe that disables the guard would freeze the drain rather than strand the notice, so P1 keeps `republisherAccepts` and makes `daemonReadPending` leave `daemon` unchanged.

| Probe | Edit | `safety` (10k/20) | `quiescentDelivery` (10k/20) | `drainedDelivery` (5k/70) |
|---|---|---|---|---|
| P1 | `daemonReadPending` keeps its guard but never advances (`daemon' = daemon`; `republisherAccepts` unchanged) | ok | ok | **violation** (193ms) |
| P2 | `daemonPublishOk` always takes the skip-inbox branch, then the mark is cleared | **violation** (182ms) | **violation** (157ms) | **violation** (258ms) |
| P3 | `daemonClearOk` keeps the mark (`tasks' = tasks`) | ok | ok | **violation** (212ms) |

```sh
sh actionAblations.sh [work-dir]
```

### `fixed`: simulation and witness coverage

```sh
quint run goalTaskCompletionPublication.qnt --main fixed --invariant safety \
  --witnesses wSetupFailWoke wInterruptedFailWoke wReconcileFailWoke wReconcileWithoutRunSlugWoke wDaemonRepublished wDaemonSoleRepublishWoke wSecondAttemptWoke wDeferredDelivered wAbortedSettled wDeletedSettled wDeletionReserved wStaleDeletionRecovered wDaemonIdleExitedAfterSettle \
  --max-samples 10000 --max-steps 20 --seed 0x2a
```

Result: `[ok] No violation found (6061ms at 1650 traces/second)`. All 13 witnesses reached:

| Witness | Reached traces (out of 10,000) |
|---|---|
| `wSetupFailWoke` | 295 (2.95%) |
| `wInterruptedFailWoke` | 143 (1.43%) |
| `wReconcileFailWoke` | 146 (1.46%) |
| `wReconcileWithoutRunSlugWoke` | 76 (0.76%) |
| `wDaemonRepublished` | 138 (1.38%) |
| `wDaemonSoleRepublishWoke` | 14 (0.14%) |
| `wSecondAttemptWoke` | 20 (0.20%) |
| `wDeferredDelivered` | 59 (0.59%) |
| `wAbortedSettled` | 209 (2.09%) |
| `wDeletedSettled` | 1,636 (16.36%) |
| `wDeletionReserved` | 4,398 (43.98%) |
| `wStaleDeletionRecovered` | 346 (3.46%) |
| `wDaemonIdleExitedAfterSettle` | 627 (6.27%) |

`wDaemonRepublished` requires both `daemonRepublished.contains(p)` and `wakes.get(p) == 1` for the same attempt `p`; being the last action (`daemonClearOk`) or waking a different attempt is not enough. `wReconcileWithoutRunSlugWoke` also covers the adoption path (`adoptLegacyRunningTask` then `writeReconcileFailure`), where the issued `execution_id` is what makes the resend possible.

Multi-seed stress test on `fixed` (`--invariant safety --max-samples 20000 --max-steps 25`):

- `--seed 0x2a`: `[ok] No violation found (11110ms)`
- `--seed 0x1`: `[ok] No violation found (10944ms)`
- `--seed 0xbeef`: `[ok] No violation found (11076ms)`

### Scenario tests

```sh
quint test goalTaskCompletionPublication_test.qnt --main beforeTest                   # 4 passing
quint test goalTaskCompletionPublication_test.qnt --main fixedNoRepublisherTest       # 2 passing
quint test goalTaskCompletionPublication_test.qnt --main fixedNoHasWorkTest           # 1 passing
quint test goalTaskCompletionPublication_test.qnt --main fixedStaleDeletionBlocksTest # 1 passing
quint test goalTaskCompletionPublication_test.qnt --main fixedNoDedupTest             # 1 passing
quint test goalTaskCompletionPublication_test.qnt --main fixedUncheckedClearTest      # 1 passing
quint test goalTaskCompletionPublication_test.qnt --main fixedTest                    # 12 passing
```

Total: 22 passing.

## When to update

Update this model and rerun `quint typecheck`, `quint test`, `quint run` (both `safety` and `drainedDelivery`), and `actionAblations.sh` before changing:

- how `completion_publication_pending` is written, normalized, or cleared in `tasks.yaml`,
- the guard of any drain progress action: the guards are mirrored in `drainProgressPossible`; a condition added to one of those actions must be added there too, or the drain can freeze (this is why the P1 ablation removes the action's advance instead of disabling its guard),
- how `FileDaemonWatchSource` (`hasWork`, `taskCompletions`) / `publishPendingGoalTaskCompletions` republishes pending completions or handles idle exit (including the order in which `hasWork` reads pending marks and the inbox),
- how `receiveInboxChange` computes the `eventId` of `kind: 'completion'` events, or
- how `requeueTask` / `requeueExceededTask` / task deletion (live vs dead owner) / goal abort interact with `completion_publication_pending`.

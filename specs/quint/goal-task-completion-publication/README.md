# Goal task completion publication

A Quint model of durable outbox publication for goal task completion notices ([j5ik2o/takt#170](https://github.com/j5ik2o/takt/issues/170)).
Covers the three failure/recovery paths that save a goal task as `failed` with `completion` in `.takt/tasks.yaml` and then notify the manager through `manager-inbox/`:

1. Setup failures in `claimNextTasks` (`src/infra/task/taskLifecycleService.ts`, `src/features/tasks/execute/claimTasks.ts`)
2. Interrupted running task recovery in `failInterruptedRunningTasks` (`src/infra/task/taskLifecycleService.ts`, `src/features/tasks/execute/claimTasks.ts`)
3. Lost-run reconciliation in `reconcileLostRun` (`src/features/daemonTurn/reconcileLostRun.ts`)

Design: `docs/design/goal-task-completion-publication.md`.

| File | Content |
|---|---|
| `goalTaskCompletionPublication.qnt` | The model. `DESIGN` selects one of seven variants (`Before`, five single-ablation negative controls, and `Fixed`). Concrete instances are at the bottom of the file. |
| `goalTaskCompletionPublication_test.qnt` | Scenario tests: counterexamples on `before`, `fixedNoRepublisher`, `fixedNoHasWork`, `fixedStaleDeletionBlocks`, `fixedNoDedup`, and `fixedUncheckedClear`, plus recovery/dedup/idle-exit/stale-deletion scenarios on `fixed`. |

## What is modelled

- **Tasks (`.takt/tasks.yaml`)**: Two goal tasks (`t1`, `t2`), each up to `MAX_ATTEMPTS = 2` attempts across requeue. Each task tracks `status` (`Absent | Pending | Running | Failed`), `attempt`, `hasCompletion`, `pendingPub` (`completion_publication_pending`), `deletion` (`DelNone | DelAlive | DelDead`), `hasRunSlug`, and `hasExecId`.
- **Writers**:
  - `writeSetupFailure`: `Pending` -> `Failed` directly (only when `goal == Active`), sets `hasRunSlug = true`, `hasExecId = true`, and `pendingPub = usesOutbox(DESIGN)`.
  - `writeInterruptedFailure`: `Running` -> `Failed`, ensures `hasRunSlug = true`, sets `pendingPub = usesOutbox(DESIGN)`.
  - `writeReconcileFailure`: `Running` -> `Failed`, preserves `hasRunSlug` (may be `false` if the worker died before `updateRunningTaskExecution`), and in `Fixed*` ensures `hasExecId = true` when `hasRunSlug == false`.
  - Post-write steps: `writerPublishOk` (writes inbox file unless `goal == Aborted`, fails on `Deleted`), `writerPublishFails` (ENOSPC / unreadable `goal.json`), `writerCrash` (process death before publish or before clear), `writerClearOk` (via `TaskStore.update`, which clears stale `DelDead` reservations before clearing `pendingPub`), `writerClearFails`.
- **Daemon outbox republisher & idle lifecycle** (`FileDaemonWatchSource.hasWork` + `taskCompletions` + `publishPendingGoalTaskCompletions`):
  - `daemonRunning`: starts `true`; all daemon republish, inbox consumption, and deferred delivery actions require `daemonRunning == true`.
  - `daemonHasWork`: `true` when `goal == Active | Paused`, `inbox` is non-empty, any task is `Pending | Running`, or (when `usesPendingHasWork(DESIGN)`) any task has `pendingPub == true` (including tasks with a `deletion` reservation, so daemon waits for deletion finish/cancel/crash).
  - `daemonIdleExit`: when `daemonRunning`, `daemon.phase == DaemonIdle`, and `not(daemonHasWork)`, stops the daemon (`daemonRunning' = false`).
  - `daemonReadPending` (active when `usesRepublisher(DESIGN)`): picks a `Failed` task with `hasCompletion`, `pendingPub`, non-blocking `deletion` (`DelAlive` blocks; `DelDead` is recovered when `usesStaleDeletionRecovery(DESIGN)`), and `hasRunSlug or hasExecId`.
  - `daemonPublishOk`: checks `goal.json`; writes an inbox file when `goal == Active | Paused`, or skips inbox write when `goal == Aborted | Deleted`.
  - `daemonPublishFails`: transient error reading `goal.json` or writing inbox; leaves `pendingPub` set.
  - `daemonClearOk`: acquires `tasks.yaml.lock` and clears `pendingPub` (and any stale `DelDead` reservation) if `status == Failed`, `pendingPub == true`, `deletion` is non-blocking, and (when `usesCheckedClear(DESIGN)`) `attempt == expectedAttempt`.
  - `daemonClearFails`: lock timeout / ENOSPC / daemon restart; leaves `pendingPub` set.
- **Inbox consumer** (`receiveInboxChange` + `FileEventStore.accept` + `conversationService`):
  - `consumeInbox`: removes one inbox file, computes `eventKeyFor(DESIGN, f)`, inserts into durable `acceptedKeys`. On a new key: increments `wakes[(task, attempt)]` if `goal == Active`, inserts into `deferred` if `goal == Paused`, discards if `goal == Aborted | Deleted`. Duplicates are ignored.
  - `deliverDeferred`: delivers a deferred completion once `goal` resumes to `Active`.
- **Concurrent lifecycle**: `startTask`, `requeueTask`, `reserveDeletion` / `cancelDeletion` / `deletionOwnerCrash` / `finishDeletion`, `pauseGoal`, `resumeGoal`, `abortGoal` (clears `inbox` and `deferred`), `deleteGoal`.

| `DESIGN` | Meaning |
|---|---|
| `Before` | Current code: no `completion_publication_pending`, no daemon republisher, no pending `hasWork`, per-file random `inbox-<hash>` eventId. |
| `FixedNoRepublisher` | Full design except daemon republishing (`daemonReadPending`) is disabled. Proves `noUnrecoverableLoss` alone does not verify delivery and that `quiescentDelivery` catches missing delivery. |
| `FixedNoHasWork` | Full design except `daemonHasWork` ignores `pendingPub`. Proves daemon can idle-exit while `pendingPub` remains unsettled. |
| `FixedStaleDeletionBlocks` | Full design except daemon treats `DelDead` as blocking instead of inspecting process liveness. Proves a dead deletion owner strands `pendingPub`. |
| `FixedNoDedup` | Full design except per-file random `eventId`. Proves deterministic `eventId` is required. |
| `FixedUncheckedClear` | Full design except clear ignores attempt identity. Proves attempt-matched clearing is required. |
| `Fixed` | Full design: durable `completion_publication_pending`, daemon republisher, `hasWork` covering pending marks, stale-deletion recovery, deterministic `eventId` (`runSlug` or `executionId`), attempt-matched clear, live-deletion guard, and aborted/deleted goal settlement. |

### Not modelled

- **Attempt-key uniqueness and writer/daemon key agreement**: `RunKey((task, attempt))` and `ExecKey((task, attempt))` key directly on `(task, attempt)`. The model therefore takes as a premise that (a) each attempt generates a unique `run_slug` / `execution_id` and (b) the writer and daemon derive the exact same `eventId` from the same `tasks.yaml` record. In the real implementation, these load-bearing premises are verified by PBT 1 (`eventId` determinism/injectivity) and the writer/daemon integration tests.
- **Multiple concurrent writers or multiple daemon instances**: the model has one writer state and one daemon state; tasks are independent and `.takt/tasks.yaml.lock` serializes writes, so multi-writer interleavings on different tasks reduce to the modelled transitions.
- **Goal `completed` status and direct goal deletion from `Active`**: `isGoalFinished` also treats `goal.status === 'completed'` as finished, and manual deletion can remove a goal directory directly from `Active` rather than only after `Aborted`. Both follow the same `Aborted`/`Deleted` settlement path (skip inbox, clear `pendingPub`).
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
| `quiescentDelivery` | For every task `t` with no enabled recovery, delivery, or live-deletion step (`not(taskRecoveryEnabled)` — without assuming `not(pendingPub)`): under `Active`, `Failed` with `completion` implies `wakes >= 1`; under `Paused`, `wakes >= 1` or `deferred`; under `Aborted`/`Deleted`, `not(pendingPub)`. |

`safety` is the conjunction of all seven. Every negative control fails at least one invariant (`noDuplicateManagerWake`, `noUnrecoverableLoss`, `noDaemonExitWithWork`, or `quiescentDelivery`), proving none of the design mechanisms or properties is vacuous.

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
| `noDuplicateManagerWake` | ok | ok | ok | ok | **violation** (182ms) | ok | ok |
| `noUnrecoverableLoss` | **violation** (82ms) | ok | ok | ok | ok | **violation** (10,105ms at 50k/25) | ok |
| `pendingPubSchemaValid` | ok | ok | ok | ok | ok | ok | ok |
| `noPhantomWake` | ok | ok | ok | ok | ok | ok | ok |
| `noDeferredWhenAbortedOrDeleted` | ok | ok | ok | ok | ok | ok | ok |
| `noDaemonExitWithWork` | ok | ok | **violation** (70ms) | ok | ok | ok | ok |
| `quiescentDelivery` | **violation** (71ms) | **violation** (60ms) | **violation** (71ms) | **violation** (46ms) | ok | **violation** (7,824ms at 50k/25) | ok |

Note the `fixedNoRepublisher` column: `noUnrecoverableLoss` passes (confirming the design review finding that checking only durable marks misses a missing republisher), whereas `quiescentDelivery` detects the violation in 60ms.

### `fixed`: simulation and witness coverage

```sh
quint run goalTaskCompletionPublication.qnt --main fixed --invariant safety \
  --witnesses wSetupFailWoke wInterruptedFailWoke wReconcileFailWoke wReconcileWithoutRunSlugWoke wDaemonRepublished wDaemonSoleRepublishWoke wSecondAttemptWoke wDeferredDelivered wAbortedSettled wDeletedSettled wDeletionReserved wStaleDeletionRecovered wDaemonIdleExitedAfterSettle \
  --max-samples 10000 --max-steps 20 --seed 0x2a
```

Result: `[ok] No violation found (11872ms at 842 traces/second)`. All 13 witnesses reached:

| Witness | Reached traces (out of 10,000) |
|---|---|
| `wSetupFailWoke` | 344 (3.44%) |
| `wInterruptedFailWoke` | 88 (0.88%) |
| `wReconcileFailWoke` | 79 (0.79%) |
| `wReconcileWithoutRunSlugWoke` | 29 (0.29%) |
| `wDaemonRepublished` | 84 (0.84%) |
| `wDaemonSoleRepublishWoke` | 13 (0.13%) |
| `wSecondAttemptWoke` | 25 (0.25%) |
| `wDeferredDelivered` | 45 (0.45%) |
| `wAbortedSettled` | 148 (1.48%) |
| `wDeletedSettled` | 1,446 (14.46%) |
| `wDeletionReserved` | 3,752 (37.52%) |
| `wStaleDeletionRecovered` | 307 (3.07%) |
| `wDaemonIdleExitedAfterSettle` | 437 (4.37%) |

Multi-seed stress test on `fixed` (`--invariant safety --max-samples 20000 --max-steps 25`):

- `--seed 0x2a`: `[ok] No violation found (21003ms at 952 traces/second)`
- `--seed 0x1`: `[ok] No violation found (20064ms at 997 traces/second)`
- `--seed 0xbeef`: `[ok] No violation found (14516ms at 1378 traces/second)`

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

Update this model and rerun `quint typecheck`, `quint test`, and `quint run` before changing:

- how `completion_publication_pending` is written, normalized, or cleared in `tasks.yaml`,
- how `FileDaemonWatchSource` (`hasWork`, `taskCompletions`) / `publishPendingGoalTaskCompletions` republishes pending completions or handles idle exit,
- how `receiveInboxChange` computes the `eventId` of `kind: 'completion'` events, or
- how `requeueTask` / `requeueExceededTask` / task deletion (live vs dead owner) / goal abort interact with `completion_publication_pending`.

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
  - `writeReconcileFailure`: `Running` -> `Failed`, preserves `hasRunSlug` (may be `false` if the worker died before `updateRunningTaskExecution`), and in `Fixed*` ensures `hasExecId = true` when `hasRunSlug == false`.
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
- **Concurrent lifecycle**: `startTask`, `requeueTask`, `reserveDeletion` / `cancelDeletion` / `deletionOwnerCrash` / `finishDeletion`, `pauseGoal`, `resumeGoal`, `abortGoal` (clears `inbox` and `deferred`), `deleteGoal`.

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

`quiescentDelivery` has a limit. `taskRecoveryEnabled` copies the action guards (for example `republisherAccepts`), so it only says "if no guard holds, the notice was delivered". It does not see an action that keeps its guard but stops doing its work. Action ablations P1 (`daemonReadPending` never fires) and P3 (`daemonClearOk` keeps the mark) pass all of `safety`. A separate property checks the effect of the actions:

| Name | Meaning |
|---|---|
| `drainedDelivery` | Runs with `--init initD --step stepD`. `stepD` runs `step` until it nondeterministically enters a drain phase. In the drain, failures and outside changes stop, and only forward progress actions run (`writerPublishOk`, `writerClearOk`, `daemonReadPending`, `daemonPublishOk`, `daemonClearOk`, `daemonIdleExit`, `consumeAnyInbox`, `deliverAnyDeferred`, `cancelDeletion`, `finishDeletion`, `deletionOwnerCrash`, `resumeGoal`), each step possibly stuttering. After `DRAIN_STEPS = 40` drain steps, every `Failed` task with `completion` under an `Active` goal has `wakes >= 1`, and no `pendingPub` remains under `Aborted`/`Deleted`. |

This is a bounded progress check under simulation, not a proof of liveness. Because a drain step may stutter, an unlucky schedule could in principle leave work undone after 40 steps; `fixed` showed no such case in the runs below.

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
| `noDuplicateManagerWake` | ok | ok | ok | ok | **violation** (93ms) | ok | ok |
| `noUnrecoverableLoss` | **violation** (33ms) | ok | ok | ok | ok | **violation** (4,192ms at 50k/25) | ok |
| `pendingPubSchemaValid` | ok | ok | ok | ok | ok | ok | ok |
| `noPhantomWake` | ok | ok | ok | ok | ok | ok | ok |
| `noDeferredWhenAbortedOrDeleted` | ok | ok | ok | ok | ok | ok | ok |
| `noDaemonExitWithWork` | ok | ok | **violation** (38ms) | ok | ok | ok | ok |
| `quiescentDelivery` | **violation** (32ms) | **violation** (34ms) | **violation** (39ms) | **violation** (36ms) | ok | **violation** (4,634ms at 50k/25) | ok |

Note the `fixedNoRepublisher` column: `noUnrecoverableLoss` passes (checking only durable marks misses a missing republisher). `quiescentDelivery` fails, but only because the `usesRepublisher` flag also enters the guard expression that the property reads (see the limit above).

### `drainedDelivery` against each instance

```sh
quint run goalTaskCompletionPublication.qnt --main <instance> --init initD --step stepD \
  --invariant drainedDelivery --max-samples 5000 --max-steps 70 --seed 0x2a
```

| `before` | `fixedNoRepublisher` | `fixedNoHasWork` | `fixedStaleDeletionBlocks` | `fixedNoDedup` | `fixedUncheckedClear` | `fixed` |
|---|---|---|---|---|---|---|
| **violation** (69ms) | **violation** (96ms) | **violation** (1,343ms) | **violation** (254ms) | ok | ok | ok |

`fixedNoDedup` and `fixedUncheckedClear` are expected to pass here: duplicate wakes and stale clears are caught by `noDuplicateManagerWake` and `noUnrecoverableLoss`, not by a progress check.

`fixed` with witnesses and three seeds (`--max-samples 10000 --max-steps 70`):

```sh
quint run goalTaskCompletionPublication.qnt --main fixed --init initD --step stepD \
  --invariant drainedDelivery --witnesses wDrainedWoke wDrainedDaemonOnlyWoke wDrainedSettledExit \
  --max-samples 10000 --max-steps 70 --seed 0x2a
```

- `--seed 0x2a`: `[ok] No violation found (19661ms)`. Witnesses: `wDrainedWoke` 1,353 (13.53%), `wDrainedDaemonOnlyWoke` 190 (1.90%), `wDrainedSettledExit` 10 (0.10%).
- `--seed 0x1`: `[ok] No violation found (18618ms)`
- `--seed 0xbeef`: `[ok] No violation found (18759ms)`

### Action ablations (P1–P3)

These probes remove the work of one action and leave the `DESIGN` flags and guard helpers unchanged. They are not `DESIGN` variants; `actionAblations.sh` applies each one-line edit to a copy of the model.

| Probe | Edit | `safety` (10k/20) | `quiescentDelivery` (10k/20) | `drainedDelivery` (5k/70) |
|---|---|---|---|---|
| P1 | `daemonReadPending` gets an extra `false` guard (`republisherAccepts` unchanged) | ok | ok | **violation** (95ms) |
| P2 | `daemonPublishOk` always takes the skip-inbox branch, then the mark is cleared | **violation** (132ms) | **violation** (121ms) | **violation** (55ms) |
| P3 | `daemonClearOk` keeps the mark (`tasks' = tasks`) | ok | ok | **violation** (244ms) |

```sh
sh actionAblations.sh [work-dir]
```

### `fixed`: simulation and witness coverage

```sh
quint run goalTaskCompletionPublication.qnt --main fixed --invariant safety \
  --witnesses wSetupFailWoke wInterruptedFailWoke wReconcileFailWoke wReconcileWithoutRunSlugWoke wDaemonRepublished wDaemonSoleRepublishWoke wSecondAttemptWoke wDeferredDelivered wAbortedSettled wDeletedSettled wDeletionReserved wStaleDeletionRecovered wDaemonIdleExitedAfterSettle \
  --max-samples 10000 --max-steps 20 --seed 0x2a
```

Result: `[ok] No violation found (5793ms at 1726 traces/second)`. All 13 witnesses reached:

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

- `--seed 0x2a`: `[ok] No violation found (10500ms)`
- `--seed 0x1`: `[ok] No violation found (11210ms)`
- `--seed 0xbeef`: `[ok] No violation found (10532ms)`

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
- how `FileDaemonWatchSource` (`hasWork`, `taskCompletions`) / `publishPendingGoalTaskCompletions` republishes pending completions or handles idle exit (including the order in which `hasWork` reads pending marks and the inbox),
- how `receiveInboxChange` computes the `eventId` of `kind: 'completion'` events, or
- how `requeueTask` / `requeueExceededTask` / task deletion (live vs dead owner) / goal abort interact with `completion_publication_pending`.

# Goal task completion publication

A Quint model of durable outbox publication for goal task completion notices ([j5ik2o/takt#170](https://github.com/j5ik2o/takt/issues/170)).
Covers the three failure/recovery paths that save a goal task as `failed` with `completion` in `.takt/tasks.yaml` and then notify the manager through `manager-inbox/`:

1. Setup failures in `claimNextTasks` (`src/infra/task/taskLifecycleService.ts`, `src/features/tasks/execute/claimTasks.ts`)
2. Interrupted running task recovery in `failInterruptedRunningTasks` (`src/infra/task/taskLifecycleService.ts`, `src/features/tasks/execute/claimTasks.ts`)
3. Lost-run reconciliation in `reconcileLostRun` (`src/features/daemonTurn/reconcileLostRun.ts`)

Design: `docs/design/goal-task-completion-publication.md`.

| File | Content |
|---|---|
| `goalTaskCompletionPublication.qnt` | The model. `DESIGN` selects one of four variants (`Before`, `FixedNoDedup`, `FixedUncheckedClear`, `Fixed`). Concrete instances are at the bottom of the file. |
| `goalTaskCompletionPublication_test.qnt` | Scenario tests: counterexamples on `before`, `fixedNoDedup`, and `fixedUncheckedClear`, and recovery/dedup/lifecycle scenarios on `fixed`. |

## What is modelled

- **Tasks (`.takt/tasks.yaml`)**: Two goal tasks (`t1`, `t2`), each up to `MAX_ATTEMPTS = 2` attempts across requeue. Each task tracks `status` (`Absent | Pending | Running | Failed`), `attempt`, `hasCompletion`, `pendingPub` (`completion_publication_pending`), `deleting` (`task.deletion` reservation), `hasRunSlug`, and `hasExecId`.
- **Writers**:
  - `writeSetupFailure`: `Pending` -> `Failed` directly (only when `goal == Active`), sets `hasRunSlug = true`, `hasExecId = true`, and `pendingPub = usesOutbox(DESIGN)`.
  - `writeInterruptedFailure`: `Running` -> `Failed`, ensures `hasRunSlug = true`, sets `pendingPub = usesOutbox(DESIGN)`.
  - `writeReconcileFailure`: `Running` -> `Failed`, preserves `hasRunSlug` (may be `false` if the worker died before `updateRunningTaskExecution`), and in `Fixed*` ensures `hasExecId = true` when `hasRunSlug == false`.
  - Post-write steps: `writerPublishOk` (writes inbox file unless `goal == Aborted`, fails on `Deleted`), `writerPublishFails` (ENOSPC / unreadable `goal.json`), `writerCrash` (process death before publish or before clear), `writerClearOk`, `writerClearFails`.
- **Daemon outbox republisher** (`FileDaemonWatchSource.taskCompletions` + `publishPendingGoalTaskCompletions`, active when `DESIGN != "Before"`):
  - `daemonReadPending`: picks a `Failed` task with `hasCompletion`, `pendingPub`, `not(deleting)`, and `hasRunSlug or hasExecId`.
  - `daemonPublishOk`: checks `goal.json`; writes an inbox file when `goal == Active | Paused`, or skips inbox write when `goal == Aborted | Deleted`.
  - `daemonPublishFails`: transient error reading `goal.json` or writing inbox; leaves `pendingPub` set.
  - `daemonClearOk`: acquires `tasks.yaml.lock` and clears `pendingPub` if `status == Failed`, `pendingPub == true`, `not(deleting)`, and (when `usesCheckedClear(DESIGN)`) `attempt == expectedAttempt`.
  - `daemonClearFails`: lock timeout / ENOSPC / daemon restart; leaves `pendingPub` set.
- **Inbox consumer** (`receiveInboxChange` + `FileEventStore.accept` + `conversationService`):
  - `consumeInbox`: removes one inbox file, computes `eventKeyFor(DESIGN, f)`, inserts into durable `acceptedKeys`. On a new key: increments `wakes[(task, attempt)]` if `goal == Active`, inserts into `deferred` if `goal == Paused`, discards if `goal == Aborted | Deleted`. Duplicates are ignored.
  - `deliverDeferred`: delivers a deferred completion once `goal` resumes to `Active`.
- **Concurrent lifecycle**: `startTask`, `requeueTask`, `reserveDeletion` / `cancelDeletion` / `finishDeletion`, `pauseGoal`, `resumeGoal`, `abortGoal` (clears `inbox` and `deferred`), `deleteGoal`.

| `DESIGN` | Meaning |
|---|---|
| `Before` | Current code: no `completion_publication_pending`, no daemon republisher, per-file random `inbox-<hash>` eventId. |
| `FixedNoDedup` | Adds `completion_publication_pending` and daemon republisher, but keeps per-file random `eventId`. Shows why deterministic `eventId` is required. |
| `FixedUncheckedClear` | Adds outbox + dedup, but clears `completion_publication_pending` by task name without matching attempt identity. Shows why attempt-matched clearing is required. |
| `Fixed` | Full design: durable `completion_publication_pending`, daemon republisher, deterministic `eventId` (`runSlug` or `executionId`), attempt-matched clear, deletion-reservation guard, and aborted/deleted goal settlement. |

### Not modelled

- Normal task execution completions (`completeTask`, `failTask`, `exceedTask`, `prFailTask` in `parallelExecution.ts`), which are out of scope for #170.
- `task_finish_hook` execution (`specs/quint/goal-task-claim/` models `hooks` for claim setup failures).
- Low-level lock contention / timeouts (`tasks.yaml.lock` and `goal-execution.lock` acquisition failures are abstracted as `writerClearFails` / `daemonClearFails`; `goal-task-claim` models claim lock retries).
- Permanent disk corruption or unbounded permanent ENOSPC (liveness premise: once transient I/O errors stop, daemon ticks retry `pendingPub`).
- TOCTOU between daemon reading `goal.json` as `Active` and writing an inbox file while `abortGoal` runs concurrently: the model captures the post-inbox protection (`conversationService` discards events for `Aborted`/`Deleted` goals in `consumeInbox`), while treating `daemonPublishOk`'s `goal` check and inbox write as one step.

## Invariants

| Name | Meaning |
|---|---|
| `noDuplicateManagerWake` | Each `(task, attempt)` wakes the manager at most once (`wakes <= 1`). |
| `noUnrecoverableLoss` | Under an `Active` or `Paused` goal, every task currently `Failed` with `completion` is either already woken/deferred, in `inbox`, held by a live pre-publish writer, or durably marked `pendingPub` in `tasks.yaml`. |
| `pendingPubSchemaValid` | `pendingPub == true` only holds on a `Failed` task with `completion`, `attempt > 0`, and `hasRunSlug or hasExecId`. |
| `noPhantomWake` | The manager only wakes or defers for a `(task, attempt)` that was actually saved as `Failed`. |
| `noDeferredWhenAbortedOrDeleted` | No deferred completions remain once a goal is `Aborted` or `Deleted`. |

`safety` is the conjunction of all five. Note that `noDuplicateManagerWake` and `noUnrecoverableLoss` are the two invariants that separate the four designs; the other three verify schema consistency and model sanity.

## Record

Quint 0.32.0. Commands run from `specs/quint/goal-task-completion-publication/`.

### Each invariant against each instance

```sh
quint run goalTaskCompletionPublication.qnt --main <instance> --invariant <name> \
  --max-samples 3000 --max-steps 16 --seed 0x2a
```

Plus deeper check on `fixedUncheckedClear` (the stale-clear race requires a 7+ step requeue interleaving):

```sh
quint run goalTaskCompletionPublication.qnt --main fixedUncheckedClear \
  --invariant noUnrecoverableLoss --max-samples 50000 --max-steps 25 --seed 0x2a
```

| Invariant | `before` | `fixedNoDedup` | `fixedUncheckedClear` | `fixed` |
|---|---|---|---|---|
| `noDuplicateManagerWake` | ok | **violation** (341ms) | ok | ok |
| `noUnrecoverableLoss` | **violation** (25ms) | ok | **violation** (2,534ms at 50k/25 steps) | ok |
| `pendingPubSchemaValid` | ok | ok | ok | ok |
| `noPhantomWake` | ok | ok | ok | ok |
| `noDeferredWhenAbortedOrDeleted` | ok | ok | ok | ok |

### `fixed`: simulation and witness coverage

```sh
quint run goalTaskCompletionPublication.qnt --main fixed --invariant safety \
  --witnesses wSetupFailWoke wInterruptedFailWoke wReconcileFailWoke wReconcileWithoutRunSlugWoke wDaemonRepublished wSecondAttemptWoke wDeferredDelivered wAbortedSettled wDeletedSettled wDeletionReserved \
  --max-samples 10000 --max-steps 20 --seed 0x2a
```

Result: `[ok] No violation found (3029ms at 3301 traces/second)`. Trace lengths: min 3, max 21, average 8.36 (short traces end when both tasks are deleted/terminal and the goal is deleted). All 10 witnesses reached:

| Witness | Reached traces (out of 10,000) |
|---|---|
| `wSetupFailWoke` | 327 (3.27%) |
| `wInterruptedFailWoke` | 86 (0.86%) |
| `wReconcileFailWoke` | 87 (0.87%) |
| `wReconcileWithoutRunSlugWoke` | 30 (0.30%) |
| `wDaemonRepublished` | 75 (0.75%) |
| `wSecondAttemptWoke` | 20 (0.20%) |
| `wDeferredDelivered` | 61 (0.61%) |
| `wAbortedSettled` | 147 (1.47%) |
| `wDeletedSettled` | 626 (6.26%) |
| `wDeletionReserved` | 2,352 (23.52%) |

Multi-seed stress test on `fixed` (`--invariant safety --max-samples 20000 --max-steps 25`):

- `--seed 0x2a`: `[ok] No violation found (5636ms at 3549 traces/second)`
- `--seed 0x1`: `[ok] No violation found (5284ms at 3785 traces/second)`
- `--seed 0xbeef`: `[ok] No violation found (5157ms at 3878 traces/second)`

### Scenario tests

```sh
quint test goalTaskCompletionPublication_test.qnt --main beforeTest              # 4 passing
quint test goalTaskCompletionPublication_test.qnt --main fixedNoDedupTest        # 1 passing
quint test goalTaskCompletionPublication_test.qnt --main fixedUncheckedClearTest # 1 passing
quint test goalTaskCompletionPublication_test.qnt --main fixedTest               # 10 passing
```

Total: 16 passing.

## When to update

Update this model and rerun `quint typecheck`, `quint test`, and `quint run` before changing:

- how `completion_publication_pending` is written or cleared in `tasks.yaml`,
- how `FileDaemonWatchSource` / `publishPendingGoalTaskCompletions` republishes pending completions,
- how `receiveInboxChange` computes the `eventId` of `kind: 'completion'` events, or
- how `requeueTask` / `requeueExceededTask` / task deletion / goal abort interact with `completion_publication_pending`.

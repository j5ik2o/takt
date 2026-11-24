# Task finish hook

A Quint model of where the task finish hook is attached to the task completion path, and of what
the hook command may and may not change.

| File | Content |
|---|---|
| `taskFinishHook.qnt` | The model. `entryPoints` is the implementation; `normalEndOnly` and `everySave` are two placements that were rejected. |
| `taskFinishHook_test.qnt` | Scenario tests for each exit and for the two rejected placements. |

## What is modelled

- `executeTaskAndCompleteWithDetails` (`src/features/tasks/execute/taskExecution.ts`): the entry
  for every queued task, including a queued PR merge task.
- `executePrWorkflow` (`src/features/merge/index.ts`): the entry for `takt merge`, which runs the
  saved merge task without the queue's completion path.
- `withTaskFinishHook` (`src/features/tasks/execute/taskFinishHook.ts`): reads the saved state
  before and after the execution and calls the command for a newly saved terminal state.

One execution of one task is modelled. It leaves through one of eight exits (`Exit`), which saves
`completed`, `failed`, `exceeded` or `pr_failed`, or saves nothing when the save itself throws.
`resumePoint` stands for everything written with the terminal state. The hook command may end in
any of four ways (`HookOutcome`); none of them writes to the state.

`PLACEMENT` chooses where the hook call is attached:

| Placement | Meaning |
|---|---|
| `AtNormalEnd` | After the last `persistTaskResult` of the queue path only. |
| `AtEverySave` | Next to every terminal save, including the one inside `executePersistedPrMergeTask`, plus the queue entry. |
| `AtEntryPoints` | One wrapper around each of the two entry points (the implementation). |

Not modelled: terminal states saved without an execution (a `pr_failed` task published later, a
goal task that fails while it is claimed, pending tasks of an aborted goal) — the code calls the
command at each of those three save sites, outside both entry points, and `noMissedExit` says
nothing about them; a second execution of the same task (retry, requeue), another process changing the
task between the save and the hook's read, the content of the environment passed to the command,
and process-group termination at the timeout. The code tests in
`src/__tests__/it-task-finish-hook.test.ts` cover the environment, the timeout, and a task handed
in again after its terminal state was saved. This model was written with the implementation, not
before it: the two rejected placements are design alternatives, not code that existed.

## Invariants

| Name | Meaning |
|---|---|
| `atMostOnce` | The command runs at most once per execution. |
| `onlyAfterTerminalSave` | The command never runs before a terminal state is saved, and never without configuration. |
| `noMissedExit` | Every execution that saved a terminal state has called the command by the time it returns. |
| `savedStateUntouched` | Nothing after the terminal save, the command included, changes what the save wrote. |
| `slotHeldUntilReturn` | The caller's slot is held until the entry point returns, including while the command runs. |

`safety` is the conjunction of all five. `slotHeldUntilReturn` records a cost, not a goal: a
command that hangs occupies the slot until its timeout.

## Record

Quint 0.32.0. Commands run from this directory.

### Rejected placement `AtNormalEnd`: counterexample

```sh
quint run taskFinishHook.qnt --main normalEndOnly --invariant safety --max-steps 12 --seed 0x8d
```

Result: `[violation]`. The violated conjunct is `noMissedExit`.

| State | `entry` | `exit` | `status` | `phase` | `hookRuns` |
|---|---|---|---|---|---|
| 0 | `DirectMerge` | - | `Running` | `Executing` | 0 |
| 1 | `DirectMerge` | `ThrownError` | `Failed` | `Saved` | 0 |
| 2 | `DirectMerge` | `ThrownError` | `Failed` | `Returned` | 0 |

A failed `takt merge` saves `failed` and returns without calling the command. The same placement
also misses `exceeded`, `pr_failed`, interruptions and errors of queued tasks
(`exceededIsMissedTest`).

### Rejected placement `AtEverySave`: counterexample

```sh
quint run taskFinishHook.qnt --main everySave --invariant safety --max-steps 12 --seed 0x224
```

Result: `[violation]`. The violated conjunct is `atMostOnce`: a queued merge task
(`entry = QueueMergeTask`, `exit = Interrupted`) reaches `hookRuns = 2`, once at the save inside
`executePersistedPrMergeTask` and once at the queue entry.

### Implemented placement `AtEntryPoints`

```sh
quint run taskFinishHook.qnt --main entryPoints --invariant safety \
  --witnesses hookRanForExceeded hookRanForPrFailed hookRanForDirectMerge hookRanForInterrupted returnedWithoutSave \
  --max-samples 10000 --max-steps 12 --seed 0x2a
```

Result: 10,000 samples, max-steps 12, seed 0x2a, no violation of `safety`. Traces have 13 states;
an execution finishes within 4 steps and then stutters, so the short traces are not a deadlock.

Witnesses reached (traces out of 10,000): `hookRanForExceeded` 188, `hookRanForPrFailed` 204,
`hookRanForDirectMerge` 1,258, `hookRanForInterrupted` 1,424, `returnedWithoutSave` 2,082. Under
`normalEndOnly` with the same parameters, `hookRanForExceeded` and `hookRanForDirectMerge` are
reached in 0 traces.

### Scenario tests

```sh
quint test taskFinishHook_test.qnt --main entryPointsTest     # 9 passing
quint test taskFinishHook_test.qnt --main normalEndOnlyTest   # 1 passing
quint test taskFinishHook_test.qnt --main everySaveTest       # 1 passing
```

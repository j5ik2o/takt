# Task finish hook

A Quint model of where the task finish hook is attached to the task completion path, and of what
the hook command may and may not change.

| File | Content |
|---|---|
| `taskFinishHook.qnt` | The model. `entryPoints` is the implementation; `normalEndOnly` and `everySave` are two placements that were rejected. |
| `taskFinishHook_test.qnt` | Scenario tests for each exit and for the two rejected placements. |
| `taskFinishHookNotice.qnt` | #171: the configuration/read prelude of `runTaskFinishHooks` and `runTaskFinishHooksForStates`, the bounded read retry, and the loss notice. |
| `taskFinishHookNotice_test.qnt` | Scenario tests for the notice model: retry success, exhausted retry, broken read, missing configuration, handed-over states, and the rejected silent/unbounded forms. |

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

## Notice loss (#171)

Design: `docs/design/task-finish-hook-notice-loss.md`.

`taskFinishHook.qnt` above answers where the hook is attached and whether it may change the saved
state. It leaves out the read of `tasks.yaml` and of the project configuration. #171 is about that
prelude: `runTaskFinishHooks` reads `tasks.yaml` itself, and a lock timeout, a broken file, or an
unreadable `config.yaml` used to leave only `log.error`, which is written only when
`logging.debug` is enabled. `taskFinishHookNotice.qnt` models one invocation and one task:

- `Path = NamedHook | StatesHook`. `NamedHook` is `runTaskFinishHooks` (it reads `tasks.yaml` after
  the caller saved a terminal state). `StatesHook` is `runTaskFinishHooksForStates` (#169; the
  caller hands the states over, so only the configuration is read).
- `Config = ConfigOk | ConfigMissing | ConfigUnreadable`. `ConfigMissing` is not a loss: no hook
  was configured.
- `Read = ReadOk | ReadNotTerminal | ReadTimeout | ReadBroken`. Only `ReadTimeout` is retried.
  `ReadNotTerminal` is a task another process moved on (retry/requeue); this model calls it not a
  loss for this invocation. `sawNotTerminal` records that the transition happened, so the
  `wReadNotTerminalNoNotice` witness is not also satisfied by `ConfigMissing`.
- `NOTICE = Silent | Fixed`. `Silent` is the old `log.error` only; `Fixed` is one `warn()` with the
  task names. `RETRY = None | Bounded | Unbounded`. `Bounded` is `MAX_READ_ATTEMPTS = 2` and
  `MAX_RETRIES = 1` (one wait); `Unbounded` is the rejected alternative.

`safety` is the conjunction of `noUnnoticedLoss`, `noFalseNotice`, `noticeAtMostOnce`,
`retryBounded`, `retriesTimeouts`, `noHookOnLoss`, and `atMostOnceHook`. `retriesTimeouts` is
about the post-save read modeled here (`runTaskFinishHooks`, `NamedHook`); the design applies the
same retry to `runHook`'s post-execution read, which is not modelled. The pre-execution stamp read
of `withTaskFinishHook` is outside the model and is not retried. `noHookOnLoss` is the modeled part of the design's
`noSilentLossOrUnconfirmedRun`; the at-least-once warning when the pre-read was unreadable is
outside the model. The "once" in `noUnnoticedLoss` and `noticeAtMostOnce` is once per invocation;
the model has no state that deduplicates calls separated in time. The model does not include the hook command outcome (#148's
`HookOutcome` does), the `terminalStamp` pre/post read, `callHook` rejection, the warning when the
pre-read was unreadable, multiple task names in one warning, the exact lock wait, or concurrent
processes. Those are covered by the code tests and PBT in the design document; they are not
modelled by #148 either.

### Notice model: records and counterexamples

Quint 0.32.0. Commands run from this directory.

```sh
quint typecheck taskFinishHookNotice.qnt
quint typecheck taskFinishHookNotice_test.qnt
quint test taskFinishHookNotice_test.qnt --main noticeFixedTest     # 9 passing
quint test taskFinishHookNotice_test.qnt --main noticeBeforeTest    # 2 passing
quint test taskFinishHookNotice_test.qnt --main noticeNoRetryTest   # 1 passing
quint test taskFinishHookNotice_test.qnt --main noticeUnboundedTest # 1 passing
```

Rejected forms (1,000 samples, max-steps 8, seed `0x2a`):

Each row is one trace; a main that violates two invariants gets two rows.

| Main | Violated invariant | Trace |
|---|---|---|
| `noticeBefore` (`Silent` + `None`) | `noUnnoticedLoss` | `ConfigUnreadable`, `path = StatesHook`, `phase = Done`, `loss = true`, `notices = 0`, `readAttempts = 0`. |
| `noticeBefore` (`Silent` + `None`) | `retriesTimeouts` | `ReadTimeout`, `path = NamedHook`, `phase = Done`, `loss = true`, `notices = 0`, `readAttempts = 1`, `retries = 0`, `timedOut = true`. |
| `noticeNoRetry` (`Fixed` + `None`) | `retriesTimeouts` | `ReadTimeout`, `path = NamedHook`, `phase = Done`, `loss = true`, `notices = 1`, `readAttempts = 1`, `retries = 0`, `timedOut = true`. The warning exists, but the retry bound is not used. |
| `noticeUnbounded` (`Fixed` + `Unbounded`) | `retryBounded` | `path = NamedHook`, `phase = Waiting`, `loss = false`, `notices = 0`, `readAttempts = 2`, `retries = 2`, `timedOut = true`. |
| `noticeUnbounded` (`Fixed` + `Unbounded`) | `retriesTimeouts` | `path = NamedHook`, `phase = Done`, `loss = true`, `notices = 1`, `readAttempts = 3`, `retries = 2`, `timedOut = true`. |

The fixed form:

```sh
quint run taskFinishHookNotice.qnt --main noticeFixed --invariant safety \
  --witnesses wRetriedThenCalled wExhaustedWarned wBrokenWarned \
    wReadNotTerminalNoNotice wConfigMissingNoNotice wStatesConfigErrorWarned \
  --max-samples 20000 --max-steps 8 --seed 0x2a
```

Result: 20,000 samples, max-steps 8, seed `0x2a`, `[ok]` (no violation, about 1.4 s). Witnesses
(traces out of 20,000; these are reachability counts, not coverage):
`wRetriedThenCalled` 197, `wExhaustedWarned` 452, `wBrokenWarned` 843,
`wReadNotTerminalNoNotice` 1,025, `wConfigMissingNoNotice` 6,693,
`wStatesConfigErrorWarned` 3,344. `wReadNotTerminalNoNotice` now requires `sawNotTerminal`, so the
number is the count of traces that actually passed through `ReadNotTerminal`, not the count that
also happens to satisfy the weaker old condition. A further 50,000 samples at max-steps 10 with
seeds `0x1` and `0x2a` also found no violation (about 3.3 s / 3.3 s). This is simulation, not a
proof.

The #148 model is unchanged and its recorded results still hold: `entryPoints` 10,000 samples at
max-steps 12 with seed `0x2a` has no violation, while `normalEndOnly` (`noMissedExit`) and
`everySave` (`atMostOnce`) still produce the counterexamples recorded above.

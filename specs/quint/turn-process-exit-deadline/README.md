# turnProcessExitDeadline

Daemon turn child process shutdown and exit deadline model for
[j5ik2o/takt#141](https://github.com/j5ik2o/takt/issues/141) /
[j5ik2o/takt#166](https://github.com/j5ik2o/takt/pull/166).

## What it covers

Source correspondence:

- `src/app/daemon-turn/index.ts`: `exitAfter`, `fatal`, `SIGTERM` and `disconnect` handlers, and `shutdown` message handling
- `src/features/daemonTurn/processRuntime.ts`: `shutdown()`, `disconnect()`, `transportClosed()`
- `src/core/daemon/processProtocol.ts`: `TURN_SHUTDOWN_GRACE_MS` (`5_000`)
- `src/features/daemon/turnProcessHost.ts`: `terminate()` waiting `TURN_SHUTDOWN_GRACE_MS` before SIGKILL

Instances (`const DESIGN: str`, `const ABORTS_ON_SHUTDOWN: bool`):

- `before` (`DESIGN = "Before"`): `exitAfter` waits on `cleanup` with no deadline timer (`337062193`).
- `unrefTimer` (`DESIGN = "UnrefTimer"`): `exitAfter` adds a deadline timer but calls `.unref()` on it.
- `fixed` (`DESIGN = "Fixed"`): `exitAfter` adds a ref'd `setTimeout(..., TURN_SHUTDOWN_GRACE_MS)` that writes `'Turn process cleanup timed out\n'` to stderr and calls `process.exit(1)` (`0a8bf2f2b`).
- `noAbort` (`DESIGN = "Fixed"`, `ABORTS_ON_SHUTDOWN = false`): mutant where `shutdown()` forgets `active?.controller.abort()`. It checks that the model notices that regression.

`GRACE = 2` models the shared `TURN_SHUTDOWN_GRACE_MS` (`5_000` ms) constant; `constantsSanityTest` asserts `GRACE > 0` and `MAX_CLOCK > GRACE`.

The initial configuration picks `initialized`, `hasTurn`, `holdsHandle`, `closeFails`, and where `shutdown()` can wait forever (`stallAt`):

| `stallAt` | Real code that never settles |
|---|---|
| `StallNone` | nothing; a turn, if any, finishes after abort |
| `StallTurn` | `await active.completion`: the turn ignores `AbortSignal` |
| `StallClose` | `business.close()` (`terminateManagedProcesses()`, `runtime.close()`, `prepareSharedServerPoolForForcedShutdown()`) |
| `StallInit` | `await initialization`: `createBusiness` never settles, and `SIGTERM` or disconnect arrives during `initialize` |

`validConfig` drops impossible combinations (for example a turn before `initialize`, or `close()` while `createBusiness` is pending). A cooperative turn finishes only after `aborted` is set, so `shutdown()` settles only when nothing is stalled and the turn was aborted (`cleanupBlocked`). The event loop drains only while `shutdown()` is blocked: a cleanup that can still settle does so in microtasks first.

Invariants (combined as `safety`):

| Invariant | Meaning |
|---|---|
| `exitsByDeadline` | Once `GRACE` elapses after `SIGTERM` or `disconnect`, the turn process is never still `Running` (even when the parent died and cannot SIGKILL). Descendants left in its process group are not covered. |
| `noZeroExitWithoutCleanup` | The child never exits with code `0` unless cleanup completed (`CleanupDone`). |
| `stalledCleanupNeverExitsZero` | If `shutdown()` waits on something that never settles (turn, `close()` or initialization), the child never exits with code `0`. |
| `timeoutExitsOne` | Writing `'Turn process cleanup timed out'` always corresponds to exit code `1`. |
| `failedCleanupNeverExitsZero` | Failed cleanup (`business.close()` error or disconnected IPC before `shutdown_complete`) never exits with code `0`. |
| `parentAliveBoundedShutdown` | While the parent is alive, parent-driven `terminate()` also finishes within `GRACE`. |
| `cleanupAbortsActiveTurn` | Starting cleanup always aborts an active turn. |

What each invariant proves:

- 1 to 3 tell the designs apart (see the matrix below).
- 4 and 5 hold by construction in every design: `childDeadlineFire` and `cleanupReject` always write `ExitedOne`. They are sanity checks, not evidence for the fix.
- 1 and 6 also rest on the premise in `canTick` that a timer fires at its deadline (the clock does not pass a pending deadline). Removing that premise breaks them.
- 7 restates `startShutdownState`. The behaviour behind it, that a cooperative turn finishes only after abort, is checked by the `noAbort` mutant: there `wCooperativeTurnCleanExit` is never reached.

States where `s.status != Running` are terminal by design, so traces shorter than `--max-steps` are expected. For the same reason `quint verify` (Apalache) reports a deadlock unless a stutter step is added for terminal states.

## What it does NOT cover

- Descendants in the turn process group after the child deadline fires while the parent is gone. `exitAfter` calls `process.exit(1)` and sends nothing to the group. `business.close()` stops children started through `spawnManagedProcess` during the grace period, but children that joined the group another way, or all of them when `close()` itself hangs, stay. `scripts/leftover-turn-processes.mjs` only looks at turn processes, so it does not detect them either. Tracked as a follow-up (see the design note).
- Direct `fatal()` invocations while IPC remains connected and a turn ignores abort (for example, a malformed IPC message from a live parent): `fatal()` calls `runtime.disconnect()` directly rather than `exitAfter`. While the parent is alive, `turnProcessHost.ts` terminates the child; if the parent dies, `disconnect` enters `exitAfter`.
- `fatal()` setting `exitCode = 1` before shutdown (for example a failed `daemon_request` send, `processRuntime.ts:63-67`). It only moves the exit code towards `1`, which is the safe side.
- Provider-side abort handling (`TurnBusiness.execute` itself).
- Wall-clock timer jitter or OS scheduling delay around `5_000` ms (modelled as discrete `GRACE` ticks), and a blocked event loop: while synchronous work such as `execFileSync` runs, neither the deadline timer nor the `SIGTERM` handler can run, so the bound becomes the length of that call. Because the child installs a JS `SIGTERM` handler, the default "exit on SIGTERM" does not apply either.
- The parent's `managed.terminate()` sends `SIGTERM` to the group, waits `TERMINATION_GRACE_MS` (250 ms), then sends `SIGKILL`. The real bound with a live parent is therefore about `GRACE` + 250 ms. `parentSigkill` absorbs the 250 ms into the same tick.
- The clean exit on the `shutdown` message path: the real child calls `process.disconnect()`, so `'disconnect'` enters `exitAfter` and then `exit()`. The model goes to `ExitedZero` without `exitAfter`, so `wCleanExitAfterShutdownMsg` uses `not(inExitAfter)`. The exit code is the same.
- Daemon main-process shutdown ([j5ik2o/takt#142](https://github.com/j5ik2o/takt/issues/142)).

## Record

Quint 0.32.0. Commands run from `specs/quint/turn-process-exit-deadline/`.

### Scenario tests (`quint test`)

```sh
quint test turnProcessExitDeadline_test.qnt --main beforeTest      # 5 passing
quint test turnProcessExitDeadline_test.qnt --main unrefTimerTest  # 1 passing
quint test turnProcessExitDeadline_test.qnt --main fixedTest       # 14 passing
quint test turnProcessExitDeadline_test.qnt --main noAbortTest     # 1 passing
```

### Invariant matrix (`quint run`)

```sh
quint run turnProcessExitDeadline.qnt --main <instance> --invariant <name> \
  --max-samples 3000 --max-steps 15 --seed 0x2a
```

| Invariant | `before` | `unrefTimer` | `fixed` | `noAbort` |
|---|---|---|---|---|
| `exitsByDeadline` | violation | ok | ok | ok |
| `noZeroExitWithoutCleanup` | violation | violation | ok | ok |
| `stalledCleanupNeverExitsZero` | violation | violation | ok | ok |
| `timeoutExitsOne` | ok | ok | ok | ok |
| `failedCleanupNeverExitsZero` | ok | ok | ok | ok |
| `parentAliveBoundedShutdown` | ok | ok | ok | ok |
| `cleanupAbortsActiveTurn` | ok | ok | ok | violation |
| `safety` | violation | violation | ok | violation |

`before` fails `exitsByDeadline` (hangs past grace when a handle stays open), and `noZeroExitWithoutCleanup` / `stalledCleanupNeverExitsZero` (exits 0 when IPC disconnects with no open handle, including the case where only `close()` hangs). `unrefTimer` still fails the last two, showing why the deadline timer must stay ref'd.

`noAbort` passes 1 to 6 because the deadline still ends the process, but a cooperative turn can no longer exit cleanly:

```sh
quint run turnProcessExitDeadline.qnt --main noAbort --invariant noZeroExitWithoutCleanup \
  --witnesses wCooperativeTurnCleanExit wCleanExitAfterSigterm \
  --max-samples 10000 --max-steps 15 --seed 0x2a
```

Result: no violation; `wCooperativeTurnCleanExit` 0 of 10,000 (in `fixed`: 45), `wCleanExitAfterSigterm` 4,018 (clean exits without a turn).

### `fixed`: simulation and witnesses (`quint run`)

```sh
quint run turnProcessExitDeadline.qnt --main fixed --invariant safety \
  --witnesses wTimeoutAfterSigterm wTimeoutAfterDisconnectHoldsHandle wTimeoutAfterDisconnectNoHandle wTimeoutCloseHangsNoHandle wTimeoutInitHangs wCleanExitAfterSigterm wCooperativeTurnCleanExit wCleanExitAfterShutdownMsg wFailedCleanupExitsOne wParentSigkill wDoubleTriggerTimeout wShutdownMsgThenParentCrashTimeout \
  --max-samples 10000 --max-steps 15 --seed 0x2a
```

Result: 10,000 samples, no violation of `safety`; trace length min=3, max=12, average=5.36.
Witnesses (out of 10,000 traces):

- `wTimeoutAfterSigterm`: 63 (0.63%)
- `wTimeoutAfterDisconnectHoldsHandle`: 1,472 (14.72%)
- `wTimeoutAfterDisconnectNoHandle`: 1,502 (15.02%)
- `wTimeoutCloseHangsNoHandle`: 232 (2.32%)
- `wTimeoutInitHangs`: 465 (4.65%)
- `wCleanExitAfterSigterm`: 4,106 (41.06%)
- `wCooperativeTurnCleanExit`: 45 (0.45%)
- `wCleanExitAfterShutdownMsg`: 365 (3.65%)
- `wFailedCleanupExitsOne`: 1,455 (14.55%)
- `wParentSigkill`: 1,036 (10.36%)
- `wDoubleTriggerTimeout`: 2,647 (26.47%)
- `wShutdownMsgThenParentCrashTimeout`: 1,944 (19.44%)

The same `safety` run with seeds `0x1`, `0x7`, and `0xbeef` (20,000 samples, 20 steps) found no violation.

## When to update

Update this spec and rerun `quint typecheck`, `quint test`, and `quint run` before changing `exitAfter`, `SIGTERM`/`disconnect` handling in `src/app/daemon-turn/index.ts`, `shutdown()` in `src/features/daemonTurn/processRuntime.ts`, or `TURN_SHUTDOWN_GRACE_MS` sharing with `src/features/daemon/turnProcessHost.ts`.

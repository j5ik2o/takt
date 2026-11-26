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

Three designs are instantiated via `const DESIGN: str`:

- `before` (`DESIGN = "Before"`): `exitAfter` waits on `cleanup` with no deadline timer (`337062193`).
- `unrefTimer` (`DESIGN = "UnrefTimer"`): `exitAfter` adds a deadline timer but calls `.unref()` on it.
- `fixed` (`DESIGN = "Fixed"`): `exitAfter` adds a ref'd `setTimeout(..., TURN_SHUTDOWN_GRACE_MS)` that writes `'Turn process cleanup timed out\n'` to stderr and calls `process.exit(1)` (`0a8bf2f2b`).

`GRACE = 2` models the shared `TURN_SHUTDOWN_GRACE_MS` (`5_000` ms) constant; `constantsSanityTest` asserts `GRACE > 0` and `MAX_CLOCK > GRACE`.

Invariants (combined as `safety`):

| Invariant | Meaning |
|---|---|
| `exitsByDeadline` | Once `GRACE` elapses after `SIGTERM` or `disconnect`, the child is never still `Running` (even when the parent died and cannot SIGKILL). |
| `noZeroExitWithoutCleanup` | The child never exits with code `0` unless cleanup completed (`CleanupDone`). |
| `abortIgnoringNeverExitsZero` | A child whose active turn ignores `AbortSignal` never exits with code `0`. |
| `timeoutExitsOne` | Writing `'Turn process cleanup timed out'` always corresponds to exit code `1`. |
| `failedCleanupNeverExitsZero` | Failed cleanup (`business.close()` error or disconnected IPC before `shutdown_complete`) never exits with code `0`. |
| `parentAliveBoundedShutdown` | While the parent is alive, parent-driven `terminate()` also finishes within `GRACE`. |
| `cleanupAbortsActiveTurn` | Starting cleanup always aborts an active turn. |

States where `s.status != Running` are terminal by design, so traces shorter than `--max-steps` are expected.

## What it does NOT cover

- Direct `fatal()` invocations while IPC remains connected and a turn ignores abort (for example, a malformed IPC message from a live parent): `fatal()` calls `runtime.disconnect()` directly rather than `exitAfter`. While the parent is alive, `turnProcessHost.ts` terminates the child; if the parent dies, `disconnect` enters `exitAfter`.
- Provider-side abort handling (`TurnBusiness.execute` itself) and child-process tree cleanup inside providers.
- Wall-clock timer jitter or OS scheduling delay around `5_000` ms (modelled as discrete `GRACE` ticks).
- Daemon main-process shutdown ([j5ik2o/takt#142](https://github.com/j5ik2o/takt/issues/142)).

## Record

Quint 0.32.0. Commands run from `specs/quint/turn-process-exit-deadline/`.

### Scenario tests (`quint test`)

```sh
quint test turnProcessExitDeadline_test.qnt --main beforeTest      # 3 passing
quint test turnProcessExitDeadline_test.qnt --main unrefTimerTest  # 1 passing
quint test turnProcessExitDeadline_test.qnt --main fixedTest       # 11 passing
```

### Invariant matrix (`quint run`)

```sh
quint run turnProcessExitDeadline.qnt --main <instance> --invariant <name> \
  --max-samples 3000 --max-steps 15 --seed 0x2a
```

| Invariant | `before` | `unrefTimer` | `fixed` |
|---|---|---|---|
| `exitsByDeadline` | violation | ok | ok |
| `noZeroExitWithoutCleanup` | violation | violation | ok |
| `abortIgnoringNeverExitsZero` | violation | violation | ok |
| `timeoutExitsOne` | ok | ok | ok |
| `failedCleanupNeverExitsZero` | ok | ok | ok |
| `parentAliveBoundedShutdown` | ok | ok | ok |
| `cleanupAbortsActiveTurn` | ok | ok | ok |
| `safety` | violation | violation | ok |

`before` fails both `exitsByDeadline` (hangs past grace when a handle stays open) and `noZeroExitWithoutCleanup` (exits 0 when IPC disconnects with no open handle). `unrefTimer` still fails `noZeroExitWithoutCleanup` and `abortIgnoringNeverExitsZero`, showing why the deadline timer must stay ref'd.

### `fixed`: simulation and witnesses (`quint run`)

```sh
quint run turnProcessExitDeadline.qnt --main fixed --invariant safety \
  --witnesses wTimeoutAfterSigterm wTimeoutAfterDisconnectHoldsHandle wTimeoutAfterDisconnectNoHandle wCleanExitAfterSigterm wCleanExitAfterShutdownMsg wFailedCleanupExitsOne wParentSigkill wDoubleTriggerTimeout wShutdownMsgThenParentCrashTimeout \
  --max-samples 10000 --max-steps 15 --seed 0x2a
```

Result: 10,000 samples, no violation of `safety`; trace length min=3, max=11, average=5.12.
Witnesses (out of 10,000 traces):

- `wTimeoutAfterSigterm`: 53 (0.53%)
- `wTimeoutAfterDisconnectHoldsHandle`: 1,030 (10.30%)
- `wTimeoutAfterDisconnectNoHandle`: 950 (9.50%)
- `wCleanExitAfterSigterm`: 4,163 (41.63%)
- `wCleanExitAfterShutdownMsg`: 407 (4.07%)
- `wFailedCleanupExitsOne`: 2,644 (26.44%)
- `wParentSigkill`: 752 (7.52%)
- `wDoubleTriggerTimeout`: 1,700 (17.00%)
- `wShutdownMsgThenParentCrashTimeout`: 1,230 (12.30%)

## When to update

Update this spec and rerun `quint typecheck`, `quint test`, and `quint run` before changing `exitAfter`, `SIGTERM`/`disconnect` handling in `src/app/daemon-turn/index.ts`, `shutdown()` in `src/features/daemonTurn/processRuntime.ts`, or `TURN_SHUTDOWN_GRACE_MS` sharing with `src/features/daemon/turnProcessHost.ts`.

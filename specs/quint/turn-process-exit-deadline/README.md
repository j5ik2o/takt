# turnProcessExitDeadline

Daemon turn child process shutdown and exit deadline model for
[j5ik2o/takt#141](https://github.com/j5ik2o/takt/issues/141) /
[j5ik2o/takt#166](https://github.com/j5ik2o/takt/pull/166), extended for
[j5ik2o/takt#177](https://github.com/j5ik2o/takt/issues/177) (descendants left in the turn process group).

## What it covers

Source correspondence:

- `src/app/daemon-turn/index.ts`: `exitAfter`, `fatal`, `SIGTERM` and `disconnect` handlers, and `shutdown` message handling
- `src/features/daemonTurn/processRuntime.ts`: `shutdown()`, `disconnect()`, `transportClosed()`
- `src/core/daemon/processProtocol.ts`: `TURN_SHUTDOWN_GRACE_MS` (`5_000`)
- `src/features/daemon/turnProcessHost.ts`: `terminate()` waiting `TURN_SHUTDOWN_GRACE_MS` before SIGKILL, and the group sweep after the leader exits (`managed.waitForExit()` then `managed.terminate()`)
- `src/shared/utils/spawn.ts`: `spawnManagedProcess` starting every child with `detached: true` (so the turn process leads its own group), and `terminatePosixProcessTree` / `waitForPosixProcessGroupExit` polling through macOS `EPERM` on a zombie-only group until `ESRCH`

Instances (`const DESIGN: str`, `const GROUP_SIGNAL: str`, `const SWEEP_ZOMBIE_EPERM: str`, `const ABORTS_ON_SHUTDOWN: bool`):

- `before` (`DESIGN = "Before"`, `GROUP_SIGNAL = "None"`, `SWEEP_ZOMBIE_EPERM = "Throw"`): `exitAfter` waits on `cleanup` with no deadline timer (`337062193`).
- `unrefTimer` (`DESIGN = "UnrefTimer"`, `GROUP_SIGNAL = "None"`, `SWEEP_ZOMBIE_EPERM = "Throw"`): `exitAfter` adds a deadline timer but calls `.unref()` on it.
- `noGroupSignal` (`DESIGN = "Fixed"`, `GROUP_SIGNAL = "None"`, `SWEEP_ZOMBIE_EPERM = "Throw"`): the code after #141 (`0a8bf2f2b`). `exitAfter` adds a ref'd `setTimeout(..., TURN_SHUTDOWN_GRACE_MS)` that writes `'Turn process cleanup timed out\n'` to stderr and calls `process.exit(1)`, and sends nothing to the group.
- `timeoutOnlyGroupSignal` (`GROUP_SIGNAL = "TimeoutOnly"`, `SWEEP_ZOMBIE_EPERM = "Throw"`): the #177 proposal as written. Only the deadline timer calls `process.kill(-process.pid, 'SIGTERM')` before `exit(1)`.
- `everyExitWithoutEpermFix` (`GROUP_SIGNAL = "EveryExit"`, `SWEEP_ZOMBIE_EPERM = "Throw"`): the pre-review #177 design (`06c8b3f1f`). Both exits in `exitAfter` signal the group, but `spawn.ts` still throws macOS `EPERM` on a zombie-only group to `turnProcessHost`'s `onError`.
- `fixed` (`GROUP_SIGNAL = "EveryExit"`, `SWEEP_ZOMBIE_EPERM = "WaitReap"`): the target. Both exits in `exitAfter` signal the group before `process.exit`, and `spawn.ts` waits through macOS `EPERM` until `launchd` reaps the zombie (`ESRCH`).
- `noAbort` (`fixed` with `ABORTS_ON_SHUTDOWN = false`): mutant where `shutdown()` forgets `active?.controller.abort()`. It checks that the model notices that regression.

`GRACE = 2` models the shared `TURN_SHUTDOWN_GRACE_MS` (`5_000` ms) constant; `constantsSanityTest` asserts `GRACE > 0` and `MAX_CLOCK > GRACE`.

The initial configuration picks `initialized`, `hasTurn`, `holdsHandle`, `closeFails`, and where `shutdown()` can wait forever (`stallAt`):

| `stallAt` | Real code that never settles |
|---|---|
| `StallNone` | nothing; a turn, if any, finishes after abort |
| `StallTurn` | `await active.completion`: the turn ignores `AbortSignal` |
| `StallClose` | `business.close()` (`terminateManagedProcesses()`, `runtime.close()`, `prepareSharedServerPoolForForcedShutdown()`) |
| `StallInit` | `await initialization`: `createBusiness` never settles, and `SIGTERM` or disconnect arrives during `initialize` |

The initial configuration also picks a descendant in the turn process group (`desc`: `DescNone`, `DescHonorsTerm`, `DescIgnoresTerm`) and whether the turn process leads its group (`groupLeader`; `false` means it was spawned without `detached`, so `-process.pid` names no group). A descendant exists only after `initialize`. `initWith` keeps the #141 scenarios: no descendant, group leader.

Group and disconnect actions (#177):

- `signalOwnGroup` (inside `cleanupResolve` / `cleanupReject` / `childDeadlineFire`, as `GROUP_SIGNAL` decides): sends SIGTERM to the descendant only when `groupLeader`.
- `parentSigkill`: the parent's group SIGKILL also ends a descendant that ignores SIGTERM.
- `parentSweepAfterExit`: a live parent sweeps the group after the leader exits. When only an unreaped zombie remains, `"Throw"` records a spurious `EPERM` (`parentSweepError = true`), while `"WaitReap"` enters `SweepWaitingReap`.
- `parentSweepFinishAfterReap`: under `"WaitReap"`, completes the sweep cleanly once every zombie has been reaped (`ESRCH`).
- `parentCrashAfterExit`: the parent dies after the leader exited, before its sweep runs or finishes.
- `parentCrashAfterDisconnect`: the parent dies while the turn process is still running after IPC already disconnected (`ipcDisconnectWhileParentAlive`).
- `descendantExitOnTerm`: a descendant that honors SIGTERM ends after receiving it and enters `descZombie = true` until reaped.
- `descendantReaped`: `init` / `launchd` reaps a zombie descendant (`descZombie: false`).

Every `cleanupResolve` / `cleanupReject` in the real code ends in `exitAfter`'s `finally` (the `shutdown` message path calls `process.disconnect()`, which enters `exitAfter`), so `EveryExit` applies the group signal there even on the model's shortcut for the `shutdown` message path.

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
| `orphanedGroupSignalled` | (#177) Once the turn process has exited, the parent is dead, and the turn process led its group, a descendant still running in that group has received SIGTERM. |
| `signalsOnlyOwnGroup` | (#177) When the turn process does not lead a group, no descendant receives its SIGTERM. |
| `noSpuriousParentSweepError` | (#177 / macOS) The parent's post-exit `managed.terminate()` does not report a spurious `EPERM` to `turnProcessHost`'s `onError` when racing with a zombie-only group left by `signalOwnGroup()`. |
| `parentSweepClearsGroup` | (#177 / macOS) A clean parent sweep finishes only when no live or zombie member remains in the group (`ESRCH` observed). |

What each invariant proves:

- 1 to 3 tell the designs apart (see the matrix below).
- 4 and 5 hold by construction in every design: `childDeadlineFire` and `cleanupReject` always write `ExitedOne`. They are sanity checks, not evidence for the fix.
- 1 and 6 also rest on the premise in `canTick` that a timer fires at its deadline (the clock does not pass a pending deadline). Removing that premise breaks them.
- 8 tells `noGroupSignal` / `timeoutOnlyGroupSignal` apart from `everyExitWithoutEpermFix` and `fixed`. 9 holds by construction (`signalOwnGroup` checks `groupLeader`); in the real process it rests on the OS premise that a PID in use as a group ID is not given to a new process.
- 10 tells `everyExitWithoutEpermFix` and `timeoutOnlyGroupSignal` apart from `fixed`. 11 holds by construction (`canParentSweepFinishAfterReap` requires `not(descAlive) and not(descZombie)`).
- 7 restates `startShutdownState`. The behaviour behind it, that a cooperative turn finishes only after abort, is checked by the `noAbort` mutant: there `wCooperativeTurnCleanExit` is never reached.

After `s.status != Running` only the post-exit group actions (`parentSweepAfterExit`, `parentSweepFinishAfterReap`, `parentCrashAfterExit`, `descendantExitOnTerm`, `descendantReaped`) can still run, so traces shorter than `--max-steps` are expected. For the same reason `quint verify` (Apalache) reports a deadlock unless a stutter step is added for terminal states.

## What it does NOT cover

- Descendants that ignore SIGTERM while the parent is gone: nobody can SIGKILL them. `wOrphanIgnoringDescendantLeft` shows this residual on purpose.
- Descendants in other groups (`setsid`, `detached: true`, including every `spawnManagedProcess` child). `business.close()` stops `spawnManagedProcess` children during the grace period; they stay if `close()` itself hangs, if `initialization` (`createBusiness`) hangs before `close()` runs, or if an abort-ignoring turn calls `spawnManagedProcess` again after `close()` finishes.
- The self-delivered SIGTERM. The real child registers `process.on('SIGTERM')` at load time and `signalOwnGroup()` also ensures a `SIGTERM` listener exists (`process.listenerCount('SIGTERM') === 0`) before calling `process.kill(-process.pid, 'SIGTERM')`, so the default signal-termination action does not run, and the synchronous `process.exit` runs before the queued JS handler. The model does not represent it; the IT checks the exit code.
- Group members with a different `euid` (e.g., setuid descendants): they cannot be signalled. On both Linux and macOS XNU (`killpg1` delivers to every permittable member, increments `nfound`, and returns `EPERM` only when `nfound == 0`), `signalOwnGroup()` still reaches permittable descendants because the leader itself is permittable; only the unpermittable member stays. In `spawn.ts`, a persisting unpermittable live member still surfaces `EPERM` after `TERMINATION_SETTLE_TIMEOUT_MS` (not modelled as a separate `Descendant` variant).
- Exits that do not go through `exitAfter` (uncaught exception, external SIGKILL).
- Direct `fatal()` invocations while IPC remains connected and a turn ignores abort (for example, a malformed IPC message from a live parent): `fatal()` calls `runtime.disconnect()` directly rather than `exitAfter`. While the parent is alive, `turnProcessHost.ts` terminates the child; if the parent dies, `disconnect` enters `exitAfter`.
- `fatal()` setting `exitCode = 1` before shutdown (for example a failed `daemon_request` send, `processRuntime.ts:63-67`). It only moves the exit code towards `1`, which is the safe side.
- Provider-side abort handling (`TurnBusiness.execute` itself).
- Wall-clock timer jitter or OS scheduling delay around `5_000` ms (modelled as discrete `GRACE` ticks), and a blocked event loop: while synchronous work such as `execFileSync` runs, neither the deadline timer nor the `SIGTERM` handler can run, so the bound becomes the length of that call. Because the child installs a JS `SIGTERM` handler, the default "exit on SIGTERM" does not apply either.
- The parent's `managed.terminate()` sends `SIGTERM` to the group, waits `TERMINATION_GRACE_MS` (250 ms), then sends `SIGKILL`. The real bound with a live parent is therefore about `GRACE` + 250 ms. `parentSigkill` absorbs the 250 ms into the same tick.
- The clean exit on the `shutdown` message path: the real child calls `process.disconnect()`, so `'disconnect'` enters `exitAfter` and then `exit()`. The model goes to `ExitedZero` without `exitAfter`, so `wCleanExitAfterShutdownMsg` uses `not(inExitAfter)`. The exit code is the same.
- Daemon main-process shutdown ([j5ik2o/takt#142](https://github.com/j5ik2o/takt/issues/142)).
- The deadline-expiry branch of the `WaitReap` sweep. The model represents only the case where the group reaches `ESRCH` within the parent's `TERMINATION_SETTLE_TIMEOUT_MS` (2 s) settlement deadline (`parentSweepFinishAfterReap`, witnessed by `wParentSweepWaitsZombieReap`). Rethrowing the `EPERM` that persists for the whole deadline is outside the model: `src/__tests__/managed-spawn.test.ts` covers it (an `EPERM` that lasts 2 s is rethrown) and `src/__tests__/devin-client.test.ts` covers the logged pid-bearing `EPERM` once the deadline passes on darwin. The design decision is unchanged.

## Record

Quint 0.32.0. Commands run from `specs/quint/turn-process-exit-deadline/`.

### Scenario tests (`quint test`)

```sh
quint test turnProcessExitDeadline_test.qnt --main beforeTest                     # 5 passing
quint test turnProcessExitDeadline_test.qnt --main unrefTimerTest                 # 1 passing
quint test turnProcessExitDeadline_test.qnt --main noGroupSignalTest              # 4 passing
quint test turnProcessExitDeadline_test.qnt --main timeoutOnlyGroupSignalTest     # 2 passing
quint test turnProcessExitDeadline_test.qnt --main everyExitWithoutEpermFixTest   # 2 passing
quint test turnProcessExitDeadline_test.qnt --main fixedTest                      # 23 passing
quint test turnProcessExitDeadline_test.qnt --main noAbortTest                    # 1 passing
```

### Invariant matrix (`quint run`)

```sh
quint run turnProcessExitDeadline.qnt --main <instance> --invariant <name> \
  --max-samples 3000 --max-steps 15 --seed 0x2a
```

| Invariant | `before` | `unrefTimer` | `noGroupSignal` | `timeoutOnlyGroupSignal` | `everyExitWithoutEpermFix` | `fixed` | `noAbort` |
|---|---|---|---|---|---|---|---|
| `exitsByDeadline` | violation | ok | ok | ok | ok | ok | ok |
| `noZeroExitWithoutCleanup` | violation | violation | ok | ok | ok | ok | ok |
| `stalledCleanupNeverExitsZero` | violation | violation | ok | ok | ok | ok | ok |
| `timeoutExitsOne` | ok | ok | ok | ok | ok | ok | ok |
| `failedCleanupNeverExitsZero` | ok | ok | ok | ok | ok | ok | ok |
| `parentAliveBoundedShutdown` | ok | ok | ok | ok | ok | ok | ok |
| `cleanupAbortsActiveTurn` | ok | ok | ok | ok | ok | ok | violation |
| `orphanedGroupSignalled` | violation | violation | violation | violation | ok | ok | ok |
| `signalsOnlyOwnGroup` | ok | ok | ok | ok | ok | ok | ok |
| `noSpuriousParentSweepError` | ok | ok | ok | violation | violation | ok | ok |
| `parentSweepClearsGroup` | ok | ok | ok | ok | ok | ok | ok |
| `safety` | violation | violation | violation | violation | violation | ok | violation |

`before` fails `exitsByDeadline` (hangs past grace when a handle stays open), and `noZeroExitWithoutCleanup` / `stalledCleanupNeverExitsZero` (exits 0 when IPC disconnects with no open handle, including the case where only `close()` hangs). `unrefTimer` still fails the last two, showing why the deadline timer must stay ref'd.

Counterexamples (seed `0x2a`):

- `noGroupSignal` / `orphanedGroupSignalled`: `ipcDisconnectWhileParentAlive` → `receiveSigterm` → `parentCrashAfterDisconnect` → `tick` × 2 → `childDeadlineFire`. The descendant is still running and never received SIGTERM.
- `timeoutOnlyGroupSignal` / `orphanedGroupSignalled`: `parentCrashAndDisconnect` → `cleanupReject` (exit 1 before the deadline). The descendant stays, so signalling only on the deadline is not enough.
- `everyExitWithoutEpermFix` / `noSpuriousParentSweepError`: `receiveSigterm` → `ipcDisconnectWhileParentAlive` → `tick` × 2 → `childDeadlineFire` (signals the group) → `descendantExitOnTerm` (unreaped zombie) → `parentSweepAfterExit` hits the zombie-only group and raises macOS `EPERM` (`parentSweepError = true`). `everyExitWithoutEpermFixTest` also reproduces the same failure after a normal `cleanupResolve`.

`noAbort` passes 1 to 6 and 8 to 11 because the deadline still ends the process and the group fix still runs, but a cooperative turn can no longer exit cleanly:

```sh
quint run turnProcessExitDeadline.qnt --main noAbort --invariant noZeroExitWithoutCleanup \
  --witnesses wCooperativeTurnCleanExit wCleanExitAfterSigterm \
  --max-samples 10000 --max-steps 15 --seed 0x2a
```

Result: no violation; `wCooperativeTurnCleanExit` 0 of 10,000 (in `fixed`: 53), `wCleanExitAfterSigterm` 4,145 (clean exits without a turn).

### `fixed`: simulation and witnesses (`quint run`)

```sh
quint run turnProcessExitDeadline.qnt --main fixed --invariant safety \
  --witnesses wTimeoutAfterSigterm wTimeoutAfterDisconnectHoldsHandle wTimeoutAfterDisconnectNoHandle wTimeoutCloseHangsNoHandle wTimeoutInitHangs wCleanExitAfterSigterm wCooperativeTurnCleanExit wCleanExitAfterShutdownMsg wFailedCleanupExitsOne wParentSigkill wDoubleTriggerTimeout wShutdownMsgThenParentCrashTimeout \
  wOrphanDescendantGoneAfterTimeout wOrphanDescendantGoneAfterFailedCleanup wOrphanIgnoringDescendantLeft \
  wParentSweepAfterExit wParentCrashAfterExitSignalled wNonLeaderDescendantUntouched \
  wParentSweepWaitsZombieReap wParentCrashAfterDisconnect \
  --max-samples 10000 --max-steps 15 --seed 0x2a
```

Result: 10,000 samples, no violation of `safety`; trace length min=3, max=13, average=6.10.
Witnesses (out of 10,000 traces):

- `wTimeoutAfterSigterm`: 59 (0.59%)
- `wTimeoutAfterDisconnectHoldsHandle`: 1,828 (18.28%)
- `wTimeoutAfterDisconnectNoHandle`: 1,827 (18.27%)
- `wTimeoutCloseHangsNoHandle`: 287 (2.87%)
- `wTimeoutInitHangs`: 565 (5.65%)
- `wCleanExitAfterSigterm`: 4,216 (42.16%)
- `wCooperativeTurnCleanExit`: 53 (0.53%)
- `wCleanExitAfterShutdownMsg`: 402 (4.02%)
- `wFailedCleanupExitsOne`: 1,441 (14.41%)
- `wParentSigkill`: 286 (2.86%)
- `wDoubleTriggerTimeout`: 3,240 (32.40%)
- `wShutdownMsgThenParentCrashTimeout`: 3,655 (36.55%)
- `wOrphanDescendantGoneAfterTimeout`: 524 (5.24%)
- `wOrphanDescendantGoneAfterFailedCleanup`: 211 (2.11%)
- `wOrphanIgnoringDescendantLeft`: 693 (6.93%)
- `wParentSweepAfterExit`: 140 (1.40%)
- `wParentCrashAfterExitSignalled`: 118 (1.18%)
- `wNonLeaderDescendantUntouched`: 1,566 (15.66%)
- `wParentSweepWaitsZombieReap`: 2 (0.02%)
- `wParentCrashAfterDisconnect`: 2,488 (24.88%)

The same `safety` run with seeds `0x1`, `0x7`, and `0xbeef` (20,000 samples, 20 steps) found no violation.

`wOrphanDescendantGoneAfterTimeout` and `wOrphanDescendantGoneAfterFailedCleanup` also require `sweep == SweepIdle`: the parent never swept the group, so the descendant ended on the turn process's own SIGTERM (`descendantExitOnTerm`), not on a sweep the parent ran before it crashed. With `descendantExitOnTerm` removed from `step` (a mutant), both are witnessed in 0 of 10,000 traces; without the `sweep` condition they were still reached (17 and 43) through that parent-sweep-then-crash path.

### `fixed`: the zombie-reap race (`quint run`)

`wParentSweepWaitsZombieReap` is rare under `init` / `step` (2 of 10,000 above). `initParentAliveHonoringDescendant` fixes the configuration that can reach it (initialized, the turn process leads its group, one descendant that honors SIGTERM) and `stepParentAlive` leaves out the parent-crash actions:

```sh
quint run turnProcessExitDeadline.qnt --main fixed \
  --init initParentAliveHonoringDescendant --step stepParentAlive \
  --invariant safety --witnesses wParentSweepWaitsZombieReap wParentSweepAfterExit \
  --max-samples 10000 --max-steps 15 --seed 0x2a
```

Result: no violation of `safety`; trace length min=4, max=15, average=7.49. `wParentSweepWaitsZombieReap`: 1,649 (16.49%), `wParentSweepAfterExit`: 4,959 (49.59%). With `descendantExitOnTerm` removed from `stepParentAlive` (a mutant), `wParentSweepWaitsZombieReap` drops to 0.

The same focused run on `everyExitWithoutEpermFix` with `--invariant noSpuriousParentSweepError` finds the violation: `ipcDisconnectWhileParentAlive` → `receiveSigterm` → `tick` × 2 → `childDeadlineFire` → `descendantExitOnTerm` → `parentSweepAfterExit`.

## When to update

Update this spec and rerun `quint typecheck`, `quint test`, and `quint run` before changing `exitAfter` (including the group SIGTERM), `SIGTERM`/`disconnect` handling in `src/app/daemon-turn/index.ts`, `shutdown()` in `src/features/daemonTurn/processRuntime.ts`, `TURN_SHUTDOWN_GRACE_MS` sharing with `src/features/daemon/turnProcessHost.ts`, or macOS zombie-group `EPERM` handling in `src/shared/utils/spawn.ts`.

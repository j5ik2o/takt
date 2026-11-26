// -*- mode: Bluespec; -*-
// Shutdown and exit deadline state machine for the daemon turn child process
// (src/app/daemon-turn/index.ts + src/features/daemonTurn/processRuntime.ts
//  + src/features/daemon/turnProcessHost.ts).
//
// Issue: https://github.com/j5ik2o/takt/issues/141 (exit deadline)
//        https://github.com/j5ik2o/takt/issues/177 (descendants left in the turn process group)
// PR:    https://github.com/j5ik2o/takt/pull/166
//
// DESIGN picks the child exitAfter implementation:
//   "Before"     - 337062193: exitAfter waits for cleanup without a deadline timer.
//   "UnrefTimer" - exitAfter sets a TURN_SHUTDOWN_GRACE_MS timer, but calls .unref() on it.
//   "Fixed"      - 0a8bf2f2b: exitAfter sets a ref'd setTimeout(..., TURN_SHUTDOWN_GRACE_MS)
//                  that writes 'Turn process cleanup timed out\n' and calls process.exit(1).
//
// GROUP_SIGNAL picks what exitAfter sends to the turn process's own group (#177):
//   "None"        - 0a8bf2f2b: nothing. Descendants in the group stay when the parent is gone.
//   "TimeoutOnly" - the deadline timer calls process.kill(-process.pid, 'SIGTERM') before exit(1).
//   "EveryExit"   - both exits in exitAfter (deadline timer and cleanup settled) signal the group
//                   before process.exit.
//
// SWEEP_ZOMBIE_EPERM picks how spawn.ts handles macOS EPERM on a zombie-only process group during
// the parent's post-exit managed.terminate() sweep (#177 review M3):
//   "Throw"    - current spawn.ts: only ignores ESRCH and rethrows EPERM to turnProcessHost's onError.
//   "WaitReap" - fixed spawn.ts: on darwin, polls kill(-pid, 0) through EPERM until launchd reaps
//                the zombie and ESRCH confirms the group is gone.
module turnProcessExitDeadline {
  const DESIGN: str
  const GROUP_SIGNAL: str
  const SWEEP_ZOMBIE_EPERM: str
  // true: shutdown() aborts the active turn first (processRuntime.ts:71). false is a mutant that
  // drops the abort, used to check that the model notices a regression there.
  const ABORTS_ON_SHUTDOWN: bool

  // Models TURN_SHUTDOWN_GRACE_MS (5_000 ms in src/core/daemon/processProtocol.ts),
  // shared between parent (turnProcessHost.ts) and child (daemon-turn/index.ts).
  pure val GRACE: int = 2
  pure val MAX_CLOCK: int = 6

  // Where shutdown() can wait forever (processRuntime.ts:70-78):
  //   StallTurn  - `await active.completion`: the active turn ignores AbortSignal
  //   StallClose - `business.close()` never settles
  //   StallInit  - `await initialization`: createBusiness never settles
  type StallPoint = StallNone | StallTurn | StallClose | StallInit
  type CleanupState = CleanIdle | Cleaning | CleanupDone | CleanupFailed
  type ExitStatus = Running | ExitedZero | ExitedOne | KilledByParent
  type ParentState = ParentAlive | ParentDead
  // A descendant in the turn process group that did not come from spawnManagedProcess (which
  // gives every child its own group), for example a child an SDK spawned directly.
  type Descendant = DescNone | DescHonorsTerm | DescIgnoresTerm
  // State of the live parent's post-exit managed.terminate() sweep (turnProcessHost.ts:182).
  type SweepState = SweepIdle | SweepWaitingReap | SweepDone

  type State = {
    // Initial run configuration
    initialized: bool,
    hasTurn: bool,
    stallAt: StallPoint,
    holdsHandle: bool,
    closeFails: bool,
    desc: Descendant,
    // The turn process leads its own group (turnProcessHost spawns it with detached: true).
    // false: something else spawned it without detached, so -process.pid names no group.
    groupLeader: bool,

    // Parent and IPC channel state
    parent: ParentState,
    ipcConnected: bool,
    parentShutdownAt: int,

    // Child lifecycle and cleanup state
    clock: int,
    cleanup: CleanupState,
    aborted: bool,
    inExitAfter: bool,
    exitAfterStartedAt: int,
    exitAfterDeadline: int,
    hasRefTimer: bool,
    timedOutMsg: bool,
    exitAfterCount: int,
    status: ExitStatus,
    lastAction: str,

    // Turn process group state (#177)
    descAlive: bool,
    descZombie: bool,
    descTermed: bool,
    groupSignalled: bool,
    sweep: SweepState,
    parentSweepError: bool,
  }

  var s: State

  // ---------- functional layer ----------

  // Initial configurations that the real process can be in.
  pure def validConfig(initDone: bool, turn: bool, stall: StallPoint, closeErr: bool): bool = all {
    // Before `initialize` there is no business, no turn and nothing to close.
    initDone or (not(turn) and stall == StallNone and not(closeErr)),
    // A turn that ignores abort needs an active turn.
    stall != StallTurn or turn,
    // While createBusiness is pending, start_turn is rejected and business.close() is not called.
    stall != StallInit or (not(turn) and not(closeErr)),
    // close() either hangs or rejects, not both.
    stall != StallClose or not(closeErr),
  }

  // process.kill(-process.pid, 'SIGTERM'). It reaches the group only when the turn process leads
  // it; otherwise the kill fails with ESRCH and nothing outside the group is touched.
  pure def signalOwnGroup(st: State): State = {
    ...st,
    groupSignalled: true,
    descTermed: st.descTermed or (st.groupLeader and st.descAlive),
  }

  // exitAfter's `cleanup.finally(() => process.exit())`. Every cleanupResolve / cleanupReject in the
  // real code ends there: the shutdown message path calls process.disconnect(), and 'disconnect'
  // enters exitAfter. The model takes that path as a shortcut, so the group signal is applied here.
  pure def signalOnSettledExit(st: State): State =
    if (GROUP_SIGNAL == "EveryExit") signalOwnGroup(st) else st

  pure def signalOnDeadlineExit(st: State): State =
    if (GROUP_SIGNAL == "None") st else signalOwnGroup(st)

  pure def startShutdownState(st: State): State =
    if (st.cleanup != CleanIdle) st
    else {
      ...st,
      cleanup: Cleaning,
      aborted: st.aborted or (ABORTS_ON_SHUTDOWN and st.hasTurn),
    }

  // shutdown() cannot settle: it waits on a stall point, or on a cooperative turn that was never aborted.
  pure def cleanupBlocked(st: State): bool =
    st.stallAt != StallNone or (st.hasTurn and not(st.aborted))

  pure def armExitAfter(st: State, design: str): State = {
    val startedAt = if (st.exitAfterStartedAt == -1) st.clock else st.exitAfterStartedAt
    // If exitAfter is invoked twice (e.g. SIGTERM followed by disconnect), the earliest
    // timer fires first and terminates the process.
    val deadline =
      if (design == "Before") -1
      else if (st.exitAfterDeadline == -1) st.clock + GRACE
      else st.exitAfterDeadline
    val refTimer =
      if (design == "Fixed") true
      else st.hasRefTimer
    {
      ...st,
      inExitAfter: true,
      exitAfterStartedAt: startedAt,
      exitAfterDeadline: deadline,
      hasRefTimer: refTimer,
      exitAfterCount: st.exitAfterCount + 1,
    }
  }

  pure def canReceiveShutdownMsg(st: State): bool =
    st.status == Running and st.parent == ParentAlive and st.ipcConnected and st.parentShutdownAt == -1

  pure def applyReceiveShutdownMsg(st: State): State = {
    val updated = startShutdownState(st)
    { ...updated, parentShutdownAt: st.clock, lastAction: "receiveShutdownMsg" }
  }

  pure def canReceiveSigterm(st: State): bool =
    st.status == Running and st.exitAfterCount < 2

  pure def applyReceiveSigterm(st: State, design: str): State = {
    val updated = armExitAfter(startShutdownState(st), design)
    { ...updated, lastAction: "receiveSigterm" }
  }

  pure def canParentCrashAndDisconnect(st: State): bool =
    st.status == Running and st.parent == ParentAlive and st.ipcConnected

  pure def applyParentCrashAndDisconnect(st: State, design: str): State = {
    val disconnected = { ...st, parent: ParentDead, ipcConnected: false, parentShutdownAt: -1 }
    val updated = armExitAfter(startShutdownState(disconnected), design)
    { ...updated, lastAction: "parentCrashAndDisconnect" }
  }

  pure def canIpcDisconnectWhileParentAlive(st: State): bool =
    st.status == Running and st.parent == ParentAlive and st.ipcConnected

  pure def applyIpcDisconnectWhileParentAlive(st: State, design: str): State = {
    val parentAt = if (st.parentShutdownAt == -1) st.clock else st.parentShutdownAt
    val disconnected = { ...st, ipcConnected: false, parentShutdownAt: parentAt }
    val updated = armExitAfter(startShutdownState(disconnected), design)
    { ...updated, lastAction: "ipcDisconnectWhileParentAlive" }
  }

  // The parent can also die while the turn process is still running after IPC already disconnected.
  pure def canParentCrashAfterDisconnect(st: State): bool =
    st.status == Running and st.parent == ParentAlive and not(st.ipcConnected)

  pure def applyParentCrashAfterDisconnect(st: State): State =
    { ...st, parent: ParentDead, parentShutdownAt: -1, lastAction: "parentCrashAfterDisconnect" }

  pure def canCleanupResolve(st: State): bool =
    st.status == Running
      and st.cleanup == Cleaning
      and not(cleanupBlocked(st))
      and not(st.closeFails)
      and (not(st.initialized) or st.ipcConnected)

  pure def applyCleanupResolve(st: State): State = {
    {
      ...signalOnSettledExit(st),
      cleanup: CleanupDone,
      ipcConnected: false,
      status: ExitedZero,
      lastAction: "cleanupResolve",
    }
  }

  // business.close() rejects, or (after disconnect) turn_finished / shutdown_complete cannot be sent.
  pure def canCleanupReject(st: State): bool =
    st.status == Running
      and st.cleanup == Cleaning
      and not(cleanupBlocked(st))
      and (st.closeFails or (st.initialized and not(st.ipcConnected)))

  pure def applyCleanupReject(st: State): State = {
    {
      ...signalOnSettledExit(st),
      cleanup: CleanupFailed,
      ipcConnected: false,
      status: ExitedOne,
      lastAction: "cleanupReject",
    }
  }

  // The event loop empties only when nothing keeps it alive. Microtasks run first, so a cleanup
  // that can still settle settles before the loop drains; draining needs shutdown() to be stuck.
  pure def canEventLoopDrain(st: State): bool =
    st.status == Running
      and st.cleanup == Cleaning
      and cleanupBlocked(st)
      and not(st.ipcConnected)
      and not(st.holdsHandle)
      and not(st.hasRefTimer)

  pure def applyEventLoopDrain(st: State): State = {
    {
      ...st,
      status: ExitedZero,
      lastAction: "eventLoopDrain",
    }
  }

  pure def canChildDeadlineFire(st: State): bool =
    st.status == Running
      and st.exitAfterDeadline != -1
      and st.clock >= st.exitAfterDeadline

  pure def applyChildDeadlineFire(st: State): State = {
    {
      ...signalOnDeadlineExit(st),
      timedOutMsg: true,
      status: ExitedOne,
      lastAction: "childDeadlineFire",
    }
  }

  // Discretized: the real parent signals the group GRACE after shutdown, then SIGKILLs it
  // TERMINATION_GRACE_MS (250 ms) later (spawn.ts). The 250 ms is absorbed into the same tick.
  // The SIGKILL also ends every descendant in the group, including one that ignores SIGTERM.
  pure def canParentSigkill(st: State): bool =
    st.status == Running
      and st.parent == ParentAlive
      and st.parentShutdownAt != -1
      and st.clock >= st.parentShutdownAt + GRACE

  pure def applyParentSigkill(st: State): State = {
    {
      ...st,
      status: KilledByParent,
      descAlive: st.descAlive and not(st.groupLeader),
      sweep: if (st.groupLeader) SweepDone else st.sweep,
      lastAction: "parentSigkill",
    }
  }

  // A live parent sweeps the group after the leader exits: turnProcessHost.ts `managed.waitForExit()`
  // then `managed.terminate()` (SIGTERM, 250 ms, SIGKILL to -pid).
  // On macOS, a group whose remaining members are all unreaped zombies returns EPERM (not ESRCH)
  // until launchd reaps them.
  pure def canParentSweepAfterExit(st: State): bool =
    st.status != Running
      and st.status != KilledByParent
      and st.parent == ParentAlive
      and st.groupLeader
      and st.sweep == SweepIdle
      and (st.descAlive or st.descZombie)

  pure def applyParentSweepAfterExit(st: State): State =
    if (st.descAlive)
      { ...st, descAlive: false, descZombie: false, sweep: SweepDone, lastAction: "parentSweepAfterExit" }
    else if (SWEEP_ZOMBIE_EPERM == "Throw")
      { ...st, sweep: SweepDone, parentSweepError: true, lastAction: "parentSweepAfterExit" }
    else
      { ...st, sweep: SweepWaitingReap, lastAction: "parentSweepAfterExit" }

  // Under WaitReap, waitForPosixProcessGroupExit polls through macOS EPERM and completes
  // cleanly once launchd reaps the zombie and kill(-pid, 0) returns ESRCH.
  pure def canParentSweepFinishAfterReap(st: State): bool =
    st.sweep == SweepWaitingReap
      and st.parent == ParentAlive
      and not(st.descAlive)
      and not(st.descZombie)

  pure def applyParentSweepFinishAfterReap(st: State): State =
    { ...st, sweep: SweepDone, lastAction: "parentSweepFinishAfterReap" }

  // The parent can die after the turn process exited but before its sweep ran (or finished).
  pure def canParentCrashAfterExit(st: State): bool =
    st.status != Running and st.parent == ParentAlive

  pure def applyParentCrashAfterExit(st: State): State =
    { ...st, parent: ParentDead, ipcConnected: false, lastAction: "parentCrashAfterExit" }

  // A descendant that keeps the default SIGTERM action (or handles it and exits) ends after SIGTERM.
  // On POSIX, an exited child remains an unreaped zombie until init / launchd reaps it.
  pure def canDescendantExitOnTerm(st: State): bool =
    st.descAlive and st.descTermed and st.desc == DescHonorsTerm

  pure def applyDescendantExitOnTerm(st: State): State =
    { ...st, descAlive: false, descZombie: true, lastAction: "descendantExitOnTerm" }

  // init / launchd reaps an exited descendant that was waiting as a zombie.
  pure def canDescendantReaped(st: State): bool =
    st.descZombie

  pure def applyDescendantReaped(st: State): State =
    { ...st, descZombie: false, lastAction: "descendantReaped" }

  // Timers fire exactly at their deadline: the clock does not pass a pending deadline.
  // Invariants 1 and 6 rely on this (the event loop is assumed not to be blocked).
  pure def canTick(st: State): bool =
    st.status == Running
      and st.clock < MAX_CLOCK
      and not(canChildDeadlineFire(st))
      and not(canParentSigkill(st))

  pure def applyTick(st: State): State =
    { ...st, clock: st.clock + 1, lastAction: "tick" }

  // ---------- state machine ----------

  action initWithGroup(initDone: bool, turn: bool, stall: StallPoint, holds: bool, closeErr: bool,
                       d: Descendant, leader: bool): bool = all {
    validConfig(initDone, turn, stall, closeErr),
    // Only a running turn (or business.close()) can have spawned a descendant.
    d == DescNone or initDone,
    s' = {
      initialized: initDone,
      hasTurn: turn,
      stallAt: stall,
      holdsHandle: holds,
      closeFails: closeErr,
      desc: d,
      groupLeader: leader,
      parent: ParentAlive,
      ipcConnected: true,
      parentShutdownAt: -1,
      clock: 0,
      cleanup: CleanIdle,
      aborted: false,
      inExitAfter: false,
      exitAfterStartedAt: -1,
      exitAfterDeadline: -1,
      hasRefTimer: false,
      timedOutMsg: false,
      exitAfterCount: 0,
      status: Running,
      lastAction: "init",
      descAlive: d != DescNone,
      descZombie: false,
      descTermed: false,
      groupSignalled: false,
      sweep: SweepIdle,
      parentSweepError: false,
    },
  }

  // The #141 scenarios: no descendant, and the turn process leads its group as in production.
  action initWith(initDone: bool, turn: bool, stall: StallPoint, holds: bool, closeErr: bool): bool =
    initWithGroup(initDone, turn, stall, holds, closeErr, DescNone, true)

  action init: bool = {
    nondet initDone = Set(true, false).oneOf()
    nondet turn = Set(true, false).oneOf()
    nondet stall = Set(StallNone, StallTurn, StallClose, StallInit).oneOf()
    nondet holds = Set(true, false).oneOf()
    nondet closeErr = Set(true, false).oneOf()
    nondet d = Set(DescNone, DescHonorsTerm, DescIgnoresTerm).oneOf()
    nondet leader = Set(true, false).oneOf()
    initWithGroup(initDone, turn, stall, holds, closeErr, d, leader)
  }

  action receiveShutdownMsg: bool = all {
    canReceiveShutdownMsg(s),
    s' = applyReceiveShutdownMsg(s),
  }

  action receiveSigterm: bool = all {
    canReceiveSigterm(s),
    s' = applyReceiveSigterm(s, DESIGN),
  }

  action parentCrashAndDisconnect: bool = all {
    canParentCrashAndDisconnect(s),
    s' = applyParentCrashAndDisconnect(s, DESIGN),
  }

  action ipcDisconnectWhileParentAlive: bool = all {
    canIpcDisconnectWhileParentAlive(s),
    s' = applyIpcDisconnectWhileParentAlive(s, DESIGN),
  }

  action parentCrashAfterDisconnect: bool = all {
    canParentCrashAfterDisconnect(s),
    s' = applyParentCrashAfterDisconnect(s),
  }

  action cleanupResolve: bool = all {
    canCleanupResolve(s),
    s' = applyCleanupResolve(s),
  }

  action cleanupReject: bool = all {
    canCleanupReject(s),
    s' = applyCleanupReject(s),
  }

  action eventLoopDrain: bool = all {
    canEventLoopDrain(s),
    s' = applyEventLoopDrain(s),
  }

  action childDeadlineFire: bool = all {
    canChildDeadlineFire(s),
    s' = applyChildDeadlineFire(s),
  }

  action parentSigkill: bool = all {
    canParentSigkill(s),
    s' = applyParentSigkill(s),
  }

  action tick: bool = all {
    canTick(s),
    s' = applyTick(s),
  }

  action parentSweepAfterExit: bool = all {
    canParentSweepAfterExit(s),
    s' = applyParentSweepAfterExit(s),
  }

  action parentSweepFinishAfterReap: bool = all {
    canParentSweepFinishAfterReap(s),
    s' = applyParentSweepFinishAfterReap(s),
  }

  action parentCrashAfterExit: bool = all {
    canParentCrashAfterExit(s),
    s' = applyParentCrashAfterExit(s),
  }

  action descendantExitOnTerm: bool = all {
    canDescendantExitOnTerm(s),
    s' = applyDescendantExitOnTerm(s),
  }

  action descendantReaped: bool = all {
    canDescendantReaped(s),
    s' = applyDescendantReaped(s),
  }

  action step: bool = any {
    receiveShutdownMsg,
    receiveSigterm,
    parentCrashAndDisconnect,
    ipcDisconnectWhileParentAlive,
    parentCrashAfterDisconnect,
    cleanupResolve,
    cleanupReject,
    eventLoopDrain,
    childDeadlineFire,
    parentSigkill,
    tick,
    parentSweepAfterExit,
    parentSweepFinishAfterReap,
    parentCrashAfterExit,
    descendantExitOnTerm,
    descendantReaped,
  }

  // ---------- invariants ----------
  // 1-3 tell the designs apart. 4 and 5 hold by construction in every design (sanity checks).
  // 1 and 6 also rest on the canTick premise that timers fire at their deadline.

  // 1. Once the grace period after SIGTERM / disconnect passes, the child is never still running
  //    (even when the parent has died and nobody will send SIGKILL). "Child" is the turn process
  //    itself; descendants left in its process group are not covered.
  val exitsByDeadline: bool =
    (s.exitAfterStartedAt != -1 and s.clock > s.exitAfterStartedAt + GRACE)
      implies s.status != Running

  // 2. The child never exits with code 0 unless cleanup actually completed.
  val noZeroExitWithoutCleanup: bool =
    s.status == ExitedZero implies s.cleanup == CleanupDone

  // 3. If shutdown() waits on something that never settles (turn, close() or initialization),
  //    the child never exits with code 0.
  val stalledCleanupNeverExitsZero: bool =
    (s.stallAt != StallNone and s.status != Running) implies s.status != ExitedZero

  // 4. Writing the cleanup timeout diagnostic always corresponds to exit code 1.
  val timeoutExitsOne: bool =
    s.timedOutMsg implies s.status == ExitedOne

  // 5. Failed cleanup (close error or broken IPC before shutdown_complete) never exits 0.
  val failedCleanupNeverExitsZero: bool =
    s.cleanup == CleanupFailed implies s.status != ExitedZero

  // 6. While the parent is alive, parent-driven shutdown also finishes within GRACE.
  val parentAliveBoundedShutdown: bool =
    (s.parent == ParentAlive and s.parentShutdownAt != -1 and s.clock > s.parentShutdownAt + GRACE)
      implies s.status != Running

  // 7. Starting cleanup always aborts an active turn. The behavioural side (a cooperative turn
  //    finishes only after abort) is in cleanupBlocked and checked by the noAbort mutant.
  val cleanupAbortsActiveTurn: bool =
    (s.cleanup != CleanIdle and s.hasTurn) implies s.aborted

  // 8. (#177) Once the turn process has exited and no parent is left to sweep its group, every
  //    descendant still running in that group has been sent SIGTERM. A descendant that ignores
  //    SIGTERM can still stay (see wOrphanIgnoringDescendantLeft); nothing can SIGKILL it.
  val orphanedGroupSignalled: bool =
    (s.status != Running and s.parent == ParentDead and s.groupLeader and s.descAlive)
      implies s.descTermed

  // 9. (#177, by construction) The turn process signals only the group it leads. When it is not a
  //    group leader, -process.pid names no group and a descendant in someone else's group is not
  //    touched.
  val signalsOnlyOwnGroup: bool =
    not(s.groupLeader) implies not(s.descTermed)

  // 10. (#177 / macOS) Parent's post-exit managed.terminate() does not report a spurious EPERM
  //     to turnProcessHost's onError when the group holds only unreaped zombies left by signalOwnGroup().
  val noSpuriousParentSweepError: bool =
    not(s.parentSweepError)

  // 11. (#177 / macOS, by construction) A clean parent sweep finishes only after no live or zombie
  //     member remains in the group (waitForPosixProcessGroupExit observed ESRCH).
  val parentSweepClearsGroup: bool =
    (s.sweep == SweepDone and not(s.parentSweepError))
      implies (not(s.descAlive) and not(s.descZombie))

  val safety: bool = all {
    exitsByDeadline,
    noZeroExitWithoutCleanup,
    stalledCleanupNeverExitsZero,
    timeoutExitsOne,
    failedCleanupNeverExitsZero,
    parentAliveBoundedShutdown,
    cleanupAbortsActiveTurn,
    orphanedGroupSignalled,
    signalsOnlyOwnGroup,
    noSpuriousParentSweepError,
    parentSweepClearsGroup,
  }

  // ---------- witnesses ----------

  val wTimeoutAfterSigterm: bool =
    s.status == ExitedOne and s.timedOutMsg and s.ipcConnected

  val wTimeoutAfterDisconnectHoldsHandle: bool =
    s.status == ExitedOne and s.timedOutMsg and not(s.ipcConnected) and s.holdsHandle

  val wTimeoutAfterDisconnectNoHandle: bool =
    s.status == ExitedOne and s.timedOutMsg and not(s.ipcConnected) and not(s.holdsHandle)

  val wTimeoutCloseHangsNoHandle: bool =
    s.status == ExitedOne and s.timedOutMsg and s.stallAt == StallClose and not(s.hasTurn)
      and not(s.ipcConnected) and not(s.holdsHandle)

  val wTimeoutInitHangs: bool =
    s.status == ExitedOne and s.timedOutMsg and s.stallAt == StallInit

  val wCleanExitAfterSigterm: bool =
    s.status == ExitedZero and s.cleanup == CleanupDone and s.inExitAfter

  val wCooperativeTurnCleanExit: bool =
    s.status == ExitedZero and s.cleanup == CleanupDone and s.hasTurn

  val wCleanExitAfterShutdownMsg: bool =
    s.status == ExitedZero and s.cleanup == CleanupDone and not(s.inExitAfter) and s.parentShutdownAt != -1

  val wFailedCleanupExitsOne: bool =
    s.status == ExitedOne and s.cleanup == CleanupFailed and not(s.timedOutMsg)

  val wParentSigkill: bool =
    s.status == KilledByParent

  val wDoubleTriggerTimeout: bool =
    s.status == ExitedOne and s.timedOutMsg and s.exitAfterCount >= 2

  val wShutdownMsgThenParentCrashTimeout: bool =
    s.status == ExitedOne and s.timedOutMsg and s.parent == ParentDead and s.inExitAfter

  // #177 witnesses
  val wOrphanDescendantGoneAfterTimeout: bool =
    s.timedOutMsg and s.parent == ParentDead and s.desc == DescHonorsTerm and s.groupLeader and not(s.descAlive)

  val wOrphanDescendantGoneAfterFailedCleanup: bool =
    s.cleanup == CleanupFailed and not(s.timedOutMsg) and s.parent == ParentDead
      and s.desc == DescHonorsTerm and s.groupLeader and not(s.descAlive)

  // Known residual: a descendant that ignores SIGTERM stays once the parent is gone.
  val wOrphanIgnoringDescendantLeft: bool =
    s.status != Running and s.parent == ParentDead and s.desc == DescIgnoresTerm and s.groupLeader
      and s.descAlive and s.descTermed

  val wParentSweepAfterExit: bool =
    s.lastAction == "parentSweepAfterExit"

  val wParentCrashAfterExitSignalled: bool =
    s.lastAction == "parentCrashAfterExit" and s.groupLeader and s.descAlive and s.descTermed

  val wNonLeaderDescendantUntouched: bool =
    s.status != Running and not(s.groupLeader) and s.groupSignalled and s.descAlive and not(s.descTermed)

  val wParentSweepWaitsZombieReap: bool =
    s.lastAction == "parentSweepFinishAfterReap" and s.sweep == SweepDone and not(s.parentSweepError)

  val wParentCrashAfterDisconnect: bool =
    s.lastAction == "parentCrashAfterDisconnect"
}

module before {
  import turnProcessExitDeadline(DESIGN = "Before", GROUP_SIGNAL = "None", SWEEP_ZOMBIE_EPERM = "Throw", ABORTS_ON_SHUTDOWN = true).*
}

module unrefTimer {
  import turnProcessExitDeadline(DESIGN = "UnrefTimer", GROUP_SIGNAL = "None", SWEEP_ZOMBIE_EPERM = "Throw", ABORTS_ON_SHUTDOWN = true).*
}

// The code as of #141 (0a8bf2f2b): the deadline exists, but nothing is sent to the group.
module noGroupSignal {
  import turnProcessExitDeadline(DESIGN = "Fixed", GROUP_SIGNAL = "None", SWEEP_ZOMBIE_EPERM = "Throw", ABORTS_ON_SHUTDOWN = true).*
}

// The proposal in #177 as written: only the deadline timer signals the group.
module timeoutOnlyGroupSignal {
  import turnProcessExitDeadline(DESIGN = "Fixed", GROUP_SIGNAL = "TimeoutOnly", SWEEP_ZOMBIE_EPERM = "Throw", ABORTS_ON_SHUTDOWN = true).*
}

// Pre-review #177 design (06c8b3f1f): signals on every exit, but spawn.ts still throws on macOS
// zombie-only group EPERM during the parent's post-exit managed.terminate() sweep.
module everyExitWithoutEpermFix {
  import turnProcessExitDeadline(DESIGN = "Fixed", GROUP_SIGNAL = "EveryExit", SWEEP_ZOMBIE_EPERM = "Throw", ABORTS_ON_SHUTDOWN = true).*
}

// Target: #141 deadline + group SIGTERM before every exit in exitAfter + macOS zombie-group EPERM wait (#177).
module fixed {
  import turnProcessExitDeadline(DESIGN = "Fixed", GROUP_SIGNAL = "EveryExit", SWEEP_ZOMBIE_EPERM = "WaitReap", ABORTS_ON_SHUTDOWN = true).*
}

// Mutant: the fixed exitAfter, but shutdown() forgets to abort the active turn.
module noAbort {
  import turnProcessExitDeadline(DESIGN = "Fixed", GROUP_SIGNAL = "EveryExit", SWEEP_ZOMBIE_EPERM = "WaitReap", ABORTS_ON_SHUTDOWN = false).*
}

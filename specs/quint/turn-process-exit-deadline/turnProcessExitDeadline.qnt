// -*- mode: Bluespec; -*-
// Shutdown and exit deadline state machine for the daemon turn child process
// (src/app/daemon-turn/index.ts + src/features/daemonTurn/processRuntime.ts
//  + src/features/daemon/turnProcessHost.ts).
//
// Issue: https://github.com/j5ik2o/takt/issues/141
// PR:    https://github.com/j5ik2o/takt/pull/166
//
// DESIGN picks the child exitAfter implementation:
//   "Before"     - 337062193: exitAfter waits for cleanup without a deadline timer.
//   "UnrefTimer" - exitAfter sets a TURN_SHUTDOWN_GRACE_MS timer, but calls .unref() on it.
//   "Fixed"      - 0a8bf2f2b: exitAfter sets a ref'd setTimeout(..., TURN_SHUTDOWN_GRACE_MS)
//                  that writes 'Turn process cleanup timed out\n' and calls process.exit(1).
module turnProcessExitDeadline {
  const DESIGN: str

  // Models TURN_SHUTDOWN_GRACE_MS (5_000 ms in src/core/daemon/processProtocol.ts),
  // shared between parent (turnProcessHost.ts) and child (daemon-turn/index.ts).
  pure val GRACE: int = 2
  pure val MAX_CLOCK: int = 6

  type TurnMode = Idle | Cooperative | IgnoresAbort
  type CleanupState = CleanIdle | Cleaning | CleanupDone | CleanupFailed
  type ExitStatus = Running | ExitedZero | ExitedOne | KilledByParent
  type ParentState = ParentAlive | ParentDead

  type State = {
    // Initial run configuration
    initialized: bool,
    turnMode: TurnMode,
    holdsHandle: bool,
    closeFails: bool,

    // Parent and IPC channel state
    parent: ParentState,
    ipcConnected: bool,
    parentShutdownAt: int,

    // Child lifecycle and cleanup state
    clock: int,
    cleanup: CleanupState,
    aborted: bool,
    exitCodeFlag: int,
    inExitAfter: bool,
    exitAfterStartedAt: int,
    exitAfterDeadline: int,
    hasRefTimer: bool,
    timedOutMsg: bool,
    exitAfterCount: int,
    status: ExitStatus,
    lastAction: str,
  }

  var s: State

  // ---------- functional layer ----------

  pure def startShutdownState(st: State): State =
    if (st.cleanup != CleanIdle) st
    else {
      ...st,
      cleanup: Cleaning,
      aborted: st.aborted or (st.turnMode != Idle),
    }

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

  pure def canCleanupResolve(st: State): bool =
    st.status == Running
      and st.cleanup == Cleaning
      and st.turnMode != IgnoresAbort
      and not(st.closeFails)
      and (not(st.initialized) or st.ipcConnected)

  pure def applyCleanupResolve(st: State): State = {
    val exitStatus = if (st.exitCodeFlag == 1) ExitedOne else ExitedZero
    {
      ...st,
      cleanup: CleanupDone,
      ipcConnected: false,
      status: exitStatus,
      lastAction: "cleanupResolve",
    }
  }

  pure def canCleanupReject(st: State): bool =
    st.status == Running
      and st.cleanup == Cleaning
      and st.turnMode != IgnoresAbort
      and (st.closeFails or (st.initialized and not(st.ipcConnected)))

  pure def applyCleanupReject(st: State): State = {
    {
      ...st,
      cleanup: CleanupFailed,
      exitCodeFlag: 1,
      ipcConnected: false,
      status: ExitedOne,
      lastAction: "cleanupReject",
    }
  }

  pure def canEventLoopDrain(st: State): bool =
    st.status == Running
      and not(st.ipcConnected)
      and not(st.holdsHandle)
      and not(st.hasRefTimer)

  pure def applyEventLoopDrain(st: State): State = {
    val exitStatus = if (st.exitCodeFlag == 1) ExitedOne else ExitedZero
    {
      ...st,
      status: exitStatus,
      lastAction: "eventLoopDrain",
    }
  }

  pure def canChildDeadlineFire(st: State): bool =
    st.status == Running
      and st.exitAfterDeadline != -1
      and st.clock >= st.exitAfterDeadline

  pure def applyChildDeadlineFire(st: State): State = {
    {
      ...st,
      timedOutMsg: true,
      status: ExitedOne,
      lastAction: "childDeadlineFire",
    }
  }

  pure def canParentSigkill(st: State): bool =
    st.status == Running
      and st.parent == ParentAlive
      and st.parentShutdownAt != -1
      and st.clock >= st.parentShutdownAt + GRACE

  pure def applyParentSigkill(st: State): State = {
    {
      ...st,
      status: KilledByParent,
      lastAction: "parentSigkill",
    }
  }

  pure def canTick(st: State): bool =
    st.status == Running
      and st.clock < MAX_CLOCK
      and not(canChildDeadlineFire(st))
      and not(canParentSigkill(st))

  pure def applyTick(st: State): State =
    { ...st, clock: st.clock + 1, lastAction: "tick" }

  // ---------- state machine ----------

  action initWith(initDone: bool, mode: TurnMode, holds: bool, closeErr: bool): bool = all {
    s' = {
      initialized: initDone,
      turnMode: mode,
      holdsHandle: holds,
      closeFails: closeErr,
      parent: ParentAlive,
      ipcConnected: true,
      parentShutdownAt: -1,
      clock: 0,
      cleanup: CleanIdle,
      aborted: false,
      exitCodeFlag: 0,
      inExitAfter: false,
      exitAfterStartedAt: -1,
      exitAfterDeadline: -1,
      hasRefTimer: false,
      timedOutMsg: false,
      exitAfterCount: 0,
      status: Running,
      lastAction: "init",
    },
  }

  action init: bool = {
    nondet initDone = Set(true, false).oneOf()
    nondet mode = Set(Idle, Cooperative, IgnoresAbort).oneOf()
    nondet holds = Set(true, false).oneOf()
    nondet closeErr = Set(true, false).oneOf()
    val validMode = if (initDone) mode else Idle
    val validCloseErr = if (initDone) closeErr else false
    initWith(initDone, validMode, holds, validCloseErr)
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

  action step: bool = any {
    receiveShutdownMsg,
    receiveSigterm,
    parentCrashAndDisconnect,
    ipcDisconnectWhileParentAlive,
    cleanupResolve,
    cleanupReject,
    eventLoopDrain,
    childDeadlineFire,
    parentSigkill,
    tick,
  }

  // ---------- invariants ----------

  // 1. Once the grace period after SIGTERM / disconnect passes, the child is never still running
  //    (even when the parent has died and nobody will send SIGKILL).
  val exitsByDeadline: bool =
    (s.exitAfterStartedAt != -1 and s.clock > s.exitAfterStartedAt + GRACE)
      implies s.status != Running

  // 2. The child never exits with code 0 unless cleanup actually completed.
  val noZeroExitWithoutCleanup: bool =
    s.status == ExitedZero implies s.cleanup == CleanupDone

  // 3. A child whose active turn ignores abort never exits with code 0.
  val abortIgnoringNeverExitsZero: bool =
    (s.turnMode == IgnoresAbort and s.status != Running) implies s.status != ExitedZero

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

  // 7. Starting cleanup always aborts an active turn.
  val cleanupAbortsActiveTurn: bool =
    (s.cleanup != CleanIdle and s.turnMode != Idle) implies s.aborted

  val safety: bool = all {
    exitsByDeadline,
    noZeroExitWithoutCleanup,
    abortIgnoringNeverExitsZero,
    timeoutExitsOne,
    failedCleanupNeverExitsZero,
    parentAliveBoundedShutdown,
    cleanupAbortsActiveTurn,
  }

  // ---------- witnesses ----------

  val wTimeoutAfterSigterm: bool =
    s.status == ExitedOne and s.timedOutMsg and s.ipcConnected

  val wTimeoutAfterDisconnectHoldsHandle: bool =
    s.status == ExitedOne and s.timedOutMsg and not(s.ipcConnected) and s.holdsHandle

  val wTimeoutAfterDisconnectNoHandle: bool =
    s.status == ExitedOne and s.timedOutMsg and not(s.ipcConnected) and not(s.holdsHandle)

  val wCleanExitAfterSigterm: bool =
    s.status == ExitedZero and s.cleanup == CleanupDone and s.inExitAfter

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
}

module before {
  import turnProcessExitDeadline(DESIGN = "Before").*
}

module unrefTimer {
  import turnProcessExitDeadline(DESIGN = "UnrefTimer").*
}

module fixed {
  import turnProcessExitDeadline(DESIGN = "Fixed").*
}

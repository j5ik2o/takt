// -*- mode: Bluespec; -*-
// Scenario tests for specs/quint/turn-process-exit-deadline/turnProcessExitDeadline.qnt.
// initWith(initialized, hasTurn, stallAt, holdsHandle, closeFails)
// initWithGroup(initialized, hasTurn, stallAt, holdsHandle, closeFails, desc, groupLeader)
module beforeTest {
  import turnProcessExitDeadline(DESIGN = "Before", GROUP_SIGNAL = "None", ABORTS_ON_SHUTDOWN = true).* from "./turnProcessExitDeadline"

  // Before #141: abort-ignoring turn with an open handle stays running past GRACE after disconnect.
  run disconnectHangsPastDeadlineTest =
    initWith(true, true, StallTurn, true, false)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(tick)
      .then(tick)
      .expect(s.status == Running and not(exitsByDeadline))

  // Before #141: abort-ignoring turn with an open handle stays running past GRACE after SIGTERM.
  run sigtermHangsPastDeadlineTest =
    initWith(true, true, StallTurn, true, false)
      .then(receiveSigterm)
      .then(tick)
      .then(tick)
      .then(tick)
      .expect(s.status == Running and not(exitsByDeadline))

  // Before #141: abort-ignoring turn with no open handle exits 0 when IPC disconnects.
  run disconnectNoHandleExitsZeroTest =
    initWith(true, true, StallTurn, false, false)
      .then(parentCrashAndDisconnect)
      .then(eventLoopDrain)
      .expect(s.status == ExitedZero and s.cleanup == Cleaning and not(noZeroExitWithoutCleanup))

  // Before #141: business.close() hangs with no turn and no handle -> exits 0 after disconnect.
  run closeHangsNoHandleExitsZeroTest =
    initWith(true, false, StallClose, false, false)
      .then(parentCrashAndDisconnect)
      .then(eventLoopDrain)
      .expect(s.status == ExitedZero and not(stalledCleanupNeverExitsZero))

  // An idle, initialized child cannot drain to 0: shutdown_complete fails in a microtask first.
  run idleDisconnectDoesNotDrainTest =
    initWith(true, false, StallNone, false, false)
      .then(parentCrashAndDisconnect)
      .expect(not(canEventLoopDrain(s)) and canCleanupReject(s))
}

module unrefTimerTest {
  import turnProcessExitDeadline(DESIGN = "UnrefTimer", GROUP_SIGNAL = "None", ABORTS_ON_SHUTDOWN = true).* from "./turnProcessExitDeadline"

  // Calling .unref() on the deadline timer still allows exit 0 when no other handle is held.
  run unrefTimerStillExitsZeroTest =
    initWith(true, true, StallTurn, false, false)
      .then(parentCrashAndDisconnect)
      .then(eventLoopDrain)
      .expect(s.status == ExitedZero and s.cleanup == Cleaning and not(noZeroExitWithoutCleanup))
}

// #177: the code as of #141. The deadline ends the turn process, but its group is never signalled.
module noGroupSignalTest {
  import turnProcessExitDeadline(DESIGN = "Fixed", GROUP_SIGNAL = "None", ABORTS_ON_SHUTDOWN = true).* from "./turnProcessExitDeadline"

  // Parent crashes, the turn ignores abort, the deadline exits 1: the descendant gets nothing.
  run orphanDescendantLeftAfterTimeoutTest =
    initWithGroup(true, true, StallTurn, true, false, DescHonorsTerm, true)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.descAlive and not(s.descTermed) and not(orphanedGroupSignalled))
      .expect(not(canDescendantExitOnTerm(s)) and not(canParentSweepAfterExit(s)))

  // business.close() hangs with no turn: same leftover.
  run orphanDescendantLeftWhenCloseHangsTest =
    initWithGroup(true, false, StallClose, false, false, DescHonorsTerm, true)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.descAlive and not(orphanedGroupSignalled))

  // With the parent alive, its sweep after the leader exit removes the descendant (no regression to fix there).
  run parentAliveSweepsWithoutGroupSignalTest =
    initWithGroup(true, true, StallNone, false, false, DescIgnoresTerm, true)
      .then(receiveShutdownMsg)
      .then(cleanupResolve)
      .then(parentSweepAfterExit)
      .expect(not(s.descAlive) and safety)

  // The parent dies between the leader exit and its sweep: the descendant stays.
  run parentCrashBeforeSweepLeavesDescendantTest =
    initWithGroup(true, true, StallNone, false, false, DescHonorsTerm, true)
      .then(receiveShutdownMsg)
      .then(cleanupResolve)
      .then(parentCrashAfterExit)
      .expect(s.descAlive and not(orphanedGroupSignalled))
}

// #177 as proposed in the issue: only the deadline timer signals the group.
module timeoutOnlyGroupSignalTest {
  import turnProcessExitDeadline(DESIGN = "Fixed", GROUP_SIGNAL = "TimeoutOnly", ABORTS_ON_SHUTDOWN = true).* from "./turnProcessExitDeadline"

  run timeoutSignalsGroupTest =
    initWithGroup(true, true, StallTurn, true, false, DescHonorsTerm, true)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.descTermed and orphanedGroupSignalled)
      .then(descendantExitOnTerm)
      .expect(not(s.descAlive))

  // A cooperative turn after the parent crashed: shutdown_complete fails, fatal, exit(1) before the
  // deadline. The group is not signalled, so the descendant the turn left behind stays.
  run failedCleanupLeavesDescendantTest =
    initWithGroup(true, true, StallNone, false, false, DescHonorsTerm, true)
      .then(parentCrashAndDisconnect)
      .then(cleanupReject)
      .expect(s.status == ExitedOne and not(s.timedOutMsg) and s.descAlive and not(orphanedGroupSignalled))
}

module fixedTest {
  import turnProcessExitDeadline(DESIGN = "Fixed", GROUP_SIGNAL = "EveryExit", ABORTS_ON_SHUTDOWN = true).* from "./turnProcessExitDeadline"

  // Constants sanity check (GRACE > 0 and MAX_CLOCK > GRACE).
  run constantsSanityTest = all {
    GRACE > 0,
    MAX_CLOCK > GRACE,
  }

  // A child before `initialize` has no turn, nothing to close and nothing to stall on.
  run uninitializedConfigRejectedTest = all {
    not(validConfig(false, true, StallNone, false)),
    not(validConfig(false, false, StallClose, false)),
    not(validConfig(true, false, StallTurn, false)),
    not(validConfig(true, true, StallInit, false)),
    validConfig(true, false, StallInit, false),
  }

  // Regression case 1: SIGTERM + abort-ignoring turn + open handle -> exits 1 at GRACE with timeout msg.
  run sigtermAbortIgnoringHoldsHandleTest =
    initWith(true, true, StallTurn, true, false)
      .then(receiveSigterm)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and s.clock == GRACE and safety)

  // Regression case 2: disconnect (parent dead) + abort-ignoring turn + open handle -> exits 1 at GRACE.
  run disconnectAbortIgnoringHoldsHandleTest =
    initWith(true, true, StallTurn, true, false)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and s.clock == GRACE and safety)

  // Regression case 3: disconnect (parent dead) + abort-ignoring turn + no handle ->
  // eventLoopDrain is disabled by the ref'd timer, so it waits until GRACE and exits 1.
  run disconnectAbortIgnoringNoHandleTest =
    initWith(true, true, StallTurn, false, false)
      .then(parentCrashAndDisconnect)
      .expect(not(canEventLoopDrain(s)) and s.hasRefTimer)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and safety)

  // business.close() hangs, no turn, no handle, parent dead -> the ref'd timer exits 1 at GRACE.
  run closeHangsNoHandleDisconnectExitsOneTest =
    initWith(true, false, StallClose, false, false)
      .then(parentCrashAndDisconnect)
      .expect(not(canEventLoopDrain(s)) and not(canCleanupResolve(s)) and not(canCleanupReject(s)))
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and s.clock == GRACE and safety)

  // createBusiness never settles and SIGTERM arrives during `initialize` -> exits 1 at GRACE.
  run initHangsSigtermExitsOneTest =
    initWith(true, false, StallInit, true, false)
      .then(receiveSigterm)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and safety)

  // Cooperative turn finishes cleanup within GRACE after SIGTERM -> exits 0 immediately.
  run cooperativeSigtermCleanExitTest =
    initWith(true, true, StallNone, true, false)
      .then(receiveSigterm)
      .expect(s.aborted)
      .then(cleanupResolve)
      .expect(s.status == ExitedZero and s.cleanup == CleanupDone and not(s.timedOutMsg) and safety)

  // Cooperative turn after disconnect -> cannot send turn_finished / shutdown_complete -> exits 1.
  run cooperativeDisconnectExitsOneTest =
    initWith(true, true, StallNone, false, false)
      .then(parentCrashAndDisconnect)
      .then(cleanupReject)
      .expect(s.status == ExitedOne and s.cleanup == CleanupFailed and not(s.timedOutMsg) and safety)

  // Cooperative turn when business.close() fails after SIGTERM -> exits 1.
  run closeFailureExitsOneTest =
    initWith(true, true, StallNone, false, true)
      .then(receiveSigterm)
      .then(cleanupReject)
      .expect(s.status == ExitedOne and s.cleanup == CleanupFailed and safety)

  // Normal IPC shutdown message with cooperative turn -> exits 0 cleanly.
  run normalShutdownMessageExitsZeroTest =
    initWith(true, true, StallNone, false, false)
      .then(receiveShutdownMsg)
      .then(cleanupResolve)
      .expect(s.status == ExitedZero and s.cleanup == CleanupDone and safety)

  // Shutdown message sent by parent, then parent crashes mid-cleanup -> disconnect arms child deadline -> exits 1.
  run shutdownMsgThenParentCrashExitsOneTest =
    initWith(true, true, StallTurn, true, false)
      .then(receiveShutdownMsg)
      .then(tick)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and s.clock == 1 + GRACE and safety)

  // Double trigger (SIGTERM at t=0, disconnect at t=1) still enforces the first deadline (t=GRACE).
  run sigtermThenDisconnectKeepsFirstDeadlineTest =
    initWith(true, true, StallTurn, true, false)
      .then(receiveSigterm)
      .then(tick)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and s.clock == GRACE and safety)

  // Parent alive during shutdown with abort-ignoring turn -> parent SIGKILLs at GRACE.
  run parentAliveSigkillsAtGraceTest =
    initWith(true, true, StallTurn, true, false)
      .then(receiveShutdownMsg)
      .then(tick)
      .then(tick)
      .then(parentSigkill)
      .expect(s.status == KilledByParent and s.clock == GRACE and safety)

  // #177: parent crashed, abort-ignoring turn: the deadline signals the group, then exits 1.
  run orphanTimeoutSignalsGroupTest =
    initWithGroup(true, true, StallTurn, true, false, DescHonorsTerm, true)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and s.descTermed and safety)
      .then(descendantExitOnTerm)
      .expect(not(s.descAlive) and safety)

  // #177: close() hangs with no turn and no handle, parent dead: same group signal at the deadline.
  run orphanCloseHangsSignalsGroupTest =
    initWithGroup(true, false, StallClose, false, false, DescHonorsTerm, true)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.descTermed and safety)

  // #177: cooperative turn after the parent crashed exits 1 through fatal; the group is still signalled.
  run orphanFailedCleanupSignalsGroupTest =
    initWithGroup(true, true, StallNone, false, false, DescHonorsTerm, true)
      .then(parentCrashAndDisconnect)
      .then(cleanupReject)
      .expect(s.status == ExitedOne and not(s.timedOutMsg) and s.descTermed and safety)

  // #177: a clean exit signals the group too; the parent dying before its sweep leaves nothing unsignalled.
  run parentCrashAfterCleanExitStillSignalledTest =
    initWithGroup(true, true, StallNone, false, false, DescHonorsTerm, true)
      .then(receiveShutdownMsg)
      .then(cleanupResolve)
      .then(parentCrashAfterExit)
      .expect(s.status == ExitedZero and s.descTermed and safety)
      .then(descendantExitOnTerm)
      .expect(not(s.descAlive))

  // #177: with the parent alive, its SIGKILL ends a descendant that ignores SIGTERM.
  run parentSigkillEndsIgnoringDescendantTest =
    initWithGroup(true, true, StallTurn, true, false, DescIgnoresTerm, true)
      .then(receiveShutdownMsg)
      .then(tick)
      .then(tick)
      .then(parentSigkill)
      .expect(s.status == KilledByParent and not(s.descAlive) and safety)

  // #177 residual: parent dead and the descendant ignores SIGTERM. It was signalled, and it stays.
  run orphanIgnoringDescendantStaysTest =
    initWithGroup(true, true, StallTurn, true, false, DescIgnoresTerm, true)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.descAlive and s.descTermed and not(canDescendantExitOnTerm(s)) and safety)

  // #177: not a group leader (spawned without detached): -process.pid names no group, nothing is touched.
  run nonLeaderSignalsNothingTest =
    initWithGroup(true, true, StallTurn, true, false, DescHonorsTerm, false)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.groupSignalled and s.descAlive and not(s.descTermed) and safety)
}

module noAbortTest {
  import turnProcessExitDeadline(DESIGN = "Fixed", GROUP_SIGNAL = "EveryExit", ABORTS_ON_SHUTDOWN = false).* from "./turnProcessExitDeadline"

  // Mutant: shutdown() does not abort. A cooperative turn then cannot finish, so cleanup never
  // settles and only the deadline ends the process (exit 1 instead of a clean exit 0).
  run cooperativeTurnWithoutAbortTimesOutTest =
    initWith(true, true, StallNone, true, false)
      .then(receiveSigterm)
      .expect(not(s.aborted) and not(canCleanupResolve(s)) and not(canCleanupReject(s)))
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and not(cleanupAbortsActiveTurn))
}

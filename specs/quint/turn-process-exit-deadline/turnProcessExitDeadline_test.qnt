// -*- mode: Bluespec; -*-
// Scenario tests for specs/quint/turn-process-exit-deadline/turnProcessExitDeadline.qnt.
// initWith(initialized, hasTurn, stallAt, holdsHandle, closeFails)
module beforeTest {
  import turnProcessExitDeadline(DESIGN = "Before", ABORTS_ON_SHUTDOWN = true).* from "./turnProcessExitDeadline"

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
  import turnProcessExitDeadline(DESIGN = "UnrefTimer", ABORTS_ON_SHUTDOWN = true).* from "./turnProcessExitDeadline"

  // Calling .unref() on the deadline timer still allows exit 0 when no other handle is held.
  run unrefTimerStillExitsZeroTest =
    initWith(true, true, StallTurn, false, false)
      .then(parentCrashAndDisconnect)
      .then(eventLoopDrain)
      .expect(s.status == ExitedZero and s.cleanup == Cleaning and not(noZeroExitWithoutCleanup))
}

module fixedTest {
  import turnProcessExitDeadline(DESIGN = "Fixed", ABORTS_ON_SHUTDOWN = true).* from "./turnProcessExitDeadline"

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
}

module noAbortTest {
  import turnProcessExitDeadline(DESIGN = "Fixed", ABORTS_ON_SHUTDOWN = false).* from "./turnProcessExitDeadline"

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

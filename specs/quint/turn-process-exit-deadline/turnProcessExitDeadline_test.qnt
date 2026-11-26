// -*- mode: Bluespec; -*-
// Scenario tests for specs/quint/turn-process-exit-deadline/turnProcessExitDeadline.qnt.
module beforeTest {
  import turnProcessExitDeadline(DESIGN = "Before").* from "./turnProcessExitDeadline"

  // Before #141: abort-ignoring turn with an open handle stays running past GRACE after disconnect.
  run disconnectHangsPastDeadlineTest =
    initWith(true, IgnoresAbort, true, false)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(tick)
      .then(tick)
      .expect(s.status == Running and not(exitsByDeadline))

  // Before #141: abort-ignoring turn with an open handle stays running past GRACE after SIGTERM.
  run sigtermHangsPastDeadlineTest =
    initWith(true, IgnoresAbort, true, false)
      .then(receiveSigterm)
      .then(tick)
      .then(tick)
      .then(tick)
      .expect(s.status == Running and not(exitsByDeadline))

  // Before #141: abort-ignoring turn with no open handle exits 0 when IPC disconnects.
  run disconnectNoHandleExitsZeroTest =
    initWith(true, IgnoresAbort, false, false)
      .then(parentCrashAndDisconnect)
      .then(eventLoopDrain)
      .expect(s.status == ExitedZero and s.cleanup == Cleaning and not(noZeroExitWithoutCleanup))
}

module unrefTimerTest {
  import turnProcessExitDeadline(DESIGN = "UnrefTimer").* from "./turnProcessExitDeadline"

  // Calling .unref() on the deadline timer still allows exit 0 when no other handle is held.
  run unrefTimerStillExitsZeroTest =
    initWith(true, IgnoresAbort, false, false)
      .then(parentCrashAndDisconnect)
      .then(eventLoopDrain)
      .expect(s.status == ExitedZero and s.cleanup == Cleaning and not(noZeroExitWithoutCleanup))
}

module fixedTest {
  import turnProcessExitDeadline(DESIGN = "Fixed").* from "./turnProcessExitDeadline"

  // Constants sanity check (GRACE > 0 and MAX_CLOCK > GRACE).
  run constantsSanityTest = all {
    GRACE > 0,
    MAX_CLOCK > GRACE,
  }

  // Regression case 1: SIGTERM + abort-ignoring turn + open handle -> exits 1 at GRACE with timeout msg.
  run sigtermAbortIgnoringHoldsHandleTest =
    initWith(true, IgnoresAbort, true, false)
      .then(receiveSigterm)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and s.clock == GRACE and safety)

  // Regression case 2: disconnect (parent dead) + abort-ignoring turn + open handle -> exits 1 at GRACE.
  run disconnectAbortIgnoringHoldsHandleTest =
    initWith(true, IgnoresAbort, true, false)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and s.clock == GRACE and safety)

  // Regression case 3: disconnect (parent dead) + abort-ignoring turn + no handle ->
  // eventLoopDrain is disabled by the ref'd timer, so it waits until GRACE and exits 1.
  run disconnectAbortIgnoringNoHandleTest =
    initWith(true, IgnoresAbort, false, false)
      .then(parentCrashAndDisconnect)
      .expect(not(canEventLoopDrain(s)) and s.hasRefTimer)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and safety)

  // Cooperative turn finishes cleanup within GRACE after SIGTERM -> exits 0 immediately.
  run cooperativeSigtermCleanExitTest =
    initWith(true, Cooperative, true, false)
      .then(receiveSigterm)
      .then(cleanupResolve)
      .expect(s.status == ExitedZero and s.cleanup == CleanupDone and not(s.timedOutMsg) and safety)

  // Cooperative turn after disconnect -> cannot send shutdown_complete -> cleanup rejects -> exits 1.
  run cooperativeDisconnectExitsOneTest =
    initWith(true, Cooperative, false, false)
      .then(parentCrashAndDisconnect)
      .then(cleanupReject)
      .expect(s.status == ExitedOne and s.cleanup == CleanupFailed and not(s.timedOutMsg) and safety)

  // Cooperative turn when business.close() fails after SIGTERM -> exits 1.
  run closeFailureExitsOneTest =
    initWith(true, Cooperative, false, true)
      .then(receiveSigterm)
      .then(cleanupReject)
      .expect(s.status == ExitedOne and s.cleanup == CleanupFailed and safety)

  // Normal IPC shutdown message with cooperative turn -> exits 0 cleanly.
  run normalShutdownMessageExitsZeroTest =
    initWith(true, Cooperative, false, false)
      .then(receiveShutdownMsg)
      .then(cleanupResolve)
      .expect(s.status == ExitedZero and s.cleanup == CleanupDone and safety)

  // Shutdown message sent by parent, then parent crashes mid-cleanup -> disconnect arms child deadline -> exits 1.
  run shutdownMsgThenParentCrashExitsOneTest =
    initWith(true, IgnoresAbort, true, false)
      .then(receiveShutdownMsg)
      .then(tick)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and s.clock == 1 + GRACE and safety)

  // Double trigger (SIGTERM at t=0, disconnect at t=1) still enforces the first deadline (t=GRACE).
  run sigtermThenDisconnectKeepsFirstDeadlineTest =
    initWith(true, IgnoresAbort, true, false)
      .then(receiveSigterm)
      .then(tick)
      .then(parentCrashAndDisconnect)
      .then(tick)
      .then(childDeadlineFire)
      .expect(s.status == ExitedOne and s.timedOutMsg and s.clock == GRACE and safety)

  // Parent alive during shutdown with abort-ignoring turn -> parent SIGKILLs at GRACE.
  run parentAliveSigkillsAtGraceTest =
    initWith(true, IgnoresAbort, true, false)
      .then(receiveShutdownMsg)
      .then(tick)
      .then(tick)
      .then(parentSigkill)
      .expect(s.status == KilledByParent and s.clock == GRACE and safety)
}

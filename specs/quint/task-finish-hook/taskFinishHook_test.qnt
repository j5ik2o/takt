// -*- mode: Bluespec; -*-
// Scenario tests for the task finish hook. Run:
//   quint test taskFinishHook_test.qnt --main entryPointsTest
//   quint test taskFinishHook_test.qnt --main normalEndOnlyTest
//   quint test taskFinishHook_test.qnt --main everySaveTest
module entryPointsTest {
  import taskFinishHook(PLACEMENT = "AtEntryPoints").* from "./taskFinishHook"

  run successCallsOnceTest =
    initWith(QueueTask, true).then(finishAs(Success, 1)).then(startHook).then(endHookAs(HookOk)).then(returnToCaller)
      .expect(hookRuns == 1 and status == Completed and not(slotHeld))

  run exceededCallsOnceTest =
    initWith(QueueTask, true).then(finishAs(LimitExceeded, 2)).then(startHook).then(endHookAs(HookOk)).then(returnToCaller)
      .expect(hookRuns == 1 and status == Exceeded and resumePoint == 2)

  run prFailedCallsOnceTest =
    initWith(QueueTask, true).then(finishAs(PrCreateFailed, 1)).then(startHook).then(endHookAs(HookOk)).then(returnToCaller)
      .expect(hookRuns == 1 and status == PrFailed)

  run interruptedCallsOnceTest =
    initWith(QueueTask, true).then(finishAs(Interrupted, 1)).then(startHook).then(endHookAs(HookOk)).then(returnToCaller)
      .expect(hookRuns == 1 and status == Failed)

  // A queued merge task passes the queue entry only: one call, not two.
  run queuedMergeCallsOnceTest =
    initWith(QueueMergeTask, true).then(finishAs(Success, 1)).then(startHook).then(endHookAs(HookOk))
      .expect(pendingCalls == 0 and hookRuns == 1)

  run directMergeCallsOnceTest =
    initWith(DirectMerge, true).then(finishAs(WorkflowFailed, 1)).then(startHook).then(endHookAs(HookOk)).then(returnToCaller)
      .expect(hookRuns == 1 and status == Failed)

  // A command that times out keeps the slot until it is killed and leaves the saved state alone.
  run timeoutKeepsStateTest =
    initWith(QueueTask, true).then(finishAs(LimitExceeded, 3)).then(startHook)
      .expect(slotHeld and phase == Hooking)
      .then(endHookAs(HookTimeout)).then(returnToCaller)
      .expect(status == Exceeded and resumePoint == 3 and not(slotHeld))

  // No terminal state was saved: nothing to report.
  run saveThrewDoesNotCallTest =
    initWith(QueueTask, true).then(finishAs(SaveThrew, 1)).then(returnToCaller)
      .expect(hookRuns == 0 and status == Running)

  run unconfiguredDoesNotCallTest =
    initWith(QueueTask, false).then(finishAs(Success, 1)).then(returnToCaller)
      .expect(hookRuns == 0)
}

module normalEndOnlyTest {
  import taskFinishHook(PLACEMENT = "AtNormalEnd").* from "./taskFinishHook"

  // The first idea misses the early return of the iteration limit.
  run exceededIsMissedTest =
    initWith(QueueTask, true).then(finishAs(LimitExceeded, 2)).then(returnToCaller)
      .expect(hookRuns == 0 and not(noMissedExit))
}

module everySaveTest {
  import taskFinishHook(PLACEMENT = "AtEverySave").* from "./taskFinishHook"

  // A call next to every save runs the command twice for a queued merge task.
  run queuedMergeCallsTwiceTest =
    initWith(QueueMergeTask, true).then(finishAs(Success, 1))
      .then(startHook).then(endHookAs(HookOk)).then(startHook)
      .expect(hookRuns == 2 and not(atMostOnce))
}

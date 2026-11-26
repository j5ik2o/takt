// -*- mode: Bluespec; -*-
// Scenario tests for claiming goal tasks. Run:
//   quint test goalTaskClaim_test.qnt --main mergedTest
//   quint test goalTaskClaim_test.qnt --main forkP1Test
//   quint test goalTaskClaim_test.qnt --main fixedTest
// t1 is a runnable goal task, t2 and t3 are goal tasks whose runtime_assignment cannot be selected;
// t3 does not exist until addTask("t3").

// d2bd16a30: each review finding as a concrete trace.
module mergedTest {
  import goalTaskClaim(DESIGN = "Merged").* from "./goalTaskClaim"

  // Critical: afterClaim times out after t1 was saved as running; t1 is in no queue, and the setup
  // failure of t2 is never reported.
  run rereadTimeoutOrphansClaimedTaskTest =
    init.then(snapshot("A")).then(claimSaved("A", false)).then(rereadFails("A"))
      .expect(and {
        tasks.get("t1") == { status: Running, owner: "A" },
        procs.get("A").queue == Set(),
        not(noOrphanRunning),
        hooks.get("t2") == 0,
        not(noMissedSetupReport),
      })

  // The orphan stays: the next tick sees no pending task to claim.
  run orphanIsNotReclaimedTest =
    init.then(snapshot("A")).then(claimSaved("A", false)).then(rereadFails("A"))
      .then(snapshot("A")).then(claimSaved("A", false)).then(rereadOk("A"))
      .expect(procs.get("A").queue == Set() and not(noOrphanRunning))

  // High 2a: both read t2 as pending; B saves its setup failure; A's second read reports it too.
  run duplicateReportTest =
    init.then(snapshot("A")).then(snapshot("B")).then(claimSaved("B", false)).then(rereadOk("B"))
      .then(claimSaved("A", false)).then(rereadOk("A"))
      .expect(hooks.get("t2") == 2 and events.get("t2") == 2 and not(noDuplicateSetupReport))

  // High 2b: t3 is added after A's first read; A's claim saves it as failed but never reports it.
  run lateTaskReportMissedTest =
    init.then(snapshot("A")).then(addTask("t3")).then(claimSaved("A", false)).then(rereadOk("A"))
      .expect(and {
        setupFailedBy.get("t3") == "A",
        hooks.get("t3") == 0,
        not(noMissedSetupReport),
      })

  // Medium: a goal-execution.lock timeout stops claiming for the rest of the run.
  run goalLockTimeoutStopsTest =
    init.then(snapshot("A")).then(claimFails("A", GoalLockTimeout))
      .expect(procs.get("A").phase == Stopped and not(claimingNeverStops))
}

// 337062193 (PR #50) as it was: the races are gone, one gap remains.
module forkP1Test {
  import goalTaskClaim(DESIGN = "ForkP1").* from "./goalTaskClaim"

  run reportsOwnSetupFailureOnceTest =
    init.then(snapshot("A")).then(snapshot("B")).then(claimSaved("B", false)).then(claimSaved("A", false))
      .expect(hooks.get("t2") == 1 and events.get("t2") == 1 and safety)

  run lateTaskReportedTest =
    init.then(snapshot("A")).then(addTask("t3")).then(claimSaved("A", false))
      .expect(hooks.get("t3") == 1 and safety)

  // A failed manager-event write in onSetupFailed escapes the claim after the write: t1 is orphaned.
  run publishFailureOrphansClaimedTaskTest =
    init.then(snapshot("A")).then(claimSaved("A", true))
      .expect(not(noOrphanRunning) and not(claimingNeverStops))
}

// The fix.
module fixedTest {
  import goalTaskClaim(DESIGN = "Fixed").* from "./goalTaskClaim"

  run claimQueuesAndReportsTest =
    init.then(snapshot("A")).then(claimSaved("A", false))
      .expect(and {
        procs.get("A").queue == Set("t1"),
        hooks.get("t2") == 1, events.get("t2") == 1,
        safety,
      })

  run concurrentClaimsReportOnceTest =
    init.then(snapshot("A")).then(snapshot("B")).then(claimSaved("B", false)).then(claimSaved("A", false))
      .expect(hooks.get("t2") == 1 and setupFailedBy.get("t2") == "B" and safety)

  run lateTaskReportedTest =
    init.then(snapshot("A")).then(addTask("t3")).then(claimSaved("A", false))
      .expect(hooks.get("t3") == 1 and safety)

  // The event write fails: the claim still returns t1, the hook still fires, the failure is logged.
  run publishFailureKeepsClaimTest =
    init.then(snapshot("A")).then(claimSaved("A", true))
      .expect(and {
        procs.get("A").queue == Set("t1"),
        hooks.get("t2") == 1, events.get("t2") == 0, publishLogged.get("t2") == 1,
        safety,
      })

  run goalLockTimeoutRetriesTest =
    init.then(snapshot("A")).then(claimFails("A", GoalLockTimeout)).then(snapshot("A")).then(claimSaved("A", false))
      .expect(procs.get("A").queue == Set("t1") and safety)

  run transientTimeoutRetriesTest =
    init.then(snapshot("A")).then(claimFails("A", TasksLockTransient)).then(snapshot("A")).then(claimSaved("A", false))
      .expect(procs.get("A").queue == Set("t1") and safety)
}

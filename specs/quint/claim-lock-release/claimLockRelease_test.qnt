// -*- mode: Bluespec; -*-
// Scenario tests for a lock release that fails after a tasks.yaml write. Run:
//   quint test claimLockRelease_test.qnt --main currentTest
//   quint test claimLockRelease_test.qnt --main returnOnlyTest
//   quint test claimLockRelease_test.qnt --main firstDesignTest
//   quint test claimLockRelease_test.qnt --main fixedTest
// t1: a runnable pending goal task. t2: a pending goal task the claim saves as failed (setup
// failure: finish hook + manager event). t3: a running task whose owner (D) is dead (recovery:
// manager event). An invalidation fails the pending tasks (finish hook).

// integration/takt-mcp at ce641a0ce: each symptom of issue #169 as a concrete trace.
module currentTest {
  import claimLockRelease(DESIGN = "Current").* from "./claimLockRelease"

  // The claim saved t1 as running and t2 as failed; the release threw. Nothing is returned, the
  // setup failure of t2 is not notified, and claiming stops.
  run claimReleaseFailureOrphansClaimTest =
    init.then(claim("A", Stuck))
      .expect(and {
        tasks.get("t1") == { status: Running, owner: "A" },
        procs.get("A").queue == Set(),
        procs.get("A").phase == Stopped,
        not(noOrphanRunning),
        needHook.get("t2"), hooks.get("t2") == 0, events.get("t2") == 0,
        not(noLostNotice),
        not(stopsOnlyWhenUnlinkFails),
        releaseFailureReported,
      })

  // "ownership changed before release" leaves no lock behind, yet the claim stops all the same.
  run claimReleaseGoneStopsTest =
    init.then(claim("A", Gone))
      .expect(orphanOf == NONE and procs.get("A").phase == Stopped and not(noOrphanRunning))

  // The stopped run does not end as a clean run: it fails with the error.
  run stoppedRunDoesNotEndCleanTest =
    init.then(claim("A", Stuck)).then(endRun("A")).fail()

  // file-lock.ts cannot read its own lock file at release and returns silently: nothing is
  // reported, the finish hook's re-read waits on that file and is lost, and the next claim of the
  // same process waits on itself.
  run unreadableReleaseIsSilentTest =
    init.then(claim("A", Unseen))
      .expect(and {
        releaseFailures.get("A") == 1, releaseReported.get("A") == 0, not(releaseFailureReported),
        orphanOf == "A", not(orphanRecorded),
        events.get("t2") == 1, hooks.get("t2") == 0, not(noLostNotice),
      })
      .then(runTask("A", "t1")).then(claim("A", Ok))
      .expect(waitingOnSelf.get("A") and not(noSelfWait))

  // failInterruptedRunningTasks at run start: t3 is saved as failed, its event is dropped, and the
  // run start fails.
  run recoverReleaseFailureDropsEventTest =
    init.then(recover("A", Stuck))
      .expect(and {
        tasks.get("t3").status == Failed, events.get("t3") == 0,
        not(noLostNotice), procs.get("A").phase == Stopped,
      })

  // The long-lived manager process invalidates an aborted goal; the release leaves the lock file.
  // The finish hooks are dropped, and its next goal-execution.lock acquisition waits on itself.
  run managerWaitsOnItsOwnLockTest =
    init.then(invalidate(Stuck)).then(recover(M, Ok))
      .expect(and {
        hooks.get("t1") == 0, hooks.get("t2") == 0, not(noLostNotice),
        orphanOf == M, waitingOnSelf.get(M), not(noSelfWait),
      })

  // Every other process waits on it too, for as long as the manager lives.
  run othersWaitOnLiveOwnerTest =
    init.then(invalidate(Stuck)).then(recover("A", Ok))
      .expect(procs.get("A").retrying and lastAction == "recoverNotAcquired")
}

// The issue's first idea alone: keep the result, warn, and leave the lock file in place.
module returnOnlyTest {
  import claimLockRelease(DESIGN = "ReturnOnly").* from "./claimLockRelease"

  // The claim and the manager event are kept; the finish hook's re-read waits on the lock file
  // A left, so the hook is lost.
  run claimKeptAfterReleaseFailureTest =
    init.then(claim("A", Stuck))
      .expect(and {
        procs.get("A").queue == Set("t1"), events.get("t2") == 1, hooks.get("t2") == 0,
        releaseReported.get("A") == 1, orphanOf == "A",
        noOrphanRunning, stopsOnlyWhenUnlinkFails, not(noLostNotice),
      })

  // The next claim of the same process waits on the lock file it left: claimRetryAt is set on every
  // tick, so `takt run` never ends.
  run runWaitsOnItselfForeverTest =
    init.then(claim("A", Stuck)).then(runTask("A", "t1")).then(claim("A", Ok))
      .expect(waitingOnSelf.get("A") and procs.get("A").retrying and not(noSelfWait))

  run runCannotEndTest =
    init.then(claim("A", Stuck)).then(runTask("A", "t1")).then(claim("A", Ok)).then(claim("A", Ok))
      .then(endRun("A")).fail()
}

// The design as first reviewed (237703e8e): the two high findings of the review as traces.
module firstDesignTest {
  import claimLockRelease(DESIGN = "FirstDesign").* from "./claimLockRelease"

  // High-1: with a lock file that can never be removed, the finish hook's re-read of tasks.yaml
  // throws the unlink error, which runTaskFinishHooks only logs. The setup failure gets its event
  // but no hook; so do the tasks of an aborted goal.
  run hookLostWhenLockStaysForGoodTest =
    init.then(claim("A", StuckForGood))
      .expect(events.get("t2") == 1 and hooks.get("t2") == 0 and not(noLostNotice))

  run invalidateHookLostWhenLockStaysForGoodTest =
    init.then(invalidate(StuckForGood))
      .expect(hooks.get("t1") == 0 and hooks.get("t2") == 0 and not(noLostNotice))

  // With a lock file that a later unlink removes, the re-read removes the recorded file, and the
  // hook runs.
  run hookRunsWhenRereadRecoversTest =
    init.then(claim("A", Stuck))
      .expect(hooks.get("t2") == 1 and orphanOf == NONE and safety)

  // High-2: a release that cannot read its own lock file returns silently: not reported, not
  // recorded, the hook is lost, and the next claim waits on itself.
  run unreadableReleaseIsSilentTest =
    init.then(claim("A", Unseen))
      .expect(and {
        not(releaseFailureReported), orphanOf == "A", not(orphanRecorded),
        hooks.get("t2") == 0, not(noLostNotice),
      })
      .then(runTask("A", "t1")).then(claim("A", Ok))
      .expect(waitingOnSelf.get("A") and not(noSelfWait))
}

// The fix: keep the result, report the release failure (an unreadable own lock file included),
// record the lock file this process left and remove it at its next acquisition, and pass the saved
// states to the finish hooks.
module fixedTest {
  import claimLockRelease(DESIGN = "Fixed").* from "./claimLockRelease"

  run claimKeptAfterReleaseFailureTest =
    init.then(claim("A", Stuck))
      .expect(and {
        procs.get("A").queue == Set("t1"), procs.get("A").phase == Idle,
        hooks.get("t2") == 1, events.get("t2") == 1, releaseReported.get("A") == 1,
        orphanOf == "A", orphanRecorded, safety,
      })

  run claimKeptAfterGoneTest =
    init.then(claim("A", Gone))
      .expect(procs.get("A").queue == Set("t1") and orphanOf == NONE and safety)

  // High-1: the hooks get the saved states, so a lock file that stays for good does not lose them.
  run hooksKeptWhenLockStaysForGoodTest =
    init.then(claim("A", StuckForGood))
      .expect(hooks.get("t2") == 1 and events.get("t2") == 1 and orphanForGood and safety)

  run invalidateHooksKeptWhenLockStaysForGoodTest =
    init.then(invalidate(StuckForGood))
      .expect(hooks.get("t1") == 1 and hooks.get("t2") == 1 and safety)

  // High-2: an unreadable own lock file at release is reported and recorded; the next claim removes it.
  run unreadableReleaseIsReportedAndRecoveredTest =
    init.then(claim("A", Unseen))
      .expect(releaseReported.get("A") == 1 and orphanOf == "A" and orphanRecorded and hooks.get("t2") == 1 and safety)
      .then(runTask("A", "t1")).then(claim("A", Ok))
      .expect(lastAction == "claimAfterSelfRecovery" and orphanOf == NONE and not(waitingOnSelf.get("A")) and safety)

  // The next claim removes the lock file A left, and the run ends normally.
  run selfRecoveryThenCleanEndTest =
    init.then(claim("A", Stuck)).then(runTask("A", "t1")).then(claim("A", Ok))
      .expect(lastAction == "claimAfterSelfRecovery" and orphanOf == NONE and not(procs.get("A").retrying) and safety)
      .then(endRun("A"))
      .expect(procs.get("A").phase == Ended and safety)

  // B waits while A lives and has not come back to the lock; once A removes it, B claims.
  run otherWaitsUntilOwnerRecoversTest =
    init.then(claim("A", Stuck)).then(claim("B", Ok))
      .expect(lastAction == "claimTimeout" and procs.get("B").retrying and not(waitingOnSelf.get("B")) and safety)
      .then(claim("A", Ok)).then(claim("B", Ok))
      .expect(orphanOf == NONE and not(procs.get("B").retrying) and safety)

  // A ends with its lock file still there; A is dead, so B removes it as a dead owner's lock.
  run deadOwnersLockIsRecoveredTest =
    init.then(claim("A", Stuck)).then(runTask("A", "t1")).then(endRun("A"))
      .then(claim("B", Ok))
      .expect(orphanOf == NONE and procs.get("B").attempted and safety)

  // A lock file that can never be removed: the next acquisition throws the unlink error instead of
  // timing out, and claiming stops. t1 is left running for interrupted recovery.
  run unlinkForGoodStopsTest =
    init.then(claim("A", StuckForGood)).then(claim("A", Ok))
      .expect(and {
        procs.get("A").phase == Stopped, procs.get("A").stopReason == Unlink,
        tasks.get("t1") == { status: Running, owner: "A" }, safety,
      })

  run recoverReleaseFailureKeepsEventTest =
    init.then(recover("A", Stuck))
      .expect(events.get("t3") == 1 and procs.get("A").phase == Idle and releaseReported.get("A") == 1 and safety)

  run invalidateReleaseFailureKeepsHooksTest =
    init.then(invalidate(Stuck))
      .expect(hooks.get("t1") == 1 and hooks.get("t2") == 1 and releaseReported.get(M) == 1 and safety)
      .then(recover(M, Ok))
      .expect(orphanOf == NONE and not(waitingOnSelf.get(M)) and events.get("t3") == 1 and safety)
}

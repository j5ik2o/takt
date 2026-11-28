// -*- mode: Bluespec; -*-
// Scenario tests for taskClaim.qnt (upstream/main merge, 2026-11-28).
//
// Each test on `merged` states one behaviour the merge must keep from either side. The fork-only
// and upstream-only modules are used to show what each side did on its own.
module mergedTest {
  import taskClaim(DESIGN = "Merged").* from "./taskClaim"

  // Upstream: a claim never takes a remotely assigned task, and the local task is claimed.
  run remoteTaskIsNotClaimedTest =
    init
      .then(lockClaimOk)
      .then(beginWrite)
      .then(claimTask)
      .expect(tasks[LOCAL].saved == Claimed and tasks[REMOTE].saved == Pending)

  // Fork: a goal task the setup guard rejects is saved as failed and stays owed to onSetupFailed
  // until the write has been released and the report runs.
  run setupFailureIsReportedAfterReleaseTest =
    init
      .then(lockClaimOk)
      .then(beginWrite)
      .then(saveSetupFailure)
      .expect(tasks[LOCAL].saved == Failed and setupFailurePending.size() == 1
        and setupReported.size() == 0)
      .then(markWritten)
      .then(release)
      .expect(setupFailurePending.size() == 1)
      .then(reportSetupFailure)
      .expect(setupFailurePending.size() == 0 and setupReported.size() == 1)

  // Fork: a release failure after the write only warns, and the saved claim stays.
  run releaseFailureOnlyWarnsTest =
    init
      .then(lockClaimOk)
      .then(beginWrite)
      .then(claimTask)
      .then(markWritten)
      .then(release)
      .expect(outcome == ReleaseWarning implies (lock == Lost and tasks[LOCAL].saved == Claimed))

  // Fork: a lock timeout before the write is the retryable one.
  run timeoutBeforeWriteIsRetriedTest =
    init
      .then(lockClaimOk)
      .expect(outcome == RetryTimeout implies not(writeStarted))

  // Upstream: aborting the goal releases the retry reservation of the remote task.
  run abortReleasesReservationTest =
    init
      .then(abortGoal)
      .expect(UPSTREAM and not(tasks[REMOTE].retryReserved))

  // Upstream: a goal task blocked by an aborted goal is not claimed (claimTask cannot fire), so a
  // claim after the abort still takes nothing.
  run abortedGoalIsNotClaimedTest =
    init
      .then(abortGoal)
      .then(lockClaimOk)
      .then(beginWrite)
      .expect(not(accepted(LOCAL) and not(goalBlocked(LOCAL))))
}

module forkTest {
  import taskClaim(DESIGN = "Fork").* from "./taskClaim"

  // The fork has no remote branch in invalidatePendingGoalTasks, so it never releases the retry
  // reservation of a remotely assigned task. The model does not reach that difference (see the
  // README); this test only pins the fork's design flag and shows the scenario runs.
  run abortKeepsReservationTest =
    init
      .then(abortGoal)
      .expect(not(UPSTREAM))
}

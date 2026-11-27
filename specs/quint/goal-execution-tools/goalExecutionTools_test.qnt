// -*- mode: Bluespec; -*-
// Scenario tests for goalExecutionTools.qnt (issue #179).
//
// currentTest shows the defect of the current code: an operation through the manager connection
// and one through an external takt-mcp can both be between begin and commit on the same goal.
// fixedTest shows the lease: the external call is refused while the manager's operation is in
// flight, the external call runs after it ends, a lease left by a dead holder is reclaimed, an
// aborted goal does not resume, and finish is rejected when the goal is not aborted.
module currentTest {
  import goalExecutionTools(DESIGN = "Current").* from "./goalExecutionTools"

  // The manager connection starts an abort; the external takt-mcp starts a pause before the abort
  // commits. Both are inside an operation at once, and neither call failed.
  run managerAndExternalBothBeginTest =
    init
      .then(begin(M, Abort))
      .then(begin(X, Pause))
      .expect(and { busy(M), busy(X), refusals == 0, not(atMostOneWriter) })
      .then(commit(M, Abort))
      .expect(exec == Aborted and busy(X))
}

module fixedTest {
  import goalExecutionTools(DESIGN = "Fixed").* from "./goalExecutionTools"

  // While the manager's pause is in flight, the external abort is refused and names the holder;
  // after the pause commits, the external resume runs.
  run managerBlocksExternalTest =
    init
      .then(begin(M, Pause))
      .expect(and { heldBy(M), busy(M), lease == Held(M) })
      .then(refuse(X))
      .expect(and { refusals == 1, lastRefusal == Held(M), exec == Active, lastAction == "externalRefusedByManager" })
      .then(commit(M, Pause))
      .expect(and { exec == Paused, lease == Free, not(busy(M)), safety })
      .then(begin(X, Resume))
      .then(commit(X, Resume))
      .expect(and { exec == Active, lease == Free, safety })

  // An external pause is in flight, the manager's abort is refused, and the external call keeps
  // the goal paused.
  run externalBlocksManagerTest =
    init
      .then(begin(X, Pause))
      .then(refuse(M))
      .expect(and { refusals == 1, lastRefusal == Held(X), exec == Active, lastAction == "refused" })
      .then(commit(X, Pause))
      .expect(and { exec == Paused, lease == Free, safety })

  // The manager dies between begin and commit of finish; the next external call reclaims the stale
  // lease and finishes the aborted goal.
  run staleLeaseReclaimedTest =
    init
      .then(begin(M, Abort))
      .then(commit(M, Abort))
      .then(begin(M, Finish))
      .then(crash(M))
      .expect(and { deadHolderLease, not(aliveM), not(busy(M)), lease == Held(M) })
      .then(begin(X, Finish))
      .expect(and { heldBy(X), lastAction == "beginAfterStaleLease", lease == Held(X) })
      .then(commit(X, Finish))
      .expect(and { goalStatus == Completed, exec == Aborted, lease == Free, safety })

  // An aborted goal does not resume: the external resume is rejected by the saved state and the
  // lease is released without a save.
  run abortedCannotResumeTest =
    init
      .then(begin(X, Abort))
      .then(commit(X, Abort))
      .expect(and { exec == Aborted, everAborted, safety })
      .then(begin(X, Resume))
      .then(abandon(X))
      .expect(and { exec == Aborted, lease == Free, not(everAborted and exec == Active), safety })

  // Finish of a goal that is not aborted is rejected by the saved state; nothing is saved.
  run finishRejectedWhenActiveTest =
    init
      .then(begin(X, Finish))
      .then(abandon(X))
      .expect(and { goalStatus == Created, exec == Active, lease == Free, safety })

  // A refused call does not change the saved goal.
  run refusalKeepsGoalTest =
    init
      .then(begin(M, Abort))
      .then(refuse(X))
      .expect(and { exec == Active, goalStatus == Created, refusals == 1, safety })
      .then(commit(M, Abort))
      .expect(and { exec == Aborted, safety })
}

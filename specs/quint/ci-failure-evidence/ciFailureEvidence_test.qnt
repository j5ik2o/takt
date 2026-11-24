// -*- mode: Bluespec; -*-
// Scenario tests for issue j5ik2o/takt#116. Run:
//   quint test ciFailureEvidence_test.qnt --main fixedCodeTest
//   quint test ciFailureEvidence_test.qnt --main currentCodeTest
module fixedCodeTest {
  import ciFailureEvidence(FIXED = true).* from "./ciFailureEvidence"

  // takt-dash #85: a diagnosed test failure beside an external status reaches the fix step.
  run mixedWithExternalReachesFixTest =
    initWith(Set(Diagnosable, External)).then(collect).then(investigateAs(Defect)).then(refresh)
      .expect(phase == FixCi)

  // takt #68: a diagnosed failure beside jobs cancelled before start reaches the fix step.
  run mixedWithNotStartedReachesFixTest =
    initWith(Set(Diagnosable, NotStarted)).then(collect).then(investigateAs(Defect)).then(refresh)
      .expect(phase == FixCi)

  // takt #49: only jobs that never started; an external verdict reaches the single rerun.
  run notStartedOnlyReachesRerunTest =
    initWith(Set(NotStarted)).then(collect).then(investigateAs(ExternalCause)).then(refresh)
      .expect(phase == RerunCi)

  // Only external statuses failed: nothing to diagnose, recovery stops and nothing is merged.
  run externalOnlyStopsTest =
    initWith(Set(External)).then(collect).then(investigateAs(Insufficient)).then(refresh)
      .expect(phase == Stopped and stopReason == IncompleteEvidence)

  // Evidence that should exist is missing: recovery stops even beside a diagnosed check.
  run missingEvidenceStopsTest =
    initWith(Set(Diagnosable, Missing)).then(collect).then(investigateAs(Defect)).then(refresh)
      .expect(phase == Stopped and stopReason == IncompleteEvidence)
}

module currentCodeTest {
  import ciFailureEvidence(FIXED = false).* from "./ciFailureEvidence"

  // The defect: the same mixed evidence stops before the fix step.
  run mixedWithExternalStopsBeforeFixTest =
    initWith(Set(Diagnosable, External)).then(collect).then(investigateAs(Defect)).then(refresh)
      .expect(phase == Stopped and stopReason == IncompleteEvidence)

  run notStartedOnlyStopsBeforeRerunTest =
    initWith(Set(NotStarted)).then(collect).then(investigateAs(Insufficient)).then(refresh)
      .expect(phase == Stopped and stopReason == IncompleteEvidence)
}

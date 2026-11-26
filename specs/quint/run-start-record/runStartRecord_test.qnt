// -*- mode: Bluespec; -*-
// Run:
//   quint test runStartRecord_test.qnt --main beginFirstTest
//   quint test runStartRecord_test.qnt --main prepareFirstTest
module beginFirstTest {
  import runStartRecord(ORDER = "BeginFirst").* from "./runStartRecord"

  run unresolvedCallIsRecordedTest =
    initWith(CallUnresolved).then(beginRun).then(bootstrap)
      .expect(phase == Exited and meta == MetaFailed and logs and reasonHasLookup and stepsRun == 0)

  run credentialUnsafeIsRecordedTest =
    initWith(CredentialUnsafe).then(beginRun).then(bootstrap)
      .expect(phase == Exited and meta == MetaFailed and logs and stepsRun == 0)

  run resolvedRunsStepsTest =
    initWith(PrepOk).then(beginRun).then(bootstrap).then(runSteps)
      .expect(phase == Executing and meta == MetaRunning and stepsRun == 1)
}

module prepareFirstTest {
  import runStartRecord(ORDER = "PrepareFirst").* from "./runStartRecord"

  // Before the fix: the failure exits with no meta.json and no logs.
  run unresolvedCallLeavesNothingTest =
    initWith(CallUnresolved).then(prepareBeforeBegin)
      .expect(phase == Exited and meta == NoMeta and not(logs) and not(failureIsRecorded))
}

// -*- mode: Bluespec; -*-
// Run:
//   quint test runStartRecord_test.qnt --main beginFirstTest
//   quint test runStartRecord_test.qnt --main prepareFirstTest
module beginFirstTest {
  import runStartRecord(ORDER = "BeginFirst").* from "./runStartRecord"

  run unresolvedCallIsRecordedTest =
    initWith(CallUnresolved)
      .then(beginRun)
      .expect(
        runs.get(RUN_1).phase == DirReserved
        and runs.get(RUN_1).dirReserved
        and runs.get(RUN_1).meta == NoMeta
        and runs.get(RUN_1).logStartCount == 0
        and invariant
      )
      .then(prepareInBootstrap)
      .expect(
        runs.get(RUN_1).phase == PrepFailed
        and runs.get(RUN_1).meta == NoMeta
        and runs.get(RUN_1).logStartCount == 0
        and invariant
      )
      .then(terminalizeBootstrapStart)
      .expect(
        runs.get(RUN_1).phase == Terminalizing
        and runs.get(RUN_1).meta == MetaRunning
        and runs.get(RUN_1).logStartCount == 1
        and runs.get(RUN_1).finishCount == 0
        and invariant
      )
      .then(terminalizeBootstrapFinish)
      .expect(
        runs.get(RUN_1).phase == Exited
        and runs.get(RUN_1).meta == MetaFailed
        and runs.get(RUN_1).logStartCount == 1
        and runs.get(RUN_1).logTerminalCount == 1
        and runs.get(RUN_1).finishCount == 1
        and runs.get(RUN_1).hasFailureRecord
        and runs.get(RUN_1).reasonHasLookup
        and runs.get(RUN_1).stepsRun == 0
        and invariant
      )

  run credentialUnsafeIsRecordedTest =
    initWith(CredentialUnsafe)
      .then(beginRun)
      .then(prepareInBootstrap)
      .then(terminalizeBootstrapStart)
      .then(terminalizeBootstrapFinish)
      .expect(
        runs.get(RUN_1).phase == Exited
        and runs.get(RUN_1).meta == MetaFailed
        and runs.get(RUN_1).logStartCount == 1
        and runs.get(RUN_1).logTerminalCount == 1
        and runs.get(RUN_1).finishCount == 1
        and runs.get(RUN_1).hasFailureRecord
        and not(runs.get(RUN_1).reasonHasLookup)
        and runs.get(RUN_1).stepsRun == 0
        and invariant
      )

  run completedRunHasNoFailureRecordTest =
    initWith(PrepOk)
      .then(beginRun)
      .expect(runs.get(RUN_1).meta == NoMeta and runs.get(RUN_1).logStartCount == 0)
      .then(prepareInBootstrap)
      .then(createBootstrap)
      .expect(
        runs.get(RUN_1).phase == Bootstrapped
        and runs.get(RUN_1).meta == MetaRunning
        and runs.get(RUN_1).metaPublishCount == 1
        and runs.get(RUN_1).logStartCount == 1
      )
      .then(runStep)
      .then(finishExecutionSuccess)
      .expect(
        runs.get(RUN_1).phase == Exited
        and runs.get(RUN_1).meta == MetaCompleted
        and not(runs.get(RUN_1).hasFailureRecord)
        and not(runs.get(RUN_1).reasonHasLookup)
        and runs.get(RUN_1).logStartCount == 1
        and runs.get(RUN_1).logTerminalCount == 1
        and runs.get(RUN_1).finishCount == 1
        and runs.get(RUN_1).stepsRun == 1
        and invariant
      )

  run resumedRunPrepFailurePreservesSourceTest =
    initWith(PrepOk)
      .then(beginRun)
      .then(prepareInBootstrap)
      .then(createBootstrap)
      .then(runStep)
      .then(finishExecutionFailure)
      .expect(runs.get(RUN_1).phase == Exited and runs.get(RUN_1).meta == MetaFailed and run1SnapshotTaken)
      .then(startResumeRun(CallUnresolved))
      .then(beginRun)
      .then(prepareInBootstrap)
      .then(terminalizeBootstrapStart)
      .then(terminalizeBootstrapFinish)
      .expect(
        runs.get(RUN_2).phase == Exited
        and runs.get(RUN_2).meta == MetaFailed
        and runs.get(RUN_2).recordedSource == FromRun(RUN_1)
        and runs.get(RUN_2).reasonHasLookup
        and runs.get(RUN_2).stepsRun == 0
        and persistedOf(runs.get(RUN_1)) == run1Snapshot
        and invariant
      )

  run resumedRunCompletionPreservesSourceTest =
    initWith(PrepOk)
      .then(beginRun)
      .then(prepareInBootstrap)
      .then(createBootstrap)
      .then(runStep)
      .then(finishExecutionFailure)
      .then(startResumeRun(PrepOk))
      .then(beginRun)
      .then(prepareInBootstrap)
      .then(createBootstrap)
      .then(runStep)
      .then(finishExecutionSuccess)
      .expect(
        runs.get(RUN_2).phase == Exited
        and runs.get(RUN_2).meta == MetaCompleted
        and runs.get(RUN_2).recordedSource == FromRun(RUN_1)
        and not(runs.get(RUN_2).hasFailureRecord)
        and persistedOf(runs.get(RUN_1)) == run1Snapshot
        and invariant
      )
}

module prepareFirstTest {
  import runStartRecord(ORDER = "PrepareFirst").* from "./runStartRecord"

  // Before the fix: a preparation failure exits with no directory, no meta.json, and no logs.
  run unresolvedCallLeavesNothingTest =
    initWith(CallUnresolved)
      .then(prepareBeforeBegin)
      .expect(
        runs.get(RUN_1).phase == Exited
        and not(runs.get(RUN_1).dirReserved)
        and runs.get(RUN_1).meta == NoMeta
        and runs.get(RUN_1).logStartCount == 0
        and not(failureIsRecorded)
      )

  // Before the fix: a resumed run whose preparation fails loses its source_run_slug lineage too.
  run resumedUnresolvedCallLosesLineageTest =
    initWith(PrepOk)
      .then(prepareBeforeBegin)
      .then(beginRun)
      .then(createBootstrap)
      .then(runStep)
      .then(finishExecutionFailure)
      .then(startResumeRun(CallUnresolved))
      .then(prepareBeforeBegin)
      .expect(
        runs.get(RUN_2).phase == Exited
        and runs.get(RUN_2).meta == NoMeta
        and runs.get(RUN_2).recordedSource == NoSource
        and not(failureIsRecorded)
        and not(resumePreservesIntegrity)
      )
}

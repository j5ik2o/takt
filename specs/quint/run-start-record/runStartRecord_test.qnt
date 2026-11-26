// -*- mode: Bluespec; -*-
// Run:
//   quint test runStartRecord_test.qnt --main beginFirstTest
//   quint test runStartRecord_test.qnt --main prepareFirstTest
module beginFirstTest {
  import runStartRecord(ORDER = "BeginFirst").* from "./runStartRecord"

  run unresolvedCallIsRecordedTest =
    initWith(CallUnresolved, BootOk)
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
        and not(runs.get(RUN_1).hasReports)
        and runs.get(RUN_1).logStartCount == 1
        and runs.get(RUN_1).logTerminalCount == 1
        and runs.get(RUN_1).finishCount == 1
        and runs.get(RUN_1).hasFailureRecord
        and runs.get(RUN_1).reasonHasLookup
        and runs.get(RUN_1).stepsRun == 0
        and invariant
      )

  run credentialUnsafeIsRecordedTest =
    initWith(CredentialUnsafe, BootOk)
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

  run postPrepBootstrapFailureIsRecordedTest =
    initWith(PrepOk, BootFailed)
      .then(beginRun)
      .then(prepareInBootstrap)
      .then(bootstrapPreMetaFail)
      .expect(
        runs.get(RUN_1).phase == BootstrapFailed
        and runs.get(RUN_1).meta == NoMeta
        and invariant
      )
      .then(terminalizeBootstrapStart)
      .then(terminalizeBootstrapFinish)
      .expect(
        runs.get(RUN_1).phase == Exited
        and runs.get(RUN_1).meta == MetaFailed
        and not(runs.get(RUN_1).hasReports)
        and runs.get(RUN_1).hasFailureRecord
        and not(runs.get(RUN_1).reasonHasLookup)
        and runs.get(RUN_1).stepsRun == 0
        and invariant
      )

  run completedRunHasNoFailureRecordTest =
    initWith(PrepOk, BootOk)
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
        and runs.get(RUN_1).hasReports
        and not(runs.get(RUN_1).hasFailureRecord)
        and not(runs.get(RUN_1).reasonHasLookup)
        and runs.get(RUN_1).logStartCount == 1
        and runs.get(RUN_1).logTerminalCount == 1
        and runs.get(RUN_1).finishCount == 1
        and runs.get(RUN_1).stepsRun == 1
        and invariant
      )

  run resumedRunPrepFailurePreservesSourceTest =
    initWith(PrepOk, BootOk)
      .then(beginRun)
      .then(prepareInBootstrap)
      .then(createBootstrap)
      .then(runStep)
      .then(finishExecutionFailure)
      .expect(
        runs.get(RUN_1).phase == Exited
        and runs.get(RUN_1).meta == MetaFailed
        and runs.get(RUN_1).hasReports
        and run1SnapshotTaken
      )
      .then(startResumeRun(CallUnresolved, BootOk, true))
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

  // When operation lineage is unavailable (OperationLineageUnavailableError fallback),
  // publishedResumeSource is undefined, so meta.json omits source_run_slug.
  run resumedRunLineageUnavailableOmitsSourceSlugTest =
    initWith(PrepOk, BootOk)
      .then(beginRun)
      .then(prepareInBootstrap)
      .then(createBootstrap)
      .then(runStep)
      .then(finishExecutionFailure)
      .then(startResumeRun(CallUnresolved, BootOk, false))
      .then(beginRun)
      .then(prepareInBootstrap)
      .then(terminalizeBootstrapStart)
      .then(terminalizeBootstrapFinish)
      .expect(
        runs.get(RUN_2).phase == Exited
        and runs.get(RUN_2).meta == MetaFailed
        and runs.get(RUN_2).recordedSource == NoSource
        and runs.get(RUN_2).reasonHasLookup
        and persistedOf(runs.get(RUN_1)) == run1Snapshot
        and invariant
      )

  // Resuming from a run that failed during preparation (no reports/ directory) cannot
  // enter createBootstrap; inheritResumeReportSnapshot fails in bootstrapPreMetaFail.
  run resumedFromPrepFailedRunFailsReportInheritanceTest =
    initWith(CallUnresolved, BootOk)
      .then(beginRun)
      .then(prepareInBootstrap)
      .then(terminalizeBootstrapStart)
      .then(terminalizeBootstrapFinish)
      .expect(not(runs.get(RUN_1).hasReports))
      .then(startResumeRun(PrepOk, BootOk, true))
      .then(beginRun)
      .then(prepareInBootstrap)
      .then(bootstrapPreMetaFail)
      .then(terminalizeBootstrapStart)
      .then(terminalizeBootstrapFinish)
      .expect(
        runs.get(RUN_2).phase == Exited
        and runs.get(RUN_2).meta == MetaFailed
        and runs.get(RUN_2).recordedSource == FromRun(RUN_1)
        and not(runs.get(RUN_2).reasonHasLookup)
        and runs.get(RUN_2).stepsRun == 0
        and persistedOf(runs.get(RUN_1)) == run1Snapshot
        and invariant
      )

  run resumedRunCompletionPreservesSourceTest =
    initWith(PrepOk, BootOk)
      .then(beginRun)
      .then(prepareInBootstrap)
      .then(createBootstrap)
      .then(runStep)
      .then(finishExecutionFailure)
      .then(startResumeRun(PrepOk, BootOk, true))
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
    initWith(CallUnresolved, BootOk)
      .then(prepareBeforeBegin)
      .expect(
        runs.get(RUN_1).phase == Exited
        and not(runs.get(RUN_1).dirReserved)
        and runs.get(RUN_1).meta == NoMeta
        and runs.get(RUN_1).logStartCount == 0
        and not(failureIsRecorded)
        and not(unresolvedReasonExplains)
      )

  // Before the fix: a resumed run whose preparation fails loses its source_run_slug lineage too.
  run resumedUnresolvedCallLosesLineageTest =
    initWith(PrepOk, BootOk)
      .then(prepareBeforeBegin)
      .then(beginRun)
      .then(createBootstrap)
      .then(runStep)
      .then(finishExecutionFailure)
      .then(startResumeRun(CallUnresolved, BootOk, true))
      .then(prepareBeforeBegin)
      .expect(
        runs.get(RUN_2).phase == Exited
        and runs.get(RUN_2).meta == NoMeta
        and runs.get(RUN_2).recordedSource == NoSource
        and not(failureIsRecorded)
        and not(unresolvedReasonExplains)
        and not(resumePreservesIntegrity)
      )
}

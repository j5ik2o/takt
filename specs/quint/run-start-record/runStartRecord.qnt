// -*- mode: Bluespec; -*-
// Run start and terminal record lifecycle: from entering executeWorkflowInternal to
// disk records (run directory, reports/, meta.json, logs) across a run and an optional resume run.
//
// Sources modelled:
//   src/features/tasks/execute/workflowExecution.ts              executeWorkflowInternal, terminalizeBootstrapFailure
//   src/features/tasks/execute/workflowRunLifecycle.ts           beginRun (reserves empty run directory only; finish guard)
//   src/features/tasks/execute/workflowExecutionBundle.ts        prepareWorkflowExecutionBundle
//   src/features/tasks/execute/workflowExecutionBootstrap.ts     resolveWorkflowExecutionResumeLineage, createWorkflowExecutionBootstrap
//   src/core/workflow/run/resume-report-snapshot.ts              inheritResumeReportSnapshot (requires source reports/)
//   src/core/workflow/engine/WorkflowEngineSetup.ts              ensureRunDirsExist (creates reports/)
//   src/features/tasks/execute/fileWorkflowRunTerminalPublisher.ts  finish (finalizeFileRunMeta + terminal NDJSON line)
//
// ORDER (a string) chooses where bundle preparation sits:
//   PrepareFirst  prepare before beginRun (before PR #167)
//   BeginFirst    prepare inside the bootstrap try after beginRun (PR #167)
module runStartRecord {
  const ORDER: str

  type RunId = int

  type Phase =
    | Idle
    | Entered
    | DirReserved
    | Prepared
    | PrepFailed
    | BootstrapFailed
    | Bootstrapped
    | Terminalizing
    | Executing
    | Exited

  type MetaStatus = NoMeta | MetaRunning | MetaCompleted | MetaFailed

  // Outcome of prepareWorkflowExecutionBundle:
  //   PrepOk            every workflow_call resolved and credentials are safe
  //   CallUnresolved    resolver returned null for some workflow_call
  //   CredentialUnsafe  central execution rejected a legacy MCP credential literal
  type PrepOutcome = PrepOk | CallUnresolved | CredentialUnsafe

  // Outcome of post-preparation, pre-meta steps inside the bootstrap try
  // (publish/load bundle, validateWorkflowReportReferences, stageTaskSpec, etc.).
  type BootstrapOutcome = BootOk | BootFailed

  type ExecOutcome = ExecPending | ExecCompleted | ExecFailed

  type SourceRef = NoSource | FromRun(RunId)

  type RunRecord = {
    phase: Phase,
    dirReserved: bool,
    hasReports: bool,
    prep: PrepOutcome,
    prepDone: bool,
    boot: BootstrapOutcome,
    execOutcome: ExecOutcome,
    sourceRun: SourceRef,
    // Whether resolveWorkflowExecutionResumeLineage obtained operation lineage (publishedResumeSource).
    // When false (OperationLineageUnavailableError fallback), meta.json omits source_run_slug.
    lineageAvailable: bool,
    recordedSource: SourceRef,
    meta: MetaStatus,
    metaPublishCount: int,
    logStartCount: int,
    logTerminalCount: int,
    finishCount: int,
    hasFailureRecord: bool,
    reasonHasLookup: bool,
    stepsRun: int,
  }

  // Subset of disk state owned exclusively by a run's meta.json and logs (operation journal is shared across lineage).
  type PersistedRecord = {
    dirReserved: bool,
    hasReports: bool,
    meta: MetaStatus,
    recordedSource: SourceRef,
    metaPublishCount: int,
    logStartCount: int,
    logTerminalCount: int,
    finishCount: int,
    hasFailureRecord: bool,
    reasonHasLookup: bool,
  }

  pure val RUN_1: RunId = 1
  pure val RUN_2: RunId = 2
  pure val RUN_IDS: Set[RunId] = Set(RUN_1, RUN_2)
  pure val PREPS: Set[PrepOutcome] = Set(PrepOk, CallUnresolved, CredentialUnsafe)
  pure val BOOTS: Set[BootstrapOutcome] = Set(BootOk, BootFailed)
  pure val BOOLS: Set[bool] = Set(true, false)

  pure val IDLE_RUN: RunRecord = {
    phase: Idle,
    dirReserved: false,
    hasReports: false,
    prep: PrepOk,
    prepDone: false,
    boot: BootOk,
    execOutcome: ExecPending,
    sourceRun: NoSource,
    lineageAvailable: false,
    recordedSource: NoSource,
    meta: NoMeta,
    metaPublishCount: 0,
    logStartCount: 0,
    logTerminalCount: 0,
    finishCount: 0,
    hasFailureRecord: false,
    reasonHasLookup: false,
    stepsRun: 0,
  }

  pure def enteredRun(
    p: PrepOutcome,
    b: BootstrapOutcome,
    src: SourceRef,
    lineageOk: bool,
  ): RunRecord = {
    ...IDLE_RUN,
    phase: Entered,
    prep: p,
    boot: b,
    sourceRun: src,
    lineageAvailable: lineageOk,
  }

  pure def persistedOf(r: RunRecord): PersistedRecord = {
    dirReserved: r.dirReserved,
    hasReports: r.hasReports,
    meta: r.meta,
    recordedSource: r.recordedSource,
    metaPublishCount: r.metaPublishCount,
    logStartCount: r.logStartCount,
    logTerminalCount: r.logTerminalCount,
    finishCount: r.finishCount,
    hasFailureRecord: r.hasFailureRecord,
    reasonHasLookup: r.reasonHasLookup,
  }

  pure val EMPTY_PERSISTED: PersistedRecord = persistedOf(IDLE_RUN)

  pure def isSourceDistinct(id: RunId, src: SourceRef): bool =
    match src {
      | NoSource => true
      | FromRun(s) => s != id
    }

  pure def expectedRecordedSource(r: RunRecord): SourceRef =
    if (r.sourceRun != NoSource and r.lineageAvailable) r.sourceRun else NoSource

  pure def applyPrepareBeforeBegin(r: RunRecord): RunRecord = {
    ...r,
    prepDone: true,
    phase: if (r.prep == PrepOk) Prepared else Exited,
  }

  // Real beginRun (workflowRunLifecycle.ts): resolves slug and reserves an empty run directory.
  // It does NOT write meta.json and does NOT create logs/ or reports/.
  pure def applyBeginRun(r: RunRecord): RunRecord = {
    ...r,
    phase: DirReserved,
    dirReserved: true,
  }

  pure def applyPrepareInBootstrap(r: RunRecord): RunRecord = {
    ...r,
    prepDone: true,
    phase: if (r.prep == PrepOk) Prepared else PrepFailed,
  }

  // Normal path: inheritResumeReportSnapshot (if resumed) + publishRunMeta(running) + initNdjsonLog.
  pure def applyCreateBootstrap(r: RunRecord): RunRecord = {
    ...r,
    phase: Bootstrapped,
    hasReports: r.hasReports or r.sourceRun != NoSource,
    meta: MetaRunning,
    recordedSource: expectedRecordedSource(r),
    metaPublishCount: r.metaPublishCount + 1,
    logStartCount: r.logStartCount + 1,
  }

  // Post-preparation, pre-meta failure inside the bootstrap try
  // (e.g. inheritResumeReportSnapshot missing source reports/, validateWorkflowReportReferences error).
  pure def applyBootstrapPreMetaFail(r: RunRecord): RunRecord = {
    ...r,
    phase: BootstrapFailed,
  }

  // Error path stage 1: terminalizeBootstrapFailure calls publishRunMeta(running) + initNdjsonLog.
  pure def applyTerminalizeStart(r: RunRecord): RunRecord = {
    ...r,
    phase: Terminalizing,
    meta: MetaRunning,
    recordedSource: expectedRecordedSource(r),
    metaPublishCount: r.metaPublishCount + 1,
    logStartCount: r.logStartCount + 1,
  }

  // Error path stage 2: terminalizeBootstrapFailure calls activeRun.finish(failed, reason).
  pure def applyTerminalizeFinish(r: RunRecord): RunRecord = {
    ...r,
    phase: Exited,
    meta: MetaFailed,
    logTerminalCount: r.logTerminalCount + 1,
    finishCount: r.finishCount + 1,
    hasFailureRecord: true,
    reasonHasLookup: r.prep == CallUnresolved,
  }

  // WorkflowEngineSetup.ensureRunDirsExist creates reports/ before executing steps.
  pure def applyRunStep(r: RunRecord): RunRecord = {
    ...r,
    phase: Executing,
    hasReports: true,
    stepsRun: r.stepsRun + 1,
  }

  // Normal completion in finally: activeRun.finish writes status=completed with no failure record.
  pure def applyFinishSuccess(r: RunRecord): RunRecord = {
    ...r,
    phase: Exited,
    execOutcome: ExecCompleted,
    meta: MetaCompleted,
    logTerminalCount: r.logTerminalCount + 1,
    finishCount: r.finishCount + 1,
    hasFailureRecord: false,
    reasonHasLookup: false,
  }

  // Execution failure/abort in finally: activeRun.finish writes status=failed + workflow_abort.
  pure def applyFinishFailure(r: RunRecord): RunRecord = {
    ...r,
    phase: Exited,
    execOutcome: ExecFailed,
    meta: MetaFailed,
    logTerminalCount: r.logTerminalCount + 1,
    finishCount: r.finishCount + 1,
    hasFailureRecord: true,
    reasonHasLookup: false,
  }

  var activeRunId: RunId
  var runs: RunId -> RunRecord
  var run1SnapshotTaken: bool
  var run1Snapshot: PersistedRecord

  def activeRun: RunRecord = runs.get(activeRunId)

  def isSourceExited(src: SourceRef): bool =
    match src {
      | NoSource => true
      | FromRun(s) => runs.get(s).phase == Exited
    }

  def sourceHasReports(src: SourceRef): bool =
    match src {
      | NoSource => true
      | FromRun(s) => runs.get(s).hasReports
    }

  action initWith(p: PrepOutcome, b: BootstrapOutcome): bool = all {
    activeRunId' = RUN_1,
    runs' = Map(RUN_1 -> enteredRun(p, b, NoSource, false), RUN_2 -> IDLE_RUN),
    run1SnapshotTaken' = false,
    run1Snapshot' = EMPTY_PERSISTED,
  }

  action init: bool = {
    nondet p = PREPS.oneOf()
    nondet b = BOOTS.oneOf()
    initWith(p, b)
  }

  // Old order only: prepareWorkflowExecutionBundle runs before beginRun.
  // A failure exits executeWorkflowInternal without creating a run directory, meta.json, or logs.
  action prepareBeforeBegin: bool = {
    val r = activeRun
    val updated = applyPrepareBeforeBegin(r)
    all {
      ORDER == "PrepareFirst",
      r.phase == Entered,
      not(r.prepDone),
      runs' = runs.put(activeRunId, updated),
      activeRunId' = activeRunId,
      run1SnapshotTaken' = if (activeRunId == RUN_1 and updated.phase == Exited) true else run1SnapshotTaken,
      run1Snapshot' = if (activeRunId == RUN_1 and updated.phase == Exited) persistedOf(updated) else run1Snapshot,
    }
  }

  action beginRun: bool = {
    val r = activeRun
    val canBegin = if (ORDER == "BeginFirst") r.phase == Entered else r.phase == Prepared
    all {
      canBegin,
      isSourceDistinct(activeRunId, r.sourceRun),
      runs' = runs.put(activeRunId, applyBeginRun(r)),
      activeRunId' = activeRunId,
      run1SnapshotTaken' = run1SnapshotTaken,
      run1Snapshot' = run1Snapshot,
    }
  }

  // Fixed order only: prepareWorkflowExecutionBundle runs inside the bootstrap try after beginRun.
  action prepareInBootstrap: bool = {
    val r = activeRun
    all {
      ORDER == "BeginFirst",
      r.phase == DirReserved,
      not(r.prepDone),
      runs' = runs.put(activeRunId, applyPrepareInBootstrap(r)),
      activeRunId' = activeRunId,
      run1SnapshotTaken' = run1SnapshotTaken,
      run1Snapshot' = run1Snapshot,
    }
  }

  // createWorkflowExecutionBootstrap succeeds only when post-prep checks pass and
  // (for resumed runs) the source run has a reports/ directory to inherit.
  action createBootstrap: bool = {
    val r = activeRun
    val ready =
      if (ORDER == "BeginFirst") r.phase == Prepared
      else (r.phase == DirReserved and r.prepDone)
    all {
      ready,
      r.dirReserved,
      r.boot == BootOk,
      sourceHasReports(r.sourceRun),
      runs' = runs.put(activeRunId, applyCreateBootstrap(r)),
      activeRunId' = activeRunId,
      run1SnapshotTaken' = run1SnapshotTaken,
      run1Snapshot' = run1Snapshot,
    }
  }

  // Post-prep, pre-meta failure inside bootstrap try (including inheritResumeReportSnapshot
  // failing because the source run never created reports/).
  action bootstrapPreMetaFail: bool = {
    val r = activeRun
    val ready =
      if (ORDER == "BeginFirst") r.phase == Prepared
      else (r.phase == DirReserved and r.prepDone)
    all {
      ready,
      r.dirReserved,
      r.boot == BootFailed or not(sourceHasReports(r.sourceRun)),
      runs' = runs.put(activeRunId, applyBootstrapPreMetaFail(r)),
      activeRunId' = activeRunId,
      run1SnapshotTaken' = run1SnapshotTaken,
      run1Snapshot' = run1Snapshot,
    }
  }

  // terminalizeBootstrapFailure stage 1: publishRunMeta(running) + initNdjsonLog(workflow_start).
  action terminalizeBootstrapStart: bool = {
    val r = activeRun
    all {
      r.phase == PrepFailed or r.phase == BootstrapFailed,
      r.dirReserved,
      runs' = runs.put(activeRunId, applyTerminalizeStart(r)),
      activeRunId' = activeRunId,
      run1SnapshotTaken' = run1SnapshotTaken,
      run1Snapshot' = run1Snapshot,
    }
  }

  // terminalizeBootstrapFailure stage 2: activeRun.finish(failed, reason).
  action terminalizeBootstrapFinish: bool = {
    val r = activeRun
    val updated = applyTerminalizeFinish(r)
    all {
      r.phase == Terminalizing,
      r.finishCount == 0,
      runs' = runs.put(activeRunId, updated),
      activeRunId' = activeRunId,
      run1SnapshotTaken' = if (activeRunId == RUN_1) true else run1SnapshotTaken,
      run1Snapshot' = if (activeRunId == RUN_1) persistedOf(updated) else run1Snapshot,
    }
  }

  action runStep: bool = {
    val r = activeRun
    all {
      r.phase == Bootstrapped,
      runs' = runs.put(activeRunId, applyRunStep(r)),
      activeRunId' = activeRunId,
      run1SnapshotTaken' = run1SnapshotTaken,
      run1Snapshot' = run1Snapshot,
    }
  }

  action finishExecutionSuccess: bool = {
    val r = activeRun
    val updated = applyFinishSuccess(r)
    all {
      r.phase == Executing,
      r.finishCount == 0,
      runs' = runs.put(activeRunId, updated),
      activeRunId' = activeRunId,
      run1SnapshotTaken' = if (activeRunId == RUN_1) true else run1SnapshotTaken,
      run1Snapshot' = if (activeRunId == RUN_1) persistedOf(updated) else run1Snapshot,
    }
  }

  action finishExecutionFailure: bool = {
    val r = activeRun
    val updated = applyFinishFailure(r)
    all {
      r.phase == Executing,
      r.finishCount == 0,
      runs' = runs.put(activeRunId, updated),
      activeRunId' = activeRunId,
      run1SnapshotTaken' = if (activeRunId == RUN_1) true else run1SnapshotTaken,
      run1Snapshot' = if (activeRunId == RUN_1) persistedOf(updated) else run1Snapshot,
    }
  }

  // Start a resume run (RUN_2) referencing a failed RUN_1.
  // lineageOk models whether resolveWorkflowExecutionResumeLineage obtained publishedResumeSource.
  action startResumeRun(nextPrep: PrepOutcome, nextBoot: BootstrapOutcome, lineageOk: bool): bool = all {
    activeRunId == RUN_1,
    runs.get(RUN_1).phase == Exited,
    runs.get(RUN_1).meta == MetaFailed,
    runs.get(RUN_2).phase == Idle,
    activeRunId' = RUN_2,
    runs' = runs.put(RUN_2, enteredRun(nextPrep, nextBoot, FromRun(RUN_1), lineageOk)),
    run1SnapshotTaken' = run1SnapshotTaken,
    run1Snapshot' = run1Snapshot,
  }

  // Terminal stutter only once the active run has exited.
  action stutter: bool = all {
    activeRun.phase == Exited,
    activeRunId' = activeRunId,
    runs' = runs,
    run1SnapshotTaken' = run1SnapshotTaken,
    run1Snapshot' = run1Snapshot,
  }

  action step: bool = {
    nondet nextPrep = PREPS.oneOf()
    nondet nextBoot = BOOTS.oneOf()
    nondet lineageOk = BOOLS.oneOf()
    any {
      prepareBeforeBegin,
      beginRun,
      prepareInBootstrap,
      createBootstrap,
      bootstrapPreMetaFail,
      terminalizeBootstrapStart,
      terminalizeBootstrapFinish,
      runStep,
      finishExecutionSuccess,
      finishExecutionFailure,
      startResumeRun(nextPrep, nextBoot, lineageOk),
      stutter,
    }
  }

  // --- Safety invariants ---

  // 1. Any run exiting after preparation, pre-meta bootstrap, or execution failure leaves meta.json (failed) and logs.
  val failureIsRecorded: bool =
    RUN_IDS.forall(id => {
      val r = runs.get(id)
      and {
        (r.phase == Exited and r.prep != PrepOk) implies and {
          r.meta == MetaFailed,
          r.logStartCount == 1,
          r.logTerminalCount == 1,
          r.finishCount == 1,
          r.hasFailureRecord,
        },
        (r.phase == Exited and r.prep == PrepOk and r.execOutcome == ExecPending) implies and {
          r.meta == MetaFailed,
          r.logStartCount == 1,
          r.logTerminalCount == 1,
          r.finishCount == 1,
          r.hasFailureRecord,
          not(r.reasonHasLookup),
          r.stepsRun == 0,
        },
        (r.phase == Exited and r.execOutcome == ExecFailed) implies and {
          r.meta == MetaFailed,
          r.logStartCount == 1,
          r.logTerminalCount == 1,
          r.finishCount == 1,
          r.hasFailureRecord,
          not(r.reasonHasLookup),
        },
      }
    })

  // 2. An unresolved call's recorded reason carries the lookup explanation.
  val unresolvedReasonExplains: bool =
    RUN_IDS.forall(id => {
      val r = runs.get(id)
      (r.phase == Exited and r.prep == CallUnresolved) implies r.reasonHasLookup
    })

  // 3. No step runs unless the run directory was reserved, the bundle was prepared, and bootstrap succeeded.
  val noStepWithoutBundle: bool =
    RUN_IDS.forall(id => {
      val r = runs.get(id)
      r.stepsRun > 0 implies (r.prep == PrepOk and r.prepDone and r.boot == BootOk and r.dirReserved)
    })

  // 4. meta.json is never left as running once a run has exited.
  val noRunningAfterExit: bool =
    RUN_IDS.forall(id => {
      val r = runs.get(id)
      r.phase == Exited implies r.meta != MetaRunning
    })

  // 5. beginRun only reserves an empty directory; meta.json and logs are not created yet.
  val beginRunLeavesNoRecordYet: bool =
    RUN_IDS.forall(id => {
      val r = runs.get(id)
      (r.phase == DirReserved or r.phase == PrepFailed or r.phase == BootstrapFailed) implies and {
        r.dirReserved,
        r.meta == NoMeta,
        r.metaPublishCount == 0,
        r.logStartCount == 0,
        r.logTerminalCount == 0,
        r.finishCount == 0,
      }
    })

  // 6. A completed run records MetaCompleted with no failure marker or lookup error reason.
  val noFailureOnSuccess: bool =
    RUN_IDS.forall(id => {
      val r = runs.get(id)
      (r.phase == Exited and r.execOutcome == ExecCompleted) implies and {
        r.meta == MetaCompleted,
        not(r.hasFailureRecord),
        not(r.reasonHasLookup),
        r.logStartCount == 1,
        r.logTerminalCount == 1,
        r.finishCount == 1,
        r.stepsRun > 0,
      }
    })

  // 7. No run publishes initial meta, workflow_start, terminal log, or finish more than once.
  val noDuplicateRecords: bool =
    RUN_IDS.forall(id => {
      val r = runs.get(id)
      and {
        r.metaPublishCount <= 1,
        r.logStartCount <= 1,
        r.logTerminalCount <= 1,
        r.finishCount <= 1,
      }
    })

  // 8. Resuming uses a distinct run slug, persists source_run_slug iff operation lineage is available
  //    (even on preparation or bootstrap failure), and never mutates the source run's meta.json / logs.
  val resumePreservesIntegrity: bool = and {
    RUN_IDS.forall(id => {
      val r = runs.get(id)
      and {
        isSourceDistinct(id, r.sourceRun),
        r.meta != NoMeta implies r.recordedSource == expectedRecordedSource(r),
        (r.phase == Exited and r.sourceRun != NoSource) implies and {
          r.meta != NoMeta,
          r.recordedSource == expectedRecordedSource(r),
          isSourceExited(r.sourceRun),
        },
      }
    }),
    run1SnapshotTaken implies persistedOf(runs.get(RUN_1)) == run1Snapshot,
  }

  // 9. Resuming from a source run that never created reports/ cannot execute steps or complete
  //    (inheritResumeReportSnapshot fails during bootstrap).
  val noResumeCompletionWithoutSourceReports: bool =
    RUN_IDS.forall(id => {
      val r = runs.get(id)
      (r.sourceRun != NoSource and not(sourceHasReports(r.sourceRun))) implies and {
        r.stepsRun == 0,
        r.meta != MetaCompleted,
      }
    })

  val invariant: bool = and {
    failureIsRecorded,
    unresolvedReasonExplains,
    noStepWithoutBundle,
    noRunningAfterExit,
    beginRunLeavesNoRecordYet,
    noFailureOnSuccess,
    noDuplicateRecords,
    resumePreservesIntegrity,
    noResumeCompletionWithoutSourceReports,
  }

  // --- Reachability witnesses (checked via quint run --witnesses) ---

  val witnessedUnresolvedCallFailure: bool =
    runs.get(RUN_1).phase == Exited
    and runs.get(RUN_1).prep == CallUnresolved
    and runs.get(RUN_1).meta == MetaFailed

  val witnessedCredentialFailure: bool =
    runs.get(RUN_1).phase == Exited
    and runs.get(RUN_1).prep == CredentialUnsafe
    and runs.get(RUN_1).meta == MetaFailed

  val witnessedPostPrepBootstrapFailure: bool =
    runs.get(RUN_1).phase == Exited
    and runs.get(RUN_1).prep == PrepOk
    and runs.get(RUN_1).boot == BootFailed
    and runs.get(RUN_1).meta == MetaFailed
    and runs.get(RUN_1).stepsRun == 0

  val witnessedCompletedRun: bool =
    runs.get(RUN_1).phase == Exited
    and runs.get(RUN_1).meta == MetaCompleted

  val witnessedExecFailure: bool =
    runs.get(RUN_1).phase == Exited
    and runs.get(RUN_1).execOutcome == ExecFailed
    and runs.get(RUN_1).meta == MetaFailed

  val witnessedResumedPrepFailure: bool =
    runs.get(RUN_2).phase == Exited
    and runs.get(RUN_2).sourceRun == FromRun(RUN_1)
    and runs.get(RUN_2).lineageAvailable
    and runs.get(RUN_2).recordedSource == FromRun(RUN_1)
    and runs.get(RUN_2).prep == CallUnresolved
    and runs.get(RUN_2).meta == MetaFailed

  val witnessedResumedInheritFailure: bool =
    runs.get(RUN_2).phase == Exited
    and runs.get(RUN_2).sourceRun == FromRun(RUN_1)
    and not(runs.get(RUN_1).hasReports)
    and runs.get(RUN_2).prep == PrepOk
    and runs.get(RUN_2).boot == BootOk
    and runs.get(RUN_2).meta == MetaFailed
    and runs.get(RUN_2).stepsRun == 0

  val witnessedResumedLineageUnavailable: bool =
    runs.get(RUN_2).phase == Exited
    and runs.get(RUN_2).sourceRun == FromRun(RUN_1)
    and not(runs.get(RUN_2).lineageAvailable)
    and runs.get(RUN_2).meta != NoMeta
    and runs.get(RUN_2).recordedSource == NoSource

  val witnessedResumedCompletion: bool =
    runs.get(RUN_2).phase == Exited
    and runs.get(RUN_2).sourceRun == FromRun(RUN_1)
    and runs.get(RUN_1).hasReports
    and runs.get(RUN_2).meta == MetaCompleted
}

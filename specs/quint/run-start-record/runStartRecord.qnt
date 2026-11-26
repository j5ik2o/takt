// -*- mode: Bluespec; -*-
// Run start: from executeWorkflowInternal entering to the run record (meta.json + logs) on disk.
//
// Sources modelled:
//   src/features/tasks/execute/workflowExecution.ts      executeWorkflowInternal
//   src/features/tasks/execute/workflowRunLifecycle.ts   beginRun (writes meta.json status=running, opens logs)
//   src/features/tasks/execute/workflowExecutionBundle.ts prepareWorkflowExecutionBundle (resolves every workflow_call)
//   terminalizeBootstrapFailure                           (rewrites meta.json status=failed with the reason)
//
// ORDER (a string) is where bundle preparation sits:
//   PrepareFirst  prepare before beginRun (before the fix)
//   BeginFirst    prepare inside the bootstrap try after beginRun (the fix)
module runStartRecord {
  const ORDER: str

  type Phase = Entered | Begun | Prepared | Executing | Exited
  type Meta = NoMeta | MetaRunning | MetaFailed
  // Outcome of preparing the bundle. CallUnresolved: the resolver returned null for some call.
  // CredentialUnsafe: central execution rejected a legacy MCP credential literal.
  type Prep = PrepOk | CallUnresolved | CredentialUnsafe

  var phase: Phase
  var meta: Meta
  var logs: bool
  var prep: Prep
  var prepDone: bool
  var reasonHasLookup: bool   // the failure reason carries call, cwd, searched and excluded candidates
  var stepsRun: int

  val PREPS = Set(PrepOk, CallUnresolved, CredentialUnsafe)

  action initWith(p: Prep): bool = all {
    phase' = Entered, meta' = NoMeta, logs' = false, prep' = p, prepDone' = false,
    reasonHasLookup' = false, stepsRun' = 0,
  }

  action init = {
    nondet p = PREPS.oneOf()
    initWith(p)
  }

  // Preparing before beginRun: a failure throws out of executeWorkflowInternal with nothing on disk.
  action prepareBeforeBegin = all {
    ORDER == "PrepareFirst", phase == Entered, not(prepDone),
    prepDone' = true,
    phase' = if (prep == PrepOk) Entered else Exited,
    reasonHasLookup' = false,
    meta' = meta, logs' = logs, prep' = prep, stepsRun' = stepsRun,
  }

  action beginRun = all {
    phase == Entered, ORDER == "BeginFirst" or prepDone,
    phase' = Begun, meta' = MetaRunning, logs' = true,
    prep' = prep, prepDone' = prepDone, reasonHasLookup' = reasonHasLookup, stepsRun' = stepsRun,
  }

  // Inside the bootstrap try: prepare (BeginFirst only), publish, load, bootstrap.
  // A failure goes to terminalizeBootstrapFailure, which writes meta status=failed with the reason.
  pure def bootstrapFails(order: str, p: Prep): bool = order == "BeginFirst" and p != PrepOk

  action bootstrap = all {
    phase == Begun,
    phase' = if (bootstrapFails(ORDER, prep)) Exited else Prepared,
    meta' = if (bootstrapFails(ORDER, prep)) MetaFailed else meta,
    reasonHasLookup' = (bootstrapFails(ORDER, prep) and prep == CallUnresolved),
    prepDone' = true,
    logs' = logs, prep' = prep, stepsRun' = stepsRun,
  }

  action runSteps = all {
    phase == Prepared,
    phase' = Executing, stepsRun' = stepsRun + 1,
    meta' = meta, logs' = logs, prep' = prep, prepDone' = prepDone, reasonHasLookup' = reasonHasLookup,
  }

  action stutter = all {
    phase == Exited or phase == Executing,
    phase' = phase, meta' = meta, logs' = logs, prep' = prep, prepDone' = prepDone,
    reasonHasLookup' = reasonHasLookup, stepsRun' = stepsRun,
  }

  action step = any { prepareBeforeBegin, beginRun, bootstrap, runSteps, stutter }

  // A failed preparation always leaves meta.json (failed) and logs.
  val failureIsRecorded =
    (phase == Exited and prep != PrepOk) implies (meta == MetaFailed and logs)

  // An unresolved call's recorded reason names where the lookup looked and what it excluded.
  val unresolvedReasonExplains =
    (phase == Exited and prep == CallUnresolved) implies reasonHasLookup

  // No step runs unless every call resolved and the bundle was prepared.
  val noStepWithoutBundle = stepsRun > 0 implies (prep == PrepOk and prepDone)

  // meta.json is never left as running once the run has exited.
  val noRunningAfterExit = phase == Exited implies meta != MetaRunning

  val invariant = failureIsRecorded and unresolvedReasonExplains and noStepWithoutBundle and noRunningAfterExit
}

// -*- mode: Bluespec; -*-
// CI failure evidence and the recovery routing that reads it (issue j5ik2o/takt#116).
//
// Sources modelled:
//   src/infra/github/pr-ci.ts                    collectPrCiFailure  -> `complete`
//   src/infra/workflow/system/system-pr-ci.ts    rerunCiEffect       -> rerun guard
//   builtins/*/workflows/merge-*.yaml            refresh_ci rules    -> fix_ci / rerun_ci / ci_stopped
//
// Each failed check is abstracted to the kind of evidence it can yield:
//   Diagnosable  an Actions job that ran and whose failed log was read
//   NotStarted   an Actions job cancelled before any step ran (steps = [], no log exists)
//   External     a failed status with no Actions log (commit status, third-party check)
//   Missing      an Actions job that ran but whose evidence could not be obtained
//
// `FIXED = false` is the code before the fix, `FIXED = true` the code after it.
module ciFailureEvidence {
  const FIXED: bool

  type Evidence = Diagnosable | NotStarted | External | Missing
  type Verdict = NoVerdict | Defect | ExternalCause | Insufficient
  type Phase = Collect | Investigate | Refresh | FixCi | RerunCi | Stopped | Merged
  type StopReason = NotStopped | IncompleteEvidence | RerunSpent | NoRecovery

  pure val KINDS: Set[Evidence] = Set(Diagnosable, NotStarted, External, Missing)
  pure val MAX_FIX_ROUNDS = 2

  var phase: Phase
  var failed: Set[Evidence]       // evidence kinds among the failed checks of the current HEAD
  var complete: bool
  var verdict: Verdict
  var fixRounds: int
  var rerunCount: int
  var stopReason: StopReason

  // collectPrCiFailure: `complete = checks.length > 0 && unavailable.length === 0`.
  // Before the fix every kind except Diagnosable lands in `unavailable`.
  // After the fix only Missing does; NotStarted stays in `checks`, External is listed apart.
  pure def isComplete(checks: Set[Evidence]): bool =
    if (FIXED)
      not(checks.contains(Missing)) and (checks.contains(Diagnosable) or checks.contains(NotStarted))
    else
      checks == Set(Diagnosable)

  // What an investigator that follows merge-ci-recovery can conclude from the evidence.
  // A defect needs a log. An external cause needs a log or a job that never started.
  pure def allowedVerdicts(checks: Set[Evidence]): Set[Verdict] =
    Set(Insufficient)
      .union(if (checks.contains(Diagnosable)) Set(Defect, ExternalCause) else Set())
      .union(if (checks.contains(NotStarted)) Set(ExternalCause) else Set())

  action initWith(first: Set[Evidence]): bool = all {
    failed' = first,
    phase' = Collect,
    complete' = false,
    verdict' = NoVerdict,
    fixRounds' = 0,
    rerunCount' = 0,
    stopReason' = NotStopped,
  }

  action init = {
    nondet first = KINDS.powerset().exclude(Set(Set())).oneOf()
    initWith(first)
  }

  action collect = all {
    phase == Collect,
    complete' = isComplete(failed),
    phase' = Investigate,
    failed' = failed, verdict' = NoVerdict, fixRounds' = fixRounds, rerunCount' = rerunCount,
    stopReason' = stopReason,
  }

  action investigateAs(v: Verdict): bool = all {
    phase == Investigate,
    allowedVerdicts(failed).contains(v),
    verdict' = v,
    phase' = Refresh,
    failed' = failed, complete' = complete, fixRounds' = fixRounds, rerunCount' = rerunCount,
    stopReason' = stopReason,
  }

  action investigate = {
    nondet v = allowedVerdicts(failed).oneOf()
    investigateAs(v)
  }

  // refresh_ci rules, in order (CI is still failed on the same HEAD here).
  action refresh = all {
    phase == Refresh,
    if (not(complete)) all { phase' = Stopped, stopReason' = IncompleteEvidence }
    else if (rerunCount > 0) all { phase' = Stopped, stopReason' = RerunSpent }
    else if (verdict == Defect and fixRounds < MAX_FIX_ROUNDS) all { phase' = FixCi, stopReason' = stopReason }
    else if (verdict == ExternalCause) all { phase' = RerunCi, stopReason' = stopReason }
    else all { phase' = Stopped, stopReason' = NoRecovery },
    failed' = failed, complete' = complete, verdict' = verdict, fixRounds' = fixRounds, rerunCount' = rerunCount,
  }

  // CI runs again on a new HEAD (after a fix) or a new attempt (after a rerun).
  // External statuses are not Actions jobs: neither a rerun nor TAKT's fix is assumed to clear them.
  action nextCi(after: Set[Evidence]): bool = all {
    failed' = after,
    phase' = if (after == Set()) Merged else Collect,
    complete' = false, verdict' = NoVerdict, stopReason' = stopReason,
  }

  action fix = all {
    phase == FixCi,
    nondet after = KINDS.powerset().oneOf()
    nextCi(after),
    fixRounds' = fixRounds + 1, rerunCount' = rerunCount,
  }

  action rerun = all {
    phase == RerunCi,
    nondet after = KINDS.powerset().filter(s => failed.contains(External) implies s.contains(External)).oneOf()
    nextCi(after),
    fixRounds' = fixRounds, rerunCount' = rerunCount + 1,
  }

  action step = any { collect, investigate, refresh, fix, rerun }

  // --- Invariants ---

  // Routing alone never reaches Merged while a check is failed: no rule skips the wait for a new CI result.
  // How `ci.passed` is computed from the checks is outside this model; `failed` is taken as given.
  val mergeOnlyWhenNothingFailed = phase == Merged implies failed == Set()

  // Recovery never acts while evidence that should exist is missing.
  val missingEvidenceBlocksRecovery =
    (phase == FixCi or phase == RerunCi) implies not(failed.contains(Missing))

  // A fix needs a diagnosed log.
  val fixNeedsDiagnosis = phase == FixCi implies failed.contains(Diagnosable)

  // A rerun needs an Actions job to rerun.
  val rerunNeedsActionsJob =
    phase == RerunCi implies (failed.contains(Diagnosable) or failed.contains(NotStarted))

  // Issue #116: recovery stops for incomplete evidence only when evidence is really missing
  // or when no Actions job is left to judge. Another check being NotStarted or External is
  // not a reason.
  val incompleteStopIsJustified =
    (phase == Stopped and stopReason == IncompleteEvidence) implies
      (failed.contains(Missing) or not(failed.contains(Diagnosable) or failed.contains(NotStarted)))

  val bounded = fixRounds <= MAX_FIX_ROUNDS and rerunCount <= 1

  val safety = and {
    mergeOnlyWhenNothingFailed, missingEvidenceBlocksRecovery, fixNeedsDiagnosis,
    rerunNeedsActionsJob, incompleteStopIsJustified, bounded,
  }

  // --- Witnesses (reachable when the count is above 0) ---
  val fixReachedWithExternalBeside = phase == FixCi and failed.contains(External)
  val rerunReachedForNotStartedOnly = phase == RerunCi and failed == Set(NotStarted)
  val stoppedForMissing = phase == Stopped and failed.contains(Missing)
  val merged = phase == Merged
}

module currentCode {
  import ciFailureEvidence(FIXED = false).*
}

module fixedCode {
  import ciFailureEvidence(FIXED = true).*
}

// -*- mode: Bluespec; -*-
// Step loop guard: max_visits and stop_on_repeated_verdict for one step in one workflow engine.
//
// Sources modelled:
//   src/core/workflow/engine/step-visit-guard.ts   StepLoopGuard (checkEntry / recordCompletion)
//   src/core/workflow/engine/WorkflowRunLoop.ts    where the run loop calls them: checkEntry before a
//                                                  step starts, recordCompletion once the step's
//                                                  transition is chosen; retries `continue` before that
//   src/core/workflow/engine/WorkflowEngineStepCoordinator.ts
//                                                  system step wait.on_timeout resolves a non-terminal
//                                                  transition with matchedRuleIndex === undefined
//
// CODE (a string) selects the implementation version:
//   "first"  first version of #164: every entry into the step counts, retries included
//   "pr164"  merged #164: only completed visits count, but non-terminal matchedRuleIndex === undefined
//            leaves lastVerdict stale (false stop on rule 0 -> wait.on_timeout -> rule 0)
//   "fixed"  follow-up fix: only completed visits count, and matchedRuleIndex === undefined clears
//            lastVerdict
module stepLoopGuard {
  const CODE: str
  const MAX_VISITS: int
  const STOP_ON_REPEATED_VERDICT: bool

  // Rule indexes a non-terminal rule transition can match.
  // NO_VERDICT represents either no previous verdict or a non-terminal transition without a rule
  // match (system step wait.on_timeout).
  pure val VERDICTS: Set[int] = Set(0, 1)
  pure val NO_VERDICT = -1

  type Status = Running | Finished | StoppedAtLimit | StoppedOnRepeat
  type Phase = Idle | InVisit

  var status: Status
  var phase: Phase
  var counted: int         // what the guard compares with MAX_VISITS
  var completedVisits: int // visits that ended in a transition
  var startedVisits: int   // visits that began (a retry is not a new visit)
  var lastVerdict: int     // verdict of the previous completed visit, NO_VERDICT if none
  var verdicts: List[int]  // verdicts of completed non-terminal visits (NO_VERDICT for wait.on_timeout)
  var reasons: List[str]   // stop reasons written to the abort reason

  action init = all {
    status' = Running,
    phase' = Idle,
    counted' = 0,
    completedVisits' = 0,
    startedVisits' = 0,
    lastVerdict' = NO_VERDICT,
    verdicts' = [],
    reasons' = [],
  }

  // checkEntry, plus the entry counting of the first version.
  action enter(isRetry: bool): bool = all {
    status == Running,
    if (isRetry) phase == InVisit else phase == Idle,
    if (counted >= MAX_VISITS) all {
      status' = StoppedAtLimit,
      reasons' = reasons.append("Visit limit reached"),
      phase' = phase, counted' = counted, completedVisits' = completedVisits,
      startedVisits' = startedVisits, lastVerdict' = lastVerdict, verdicts' = verdicts,
    } else all {
      status' = status,
      reasons' = reasons,
      phase' = InVisit,
      counted' = if (CODE == "first") counted + 1 else counted,
      completedVisits' = completedVisits,
      startedVisits' = if (isRetry) startedVisits else startedVisits + 1,
      lastVerdict' = lastVerdict,
      verdicts' = verdicts,
    },
  }

  // recordCompletion for a non-terminal rule transition with the given verdict.
  action complete(verdict: int): bool = all {
    status == Running,
    phase == InVisit,
    VERDICTS.contains(verdict),
    val repeated = STOP_ON_REPEATED_VERDICT and lastVerdict == verdict
    all {
      phase' = Idle,
      counted' = if (CODE == "first") counted else counted + 1,
      completedVisits' = completedVisits + 1,
      startedVisits' = startedVisits,
      lastVerdict' = verdict,
      verdicts' = verdicts.append(verdict),
      status' = if (repeated) StoppedOnRepeat else Running,
      reasons' = if (repeated) reasons.append("No progress") else reasons,
    },
  }

  // recordCompletion for a non-terminal transition without a matched rule (system step wait.on_timeout).
  // In "pr164" (and "first"), lastVerdict is left untouched; in "fixed", it is cleared to NO_VERDICT.
  action completeWithoutRule: bool = all {
    status == Running,
    phase == InVisit,
    phase' = Idle,
    counted' = if (CODE == "first") counted else counted + 1,
    completedVisits' = completedVisits + 1,
    startedVisits' = startedVisits,
    lastVerdict' = if (CODE == "fixed") NO_VERDICT else lastVerdict,
    verdicts' = verdicts.append(NO_VERDICT),
    status' = Running,
    reasons' = reasons,
  }

  // A terminal transition (COMPLETE, ABORT, return) ends the run without comparing verdicts.
  action finish: bool = all {
    status == Running,
    phase == InVisit,
    status' = Finished,
    phase' = Idle,
    counted' = counted,
    completedVisits' = completedVisits + 1,
    startedVisits' = startedVisits,
    lastVerdict' = lastVerdict,
    verdicts' = verdicts,
    reasons' = reasons,
  }

  action stutter: bool = all {
    status != Running,
    status' = status, phase' = phase, counted' = counted, completedVisits' = completedVisits,
    startedVisits' = startedVisits, lastVerdict' = lastVerdict, verdicts' = verdicts, reasons' = reasons,
  }

  action step = any {
    nondet isRetry = oneOf(Set(true, false))
    enter(isRetry),
    nondet verdict = oneOf(VERDICTS)
    complete(verdict),
    completeWithoutRule,
    finish,
    stutter,
  }

  // --- Invariants ---

  // Tightened from MAX_VISITS + 1: completed visits never exceed started visits, and neither exceeds MAX_VISITS.
  val visitsBounded = completedVisits <= startedVisits and startedVisits <= MAX_VISITS

  // Retrying the same visit never uses the limit: a stop at the limit means MAX_VISITS visits completed.
  val retriesFree = status == StoppedAtLimit implies completedVisits == MAX_VISITS

  // A stop on repetition requires the setting on and two consecutive equal non-empty verdicts.
  // A non-terminal transition without a matched rule (NO_VERDICT) breaks the streak.
  val stopOnRepeatNeedsRepeat =
    status == StoppedOnRepeat implies (
      STOP_ON_REPEATED_VERDICT
      and verdicts.length() >= 2
      and verdicts[verdicts.length() - 1] != NO_VERDICT
      and verdicts[verdicts.length() - 1] == verdicts[verdicts.length() - 2]
    )

  // No two consecutive equal rule verdicts survive while the setting is on and the run is still going.
  val noRepeatWhileRunning =
    (STOP_ON_REPEATED_VERDICT and status == Running) implies
      verdicts.indices().forall(i =>
        i == 0
        or verdicts[i] == NO_VERDICT
        or verdicts[i] != verdicts[i - 1]
      )

  // A stop leaves exactly one reason line; a run that has not stopped leaves none.
  val oneReasonPerStop =
    if (status == StoppedAtLimit or status == StoppedOnRepeat) reasons.length() == 1
    else reasons.length() == 0

  val safety = visitsBounded and retriesFree and stopOnRepeatNeedsRepeat
    and noRepeatWhileRunning and oneReasonPerStop

  // --- Witnesses ---
  val witnessStoppedAtLimit = status == StoppedAtLimit
  val witnessStoppedOnRepeat = status == StoppedOnRepeat
  val witnessFinished = status == Finished
  val witnessWithoutRuleSeen = verdicts.indices().exists(i => verdicts[i] == NO_VERDICT)
}

module currentCode {
  import stepLoopGuard(CODE = "fixed", MAX_VISITS = 3, STOP_ON_REPEATED_VERDICT = true).*
}

module currentCodeWithoutRepeat {
  import stepLoopGuard(CODE = "fixed", MAX_VISITS = 3, STOP_ON_REPEATED_VERDICT = false).*
}

module pr164Version {
  import stepLoopGuard(CODE = "pr164", MAX_VISITS = 3, STOP_ON_REPEATED_VERDICT = true).*
}

module firstVersion {
  import stepLoopGuard(CODE = "first", MAX_VISITS = 3, STOP_ON_REPEATED_VERDICT = true).*
}

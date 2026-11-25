// -*- mode: Bluespec; -*-
// Step loop guard: max_visits and stop_on_repeated_verdict for one step in one workflow engine.
//
// Sources modelled:
//   src/core/workflow/engine/step-visit-guard.ts   StepLoopGuard (checkEntry / recordCompletion)
//   src/core/workflow/engine/WorkflowRunLoop.ts    where the run loop calls them: checkEntry before a
//                                                  step starts, recordCompletion once the step's
//                                                  transition is chosen; retries `continue` before that
//
// CODE (a string) selects the counting:
//   "first"  the first version of #164: every entry into the step counts, retries included
//   "fixed"  the current code: only visits that ended in a transition count
module stepLoopGuard {
  const CODE: str
  const MAX_VISITS: int
  const STOP_ON_REPEATED_VERDICT: bool

  // Rule indexes a non-terminal transition can match. Terminal transitions end the run.
  pure val VERDICTS: Set[int] = Set(0, 1)
  pure val NO_VERDICT = -1

  type Status = Running | Finished | StoppedAtLimit | StoppedOnRepeat
  type Phase = Idle | InVisit

  var status: Status
  var phase: Phase
  var counted: int        // what the guard compares with MAX_VISITS
  var completedVisits: int // visits that ended in a transition
  var startedVisits: int   // visits that began (a retry is not a new visit)
  var lastVerdict: int     // verdict of the previous completed visit, NO_VERDICT if none
  var verdicts: List[int]  // verdicts of completed non-terminal visits, in order
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

  // recordCompletion for a non-terminal transition with the given verdict.
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
    finish,
    stutter,
  }

  // --- Invariants ---

  // The step never starts more than MAX_VISITS visits.
  val visitsBounded = startedVisits <= MAX_VISITS and completedVisits <= MAX_VISITS + 1

  // Retrying the same visit never uses the limit: a stop at the limit means MAX_VISITS visits completed.
  val retriesFree = status == StoppedAtLimit implies completedVisits == MAX_VISITS

  // While different verdicts alternate, the guard does not stop on repetition.
  val stopOnRepeatNeedsRepeat =
    status == StoppedOnRepeat implies (
      STOP_ON_REPEATED_VERDICT
      and verdicts.length() >= 2
      and verdicts[verdicts.length() - 1] == verdicts[verdicts.length() - 2]
    )

  // No two equal verdicts in a row survive while the setting is on and the run is still going.
  val noRepeatWhileRunning =
    (STOP_ON_REPEATED_VERDICT and status == Running) implies
      verdicts.indices().forall(i => i == 0 or verdicts[i] != verdicts[i - 1])

  // A stop leaves exactly one reason line; a run that has not stopped leaves none.
  val oneReasonPerStop =
    if (status == StoppedAtLimit or status == StoppedOnRepeat) reasons.length() == 1
    else reasons.length() == 0

  val safety = visitsBounded and retriesFree and stopOnRepeatNeedsRepeat
    and noRepeatWhileRunning and oneReasonPerStop
}

module currentCode {
  import stepLoopGuard(CODE = "fixed", MAX_VISITS = 3, STOP_ON_REPEATED_VERDICT = true).*
}

module currentCodeWithoutRepeat {
  import stepLoopGuard(CODE = "fixed", MAX_VISITS = 3, STOP_ON_REPEATED_VERDICT = false).*
}

module firstVersion {
  import stepLoopGuard(CODE = "first", MAX_VISITS = 3, STOP_ON_REPEATED_VERDICT = true).*
}

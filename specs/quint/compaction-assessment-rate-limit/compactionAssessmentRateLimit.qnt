// -*- mode: Bluespec; -*-
// Compaction completion assessment: what the Phase 1 caller sees when a provider call is rate limited.
//
// Sources modelled:
//   src/agents/runner.ts            the compaction loop of AgentRunner (call / assess / recover)
//   src/infra/providers/codex.ts    assessCompactedResponse (maps the assessor's response to a decision)
//
// CODE (a string) selects the mapping of a failed assessment:
//   "current"  the assessment result carries decision, error, failureCategory and usage only
//   "fixed"    the assessment result also carries errorKind and rateLimitInfo, and the loop
//              returns status rate_limited when errorKind is rate_limit
module compactionAssessmentRateLimit {
  const CODE: str

  // How one provider call (a turn or the assessor) ends.
  type CallEnd =
    | Done             // status done
    | PlainError       // status error
    | RateLimited      // status rate_limited, errorKind rate_limit, rateLimitInfo set
    | Threw            // the call rejected
  type Decision = Complete | NeedsRecovery | InvalidDecision
  type Phase = Turn | Assess | Returned
  // What the loop returns to the Phase 1 caller.
  type Result = Pending | RDone | RError | RRateLimited

  pure val TURN_ENDS: Set[CallEnd] = Set(Done, PlainError, RateLimited)
  pure val ASSESS_ENDS: Set[CallEnd] = Set(Done, PlainError, RateLimited, Threw)
  pure val DECISIONS: Set[Decision] = Set(Complete, NeedsRecovery, InvalidDecision)
  pure val MAX_RECOVERIES_WITHOUT_PROGRESS = 3

  var phase: Phase
  var recovering: bool
  var recoveriesWithoutProgress: int
  var result: Result
  var resultHasRateLimitInfo: bool
  var lastCallEnd: CallEnd        // how the provider call that decided the result ended
  var turns: int

  // The assessment result as the loop reads it: (is an error decision, says rate limit).
  pure def assessmentSaysRateLimit(code: str, end: CallEnd): bool =
    code == "fixed" and end == RateLimited

  action init = all {
    phase' = Turn, recovering' = false, recoveriesWithoutProgress' = 0,
    result' = Pending, resultHasRateLimitInfo' = false, lastCallEnd' = Done, turns' = 0,
  }

  action finish(r: Result, info: bool, end: CallEnd): bool = all {
    phase' = Returned, result' = r, resultHasRateLimitInfo' = info, lastCallEnd' = end,
    recovering' = recovering, recoveriesWithoutProgress' = recoveriesWithoutProgress, turns' = turns,
  }

  // agent.call or recoverFromCompaction. `compacted` is the context_compacted event of this turn.
  action turnWith(end: CallEnd, compacted: bool, calledTool: bool): bool = all {
    phase == Turn,
    if (end != Done or not(compacted)) {
      // The turn's own response is returned unchanged, rate limit fields included.
      val r = if (end == Done) RDone else if (end == RateLimited) RRateLimited else RError
      finish(r, end == RateLimited, end)
    } else all {
      phase' = Assess,
      recoveriesWithoutProgress' =
        if (recovering) (if (calledTool) 0 else recoveriesWithoutProgress + 1) else recoveriesWithoutProgress,
      recovering' = recovering, result' = result, resultHasRateLimitInfo' = resultHasRateLimitInfo,
      lastCallEnd' = lastCallEnd, turns' = turns + 1,
    },
  }

  action runTurn = {
    nondet end = TURN_ENDS.oneOf()
    nondet compacted = Set(true, false).oneOf()
    nondet calledTool = Set(true, false).oneOf()
    turnWith(end, compacted, calledTool)
  }

  action assessWith(end: CallEnd, decision: Decision): bool = all {
    phase == Assess,
    if (end != Done or decision == InvalidDecision) {
      if (assessmentSaysRateLimit(CODE, end)) finish(RRateLimited, true, end)
      else finish(RError, false, end)
    } else if (decision == Complete) {
      finish(RDone, false, end)
    } else if (recoveriesWithoutProgress == MAX_RECOVERIES_WITHOUT_PROGRESS) {
      finish(RError, false, end)
    } else all {
      phase' = Turn, recovering' = true,
      recoveriesWithoutProgress' = recoveriesWithoutProgress, result' = result,
      resultHasRateLimitInfo' = resultHasRateLimitInfo, lastCallEnd' = lastCallEnd, turns' = turns,
    },
  }

  action assess = {
    nondet end = ASSESS_ENDS.oneOf()
    nondet decision = DECISIONS.oneOf()
    assessWith(end, decision)
  }

  action stutter = all {
    phase == Returned,
    phase' = phase, recovering' = recovering, recoveriesWithoutProgress' = recoveriesWithoutProgress,
    result' = result, resultHasRateLimitInfo' = resultHasRateLimitInfo, lastCallEnd' = lastCallEnd,
    turns' = turns,
  }

  action step = any { runTurn, assess, stutter }

  // A rate limit on the deciding call reaches the caller as rate_limited with its metadata.
  val rateLimitReachesCaller =
    (phase == Returned and lastCallEnd == RateLimited)
      implies (result == RRateLimited and resultHasRateLimitInfo)
  // The loop never reports a rate limit that no provider call reported.
  val noInventedRateLimit =
    (result == RRateLimited or resultHasRateLimitInfo) implies lastCallEnd == RateLimited
  // A candidate response is accepted only by a done turn (and, after compaction, a Complete decision).
  val doneNeedsDoneCall = result == RDone implies lastCallEnd == Done
  val bounded = recoveriesWithoutProgress <= MAX_RECOVERIES_WITHOUT_PROGRESS

  val safety = and { rateLimitReachesCaller, noInventedRateLimit, doneNeedsDoneCall, bounded }

  // Witnesses (reachable when the count is greater than 0).
  val assessmentRateLimited = phase == Returned and lastCallEnd == RateLimited and turns > 0
  val completedAfterRecovery = phase == Returned and result == RDone and recovering
}

module currentCode {
  import compactionAssessmentRateLimit(CODE = "current").*
}

module fixedCode {
  import compactionAssessmentRateLimit(CODE = "fixed").*
}

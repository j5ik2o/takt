// -*- mode: Bluespec; -*-
// Scenario tests for the step loop guard (#164 and follow-up).
module fixedCodeTest {
  import stepLoopGuard(CODE = "fixed", MAX_VISITS = 2, STOP_ON_REPEATED_VERDICT = true).* from "./stepLoopGuard"

  // Two completed visits, then the third start stops with one reason.
  run stopsAtLimitTest =
    init
      .then(enter(false)).then(complete(0))
      .then(enter(false)).then(complete(1))
      .then(enter(false))
      .expect(status == StoppedAtLimit and reasons.length() == 1 and startedVisits == 2 and completedVisits == 2 and safety)

  // Retries of one visit (blocked → user input, quality gate, rate-limit fallback) do not use the limit.
  run retriesAreFreeTest =
    init
      .then(enter(false)).then(enter(true)).then(enter(true)).then(enter(true))
      .then(complete(0))
      .expect(status == Running and completedVisits == 1 and safety)

  // The same verdict twice in a row stops.
  run sameVerdictTwiceStopsTest =
    init
      .then(enter(false)).then(complete(1))
      .then(enter(false)).then(complete(1))
      .expect(status == StoppedOnRepeat and reasons.length() == 1 and safety)

  // A terminal transition ends the run and is never compared.
  run terminalIsNotComparedTest =
    init
      .then(enter(false)).then(complete(0))
      .then(enter(false)).then(finish)
      .expect(status == Finished and reasons.length() == 0 and safety)

  // Two rule-less completions (wait.on_timeout) in a row never stop on repetition, and still count toward max_visits.
  run consecutiveWithoutRuleDoesNotRepeatTest =
    init
      .then(enter(false)).then(completeWithoutRule)
      .then(enter(false)).then(completeWithoutRule)
      .expect(status == Running and completedVisits == 2 and safety)
}

module withoutRuleStreakBreakTest {
  import stepLoopGuard(CODE = "fixed", MAX_VISITS = 5, STOP_ON_REPEATED_VERDICT = true).* from "./stepLoopGuard"

  // rule 0 -> wait.on_timeout (no rule) -> rule 0 is not consecutive, so it keeps running;
  // a second rule 0 immediately afterward stops on repetition.
  run timeoutBreaksVerdictStreakTest =
    init
      .then(enter(false)).then(complete(0))
      .then(enter(false)).then(completeWithoutRule)
      .then(enter(false)).then(complete(0))
      .expect(status == Running and completedVisits == 3 and safety)
      .then(enter(false)).then(complete(0))
      .expect(status == StoppedOnRepeat and reasons.length() == 1 and safety)
}

module alternatingTest {
  import stepLoopGuard(CODE = "fixed", MAX_VISITS = 5, STOP_ON_REPEATED_VERDICT = true).* from "./stepLoopGuard"

  // Different verdicts alternating never stop on repetition; only the limit stops them.
  run alternatingRunsToLimitTest =
    init
      .then(enter(false)).then(complete(0))
      .then(enter(false)).then(complete(1))
      .then(enter(false)).then(complete(0))
      .then(enter(false)).then(complete(1))
      .then(enter(false)).then(complete(0))
      .then(enter(false))
      .expect(status == StoppedAtLimit and completedVisits == 5 and safety)
}

module pr164VersionTest {
  import stepLoopGuard(CODE = "pr164", MAX_VISITS = 5, STOP_ON_REPEATED_VERDICT = true).* from "./stepLoopGuard"

  // Merged #164 left lastVerdict stale across wait.on_timeout, causing a false stop on rule 0 -> timeout -> rule 0.
  run timeoutLeftStaleVerdictTest =
    init
      .then(enter(false)).then(complete(0))
      .then(enter(false)).then(completeWithoutRule)
      .then(enter(false)).then(complete(0))
      .expect(status == StoppedOnRepeat and not(stopOnRepeatNeedsRepeat))
}

module firstVersionTest {
  import stepLoopGuard(CODE = "first", MAX_VISITS = 2, STOP_ON_REPEATED_VERDICT = true).* from "./stepLoopGuard"

  // The first version counted retries: two entries of one visit stopped it before it ever completed.
  run retryUsedTheLimitTest =
    init
      .then(enter(false)).then(enter(true)).then(enter(true))
      .expect(status == StoppedAtLimit and completedVisits == 0 and not(retriesFree))
}

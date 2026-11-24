// -*- mode: Bluespec; -*-
// Scenario tests for the compaction completion assessment (issue j5ik2o/takt#86).
module currentCodeTest {
  import compactionAssessmentRateLimit(CODE = "current").* from "./compactionAssessmentRateLimit"

  // The defect: a rate-limited assessment reaches the caller as an ordinary error.
  run rateLimitedAssessmentBecomesPlainErrorTest =
    init
      .then(turnWith(Done, true, false))
      .then(assessWith(RateLimited, Complete))
      .expect(result == RError and not(resultHasRateLimitInfo) and not(rateLimitReachesCaller))
}

module fixedCodeTest {
  import compactionAssessmentRateLimit(CODE = "fixed").* from "./compactionAssessmentRateLimit"

  run rateLimitedAssessmentReachesCallerTest =
    init
      .then(turnWith(Done, true, false))
      .then(assessWith(RateLimited, Complete))
      .expect(result == RRateLimited and resultHasRateLimitInfo and safety)

  run rateLimitedAssessmentAfterRecoveryTest =
    init
      .then(turnWith(Done, true, false))
      .then(assessWith(Done, NeedsRecovery))
      .then(turnWith(Done, true, true))
      .then(assessWith(RateLimited, NeedsRecovery))
      .expect(result == RRateLimited and resultHasRateLimitInfo and safety)

  run plainAssessmentErrorStaysErrorTest =
    init
      .then(turnWith(Done, true, false))
      .then(assessWith(PlainError, Complete))
      .expect(result == RError and not(resultHasRateLimitInfo) and safety)

  run thrownAssessmentStaysErrorTest =
    init
      .then(turnWith(Done, true, false))
      .then(assessWith(Threw, Complete))
      .expect(result == RError and not(resultHasRateLimitInfo) and safety)

  run invalidDecisionStaysErrorTest =
    init
      .then(turnWith(Done, true, false))
      .then(assessWith(Done, InvalidDecision))
      .expect(result == RError and safety)

  run completeDecisionKeepsCandidateTest =
    init
      .then(turnWith(Done, true, false))
      .then(assessWith(Done, Complete))
      .expect(result == RDone and safety)

  run rateLimitedTurnIsReturnedUnchangedTest =
    init
      .then(turnWith(RateLimited, true, false))
      .expect(result == RRateLimited and resultHasRateLimitInfo and safety)

  run uncompactedTurnSkipsAssessmentTest =
    init
      .then(turnWith(Done, false, false))
      .expect(result == RDone and turns == 0 and safety)

  // Three recoveries without a tool call end the loop with an ordinary error.
  run recoveryLimitTest =
    init
      .then(turnWith(Done, true, false))
      .then(assessWith(Done, NeedsRecovery))
      .then(turnWith(Done, true, false))
      .then(assessWith(Done, NeedsRecovery))
      .then(turnWith(Done, true, false))
      .then(assessWith(Done, NeedsRecovery))
      .then(turnWith(Done, true, false))
      .then(assessWith(Done, NeedsRecovery))
      .expect(result == RError and recoveriesWithoutProgress == MAX_RECOVERIES_WITHOUT_PROGRESS and safety)
}

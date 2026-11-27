// -*- mode: Bluespec; -*-
// Scenario tests for development-core replan monitor interaction (#164 follow-up).
module fixedMonitorTest {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 4,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = false
  ).* from "./replanMonitor"

  // Normal path from Plan: 1st peer-review does not fire judge; 2nd peer-review fires judge,
  // and judge ABORT stops immediately.
  run normalPathSecondPeerReviewTriggersJudgeTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .expect(status == Running and judgePeerReviewCounts.length() == 0 and peerReviewCompletions == 1 and safety)
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .expect(status == AbortedByJudge and judgePeerReviewCounts == [2] and replanCompleted == 1 and safety)

  // Item 1 (implement -> replan path): 1st peer-review must NOT fire judge; 2nd peer-review fires judge.
  run implementToReplanDoesNotFalseFireTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .expect(status == Running and judgePeerReviewCounts.length() == 0 and peerReviewCompletions == 1 and safety)
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .expect(status == AbortedByJudge and judgePeerReviewCounts == [2] and replanCompleted == 2 and safety)

  // Item 1 (replan resume path): 1st peer-review after starting at replan must NOT fire judge;
  // 2nd peer-review fires judge.
  run resumeAtReplanDoesNotFalseFireTest =
    initAt(Replan)
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .expect(status == Running and judgePeerReviewCounts.length() == 0 and peerReviewCompletions == 1 and safety)
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .expect(status == AbortedByJudge and judgePeerReviewCounts == [2] and replanCompleted == 2 and safety)

  // Item 1 + retry: retrying the 1st peer-review never counts as a 2nd completion.
  run retriedFirstPeerReviewDoesNotFalseFireTest =
    initAt(Replan)
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(retryStep).then(retryStep).then(completeNonTerminal(Replan, JudgeAbort))
      .expect(status == Running and judgePeerReviewCounts.length() == 0 and peerReviewCompletions == 1 and safety)

  // Resume at peer-review (design 低-1): the resumed visit is the 1st completion, so the judge waits
  // for the 2nd peer-review.
  run resumeAtPeerReviewDoesNotFalseFireTest =
    initAt(PeerReview)
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .expect(status == Running and judgePeerReviewCounts.length() == 0 and peerReviewCompletions == 1 and safety)
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .expect(status == AbortedByJudge and judgePeerReviewCounts == [2] and safety)

  // [plan, write_tests] monitor (design 低-1): the 3rd write_tests -> plan asks its judge; the
  // [replan, peer-review] judge is not involved.
  run planWriteTestsMonitorFiresOnThirdLapTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, Continue))
      .then(enterStep).then(completeNonTerminal(Plan, Continue))
      .then(enterStep).then(completeNonTerminal(WriteTests, Continue))
      .then(enterStep).then(completeNonTerminal(Plan, Continue))
      .then(enterStep).then(completeNonTerminal(WriteTests, Continue))
      .expect(otherJudgeRuns == 0 and safety)
      .then(enterStep).then(completeNonTerminal(Plan, JudgeAbort))
      .expect(status == AbortedByJudge and otherJudgeRuns == 1 and judgePeerReviewCounts.length() == 0 and safety)

  // Item 2 (max_visits = 4): judge fires on 2nd, 3rd, and 4th peer-review (3 times),
  // and on the 5th peer-review (after replan completed 4 times) stops at visit limit with NO 4th judge.
  run stopsAtMaxVisitsWithoutExtraJudgeTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      // Lap 1: replan(1) -> implement -> peer-review(2) -> judge #1 (continue)
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      // Lap 2: replan(2) -> implement -> peer-review(3) -> judge #2 (continue)
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      // Lap 3: replan(3) -> implement -> peer-review(4) -> judge #3 (continue)
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      // Lap 4: replan(4) -> implement -> peer-review(5) -> replan is at limit -> NO judge -> AbortedAtVisitLimit
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .then(enterStep)
      .expect(
        status == AbortedAtVisitLimit
        and replanCompleted == 4
        and judgePeerReviewCounts == [2, 3, 4]
        and judgeReplanCounts == [1, 2, 3]
        and safety
      )
}

module fixedMonitorMax1Test {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 1,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = false
  ).* from "./replanMonitor"

  // Item 2 (max_visits = 1): after 1 replan, 2nd peer-review -> replan stops at visit limit with 0 judge calls.
  run maxVisits1NeverCallsJudgeTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .then(enterStep)
      .expect(
        status == AbortedAtVisitLimit
        and replanCompleted == 1
        and judgePeerReviewCounts.length() == 0
        and safety
      )
}

module beforeFollowupTest {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 0,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = false,
    MAX_VISITS = 1,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = false
  ).* from "./replanMonitor"

  // Reproduces Item 1 counterexample (implement -> replan -> 1st peer-review false-fires judge).
  run pr164FalseFiresOnImplementToReplanTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .expect(status == AbortedByJudge and not(noJudgeOnFirstPeerReview) and not(noJudgeWhenNextAtVisitLimit))

  // Reproduces Item 1 counterexample (replan resume -> 1st peer-review false-fires judge).
  run pr164FalseFiresOnResumeAtReplanTest =
    initAt(Replan)
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .expect(status == AbortedByJudge and not(noJudgeOnFirstPeerReview))

  // Reproduces Item 2 counterexample (normal path with max_visits: 1 still invokes judge on 2nd peer-review).
  run pr164CallsJudgeAtVisitLimitTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .expect(status == AbortedByJudge and noJudgeOnFirstPeerReview and not(noJudgeWhenNextAtVisitLimit))
}

module fixedMonitorMax3Test {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 3,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = false
  ).* from "./replanMonitor"

  // [replan, implement] monitor (design 低-1): the 3rd implement -> replan would complete 3 laps, but
  // replan is already at max_visits = 3, so no judge runs and the run stops at the visit limit.
  run replanImplementMonitorSkippedAtLimitTest =
    initAt(Replan)
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .then(enterStep)
      .expect(status == AbortedAtVisitLimit and replanCompleted == 3 and otherJudgeRuns == 0 and safety)
}

module beforeFollowupMax3Test {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = false,
    MAX_VISITS = 3,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = false
  ).* from "./replanMonitor"

  // Before the fix the [replan, implement] judge runs although replan is at its limit (design 低-1).
  run replanImplementJudgeAtLimitTest =
    initAt(Replan)
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, JudgeAbort))
      .expect(status == AbortedByJudge and otherJudgeRuns == 1 and not(noJudgeWhenNextAtVisitLimit))
}

module fixedMonitorWithEscapeTest {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 2,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = true
  ).* from "./replanMonitor"

  // Design 中-1, option (b): below the limit the judge's escape route is honoured.
  run escapeBelowLimitCompletesTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Escape))
      .expect(status == CompletedByJudgeEscape and judgePeerReviewCounts == [2] and safety)

  // Design 中-1, option (b): when replan is at its limit the judge is not asked, so its escape route
  // cannot run; the run stops at the visit limit.
  run limitBeatsEscapeTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Escape))
      .then(enterStep)
      .expect(
        status == AbortedAtVisitLimit
        and replanCompleted == 2
        and judgePeerReviewCounts == [2]
        and transitionedIntoLimit
        and safety
      )
}

module judgeBeforeLimitWithEscapeTest {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = false,
    MAX_VISITS = 2,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = true
  ).* from "./replanMonitor"

  // Merged #164 / option (a) of design 中-1: the judge runs at the limit and its escape completes the
  // run. This is the outcome option (b) changes.
  run escapeAtLimitCompletesTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Escape))
      .expect(
        status == CompletedByJudgeEscape
        and judgePeerReviewCounts == [2, 3]
        and not(limitBeatsJudge)
        and not(noJudgeWhenNextAtVisitLimit)
      )
}

module mutantMinTrigger3Test {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 3,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 4,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = false
  ).* from "./replanMonitor"

  // Design 低-2: firing too late (min_trigger_visits 3) skips the due judge on the 2nd peer-review.
  run lateFireMissesDueJudgeTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .then(enterStep).then(completeNonTerminal(Implement, Continue))
      .then(enterStep).then(completeNonTerminal(PeerReview, Continue))
      .then(enterStep).then(completeNonTerminal(Replan, Continue))
      .expect(status == Running and judgePeerReviewCounts.length() == 0 and not(judgeFiresWhenDue))
}

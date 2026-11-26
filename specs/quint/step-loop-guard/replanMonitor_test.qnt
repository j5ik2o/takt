// -*- mode: Bluespec; -*-
// Scenario tests for development-core replan monitor interaction (#164 follow-up).
module fixedMonitorTest {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 4,
    ALLOW_RESUME_AT_REPLAN = true
  ).* from "./replanMonitor"

  // Normal path from Plan: 1st peer-review does not fire judge; 2nd peer-review fires judge,
  // and judge ABORT stops immediately.
  run normalPathSecondPeerReviewTriggersJudgeTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, true))
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, true))
      .expect(status == Running and judgePeerReviewCounts.length() == 0 and peerReviewCompletions == 1 and safety)
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, false))
      .expect(status == AbortedByJudge and judgePeerReviewCounts == [2] and replanCompleted == 1 and safety)

  // Item 1 (implement -> replan path): 1st peer-review must NOT fire judge; 2nd peer-review fires judge.
  run implementToReplanDoesNotFalseFireTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, true))
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(Replan, true))
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, false))
      .expect(status == Running and judgePeerReviewCounts.length() == 0 and peerReviewCompletions == 1 and safety)
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, false))
      .expect(status == AbortedByJudge and judgePeerReviewCounts == [2] and replanCompleted == 2 and safety)

  // Item 1 (replan resume path): 1st peer-review after starting at replan must NOT fire judge;
  // 2nd peer-review fires judge.
  run resumeAtReplanDoesNotFalseFireTest =
    initAt(Replan)
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, false))
      .expect(status == Running and judgePeerReviewCounts.length() == 0 and peerReviewCompletions == 1 and safety)
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, false))
      .expect(status == AbortedByJudge and judgePeerReviewCounts == [2] and replanCompleted == 2 and safety)

  // Item 1 + retry: retrying the 1st peer-review never counts as a 2nd completion.
  run retriedFirstPeerReviewDoesNotFalseFireTest =
    initAt(Replan)
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(retryStep).then(retryStep).then(completeNonTerminal(Replan, false))
      .expect(status == Running and judgePeerReviewCounts.length() == 0 and peerReviewCompletions == 1 and safety)

  // Item 2 (max_visits = 4): judge fires on 2nd, 3rd, and 4th peer-review (3 times),
  // and on the 5th peer-review (after replan completed 4 times) stops at visit limit with NO 4th judge.
  run stopsAtMaxVisitsWithoutExtraJudgeTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, true))
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, true))
      // Lap 1: replan(1) -> implement -> peer-review(2) -> judge #1 (continue)
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, true))
      // Lap 2: replan(2) -> implement -> peer-review(3) -> judge #2 (continue)
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, true))
      // Lap 3: replan(3) -> implement -> peer-review(4) -> judge #3 (continue)
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, true))
      // Lap 4: replan(4) -> implement -> peer-review(5) -> replan is at limit -> NO judge -> AbortedAtVisitLimit
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, false))
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
    ALLOW_RESUME_AT_REPLAN = true
  ).* from "./replanMonitor"

  // Item 2 (max_visits = 1): after 1 replan, 2nd peer-review -> replan stops at visit limit with 0 judge calls.
  run maxVisits1NeverCallsJudgeTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, true))
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, true))
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, false))
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
    ALLOW_RESUME_AT_REPLAN = true
  ).* from "./replanMonitor"

  // Reproduces Item 1 counterexample (implement -> replan -> 1st peer-review false-fires judge).
  run pr164FalseFiresOnImplementToReplanTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, true))
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(Replan, true))
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, false))
      .expect(status == AbortedByJudge and not(noJudgeOnFirstPeerReview) and not(noJudgeWhenNextAtVisitLimit))

  // Reproduces Item 1 counterexample (replan resume -> 1st peer-review false-fires judge).
  run pr164FalseFiresOnResumeAtReplanTest =
    initAt(Replan)
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, false))
      .expect(status == AbortedByJudge and not(noJudgeOnFirstPeerReview))

  // Reproduces Item 2 counterexample (normal path with max_visits: 1 still invokes judge on 2nd peer-review).
  run pr164CallsJudgeAtVisitLimitTest =
    initAt(Plan)
      .then(enterStep).then(completeNonTerminal(WriteTests, true))
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, true))
      .then(enterStep).then(completeNonTerminal(Implement, true))
      .then(enterStep).then(completeNonTerminal(PeerReview, true))
      .then(enterStep).then(completeNonTerminal(Replan, false))
      .expect(status == AbortedByJudge and noJudgeOnFirstPeerReview and not(noJudgeWhenNextAtVisitLimit))
}

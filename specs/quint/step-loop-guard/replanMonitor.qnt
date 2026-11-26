// -*- mode: Bluespec; -*-
// Interaction model of development-core + CycleDetector + StepLoopGuard + LoopMonitorJudge.
//
// Sources modelled:
//   builtins/{ja,en}/workflows/development-core.yaml  transition graph, replan max_visits, and all three
//                                                     loop monitors in YAML order:
//                                                       1. [plan, write_tests]   threshold: 3
//                                                       2. [replan, implement]   threshold: 3
//                                                       3. [replan, peer-review] ignore_steps: [implement],
//                                                          threshold: 1, min_trigger_visits: 2
//   src/core/workflow/engine/cycle-detector.ts        CycleDetector (history, completedCounts, reset,
//                                                     first triggered monitor wins)
//   src/core/workflow/engine/step-visit-guard.ts      StepLoopGuard on replan
//   src/core/workflow/engine/WorkflowRunLoop.ts       ordering of handleTerminalTransition,
//                                                     stepVisitRecordCompletion, next-step visit-limit check,
//                                                     cycleDetectorRecordAndCheck, runLoopMonitorJudge
//   src/core/workflow/engine/LoopMonitorJudgeRunner.ts resetCycleDetector() after every judge run;
//                                                     the judge's rule picks the next step
//
// Contract chosen for the next-step limit (design "中-1", option b): when the natural next step has
// already reached max_visits, the run stops at the visit limit without asking any judge, even when a
// judge rule could route elsewhere. `limitBeatsJudge` states this outcome.
module replanMonitor {
  // 0 in merged #164 (no minimum on peer-review completions); 2 in follow-up fix.
  const MIN_TRIGGER_VISITS: int
  // false in merged #164 (judge runs before checking nextStep's visit limit); true in follow-up fix.
  const CHECK_NEXT_LIMIT_BEFORE_JUDGE: bool
  // replan max_visits (4 by default in development-core, or overridden via config.yaml e.g. 1).
  const MAX_VISITS: int
  // When true, init explores a start or resume at every step; otherwise only a start at Plan.
  const ALLOW_RESUME: bool
  // false for builtin judges (rules go to the cycle head or ABORT only). true models a custom workflow
  // whose judge rules also have an escape route (e.g. `escalate`, which then COMPLETEs).
  const JUDGE_HAS_ESCAPE: bool

  type StepName = Plan | WriteTests | Implement | PeerReview | Replan
  type RunStatus = Running | Completed | AbortedNatural | AbortedAtVisitLimit | AbortedByJudge | CompletedByJudgeEscape
  type VisitPhase = Entering | InStep
  // Which judge rule the LLM picks: the monitor's continue rule (the cycle head), ABORT, or an escape route.
  type JudgeChoice = Continue | JudgeAbort | Escape

  var status: RunStatus
  var phase: VisitPhase
  var currentStep: StepName
  var startStep: StepName
  var history: List[StepName]           // CycleDetector.history (cleared on judge reset)
  var peerReviewCompletions: int        // engine-wide completedCounts['peer-review'] (preserved across reset)
  var replanStarted: int                // replan visits started (retries excluded)
  var replanCompleted: int              // replan visits completed with a non-terminal transition
  var judgePeerReviewCounts: List[int]  // peerReviewCompletions at each [replan, peer-review] judge
  var judgeReplanCounts: List[int]      // replanCompleted at each judge whose proposed next step is replan
  var otherJudgeRuns: int               // runs of the [plan, write_tests] and [replan, implement] judges
  var tookImplementToReplan: bool       // true once Implement -> Replan occurred
  var transitionedIntoLimit: bool       // a non-terminal transition proposed replan with replan at max_visits
  var missedDueJudge: bool              // a transition was due for the [replan, peer-review] judge but got none

  // Valid non-terminal edges of development-core.yaml.
  pure def isValidNonTerminalEdge(fromStep: StepName, toStep: StepName): bool =
    or {
      fromStep == Plan and toStep == WriteTests,
      fromStep == WriteTests and (toStep == Implement or toStep == Plan),
      fromStep == Implement and (toStep == PeerReview or toStep == Replan),
      fromStep == Replan and (toStep == Implement or toStep == PeerReview),
      fromStep == PeerReview and toStep == Replan,
    }

  // Valid terminal transitions of development-core.yaml (COMPLETE / ABORT).
  pure def canComplete(s: StepName): bool = s == Plan or s == PeerReview
  pure def canNaturalAbort(s: StepName): bool = s == Plan or s == Replan or s == PeerReview

  // CycleDetector.checkMonitor for a two-step cycle [a, b] without ignore_steps:
  // the last `k` pairs of the history are [a, b] (cycleCount >= threshold).
  pure def endsWithPairs(h: List[StepName], a: StepName, b: StepName, k: int): bool = {
    val n = h.length()
    n >= 2 * k and 0.to(k - 1).forall(i => h[n - 2 - 2 * i] == a and h[n - 1 - 2 * i] == b)
  }

  // Monitor 1 [plan, write_tests] (threshold 3), then monitor 2 [replan, implement] (threshold 3).
  pure def otherTriggered(hist: List[StepName], nextStep: StepName): bool = or {
    nextStep == Plan and endsWithPairs(hist, Plan, WriteTests, 3),
    nextStep == Replan and endsWithPairs(hist, Replan, Implement, 3),
  }

  // Monitor 3: cycle = [Replan, PeerReview], ignore_steps = [Implement], threshold = 1,
  // plus optional min_trigger_visits against engine-wide completedCounts['peer-review'].
  pure def cycleTriggered(
    hist: List[StepName],
    prCount: int,
    nextStep: StepName,
    minTriggerVisits: int
  ): bool = {
    val relevant = hist.select(s => s != Implement)
    val n = relevant.length()
    and {
      nextStep == Replan,
      n >= 2,
      relevant[n - 1] == PeerReview,
      relevant[n - 2] == Replan,
      minTriggerVisits <= 0 or prCount >= minTriggerVisits,
    }
  }

  action initAt(s: StepName): bool = all {
    status' = Running,
    phase' = Entering,
    currentStep' = s,
    startStep' = s,
    history' = [],
    peerReviewCompletions' = 0,
    replanStarted' = 0,
    replanCompleted' = 0,
    judgePeerReviewCounts' = [],
    judgeReplanCounts' = [],
    otherJudgeRuns' = 0,
    tookImplementToReplan' = false,
    transitionedIntoLimit' = false,
    missedDueJudge' = false,
  }

  action init = {
    val startCandidates =
      if (ALLOW_RESUME) Set(Plan, WriteTests, Implement, PeerReview, Replan) else Set(Plan)
    nondet s = oneOf(startCandidates)
    initAt(s)
  }

  // Variables a step entry, retry, or terminal transition leaves untouched.
  action keepCounters: bool = all {
    startStep' = startStep,
    history' = history,
    peerReviewCompletions' = peerReviewCompletions,
    replanCompleted' = replanCompleted,
    judgePeerReviewCounts' = judgePeerReviewCounts,
    judgeReplanCounts' = judgeReplanCounts,
    otherJudgeRuns' = otherJudgeRuns,
    tookImplementToReplan' = tookImplementToReplan,
    transitionedIntoLimit' = transitionedIntoLimit,
    missedDueJudge' = missedDueJudge,
  }

  // Step entry: checks StepLoopGuard.checkEntry(currentStep).
  action enterStep: bool = all {
    status == Running,
    phase == Entering,
    currentStep' = currentStep,
    keepCounters,
    if (currentStep == Replan and replanCompleted >= MAX_VISITS) all {
      status' = AbortedAtVisitLimit,
      phase' = phase,
      replanStarted' = replanStarted,
    } else all {
      status' = Running,
      phase' = InStep,
      replanStarted' = if (currentStep == Replan) replanStarted + 1 else replanStarted,
    },
  }

  // Retry of the same visit (blocked -> user input, quality gate failure, rate-limit fallback,
  // requiresUserInput): continues before recordCompletion and before CycleDetector.recordAndCheck.
  action retryStep: bool = all {
    status == Running,
    phase == InStep,
    status' = status,
    phase' = InStep,
    currentStep' = currentStep,
    replanStarted' = replanStarted,
    keepCounters,
  }

  // Natural terminal transition (COMPLETE or ABORT): handled before recordCompletion and CycleDetector.
  action completeTerminal(isComplete: bool): bool = all {
    status == Running,
    phase == InStep,
    if (isComplete) canComplete(currentStep) else canNaturalAbort(currentStep),
    status' = if (isComplete) Completed else AbortedNatural,
    phase' = Entering,
    currentStep' = currentStep,
    replanStarted' = replanStarted,
    keepCounters,
  }

  // Non-terminal transition with optional loop-monitor judge intervention.
  action completeNonTerminal(nextStep: StepName, judgeChoice: JudgeChoice): bool = all {
    status == Running,
    phase == InStep,
    isValidNonTerminalEdge(currentStep, nextStep),
    JUDGE_HAS_ESCAPE or judgeChoice != Escape,
    val nextReplanCompleted =
      if (currentStep == Replan) replanCompleted + 1 else replanCompleted
    val intoLimit = nextStep == Replan and nextReplanCompleted >= MAX_VISITS
    val skipMonitors = CHECK_NEXT_LIMIT_BEFORE_JUDGE and intoLimit
    val nextHist =
      if (skipMonitors) history else history.append(currentStep)
    val nextPrCount =
      if (skipMonitors) peerReviewCompletions
      else if (currentStep == PeerReview) peerReviewCompletions + 1
      else peerReviewCompletions
    // CycleDetector checks monitors in YAML order and returns the first one that triggers.
    val otherFires = not(skipMonitors) and otherTriggered(nextHist, nextStep)
    val monitor3Fires =
      not(skipMonitors) and not(otherFires)
        and cycleTriggered(nextHist, nextPrCount, nextStep, MIN_TRIGGER_VISITS)
    val judgeRuns = otherFires or monitor3Fires
    // Spec of the builtin monitor, written independently of MIN_TRIGGER_VISITS and the skip:
    // a peer-review -> replan transition below the replan limit, whose filtered history ends with
    // [replan, peer-review], from the 2nd peer-review completion on, must ask the judge.
    val dueForMonitor3 = and {
      currentStep == PeerReview,
      not(intoLimit),
      cycleTriggered(history.append(currentStep), peerReviewCompletions + 1, nextStep, 2),
    }
    all {
      replanStarted' = replanStarted,
      replanCompleted' = nextReplanCompleted,
      startStep' = startStep,
      tookImplementToReplan' =
        if (currentStep == Implement and nextStep == Replan) true else tookImplementToReplan,
      transitionedIntoLimit' = (transitionedIntoLimit or intoLimit),
      missedDueJudge' = (missedDueJudge or (dueForMonitor3 and not(monitor3Fires))),
      peerReviewCompletions' = nextPrCount,
      judgePeerReviewCounts' =
        if (monitor3Fires) judgePeerReviewCounts.append(nextPrCount) else judgePeerReviewCounts,
      judgeReplanCounts' =
        if (judgeRuns and nextStep == Replan) judgeReplanCounts.append(nextReplanCompleted)
        else judgeReplanCounts,
      otherJudgeRuns' = if (otherFires) otherJudgeRuns + 1 else otherJudgeRuns,
      phase' = Entering,
      if (judgeRuns) all {
        // LoopMonitorJudgeRunner calls resetCycleDetector() after every judge run: clears history,
        // keeps engine-wide peerReviewCompletions. The continue rule of every builtin judge goes to
        // the cycle head, which is the proposed nextStep.
        history' = [],
        status' =
          if (judgeChoice == Continue) Running
          else if (judgeChoice == JudgeAbort) AbortedByJudge
          else CompletedByJudgeEscape,
        currentStep' = if (judgeChoice == Continue) nextStep else currentStep,
      } else all {
        history' = nextHist,
        status' = Running,
        currentStep' = nextStep,
      },
    },
  }

  action stutter: bool = all {
    status != Running,
    status' = status, phase' = phase, currentStep' = currentStep,
    replanStarted' = replanStarted,
    keepCounters,
  }

  action step = any {
    enterStep,
    retryStep,
    nondet isComplete = oneOf(Set(true, false))
    completeTerminal(isComplete),
    nondet nextStep = oneOf(Set(Plan, WriteTests, Implement, PeerReview, Replan))
    nondet judgeChoice = oneOf(Set(Continue, JudgeAbort, Escape))
    completeNonTerminal(nextStep, judgeChoice),
    stutter,
  }

  // --- Invariants ---

  // Item 1 (no false fire): the [replan, peer-review] judge never fires until peer-review has
  // completed at least 2 visits in this engine run (so review-resolution.md has >= 2 generations).
  val noJudgeOnFirstPeerReview =
    judgePeerReviewCounts.indices().forall(i => judgePeerReviewCounts[i] >= 2)

  // Item 2 (no wasted judge at visit limit): no judge runs when the proposed next step (replan) has
  // already completed MAX_VISITS visits and would stop on entry.
  val noJudgeWhenNextAtVisitLimit =
    judgeReplanCounts.indices().forall(i => judgeReplanCounts[i] < MAX_VISITS)

  // Design 中-1 (option b): a transition into replan at its limit always ends the run at the visit
  // limit; no judge can turn it into an ABORT by the judge or an escape.
  val limitBeatsJudge =
    transitionedIntoLimit implies (status == Running or status == AbortedAtVisitLimit)

  // Design 低-2 (no under-firing): every transition due for the [replan, peer-review] judge asks it.
  val judgeFiresWhenDue = not(missedDueJudge)

  // Item 4 (tightened bound): completed replan visits never exceed started visits or MAX_VISITS.
  val replanVisitsBounded =
    replanCompleted <= replanStarted and replanStarted <= MAX_VISITS

  // Stopping at the visit limit means exactly MAX_VISITS replan visits completed.
  val limitAbortHasExactVisits =
    status == AbortedAtVisitLimit implies replanCompleted == MAX_VISITS

  val safety = and {
    noJudgeOnFirstPeerReview,
    noJudgeWhenNextAtVisitLimit,
    limitBeatsJudge,
    judgeFiresWhenDue,
    replanVisitsBounded,
    limitAbortHasExactVisits,
  }

  // --- Witnesses ---
  val witnessJudgeFired = judgePeerReviewCounts.length() > 0
  val witnessAbortedAtLimit = status == AbortedAtVisitLimit
  val witnessJudgeAfterImplementReplan = tookImplementToReplan and judgePeerReviewCounts.length() > 0
  val witnessJudgeAfterResumeAtReplan = startStep == Replan and judgePeerReviewCounts.length() > 0
  val witnessJudgeAfterResumeAtPeerReview = startStep == PeerReview and judgePeerReviewCounts.length() > 0
  val witnessOtherJudgeFired = otherJudgeRuns > 0
  val witnessJudgeEscaped = status == CompletedByJudgeEscape
  val witnessCompleted = status == Completed
}

// Follow-up fix with default development-core max_visits = 4, start or resume at any step.
module fixedMonitor {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 4,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = false
  ).*
}

// Follow-up fix with config.yaml override max_visits = 1.
module fixedMonitorMax1 {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 1,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = false
  ).*
}

// Follow-up fix with max_visits = 3: the [replan, implement] judge (threshold 3) could reach replan
// at its limit before the fix.
module fixedMonitorMax3 {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 3,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = false
  ).*
}

// Follow-up fix in a custom workflow whose judge rules also have an escape route (design 中-1).
module fixedMonitorWithEscape {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 2,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = true
  ).*
}

// Merged PR #164 (before follow-up), start or resume at any step.
module beforeFollowup {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 0,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = false,
    MAX_VISITS = 4,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = false
  ).*
}

// Merged PR #164 starting strictly from Plan (proves implement -> replan false fire and wasted judge
// at max_visits even without resume).
module beforeFollowupFromPlan {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 0,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = false,
    MAX_VISITS = 2,
    ALLOW_RESUME = false,
    JUDGE_HAS_ESCAPE = false
  ).*
}

// Merged PR #164 with max_visits = 3: only the [replan, implement] judge can reach replan at its
// limit here before peer-review runs twice (design 低-1).
module beforeFollowupMax3 {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = false,
    MAX_VISITS = 3,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = false
  ).*
}

// Option (a) of design 中-1 / merged #164 behaviour with an escape route: the judge runs at the
// limit and its escape completes the run. `limitBeatsJudge` must fail here.
module judgeBeforeLimitWithEscape {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = false,
    MAX_VISITS = 2,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = true
  ).*
}

// Mutants that `safety` must reject (design 低-2): firing too early and firing too late.
module mutantMinTrigger1 {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 1,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 4,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = false
  ).*
}

module mutantMinTrigger3 {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 3,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 4,
    ALLOW_RESUME = true,
    JUDGE_HAS_ESCAPE = false
  ).*
}

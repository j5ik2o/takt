// -*- mode: Bluespec; -*-
// Interaction model of development-core + CycleDetector + StepLoopGuard + LoopMonitorJudge.
//
// Sources modelled:
//   builtins/{ja,en}/workflows/development-core.yaml  transition graph, replan max_visits,
//                                                     [replan, peer-review] monitor (ignore_steps: [implement],
//                                                     threshold: 1, min_trigger_visits: 2)
//   src/core/workflow/engine/cycle-detector.ts        CycleDetector (history, completedCounts, reset)
//   src/core/workflow/engine/step-visit-guard.ts      StepLoopGuard on replan
//   src/core/workflow/engine/WorkflowRunLoop.ts       ordering of handleTerminalTransition,
//                                                     stepVisitRecordCompletion, next-step visit-limit check,
//                                                     cycleDetectorRecordAndCheck, runLoopMonitorJudge
//   src/core/workflow/engine/LoopMonitorJudgeRunner.ts resetCycleDetector() after judge runs
module replanMonitor {
  // 0 in merged #164 (no minimum on peer-review completions); 2 in follow-up fix.
  const MIN_TRIGGER_VISITS: int
  // false in merged #164 (judge runs before checking nextStep's visit limit); true in follow-up fix.
  const CHECK_NEXT_LIMIT_BEFORE_JUDGE: bool
  // replan max_visits (4 by default in development-core, or overridden via config.yaml e.g. 1).
  const MAX_VISITS: int
  // When true, init explores both starting from Plan and resuming from Replan.
  const ALLOW_RESUME_AT_REPLAN: bool

  type StepName = Plan | WriteTests | Implement | PeerReview | Replan
  type RunStatus = Running | Completed | AbortedNatural | AbortedAtVisitLimit | AbortedByJudge
  type VisitPhase = Entering | InStep

  var status: RunStatus
  var phase: VisitPhase
  var currentStep: StepName
  var history: List[StepName]         // CycleDetector.history (cleared on judge reset)
  var peerReviewCompletions: int      // engine-wide completedCounts['peer-review'] (preserved across reset)
  var replanStarted: int              // replan visits started (retries excluded)
  var replanCompleted: int            // replan visits completed with a non-terminal transition
  var judgePeerReviewCounts: List[int] // peerReviewCompletions observed at each judge invocation
  var judgeReplanCounts: List[int]    // replanCompleted observed at each judge invocation
  var startedFromReplan: bool         // true when run started/resumed at Replan
  var tookImplementToReplan: bool     // true when Implement -> Replan occurred

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

  // Exact CycleDetector.checkMonitor logic for cycle = [Replan, PeerReview],
  // ignore_steps = [Implement], threshold = 1, plus optional min_trigger_visits.
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

  action initAt(startStep: StepName): bool = all {
    status' = Running,
    phase' = Entering,
    currentStep' = startStep,
    history' = [],
    peerReviewCompletions' = 0,
    replanStarted' = 0,
    replanCompleted' = 0,
    judgePeerReviewCounts' = [],
    judgeReplanCounts' = [],
    startedFromReplan' = (startStep == Replan),
    tookImplementToReplan' = false,
  }

  action init = {
    val startCandidates = if (ALLOW_RESUME_AT_REPLAN) Set(Plan, Replan) else Set(Plan)
    nondet startStep = oneOf(startCandidates)
    initAt(startStep)
  }

  // Step entry: checks StepLoopGuard.checkEntry(currentStep).
  action enterStep: bool = all {
    status == Running,
    phase == Entering,
    if (currentStep == Replan and replanCompleted >= MAX_VISITS) all {
      status' = AbortedAtVisitLimit,
      phase' = phase,
      currentStep' = currentStep,
      history' = history,
      peerReviewCompletions' = peerReviewCompletions,
      replanStarted' = replanStarted,
      replanCompleted' = replanCompleted,
      judgePeerReviewCounts' = judgePeerReviewCounts,
      judgeReplanCounts' = judgeReplanCounts,
      startedFromReplan' = startedFromReplan,
      tookImplementToReplan' = tookImplementToReplan,
    } else all {
      status' = Running,
      phase' = InStep,
      currentStep' = currentStep,
      history' = history,
      peerReviewCompletions' = peerReviewCompletions,
      replanStarted' = if (currentStep == Replan) replanStarted + 1 else replanStarted,
      replanCompleted' = replanCompleted,
      judgePeerReviewCounts' = judgePeerReviewCounts,
      judgeReplanCounts' = judgeReplanCounts,
      startedFromReplan' = startedFromReplan,
      tookImplementToReplan' = tookImplementToReplan,
    },
  }

  // Retry of the same visit (blocked -> user input, quality gate failure, rate-limit fallback):
  // continues before recordCompletion and before CycleDetector.recordAndCheck.
  action retryStep: bool = all {
    status == Running,
    phase == InStep,
    status' = status,
    phase' = InStep,
    currentStep' = currentStep,
    history' = history,
    peerReviewCompletions' = peerReviewCompletions,
    replanStarted' = replanStarted,
    replanCompleted' = replanCompleted,
    judgePeerReviewCounts' = judgePeerReviewCounts,
    judgeReplanCounts' = judgeReplanCounts,
    startedFromReplan' = startedFromReplan,
    tookImplementToReplan' = tookImplementToReplan,
  }

  // Natural terminal transition (COMPLETE or ABORT): handled before recordCompletion and CycleDetector.
  action completeTerminal(isComplete: bool): bool = all {
    status == Running,
    phase == InStep,
    if (isComplete) canComplete(currentStep) else canNaturalAbort(currentStep),
    status' = if (isComplete) Completed else AbortedNatural,
    phase' = Entering,
    currentStep' = currentStep,
    history' = history,
    peerReviewCompletions' = peerReviewCompletions,
    replanStarted' = replanStarted,
    replanCompleted' = replanCompleted,
    judgePeerReviewCounts' = judgePeerReviewCounts,
    judgeReplanCounts' = judgeReplanCounts,
    startedFromReplan' = startedFromReplan,
    tookImplementToReplan' = tookImplementToReplan,
  }

  // Non-terminal transition with optional loop-monitor judge intervention.
  action completeNonTerminal(nextStep: StepName, judgeContinues: bool): bool = all {
    status == Running,
    phase == InStep,
    isValidNonTerminalEdge(currentStep, nextStep),
    val nextReplanCompleted =
      if (currentStep == Replan) replanCompleted + 1 else replanCompleted
    val nextTargetAtLimit =
      CHECK_NEXT_LIMIT_BEFORE_JUDGE and nextStep == Replan and nextReplanCompleted >= MAX_VISITS
    val nextHist =
      if (nextTargetAtLimit) history else history.append(currentStep)
    val nextPrCount =
      if (nextTargetAtLimit) peerReviewCompletions
      else if (currentStep == PeerReview) peerReviewCompletions + 1
      else peerReviewCompletions
    val triggered =
      not(nextTargetAtLimit) and cycleTriggered(nextHist, nextPrCount, nextStep, MIN_TRIGGER_VISITS)
    all {
      replanStarted' = replanStarted,
      replanCompleted' = nextReplanCompleted,
      startedFromReplan' = startedFromReplan,
      tookImplementToReplan' =
        if (currentStep == Implement and nextStep == Replan) true else tookImplementToReplan,
      peerReviewCompletions' = nextPrCount,
      if (triggered) all {
        judgePeerReviewCounts' = judgePeerReviewCounts.append(nextPrCount),
        judgeReplanCounts' = judgeReplanCounts.append(nextReplanCompleted),
        // LoopMonitorJudgeRunner calls resetCycleDetector() after every judge run: clears history,
        // keeps engine-wide peerReviewCompletions.
        history' = [],
        phase' = Entering,
        if (judgeContinues) all {
          status' = Running,
          currentStep' = Replan,
        } else all {
          status' = AbortedByJudge,
          currentStep' = currentStep,
        },
      } else all {
        judgePeerReviewCounts' = judgePeerReviewCounts,
        judgeReplanCounts' = judgeReplanCounts,
        history' = nextHist,
        status' = Running,
        phase' = Entering,
        currentStep' = nextStep,
      },
    },
  }

  action stutter: bool = all {
    status != Running,
    status' = status, phase' = phase, currentStep' = currentStep,
    history' = history, peerReviewCompletions' = peerReviewCompletions,
    replanStarted' = replanStarted, replanCompleted' = replanCompleted,
    judgePeerReviewCounts' = judgePeerReviewCounts, judgeReplanCounts' = judgeReplanCounts,
    startedFromReplan' = startedFromReplan, tookImplementToReplan' = tookImplementToReplan,
  }

  action step = any {
    enterStep,
    retryStep,
    nondet isComplete = oneOf(Set(true, false))
    completeTerminal(isComplete),
    nondet nextStep = oneOf(Set(Plan, WriteTests, Implement, PeerReview, Replan))
    nondet judgeContinues = oneOf(Set(true, false))
    completeNonTerminal(nextStep, judgeContinues),
    stutter,
  }

  // --- Invariants ---

  // Item 1 (no false fire): the [replan, peer-review] judge never fires until peer-review has
  // completed at least 2 visits in this engine run (so review-resolution.md has >= 2 generations).
  val noJudgeOnFirstPeerReview =
    judgePeerReviewCounts.indices().forall(i => judgePeerReviewCounts[i] >= 2)

  // Item 2 (no wasted judge at visit limit): the judge never runs when the proposed next step
  // (replan) has already completed MAX_VISITS visits and will stop on entry anyway.
  val noJudgeWhenNextAtVisitLimit =
    judgeReplanCounts.indices().forall(i => judgeReplanCounts[i] < MAX_VISITS)

  // Item 4 (tightened bound): completed replan visits never exceed started visits or MAX_VISITS.
  val replanVisitsBounded =
    replanCompleted <= replanStarted and replanStarted <= MAX_VISITS

  // Stopping at the visit limit means exactly MAX_VISITS replan visits completed.
  val limitAbortHasExactVisits =
    status == AbortedAtVisitLimit implies replanCompleted == MAX_VISITS

  val safety = noJudgeOnFirstPeerReview and noJudgeWhenNextAtVisitLimit
    and replanVisitsBounded and limitAbortHasExactVisits

  // --- Witnesses ---
  val witnessJudgeFired = judgePeerReviewCounts.length() > 0
  val witnessAbortedAtLimit = status == AbortedAtVisitLimit
  val witnessJudgeAfterImplementReplan = tookImplementToReplan and judgePeerReviewCounts.length() > 0
  val witnessJudgeAfterResumeAtReplan = startedFromReplan and judgePeerReviewCounts.length() > 0
  val witnessCompleted = status == Completed
}

// Follow-up fixed specification with default development-core max_visits = 4 (both Plan start & Replan resume).
module fixedMonitor {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 4,
    ALLOW_RESUME_AT_REPLAN = true
  ).*
}

// Follow-up fixed specification with config.yaml override max_visits = 1.
module fixedMonitorMax1 {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 2,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = true,
    MAX_VISITS = 1,
    ALLOW_RESUME_AT_REPLAN = true
  ).*
}

// Merged PR #164 specification (before follow-up): explores both Plan start & Replan resume.
module beforeFollowup {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 0,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = false,
    MAX_VISITS = 4,
    ALLOW_RESUME_AT_REPLAN = true
  ).*
}

// Merged PR #164 specification starting strictly from Plan (proves implement -> replan false fire
// and wasted judge at max_visits even without resume).
module beforeFollowupFromPlan {
  import replanMonitor(
    MIN_TRIGGER_VISITS = 0,
    CHECK_NEXT_LIMIT_BEFORE_JUDGE = false,
    MAX_VISITS = 2,
    ALLOW_RESUME_AT_REPLAN = false
  ).*
}

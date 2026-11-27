// -*- mode: Bluespec; -*-
// Iteration-start check ordering and exceeded persistence model (j5ik2o/takt#176).
//
// Sources modelled:
//   src/core/workflow/engine/WorkflowRunLoop.ts
//     - runWorkflowToCompletionCore (iteration-start checks + end-of-iteration nextStep check + loop monitor judge)
//     - runSingleWorkflowIterationCore (iteration-start checks without max_steps)
//     - workflow_call ABORT handling (ABORT -> ABORT / no rule / ABORT -> COMPLETE / ABORT -> nextStep)
//   src/core/workflow/engine/WorkflowCallExecutor.ts
//     - child engine inherits parent onIterationLimit and shares root max_steps budget
//   src/core/workflow/engine/step-visit-guard.ts      StepLoopGuard (checkEntry / recordCompletion)
//   src/core/workflow/engine/loop-detector.ts         LoopDetector (stateful consecutiveCount check)
//   src/core/workflow/engine/LoopMonitorJudgeRunner.ts
//     - judge consumes state.iteration++ and may route to any step (including one already at max_visits)
//   src/features/tasks/execute/workflowExecution.ts
//   src/features/tasks/execute/iterationLimitHandler.ts
//   src/features/tasks/execute/taskExecution.ts
//     - onIterationLimit: in non-interactive takt run, sets exceededInfo and returns null (persisted as `exceeded`);
//       via direct WorkflowEngine API, may return +N to extend maxSteps and `continue` to the top of the loop.
//     - EXCEEDED_GUARD models workflowExecution.ts:661-662:
//         false (#174 / 657f16ad6): exceeded = exceededInfo != null
//         true  (#176 fix):         exceeded = finalState.status === 'aborted' && abortKind === 'iteration_limit' && exceededInfo != null
//
// ORDER selects the iteration-start check order:
//   "before"             Current code (#174 / 657f16ad6):
//                          full:   Interrupt -> MaxSteps -> UserInput -> LoopDetector -> VisitLimit
//                          single: Interrupt -> UserInput -> LoopDetector -> VisitLimit
//   "fixed"              Issue #176 fix:
//                          full:   Interrupt -> VisitLimit -> MaxSteps -> UserInput -> LoopDetector
//                          single: Interrupt -> VisitLimit -> UserInput -> LoopDetector
//   "abortAtTransition"  Alternative (abort at line 1214 pre-judge check only, keeping MaxSteps before VisitLimit):
//                          fails when a loop monitor judge (triggered for a non-limit nextStep) increments
//                          iteration to maxSteps and routes to another step already at max_visits.
//   "loopBeforeMaxSteps" Mutant moving stateful LoopDetector before MaxSteps:
//                          fails because extending maxSteps via onIterationLimit executes `continue`,
//                          causing LoopDetector to double-count the same step entry.
module iterationEntryOrder {
  const ORDER: str
  const MODE: str // "full" | "single"
  const EXCEEDED_GUARD: bool
  const ALLOW_INTERRUPT: bool
  const INITIAL_MAX_STEPS: int
  const STEP_A_MAX_VISITS: int // <= 0 means no max_visits
  const STEP_C_MAX_VISITS: int // <= 0 means no max_visits
  const STEP_CALL_MAX_VISITS: int // <= 0 means no max_visits
  const LOOP_DETECTION_MAX: int
  const LOOP_DETECTION_ABORT: bool
  const INTERACTIVE_EXTEND: bool
  const IGNORE_ITERATION_LIMIT: bool
  const USER_INPUT_INVALID_ON_B: bool
  const ENABLE_LOOP_MONITOR: bool

  type StepName = StepA | StepB | StepC | StepCall
  type VisitPhase = Entering | InStep
  type RunStatus =
    | Running
    | Completed
    | AbortedInterrupt
    | AbortedVisitLimit
    | AbortedIterationLimit
    | AbortedUserInput
    | AbortedLoopDetector
    | AbortedByJudge
  type JudgeChoice = JudgeContinue | JudgeRouteToC | JudgeAbort
  type ChildAbortOutcome = ChildAbortPropagate | ChildAbortToComplete | ChildAbortToStepA

  pure val ALL_STEPS: Set[StepName] = Set(StepA, StepB, StepC, StepCall)

  pure def maxVisitsFor(s: StepName): int =
    match s {
      | StepA => STEP_A_MAX_VISITS
      | StepB => 0
      | StepC => STEP_C_MAX_VISITS
      | StepCall => STEP_CALL_MAX_VISITS
    }

  pure def consumesBudget(s: StepName): bool = s != StepCall

  pure def isAtVisitLimit(s: StepName, completed: StepName -> int): bool = {
    val limit = maxVisitsFor(s)
    limit > 0 and completed.get(s) >= limit
  }

  pure def isUserInputInvalid(s: StepName): bool =
    USER_INPUT_INVALID_ON_B and s == StepB

  pure def isValidNonTerminalEdge(fromStep: StepName, dstStep: StepName): bool =
    match fromStep {
      | StepA => dstStep == StepB or dstStep == StepA or dstStep == StepC or dstStep == StepCall
      | StepB => dstStep == StepA or dstStep == StepB or dstStep == StepC
      | StepC => dstStep == StepA or dstStep == StepB
      | StepCall => dstStep == StepA or dstStep == StepCall
    }

  // Stateful LoopDetector.check(stepName) pure computation.
  pure def nextLoopState(
    hasLast: bool,
    lastStep: StepName,
    count: int,
    stepName: StepName
  ): { nextCount: int, isLoop: bool, shouldAbort: bool } = {
    val c = if (hasLast and lastStep == stepName) count + 1 else 1
    val loop = c > LOOP_DETECTION_MAX
    { nextCount: c, isLoop: loop, shouldAbort: loop and LOOP_DETECTION_ABORT }
  }

  // --- State variables ---
  var status: RunStatus
  var phase: VisitPhase
  var currentStep: StepName
  var inRetry: bool
  var iteration: int
  var maxSteps: int
  var interruptPending: bool
  var completedVisits: StepName -> int
  var startedVisits: StepName -> int
  var hasLastLoopStep: bool
  var lastLoopStep: StepName
  var consecutiveLoopCount: int
  var exceededInfoRecorded: bool // models eventBridge.state.exceededInfo != null

  // Ghost variables for verifying side effects and priority contracts.
  var onIterationLimitCalls: int
  var judgeCalls: int
  var loopDetectorChecks: int
  var entryId: int // identifies each step entry; unchanged across onIterationLimit extension `continue`
  var lastLoopCheckEntryId: int
  var loopDetectorDoubleCounted: bool
  var naturalTransitionIntoLimit: bool
  var maxStepsFiredAtVisitLimit: bool
  var promptedLimitAtVisitLimit: bool
  var loopDetectorRanAtVisitLimit: bool
  var abortedLoopDetectorAtVisitLimit: bool
  var startedOverBudget: bool
  var extendedCount: int

  // Models workflowExecution.ts:661-662 (computed when engine.run() completes).
  val exceededSaved =
    if (status == Running) false
    else if (EXCEEDED_GUARD) (status == AbortedIterationLimit and exceededInfoRecorded)
    else exceededInfoRecorded

  action initAt(s: StepName, initIter: int): bool = all {
    status' = Running,
    phase' = Entering,
    currentStep' = s,
    inRetry' = false,
    iteration' = initIter,
    maxSteps' = INITIAL_MAX_STEPS,
    interruptPending' = false,
    completedVisits' = ALL_STEPS.mapBy(_ => 0),
    startedVisits' = ALL_STEPS.mapBy(_ => 0),
    hasLastLoopStep' = false,
    lastLoopStep' = StepA,
    consecutiveLoopCount' = 0,
    exceededInfoRecorded' = false,
    onIterationLimitCalls' = 0,
    judgeCalls' = 0,
    loopDetectorChecks' = 0,
    entryId' = 0,
    lastLoopCheckEntryId' = -1,
    loopDetectorDoubleCounted' = false,
    naturalTransitionIntoLimit' = false,
    maxStepsFiredAtVisitLimit' = false,
    promptedLimitAtVisitLimit' = false,
    loopDetectorRanAtVisitLimit' = false,
    abortedLoopDetectorAtVisitLimit' = false,
    startedOverBudget' = false,
    extendedCount' = 0,
  }

  action init = {
    nondet s = oneOf(Set(StepA, StepB, StepC))
    initAt(s, 0)
  }

  // External SIGINT / AbortSignal arrives before an entry check.
  action requestInterrupt: bool = all {
    ALLOW_INTERRUPT,
    status == Running,
    phase == Entering,
    not(interruptPending),
    interruptPending' = true,
    status' = status, phase' = phase, currentStep' = currentStep, inRetry' = inRetry,
    iteration' = iteration, maxSteps' = maxSteps,
    completedVisits' = completedVisits, startedVisits' = startedVisits,
    hasLastLoopStep' = hasLastLoopStep, lastLoopStep' = lastLoopStep,
    consecutiveLoopCount' = consecutiveLoopCount, exceededInfoRecorded' = exceededInfoRecorded,
    onIterationLimitCalls' = onIterationLimitCalls, judgeCalls' = judgeCalls,
    loopDetectorChecks' = loopDetectorChecks,
    entryId' = entryId, lastLoopCheckEntryId' = lastLoopCheckEntryId,
    loopDetectorDoubleCounted' = loopDetectorDoubleCounted,
    naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
    maxStepsFiredAtVisitLimit' = maxStepsFiredAtVisitLimit,
    promptedLimitAtVisitLimit' = promptedLimitAtVisitLimit,
    loopDetectorRanAtVisitLimit' = loopDetectorRanAtVisitLimit,
    abortedLoopDetectorAtVisitLimit' = abortedLoopDetectorAtVisitLimit,
    startedOverBudget' = startedOverBudget,
    extendedCount' = extendedCount,
  }

  // Iteration-start guard evaluation (models lines 856-921 in full mode, 1296-1348 in single mode).
  // `extendOnLimit` is only relevant when INTERACTIVE_EXTEND is true and max_steps triggers.
  action enterStep(extendOnLimit: bool): bool = all {
    status == Running,
    phase == Entering,
    (INTERACTIVE_EXTEND and extendedCount < 2) or not(extendOnLimit),
    val atVisitLimit = isAtVisitLimit(currentStep, completedVisits)
    val maxStepsActive =
      MODE == "full"
      and consumesBudget(currentStep)
      and not(IGNORE_ITERATION_LIMIT)
      and iteration >= maxSteps
    val userInputInvalid = isUserInputInvalid(currentStep)
    val ld = nextLoopState(hasLastLoopStep, lastLoopStep, consecutiveLoopCount, currentStep)
    val doubleCountOnLd = lastLoopCheckEntryId == entryId

    // 1. Interrupt always checked first in all versions.
    if (interruptPending) all {
      status' = AbortedInterrupt,
      phase' = Entering,
      currentStep' = currentStep,
      inRetry' = inRetry,
      iteration' = iteration,
      maxSteps' = maxSteps,
      interruptPending' = interruptPending,
      completedVisits' = completedVisits,
      startedVisits' = startedVisits,
      hasLastLoopStep' = hasLastLoopStep,
      lastLoopStep' = lastLoopStep,
      consecutiveLoopCount' = consecutiveLoopCount,
      exceededInfoRecorded' = exceededInfoRecorded,
      onIterationLimitCalls' = onIterationLimitCalls,
      judgeCalls' = judgeCalls,
      loopDetectorChecks' = loopDetectorChecks,
      entryId' = entryId,
      lastLoopCheckEntryId' = lastLoopCheckEntryId,
      loopDetectorDoubleCounted' = loopDetectorDoubleCounted,
      naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
      maxStepsFiredAtVisitLimit' = maxStepsFiredAtVisitLimit,
      promptedLimitAtVisitLimit' = promptedLimitAtVisitLimit,
      loopDetectorRanAtVisitLimit' = loopDetectorRanAtVisitLimit,
      abortedLoopDetectorAtVisitLimit' = abortedLoopDetectorAtVisitLimit,
      startedOverBudget' = startedOverBudget,
      extendedCount' = extendedCount,
    } else if ((ORDER == "fixed" or ORDER == "loopBeforeMaxSteps") and atVisitLimit) all {
      // VisitLimit runs immediately after Interrupt, before MaxSteps / UserInput / LoopDetector.
      status' = AbortedVisitLimit,
      phase' = Entering,
      currentStep' = currentStep,
      inRetry' = inRetry,
      iteration' = iteration,
      maxSteps' = maxSteps,
      interruptPending' = interruptPending,
      completedVisits' = completedVisits,
      startedVisits' = startedVisits,
      hasLastLoopStep' = hasLastLoopStep,
      lastLoopStep' = lastLoopStep,
      consecutiveLoopCount' = consecutiveLoopCount,
      exceededInfoRecorded' = exceededInfoRecorded,
      onIterationLimitCalls' = onIterationLimitCalls,
      judgeCalls' = judgeCalls,
      loopDetectorChecks' = loopDetectorChecks,
      entryId' = entryId,
      lastLoopCheckEntryId' = lastLoopCheckEntryId,
      loopDetectorDoubleCounted' = loopDetectorDoubleCounted,
      naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
      maxStepsFiredAtVisitLimit' = maxStepsFiredAtVisitLimit,
      promptedLimitAtVisitLimit' = promptedLimitAtVisitLimit,
      loopDetectorRanAtVisitLimit' = loopDetectorRanAtVisitLimit,
      abortedLoopDetectorAtVisitLimit' = abortedLoopDetectorAtVisitLimit,
      startedOverBudget' = startedOverBudget,
      extendedCount' = extendedCount,
    } else if (ORDER == "loopBeforeMaxSteps" and ld.shouldAbort) all {
      // Mutant: LoopDetector ran before MaxSteps and aborted.
      status' = AbortedLoopDetector,
      phase' = Entering,
      currentStep' = currentStep,
      inRetry' = inRetry,
      iteration' = iteration,
      maxSteps' = maxSteps,
      interruptPending' = interruptPending,
      completedVisits' = completedVisits,
      startedVisits' = startedVisits,
      hasLastLoopStep' = true,
      lastLoopStep' = currentStep,
      consecutiveLoopCount' = ld.nextCount,
      exceededInfoRecorded' = exceededInfoRecorded,
      onIterationLimitCalls' = onIterationLimitCalls,
      judgeCalls' = judgeCalls,
      loopDetectorChecks' = loopDetectorChecks + 1,
      entryId' = entryId,
      lastLoopCheckEntryId' = entryId,
      loopDetectorDoubleCounted' = (loopDetectorDoubleCounted or doubleCountOnLd),
      naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
      maxStepsFiredAtVisitLimit' = maxStepsFiredAtVisitLimit,
      promptedLimitAtVisitLimit' = promptedLimitAtVisitLimit,
      loopDetectorRanAtVisitLimit' = (loopDetectorRanAtVisitLimit or atVisitLimit),
      abortedLoopDetectorAtVisitLimit' = (abortedLoopDetectorAtVisitLimit or atVisitLimit),
      startedOverBudget' = startedOverBudget,
      extendedCount' = extendedCount,
    } else if (maxStepsActive) all {
      // MaxSteps check fires: emits iteration:limit and calls onIterationLimit.
      // In mutant "loopBeforeMaxSteps", LoopDetector already mutated consecutiveCount before this!
      val ldRanBefore = ORDER == "loopBeforeMaxSteps"
      all {
        onIterationLimitCalls' = onIterationLimitCalls + 1,
        maxStepsFiredAtVisitLimit' = (maxStepsFiredAtVisitLimit or atVisitLimit),
        promptedLimitAtVisitLimit' = (promptedLimitAtVisitLimit or atVisitLimit),
        hasLastLoopStep' = if (ldRanBefore) true else hasLastLoopStep,
        lastLoopStep' = if (ldRanBefore) currentStep else lastLoopStep,
        consecutiveLoopCount' = if (ldRanBefore) ld.nextCount else consecutiveLoopCount,
        loopDetectorChecks' = if (ldRanBefore) loopDetectorChecks + 1 else loopDetectorChecks,
        entryId' = entryId,
        lastLoopCheckEntryId' = if (ldRanBefore) entryId else lastLoopCheckEntryId,
        loopDetectorDoubleCounted' = (loopDetectorDoubleCounted or (ldRanBefore and doubleCountOnLd)),
        loopDetectorRanAtVisitLimit' = (loopDetectorRanAtVisitLimit or (ldRanBefore and atVisitLimit)),
        abortedLoopDetectorAtVisitLimit' = abortedLoopDetectorAtVisitLimit,
        currentStep' = currentStep,
        inRetry' = inRetry,
        iteration' = iteration,
        interruptPending' = interruptPending,
        completedVisits' = completedVisits,
        startedVisits' = startedVisits,
        judgeCalls' = judgeCalls,
        naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
        startedOverBudget' = startedOverBudget,
        if (extendOnLimit) all {
          // Extension via WorkflowEngine API: updateMaxSteps(maxSteps + 1); continue;
          // Stays in Entering with the SAME entryId.
          status' = Running,
          phase' = Entering,
          maxSteps' = maxSteps + 1,
          exceededInfoRecorded' = exceededInfoRecorded,
          extendedCount' = extendedCount + 1,
        } else all {
          // Non-interactive takt run sets exceededInfo and returns null; Stop returns null.
          status' = AbortedIterationLimit,
          phase' = Entering,
          maxSteps' = maxSteps,
          exceededInfoRecorded' = if (not(INTERACTIVE_EXTEND)) true else exceededInfoRecorded,
          extendedCount' = extendedCount,
        },
      }
    } else if (userInputInvalid) all {
      // validateUserInputRuntime aborts.
      val ldRanBefore = ORDER == "loopBeforeMaxSteps"
      all {
        status' = AbortedUserInput,
        phase' = Entering,
        currentStep' = currentStep,
        inRetry' = inRetry,
        iteration' = iteration,
        maxSteps' = maxSteps,
        interruptPending' = interruptPending,
        completedVisits' = completedVisits,
        startedVisits' = startedVisits,
        hasLastLoopStep' = if (ldRanBefore) true else hasLastLoopStep,
        lastLoopStep' = if (ldRanBefore) currentStep else lastLoopStep,
        consecutiveLoopCount' = if (ldRanBefore) ld.nextCount else consecutiveLoopCount,
        exceededInfoRecorded' = exceededInfoRecorded,
        onIterationLimitCalls' = onIterationLimitCalls,
        judgeCalls' = judgeCalls,
        loopDetectorChecks' = if (ldRanBefore) loopDetectorChecks + 1 else loopDetectorChecks,
        entryId' = entryId,
        lastLoopCheckEntryId' = if (ldRanBefore) entryId else lastLoopCheckEntryId,
        loopDetectorDoubleCounted' = (loopDetectorDoubleCounted or (ldRanBefore and doubleCountOnLd)),
        naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
        maxStepsFiredAtVisitLimit' = maxStepsFiredAtVisitLimit,
        promptedLimitAtVisitLimit' = promptedLimitAtVisitLimit,
        loopDetectorRanAtVisitLimit' = (loopDetectorRanAtVisitLimit or (ldRanBefore and atVisitLimit)),
        abortedLoopDetectorAtVisitLimit' = abortedLoopDetectorAtVisitLimit,
        startedOverBudget' = startedOverBudget,
        extendedCount' = extendedCount,
      }
    } else if (ld.shouldAbort) all {
      // LoopDetector aborts (in "before" and "abortAtTransition", this runs BEFORE VisitLimit).
      status' = AbortedLoopDetector,
      phase' = Entering,
      currentStep' = currentStep,
      inRetry' = inRetry,
      iteration' = iteration,
      maxSteps' = maxSteps,
      interruptPending' = interruptPending,
      completedVisits' = completedVisits,
      startedVisits' = startedVisits,
      hasLastLoopStep' = true,
      lastLoopStep' = currentStep,
      consecutiveLoopCount' = ld.nextCount,
      exceededInfoRecorded' = exceededInfoRecorded,
      onIterationLimitCalls' = onIterationLimitCalls,
      judgeCalls' = judgeCalls,
      loopDetectorChecks' = loopDetectorChecks + 1,
      entryId' = entryId,
      lastLoopCheckEntryId' = entryId,
      loopDetectorDoubleCounted' = (loopDetectorDoubleCounted or doubleCountOnLd),
      naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
      maxStepsFiredAtVisitLimit' = maxStepsFiredAtVisitLimit,
      promptedLimitAtVisitLimit' = promptedLimitAtVisitLimit,
      loopDetectorRanAtVisitLimit' = (loopDetectorRanAtVisitLimit or atVisitLimit),
      abortedLoopDetectorAtVisitLimit' = (abortedLoopDetectorAtVisitLimit or atVisitLimit),
      startedOverBudget' = startedOverBudget,
      extendedCount' = extendedCount,
    } else if (atVisitLimit) all {
      // In "before" and "abortAtTransition", VisitLimit runs AFTER LoopDetector (even when action == warn!).
      status' = AbortedVisitLimit,
      phase' = Entering,
      currentStep' = currentStep,
      inRetry' = inRetry,
      iteration' = iteration,
      maxSteps' = maxSteps,
      interruptPending' = interruptPending,
      completedVisits' = completedVisits,
      startedVisits' = startedVisits,
      hasLastLoopStep' = true,
      lastLoopStep' = currentStep,
      consecutiveLoopCount' = ld.nextCount,
      exceededInfoRecorded' = exceededInfoRecorded,
      onIterationLimitCalls' = onIterationLimitCalls,
      judgeCalls' = judgeCalls,
      loopDetectorChecks' = loopDetectorChecks + 1,
      entryId' = entryId,
      lastLoopCheckEntryId' = entryId,
      loopDetectorDoubleCounted' = (loopDetectorDoubleCounted or doubleCountOnLd),
      naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
      maxStepsFiredAtVisitLimit' = maxStepsFiredAtVisitLimit,
      promptedLimitAtVisitLimit' = promptedLimitAtVisitLimit,
      loopDetectorRanAtVisitLimit' = true,
      abortedLoopDetectorAtVisitLimit' = abortedLoopDetectorAtVisitLimit,
      startedOverBudget' = startedOverBudget,
      extendedCount' = extendedCount,
    } else all {
      // All entry checks passed: consume iteration budget (if applicable) and start step.
      val overBudget =
        MODE == "full" and consumesBudget(currentStep) and not(IGNORE_ITERATION_LIMIT) and iteration >= maxSteps
      all {
        status' = Running,
        phase' = InStep,
        currentStep' = currentStep,
        inRetry' = false,
        iteration' = if (consumesBudget(currentStep)) iteration + 1 else iteration,
        maxSteps' = maxSteps,
        interruptPending' = interruptPending,
        completedVisits' = completedVisits,
        startedVisits' =
          if (inRetry) startedVisits
          else startedVisits.set(currentStep, startedVisits.get(currentStep) + 1),
        hasLastLoopStep' = true,
        lastLoopStep' = currentStep,
        consecutiveLoopCount' = ld.nextCount,
        exceededInfoRecorded' = exceededInfoRecorded,
        onIterationLimitCalls' = onIterationLimitCalls,
        judgeCalls' = judgeCalls,
        loopDetectorChecks' = loopDetectorChecks + 1,
        entryId' = entryId,
        lastLoopCheckEntryId' = entryId,
        loopDetectorDoubleCounted' = (loopDetectorDoubleCounted or doubleCountOnLd),
        naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
        maxStepsFiredAtVisitLimit' = maxStepsFiredAtVisitLimit,
        promptedLimitAtVisitLimit' = promptedLimitAtVisitLimit,
        loopDetectorRanAtVisitLimit' = loopDetectorRanAtVisitLimit,
        abortedLoopDetectorAtVisitLimit' = abortedLoopDetectorAtVisitLimit,
        startedOverBudget' = (startedOverBudget or overBudget),
        extendedCount' = extendedCount,
      }
    },
  }

  // Same-visit retry (quality gate failure / blocked -> user input): continues before recordCompletion,
  // re-entering the loop at the top for the same step as a fresh entry (entryId + 1).
  // (rate_limited also decrements iteration, modelled by `refundIteration = true`).
  action retryStep(refundIteration: bool): bool = all {
    status == Running,
    phase == InStep,
    val nextIter = if (refundIteration and consumesBudget(currentStep) and iteration > 0) iteration - 1 else iteration
    all {
      status' = Running,
      phase' = Entering,
      currentStep' = currentStep,
      inRetry' = true,
      iteration' = nextIter,
      maxSteps' = maxSteps,
      interruptPending' = interruptPending,
      completedVisits' = completedVisits,
      startedVisits' = startedVisits,
      hasLastLoopStep' = hasLastLoopStep,
      lastLoopStep' = lastLoopStep,
      consecutiveLoopCount' = consecutiveLoopCount,
      exceededInfoRecorded' = exceededInfoRecorded,
      onIterationLimitCalls' = onIterationLimitCalls,
      judgeCalls' = judgeCalls,
      loopDetectorChecks' = loopDetectorChecks,
      entryId' = entryId + 1,
      lastLoopCheckEntryId' = lastLoopCheckEntryId,
      loopDetectorDoubleCounted' = loopDetectorDoubleCounted,
      naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
      maxStepsFiredAtVisitLimit' = maxStepsFiredAtVisitLimit,
      promptedLimitAtVisitLimit' = promptedLimitAtVisitLimit,
      loopDetectorRanAtVisitLimit' = loopDetectorRanAtVisitLimit,
      abortedLoopDetectorAtVisitLimit' = abortedLoopDetectorAtVisitLimit,
      startedOverBudget' = startedOverBudget,
      extendedCount' = extendedCount,
    },
  }

  // Natural COMPLETE transition: ends the run before recordCompletion and loop monitors.
  action completeTerminal: bool = all {
    status == Running,
    phase == InStep,
    status' = Completed,
    phase' = Entering,
    currentStep' = currentStep,
    inRetry' = false,
    iteration' = iteration,
    maxSteps' = maxSteps,
    interruptPending' = interruptPending,
    completedVisits' = completedVisits,
    startedVisits' = startedVisits,
    hasLastLoopStep' = hasLastLoopStep,
    lastLoopStep' = lastLoopStep,
    consecutiveLoopCount' = consecutiveLoopCount,
    exceededInfoRecorded' = exceededInfoRecorded,
    onIterationLimitCalls' = onIterationLimitCalls,
    judgeCalls' = judgeCalls,
    loopDetectorChecks' = loopDetectorChecks,
    entryId' = entryId,
    lastLoopCheckEntryId' = lastLoopCheckEntryId,
    loopDetectorDoubleCounted' = loopDetectorDoubleCounted,
    naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
    maxStepsFiredAtVisitLimit' = maxStepsFiredAtVisitLimit,
    promptedLimitAtVisitLimit' = promptedLimitAtVisitLimit,
    loopDetectorRanAtVisitLimit' = loopDetectorRanAtVisitLimit,
    abortedLoopDetectorAtVisitLimit' = abortedLoopDetectorAtVisitLimit,
    startedOverBudget' = startedOverBudget,
    extendedCount' = extendedCount,
  }

  // Child workflow_call inside StepCall exhausts the shared root max_steps budget.
  // Models WorkflowCallExecutor.ts:595-598 (child inherits parent onIterationLimit) and
  // WorkflowCallExecutor.ts:665-679 (child runs with maxStepsOverride = shared root budget):
  //   - In non-interactive takt run, child sets eventBridge.state.exceededInfo (exceededInfoRecorded' = true)
  //     and aborts with abortKind = 'iteration_limit'.
  //   - The child's own entry check is not the parent's: `runSingleWorkflowIterationCore` skips the
  //     parent's max_steps check, but the child engine still inherits the shared budget and stops at it.
  //     So this path is modelled in BOTH MODE values; only `enterStep`'s parent max_steps check is
  //     gated on MODE == "full". (CodeRabbit #187: MODE == "full" used to exclude single mode here.)
  //   - Parent handles child ABORT according to its workflow_call step rules:
  //       ChildAbortPropagate  : ABORT -> ABORT or no rule (propagates iteration_limit -> AbortedIterationLimit)
  //       ChildAbortToComplete : ABORT -> COMPLETE (finalState.status = Completed; design 中-2)
  //       ChildAbortToStepA    : ABORT -> StepA (e.g. development-core implement ABORT -> replan; design 中-1)
  action childWorkflowCallIterationLimit(outcome: ChildAbortOutcome): bool = all {
    status == Running,
    phase == InStep,
    currentStep == StepCall,
    not(IGNORE_ITERATION_LIMIT),
    val nextIter = if (iteration < maxSteps) maxSteps else iteration
    val nextExceededInfo = if (not(INTERACTIVE_EXTEND)) true else exceededInfoRecorded
    val nextCompleted = completedVisits.set(StepCall, completedVisits.get(StepCall) + 1)
    val naturalAtLimit = isAtVisitLimit(StepA, nextCompleted)
    all {
      inRetry' = false,
      iteration' = nextIter,
      maxSteps' = maxSteps,
      interruptPending' = interruptPending,
      startedVisits' = startedVisits,
      hasLastLoopStep' = hasLastLoopStep,
      lastLoopStep' = lastLoopStep,
      consecutiveLoopCount' = consecutiveLoopCount,
      exceededInfoRecorded' = nextExceededInfo,
      onIterationLimitCalls' = onIterationLimitCalls + 1,
      judgeCalls' = judgeCalls,
      loopDetectorChecks' = loopDetectorChecks,
      lastLoopCheckEntryId' = lastLoopCheckEntryId,
      loopDetectorDoubleCounted' = loopDetectorDoubleCounted,
      maxStepsFiredAtVisitLimit' = maxStepsFiredAtVisitLimit,
      promptedLimitAtVisitLimit' = promptedLimitAtVisitLimit,
      loopDetectorRanAtVisitLimit' = loopDetectorRanAtVisitLimit,
      abortedLoopDetectorAtVisitLimit' = abortedLoopDetectorAtVisitLimit,
      startedOverBudget' = startedOverBudget,
      extendedCount' = extendedCount,
      phase' = Entering,
      if (outcome == ChildAbortPropagate) all {
        status' = AbortedIterationLimit,
        currentStep' = StepCall,
        completedVisits' = completedVisits,
        entryId' = entryId,
        naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
      } else if (outcome == ChildAbortToComplete) all {
        status' = Completed,
        currentStep' = StepCall,
        completedVisits' = completedVisits,
        entryId' = entryId,
        naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
      } else all {
        // ChildAbortToStepA: non-terminal transition to StepA (e.g. development-core implement ABORT -> replan).
        completedVisits' = nextCompleted,
        currentStep' = StepA,
        entryId' = entryId + 1,
        naturalTransitionIntoLimit' = (naturalTransitionIntoLimit or naturalAtLimit),
        status' =
          if (ORDER == "abortAtTransition" and naturalAtLimit) AbortedVisitLimit
          else Running,
      },
    },
  }

  // Non-terminal transition from currentStep to nextStep.
  // Models:
  //   1. stepVisitRecordCompletion(currentStep)
  //   2. Pre-judge check: if stepVisitCheckEntry(nextStep) != undefined:
  //        - in "before"/"fixed"/"loopBeforeMaxSteps": skip monitor & judge, advance to nextStep
  //        - in "abortAtTransition" (Approach B): advance to nextStep and immediately abort with VisitLimit
  //   3. Otherwise (in full mode with ENABLE_LOOP_MONITOR):
  //        - monitor on StepB -> StepA (when StepA not at limit) or StepC -> StepB triggers judge
  //        - judge increments iteration++ (LoopMonitorJudgeRunner.ts:79) and picks JudgeContinue / JudgeRouteToC / JudgeAbort
  action completeNonTerminal(nextStep: StepName, judgeChoice: JudgeChoice): bool = all {
    status == Running,
    phase == InStep,
    isValidNonTerminalEdge(currentStep, nextStep),
    val nextCompleted = completedVisits.set(currentStep, completedVisits.get(currentStep) + 1)
    val naturalAtLimit = isAtVisitLimit(nextStep, nextCompleted)
    val monitorTriggered =
      MODE == "full"
      and ENABLE_LOOP_MONITOR
      and not(naturalAtLimit)
      and ((currentStep == StepB and nextStep == StepA) or (currentStep == StepC and nextStep == StepB))
    all {
      completedVisits' = nextCompleted,
      startedVisits' = startedVisits,
      inRetry' = false,
      maxSteps' = maxSteps,
      interruptPending' = interruptPending,
      hasLastLoopStep' = hasLastLoopStep,
      lastLoopStep' = lastLoopStep,
      consecutiveLoopCount' = consecutiveLoopCount,
      exceededInfoRecorded' = exceededInfoRecorded,
      onIterationLimitCalls' = onIterationLimitCalls,
      loopDetectorChecks' = loopDetectorChecks,
      entryId' = entryId + 1,
      lastLoopCheckEntryId' = lastLoopCheckEntryId,
      loopDetectorDoubleCounted' = loopDetectorDoubleCounted,
      naturalTransitionIntoLimit' = (naturalTransitionIntoLimit or naturalAtLimit),
      maxStepsFiredAtVisitLimit' = maxStepsFiredAtVisitLimit,
      promptedLimitAtVisitLimit' = promptedLimitAtVisitLimit,
      loopDetectorRanAtVisitLimit' = loopDetectorRanAtVisitLimit,
      abortedLoopDetectorAtVisitLimit' = abortedLoopDetectorAtVisitLimit,
      startedOverBudget' = startedOverBudget,
      extendedCount' = extendedCount,
      phase' = Entering,
      if (ORDER == "abortAtTransition" and MODE == "full" and naturalAtLimit) all {
        // Approach B: abort right after advancing active step when natural nextStep is at max_visits.
        status' = AbortedVisitLimit,
        currentStep' = nextStep,
        iteration' = iteration,
        judgeCalls' = judgeCalls,
      } else if (monitorTriggered) all {
        // LoopMonitorJudgeRunner increments state.iteration++ and decides next step.
        iteration' = iteration + 1,
        judgeCalls' = judgeCalls + 1,
        if (judgeChoice == JudgeAbort) all {
          status' = AbortedByJudge,
          currentStep' = currentStep,
        } else if (judgeChoice == JudgeRouteToC) all {
          status' = Running,
          currentStep' = StepC,
        } else all {
          status' = Running,
          currentStep' = nextStep,
        },
      } else all {
        status' = Running,
        currentStep' = nextStep,
        iteration' = iteration,
        judgeCalls' = judgeCalls,
      },
    },
  }

  action stutter: bool = all {
    status != Running,
    status' = status, phase' = phase, currentStep' = currentStep, inRetry' = inRetry,
    iteration' = iteration, maxSteps' = maxSteps, interruptPending' = interruptPending,
    completedVisits' = completedVisits, startedVisits' = startedVisits,
    hasLastLoopStep' = hasLastLoopStep, lastLoopStep' = lastLoopStep,
    consecutiveLoopCount' = consecutiveLoopCount, exceededInfoRecorded' = exceededInfoRecorded,
    onIterationLimitCalls' = onIterationLimitCalls, judgeCalls' = judgeCalls,
    loopDetectorChecks' = loopDetectorChecks,
    entryId' = entryId, lastLoopCheckEntryId' = lastLoopCheckEntryId,
    loopDetectorDoubleCounted' = loopDetectorDoubleCounted,
    naturalTransitionIntoLimit' = naturalTransitionIntoLimit,
    maxStepsFiredAtVisitLimit' = maxStepsFiredAtVisitLimit,
    promptedLimitAtVisitLimit' = promptedLimitAtVisitLimit,
    loopDetectorRanAtVisitLimit' = loopDetectorRanAtVisitLimit,
    abortedLoopDetectorAtVisitLimit' = abortedLoopDetectorAtVisitLimit,
    startedOverBudget' = startedOverBudget,
    extendedCount' = extendedCount,
  }

  action step = any {
    requestInterrupt,
    nondet extendOnLimit = oneOf(Set(false, true))
    enterStep(extendOnLimit),
    nondet refundIteration = oneOf(Set(false, true))
    retryStep(refundIteration),
    completeTerminal,
    nondet childOutcome = oneOf(Set(ChildAbortPropagate, ChildAbortToComplete, ChildAbortToStepA))
    childWorkflowCallIterationLimit(childOutcome),
    nondet nextStep = oneOf(ALL_STEPS)
    nondet judgeChoice = oneOf(Set(JudgeContinue, JudgeRouteToC, JudgeAbort))
    completeNonTerminal(nextStep, judgeChoice),
    stutter,
  }

  // --- Safety Invariants ---

  // 1. Interrupt always wins over every other check when pending at entry.
  val interruptWins =
    (interruptPending and status != Running) implies (status == AbortedInterrupt and not(exceededSaved))

  // 2. Visit limit beats max_steps: max_steps never fires (neither aborts nor prompts/extends)
  //    when currentStep has already reached its max_visits.
  val visitLimitBeatsMaxSteps = not(maxStepsFiredAtVisitLimit) and not(promptedLimitAtVisitLimit)

  // 3. Exceeded persistence contract: `exceeded` is saved ONLY on AbortedIterationLimit,
  //    and NEVER when currentStep has already reached max_visits (even if a child workflow_call
  //    recorded exceededInfo before parent ABORT -> replan or ABORT -> COMPLETE).
  val exceededOnlyOnIterationLimit =
    exceededSaved implies (status == AbortedIterationLimit and not(isAtVisitLimit(currentStep, completedVisits)))

  // 4. Natural transition into a visit-limited step (which skipped loop monitors) must end at
  //    VisitLimit (or Interrupt if interrupted), never hijacked by MaxSteps / LoopDetector.
  val visitLimitOutcomePreserved =
    naturalTransitionIntoLimit implies (
      status == Running or status == AbortedInterrupt or status == AbortedVisitLimit
    )

  // 5. Visit limit runs before LoopDetector: no spurious LoopDetector mutation/warning/abort
  //    when currentStep is already at max_visits (consistent across full and single modes).
  val visitLimitSkipsLoopDetector =
    not(loopDetectorRanAtVisitLimit) and not(abortedLoopDetectorAtVisitLimit)

  // 6. LoopDetector is never double-counted on the same step entry (e.g., when onIterationLimit
  //    extends maxSteps and `continue`s to the top of the loop).
  val noLoopDetectorDoubleCount = not(loopDetectorDoubleCounted)

  // 7. Per-step max_visits bound always holds: completed <= started <= max_visits.
  val visitsBounded =
    ALL_STEPS.forall(s => {
      val limit = maxVisitsFor(s)
      completedVisits.get(s) <= startedVisits.get(s)
        and (limit <= 0 or startedVisits.get(s) <= limit)
    })

  // 8. Retries do not consume max_visits: AbortedVisitLimit implies completedVisits == max_visits.
  val visitLimitAbortHasExactVisits =
    status == AbortedVisitLimit implies (
      maxVisitsFor(currentStep) > 0 and completedVisits.get(currentStep) == maxVisitsFor(currentStep)
    )

  // 9. No budget-consuming step begins execution when iteration >= maxSteps (in full mode without ignore).
  val budgetRespected = not(startedOverBudget)

  val safety = and {
    interruptWins,
    visitLimitBeatsMaxSteps,
    exceededOnlyOnIterationLimit,
    visitLimitOutcomePreserved,
    visitLimitSkipsLoopDetector,
    noLoopDetectorDoubleCount,
    visitsBounded,
    visitLimitAbortHasExactVisits,
    budgetRespected,
  }

  // --- Witnesses ---
  val witnessAbortedVisitLimit = status == AbortedVisitLimit
  val witnessAbortedIterationLimit = status == AbortedIterationLimit
  val witnessExceededSaved = exceededSaved
  val witnessAbortedInterrupt = status == AbortedInterrupt
  val witnessAbortedUserInput = status == AbortedUserInput
  val witnessAbortedLoopDetector = status == AbortedLoopDetector
  // Both limits "reached" at the same entry: visit limit wins and the run stops. This counts only
  // when the iteration limit is actually effective (full mode, not ignoreIterationLimit); in single
  // mode the parent does not evaluate max_steps, and with IGNORE_ITERATION_LIMIT = true
  // (fixedFullIgnoreLimit, StepA -> StepA at iteration == maxSteps == 1) there is no iteration limit.
  // (CodeRabbit #187)
  val witnessBothLimitsSimultaneous =
    MODE == "full"
    and not(IGNORE_ITERATION_LIMIT)
    and status == AbortedVisitLimit
    and consumesBudget(currentStep)
    and iteration >= maxSteps
  val witnessExtended = extendedCount > 0
  val witnessJudgeRan = judgeCalls > 0
  val witnessCompleted = status == Completed
  val witnessChildAbortToVisitLimitNoExceeded =
    status == AbortedVisitLimit and exceededInfoRecorded and not(exceededSaved)
  val witnessChildAbortToCompleteNoExceeded =
    status == Completed and exceededInfoRecorded and not(exceededSaved)
  val witnessChildAbortPropagatedExceeded =
    status == AbortedIterationLimit and currentStep == StepCall and exceededSaved
}

// --- Concrete runnable instances ---

// Fixed full loop (takt run / non-interactive exceeded mode, loop monitor enabled, max_steps = 2).
module fixedFullExceeded {
  import iterationEntryOrder(
    ORDER = "fixed",
    MODE = "full",
    EXCEEDED_GUARD = true,
    ALLOW_INTERRUPT = true,
    INITIAL_MAX_STEPS = 2,
    STEP_A_MAX_VISITS = 1,
    STEP_C_MAX_VISITS = 1,
    STEP_CALL_MAX_VISITS = 1,
    LOOP_DETECTION_MAX = 2,
    LOOP_DETECTION_ABORT = true,
    INTERACTIVE_EXTEND = false,
    IGNORE_ITERATION_LIMIT = false,
    USER_INPUT_INVALID_ON_B = false,
    ENABLE_LOOP_MONITOR = true
  ).*
}

// Fixed full loop without interrupts: increases trace depth & witness density for simultaneous limits
// and child workflow_call ABORT paths (review 低-5).
module fixedFullExceededNoInterrupt {
  import iterationEntryOrder(
    ORDER = "fixed",
    MODE = "full",
    EXCEEDED_GUARD = true,
    ALLOW_INTERRUPT = false,
    INITIAL_MAX_STEPS = 2,
    STEP_A_MAX_VISITS = 1,
    STEP_C_MAX_VISITS = 1,
    STEP_CALL_MAX_VISITS = 1,
    LOOP_DETECTION_MAX = 2,
    LOOP_DETECTION_ABORT = true,
    INTERACTIVE_EXTEND = false,
    IGNORE_ITERATION_LIMIT = false,
    USER_INPUT_INVALID_ON_B = false,
    ENABLE_LOOP_MONITOR = true
  ).*
}

// Fixed full loop (WorkflowEngine API extension mode + invalid user-input step B).
module fixedFullInteractive {
  import iterationEntryOrder(
    ORDER = "fixed",
    MODE = "full",
    EXCEEDED_GUARD = true,
    ALLOW_INTERRUPT = true,
    INITIAL_MAX_STEPS = 2,
    STEP_A_MAX_VISITS = 1,
    STEP_C_MAX_VISITS = 1,
    STEP_CALL_MAX_VISITS = 1,
    LOOP_DETECTION_MAX = 1,
    LOOP_DETECTION_ABORT = true,
    INTERACTIVE_EXTEND = true,
    IGNORE_ITERATION_LIMIT = false,
    USER_INPUT_INVALID_ON_B = true,
    ENABLE_LOOP_MONITOR = true
  ).*
}

// Fixed full loop (API extension mode) without interrupts: dense witness coverage for extension `continue`.
module fixedFullInteractiveNoInterrupt {
  import iterationEntryOrder(
    ORDER = "fixed",
    MODE = "full",
    EXCEEDED_GUARD = true,
    ALLOW_INTERRUPT = false,
    INITIAL_MAX_STEPS = 2,
    STEP_A_MAX_VISITS = 1,
    STEP_C_MAX_VISITS = 1,
    STEP_CALL_MAX_VISITS = 1,
    LOOP_DETECTION_MAX = 1,
    LOOP_DETECTION_ABORT = true,
    INTERACTIVE_EXTEND = true,
    IGNORE_ITERATION_LIMIT = false,
    USER_INPUT_INVALID_ON_B = true,
    ENABLE_LOOP_MONITOR = true
  ).*
}

// Fixed full loop with ignoreIterationLimit = true (or max_steps: infinite).
module fixedFullIgnoreLimit {
  import iterationEntryOrder(
    ORDER = "fixed",
    MODE = "full",
    EXCEEDED_GUARD = true,
    ALLOW_INTERRUPT = true,
    INITIAL_MAX_STEPS = 1,
    STEP_A_MAX_VISITS = 1,
    STEP_C_MAX_VISITS = 1,
    STEP_CALL_MAX_VISITS = 1,
    LOOP_DETECTION_MAX = 2,
    LOOP_DETECTION_ABORT = true,
    INTERACTIVE_EXTEND = false,
    IGNORE_ITERATION_LIMIT = true,
    USER_INPUT_INVALID_ON_B = false,
    ENABLE_LOOP_MONITOR = true
  ).*
}

// Fixed single-iteration mode (runSingleWorkflowIterationCore).
module fixedSingleIteration {
  import iterationEntryOrder(
    ORDER = "fixed",
    MODE = "single",
    EXCEEDED_GUARD = true,
    ALLOW_INTERRUPT = true,
    INITIAL_MAX_STEPS = 2,
    STEP_A_MAX_VISITS = 1,
    STEP_C_MAX_VISITS = 1,
    STEP_CALL_MAX_VISITS = 1,
    LOOP_DETECTION_MAX = 1,
    LOOP_DETECTION_ABORT = true,
    INTERACTIVE_EXTEND = false,
    IGNORE_ITERATION_LIMIT = false,
    USER_INPUT_INVALID_ON_B = true,
    ENABLE_LOOP_MONITOR = false
  ).*
}

// Pre-fix full loop (#174 / 657f16ad6): must violate visitLimitBeatsMaxSteps,
// exceededOnlyOnIterationLimit, visitLimitOutcomePreserved, and visitLimitSkipsLoopDetector.
module beforeFullExceeded {
  import iterationEntryOrder(
    ORDER = "before",
    MODE = "full",
    EXCEEDED_GUARD = false,
    ALLOW_INTERRUPT = true,
    INITIAL_MAX_STEPS = 2,
    STEP_A_MAX_VISITS = 1,
    STEP_C_MAX_VISITS = 1,
    STEP_CALL_MAX_VISITS = 1,
    LOOP_DETECTION_MAX = 2,
    LOOP_DETECTION_ABORT = true,
    INTERACTIVE_EXTEND = false,
    IGNORE_ITERATION_LIMIT = false,
    USER_INPUT_INVALID_ON_B = false,
    ENABLE_LOOP_MONITOR = true
  ).*
}

// Mutant with Approach A entry order ONLY (missing executeWorkflow iteration_limit guard):
// must violate exceededOnlyOnIterationLimit when a child workflow_call hits max_steps and parent
// routes ABORT -> StepA (at max_visits, like development-core implement ABORT -> replan) or ABORT -> COMPLETE.
module fixedOrderWithoutGuard {
  import iterationEntryOrder(
    ORDER = "fixed",
    MODE = "full",
    EXCEEDED_GUARD = false,
    ALLOW_INTERRUPT = false,
    INITIAL_MAX_STEPS = 2,
    STEP_A_MAX_VISITS = 1,
    STEP_C_MAX_VISITS = 1,
    STEP_CALL_MAX_VISITS = 1,
    LOOP_DETECTION_MAX = 2,
    LOOP_DETECTION_ABORT = true,
    INTERACTIVE_EXTEND = false,
    IGNORE_ITERATION_LIMIT = false,
    USER_INPUT_INVALID_ON_B = false,
    ENABLE_LOOP_MONITOR = true
  ).*
}

// Pre-fix single-iteration mode (#174 / 657f16ad6): must violate visitLimitSkipsLoopDetector.
module beforeSingleIteration {
  import iterationEntryOrder(
    ORDER = "before",
    MODE = "single",
    EXCEEDED_GUARD = false,
    ALLOW_INTERRUPT = true,
    INITIAL_MAX_STEPS = 2,
    STEP_A_MAX_VISITS = 1,
    STEP_C_MAX_VISITS = 1,
    STEP_CALL_MAX_VISITS = 1,
    LOOP_DETECTION_MAX = 1,
    LOOP_DETECTION_ABORT = true,
    INTERACTIVE_EXTEND = false,
    IGNORE_ITERATION_LIMIT = false,
    USER_INPUT_INVALID_ON_B = false,
    ENABLE_LOOP_MONITOR = false
  ).*
}

// Alternative Approach B (abort only at line 1214 pre-judge check): must violate
// visitLimitBeatsMaxSteps when a judge increments iteration and routes to StepC at max_visits.
module abortAtTransitionAlternative {
  import iterationEntryOrder(
    ORDER = "abortAtTransition",
    MODE = "full",
    EXCEEDED_GUARD = true,
    ALLOW_INTERRUPT = true,
    INITIAL_MAX_STEPS = 2,
    STEP_A_MAX_VISITS = 1,
    STEP_C_MAX_VISITS = 1,
    STEP_CALL_MAX_VISITS = 1,
    LOOP_DETECTION_MAX = 2,
    LOOP_DETECTION_ABORT = true,
    INTERACTIVE_EXTEND = false,
    IGNORE_ITERATION_LIMIT = false,
    USER_INPUT_INVALID_ON_B = false,
    ENABLE_LOOP_MONITOR = true
  ).*
}

// Mutant moving stateful LoopDetector before MaxSteps: must violate noLoopDetectorDoubleCount
// ONLY when onIterationLimit extends maxSteps and `continue`s on the same entryId (review 低-1).
module mutantLoopBeforeMaxSteps {
  import iterationEntryOrder(
    ORDER = "loopBeforeMaxSteps",
    MODE = "full",
    EXCEEDED_GUARD = true,
    ALLOW_INTERRUPT = false,
    INITIAL_MAX_STEPS = 1,
    STEP_A_MAX_VISITS = 2,
    STEP_C_MAX_VISITS = 2,
    STEP_CALL_MAX_VISITS = 2,
    LOOP_DETECTION_MAX = 3,
    LOOP_DETECTION_ABORT = true,
    INTERACTIVE_EXTEND = true,
    IGNORE_ITERATION_LIMIT = false,
    USER_INPUT_INVALID_ON_B = false,
    ENABLE_LOOP_MONITOR = false
  ).*
}

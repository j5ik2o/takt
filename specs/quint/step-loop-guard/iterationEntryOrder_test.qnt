// -*- mode: Bluespec; -*-
// Scenario tests for iteration-start check ordering and exceeded persistence (j5ik2o/takt#176).

module fixedFullExceededTest {
  import iterationEntryOrder(
    ORDER = "fixed",
    MODE = "full",
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
  ).* from "./iterationEntryOrder"

  // Core issue #176 scenario: max_steps = 2, a.max_visits = 1, a -> b -> a.
  // Both limits are reached simultaneously on entering a again; visit limit must win,
  // judge and onIterationLimit must not run, and exceeded must not be saved.
  run simultaneousLimitsVisitLimitWinsTest =
    initAt(StepA, 0)
      .then(enterStep(false)).then(completeNonTerminal(StepB, JudgeContinue))
      .then(enterStep(false)).then(completeNonTerminal(StepA, JudgeAbort))
      .then(enterStep(false))
      .expect(
        status == AbortedVisitLimit
        and currentStep == StepA
        and iteration == 2
        and onIterationLimitCalls == 0
        and judgeCalls == 0
        and not(exceededSaved)
        and safety
      )

  // Judge routes to StepC which already reached max_visits = 1 while judge's iteration++ hit max_steps = 2.
  // Visit limit must still win over max_steps on the next entry.
  run judgeRoutesToVisitLimitedStepAtMaxStepsTest =
    initAt(StepC, 0)
      .then(enterStep(false)).then(completeNonTerminal(StepB, JudgeRouteToC))
      .expect(status == Running and currentStep == StepC and iteration == 2 and judgeCalls == 1)
      .then(enterStep(false))
      .expect(
        status == AbortedVisitLimit
        and currentStep == StepC
        and onIterationLimitCalls == 0
        and not(exceededSaved)
        and safety
      )

  // Interrupt still beats both visit limit and max_steps when pending at entry.
  run interruptBeatsSimultaneousLimitsTest =
    initAt(StepA, 0)
      .then(enterStep(false)).then(completeNonTerminal(StepB, JudgeContinue))
      .then(enterStep(false)).then(completeNonTerminal(StepA, JudgeContinue))
      .then(requestInterrupt)
      .then(enterStep(false))
      .expect(
        status == AbortedInterrupt
        and onIterationLimitCalls == 0
        and not(exceededSaved)
        and safety
      )

  // When next step has NOT reached max_visits, max_steps still wins and saves exceeded.
  run maxStepsSavesExceededWhenBelowVisitLimitTest =
    initAt(StepA, 0)
      .then(enterStep(false)).then(completeNonTerminal(StepB, JudgeContinue))
      .then(enterStep(false)).then(completeNonTerminal(StepB, JudgeContinue))
      .then(enterStep(false))
      .expect(
        status == AbortedIterationLimit
        and currentStep == StepB
        and onIterationLimitCalls == 1
        and exceededSaved
        and safety
      )

  // Resuming with initialIteration >= maxSteps on a fresh engine (completedVisits = 0)
  // still triggers max_steps immediately (existing exceeded-requeue contract).
  run resumeAtMaxStepsTriggersIterationLimitTest =
    initAt(StepA, 2)
      .then(enterStep(false))
      .expect(
        status == AbortedIterationLimit
        and onIterationLimitCalls == 1
        and exceededSaved
        and safety
      )

  // Same-visit retry at iteration == maxSteps (completedVisits still 0 < max_visits)
  // hits max_steps rather than visit limit.
  run retryAtMaxStepsDoesNotTriggerVisitLimitTest =
    initAt(StepA, 1)
      .then(enterStep(false)).then(retryStep(false))
      .then(enterStep(false))
      .expect(
        status == AbortedIterationLimit
        and completedVisits.get(StepA) == 0
        and onIterationLimitCalls == 1
        and exceededSaved
        and safety
      )

  // workflow_call step with max_visits = 1 does not consume iteration budget and stops at visit limit
  // even when iteration has already reached maxSteps.
  run workflowCallVisitLimitStopsAtMaxStepsTest =
    initAt(StepCall, 2)
      .then(enterStep(false)).then(completeNonTerminal(StepCall, JudgeContinue))
      .then(enterStep(false))
      .expect(
        status == AbortedVisitLimit
        and currentStep == StepCall
        and iteration == 2
        and onIterationLimitCalls == 0
        and not(exceededSaved)
        and safety
      )
}

module fixedFullInteractiveTest {
  import iterationEntryOrder(
    ORDER = "fixed",
    MODE = "full",
    INITIAL_MAX_STEPS = 1,
    STEP_A_MAX_VISITS = 2,
    STEP_C_MAX_VISITS = 1,
    STEP_CALL_MAX_VISITS = 1,
    LOOP_DETECTION_MAX = 2,
    LOOP_DETECTION_ABORT = true,
    INTERACTIVE_EXTEND = true,
    IGNORE_ITERATION_LIMIT = false,
    USER_INPUT_INVALID_ON_B = true,
    ENABLE_LOOP_MONITOR = false
  ).* from "./iterationEntryOrder"

  // Interactive extension via onIterationLimit does not double-count LoopDetector.
  run interactiveExtensionDoesNotDoubleCountLoopDetectorTest =
    initAt(StepA, 0)
      .then(enterStep(false)).then(completeNonTerminal(StepA, JudgeContinue))
      .then(enterStep(true))
      .expect(status == Running and maxSteps == 2 and loopDetectorChecks == 1 and safety)
      .then(enterStep(false))
      .expect(status == Running and phase == InStep and consecutiveLoopCount == 2 and loopDetectorChecks == 2 and safety)

  // Preserves MaxSteps -> UserInput order for steps without max_visits (existing contract).
  run maxStepsStillBeatsUserInputWhenNotAtVisitLimitTest =
    initAt(StepA, 0)
      .then(enterStep(false)).then(completeNonTerminal(StepB, JudgeContinue))
      .then(enterStep(false))
      .expect(status == AbortedIterationLimit and currentStep == StepB and safety)
}

module fixedSingleIterationTest {
  import iterationEntryOrder(
    ORDER = "fixed",
    MODE = "single",
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
  ).* from "./iterationEntryOrder"

  // Single-iteration mode matches full mode: VisitLimit beats LoopDetector on self-loop a -> a.
  run singleIterationVisitLimitBeatsLoopDetectorTest =
    initAt(StepA, 0)
      .then(enterStep(false)).then(completeNonTerminal(StepA, JudgeContinue))
      .then(enterStep(false))
      .expect(
        status == AbortedVisitLimit
        and loopDetectorChecks == 1
        and safety
      )
}

module beforeFullExceededTest {
  import iterationEntryOrder(
    ORDER = "before",
    MODE = "full",
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
  ).* from "./iterationEntryOrder"

  // Reproduces issue #176 on pre-fix code: a -> b -> a with max_steps = 2, a.max_visits = 1
  // skips the judge yet aborts with MaxSteps and saves exceeded.
  run preFixSavesExceededInsteadOfVisitLimitTest =
    initAt(StepA, 0)
      .then(enterStep(false)).then(completeNonTerminal(StepB, JudgeContinue))
      .then(enterStep(false)).then(completeNonTerminal(StepA, JudgeAbort))
      .then(enterStep(false))
      .expect(
        status == AbortedIterationLimit
        and exceededSaved
        and judgeCalls == 0
        and not(visitLimitBeatsMaxSteps)
        and not(exceededOnlyOnIterationLimit)
        and not(visitLimitOutcomePreserved)
      )
}

module abortAtTransitionAlternativeTest {
  import iterationEntryOrder(
    ORDER = "abortAtTransition",
    MODE = "full",
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
  ).* from "./iterationEntryOrder"

  // Shows why Approach B (abort only at line 1214 pre-judge check) is insufficient:
  // when a judge routes to StepC (already at max_visits) after bumping iteration to maxSteps,
  // MaxSteps still wins on the next entry and saves exceeded.
  run approachBMissesJudgeRoutedVisitLimitTest =
    initAt(StepC, 0)
      .then(enterStep(false)).then(completeNonTerminal(StepB, JudgeRouteToC))
      .then(enterStep(false))
      .expect(
        status == AbortedIterationLimit
        and exceededSaved
        and not(visitLimitBeatsMaxSteps)
        and not(exceededOnlyOnIterationLimit)
      )
}

module mutantLoopBeforeMaxStepsTest {
  import iterationEntryOrder(
    ORDER = "loopBeforeMaxSteps",
    MODE = "full",
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
  ).* from "./iterationEntryOrder"

  // Shows why stateful LoopDetector must not move ahead of MaxSteps:
  // interactive extension executes `continue` and double-counts the same entry.
  run loopBeforeMaxStepsDoubleCountsOnExtensionTest =
    initAt(StepA, 0)
      .then(enterStep(false)).then(completeNonTerminal(StepA, JudgeContinue))
      .then(enterStep(true))
      .then(enterStep(false))
      .expect(consecutiveLoopCount == 3 and not(noLoopDetectorDoubleCount))
}

module beforeSingleIterationWarnTest {
  import iterationEntryOrder(
    ORDER = "before",
    MODE = "single",
    INITIAL_MAX_STEPS = 2,
    STEP_A_MAX_VISITS = 1,
    STEP_C_MAX_VISITS = 1,
    STEP_CALL_MAX_VISITS = 1,
    LOOP_DETECTION_MAX = 1,
    LOOP_DETECTION_ABORT = false,
    INTERACTIVE_EXTEND = false,
    IGNORE_ITERATION_LIMIT = false,
    USER_INPUT_INVALID_ON_B = false,
    ENABLE_LOOP_MONITOR = false
  ).* from "./iterationEntryOrder"

  // Even in default `warn` mode, pre-fix single-iteration mode runs and mutates LoopDetector
  // before VisitLimit aborts the entry.
  run preFixSingleIterationMutatesLoopDetectorBeforeVisitLimitTest =
    initAt(StepA, 0)
      .then(enterStep(false)).then(completeNonTerminal(StepA, JudgeContinue))
      .then(enterStep(false))
      .expect(
        status == AbortedVisitLimit
        and loopDetectorChecks == 2
        and not(visitLimitSkipsLoopDetector)
      )
}

// -*- mode: Bluespec; -*-
// Scenario tests for a schema violation in a structured agent call. Run:
//   quint test structuredOutputRejection_test.qnt --main fixedTest
//   quint test structuredOutputRejection_test.qnt --main pr162Test
//   quint test structuredOutputRejection_test.qnt --main baselineTest
//   quint test structuredOutputRejection_test.qnt --main m7Test
module fixedTest {
  import structuredOutputRejection(TRANSPORT = "Fixed").* from "./structuredOutputRejection"

  pure val REJECTED_NO_CATEGORY: Response =
    { status: Error, category: NoCategory, rejected: true, outputParsed: true, outputValid: false }

  // Claude Terminal loop judge, JSON that breaks {content}: the run stops as before #162.
  run terminalLoopJudgeViolationHaltsTest =
    initWith(ClaudeTerminal, SchemaViolation, LoopJudge).then(call).then(consumeThrown)
      .expect(outcome == Halt(ProviderError) and allInvariants)

  // Claude Terminal selector, id outside the pool: aborts and names the returned ids.
  run terminalSelectorViolationNamesIdsTest =
    initWith(ClaudeTerminal, SchemaViolation, Selector).then(call).then(consumeThrown)
      .expect(outcome == Abort(true) and allInvariants)

  // Native provider: the transport rejects the done response and the selector names the ids.
  run nativeSelectorViolationNamesIdsTest =
    initWith(Native, SchemaViolation, Selector).then(call).then(consumeThrown)
      .expect(outcome == Abort(true) and allInvariants)

  // A network failure whose text holds the selector JSON is still a plain provider failure.
  run networkFailureWithJsonIsNotContractTest =
    initWith(ClaudeTerminal, NetworkErrorWithJson, Selector).then(call).then(consumeThrown)
      .expect(thrown == FailureErr({ category: ProviderError, carriesOutput: false })
        and outcome == Abort(false) and allInvariants)

  // rate_limited is a status without a category: the loop judge goes on, as before #162.
  run rateLimitedLoopJudgeKeepsPathTest =
    initWith(ClaudeTerminal, RateLimited, LoopJudge).then(call).then(consumeThrown)
      .expect(thrown == ResponseErr({ rateLimited: true }) and outcome == NaturalTransition and allInvariants)

  // An unclassified failure of the loop judge goes on with the natural transition, as before #162.
  run unclassifiedLoopJudgeFailureContinuesTest =
    initWith(Native, Unclassified, LoopJudge).then(call).then(consumeThrown)
      .expect(outcome == NaturalTransition and allInvariants)

  run validDecisionTest =
    initWith(ClaudeTerminal, Valid, LoopJudge).then(call).then(consumeThrown)
      .expect(outcome == Decision and allInvariants)

  // A rejected output without a category is a provider_error failure: it stops.
  run rejectedWithoutCategoryStopsTest =
    initWithResponse(AnyAdapter, Valid, LoopJudge, REJECTED_NO_CATEGORY).then(call).then(consumeThrown)
      .expect(thrown == FailureErr({ category: ProviderError, carriesOutput: true })
        and outcome == Halt(ProviderError) and allInvariants)

  // rate_limited wins over a rejected output.
  run rateLimitedWinsOverRejectedTest =
    initWithResponse(AnyAdapter, Valid, LoopJudge, { ...REJECTED_NO_CATEGORY, status: RateLimitedStatus })
      .then(call).then(consumeThrown)
      .expect(thrown == ResponseErr({ rateLimited: true }) and allInvariants)

  // A stream parse failure keeps its own error even with a rejected output.
  run streamParseWinsOverRejectedTest =
    initWithResponse(AnyAdapter, Valid, Selector, { ...REJECTED_NO_CATEGORY, category: StreamParse })
      .then(call).then(consumeThrown)
      .expect(thrown == FailureErr({ category: StreamParse, carriesOutput: false })
        and outcome == Abort(false) and allInvariants)

  // A done response re-validates its own output; a stray rejected output changes nothing.
  run doneIgnoresRejectedTest =
    initWithResponse(AnyAdapter, Valid, LoopJudge, { ...REJECTED_NO_CATEGORY, status: Done, outputValid: true })
      .then(call).then(consumeThrown)
      .expect(outcome == Decision and allInvariants)
}

module pr162Test {
  import structuredOutputRejection(TRANSPORT = "Pr162").* from "./structuredOutputRejection"

  // The regression the fix removes: the loop judge goes on instead of stopping.
  run terminalLoopJudgeViolationContinuesTest =
    initWith(ClaudeTerminal, SchemaViolation, LoopJudge).then(call).then(consumeThrown)
      .expect(outcome == NaturalTransition and not(contractViolationStops) and not(loopJudgeMatchesBaseline))
}

module baselineTest {
  import structuredOutputRejection(TRANSPORT = "Baseline").* from "./structuredOutputRejection"

  // The defect #162 fixes: Claude Terminal loses the returned ids.
  run terminalSelectorViolationLosesIdsTest =
    initWith(ClaudeTerminal, SchemaViolation, Selector).then(call).then(consumeThrown)
      .expect(outcome == Abort(false) and not(selectorNamesIdsOnViolation))
}

module m7Test {
  import structuredOutputRejection(TRANSPORT = "M7").* from "./structuredOutputRejection"

  // Mutation M7: the loop judge accepts output that breaks the schema.
  run terminalLoopJudgeViolationIsReturnedTest =
    initWith(ClaudeTerminal, SchemaViolation, LoopJudge).then(call).then(consumeThrown)
      .expect(outcome == Decision and not(nonDoneNeverReturns) and not(contractViolationStops))
}

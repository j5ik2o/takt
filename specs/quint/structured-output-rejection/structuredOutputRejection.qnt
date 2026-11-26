// -*- mode: Bluespec; -*-
// What a structured agent call does when the provider returns output that breaks the schema.
//
// Sources modelled:
//   src/infra/claude-terminal/response-normalizer.ts   normalizeClaudeTerminalResponse
//   src/agents/structured-caller/transport.ts          executeStructuredAgent
//   src/core/workflow/selector-contract.ts             describeSelectorError, validateSelectorResponse
//   src/core/workflow/engine/StepExecutor.ts           the catch around executeStructuredTextAgent
//   src/core/workflow/engine/LoopMonitorJudgeRunner.ts the non-done branch ("natural transition")
//
// TRANSPORT (a string) chooses the transport:
//   Baseline  before #162: a schema violation from Claude Terminal is a provider_error failure
//             and the rejected output is lost.
//   Pr162     #162 as first pushed: any non-done response with a rejected output is thrown as a
//             contract error that carries the non-done response.
//   Fixed     the fix: a rate_limited response keeps its path; an error or blocked response with a
//             rejected output and no category other than provider_error becomes a provider_error
//             failure that carries the rejected output; every other response keeps its Baseline
//             path.
//   M7        mutation M7 from the review of #162: a non-done response with a rejected output is
//             returned as a result. Kept to show that nonDoneNeverReturns catches it.
module structuredOutputRejection {
  const TRANSPORT: str

  // AnyAdapter returns any response at all: a provider not written yet, or a change to one.
  type Provider = Native | PromptJson | ClaudeTerminal | AnyAdapter

  type Reply =
    | Valid
    | SchemaViolation
    | Unparseable
    | NetworkError
    // A real failure whose text happens to contain the selector JSON.
    | NetworkErrorWithJson
    | RateLimited
    | Unclassified

  type Consumer = Selector | LoopJudge

  // AgentResponse.status. rate_limited is a status, not a failure category.
  type Status = Done | Error | Blocked | RateLimitedStatus

  // AgentResponse.failureCategory. OtherFailure stands for external_abort, part_timeout and the
  // other categories that createAgentFailureError maps to a plain AgentFailureError.
  type Category = NoCategory | ProviderError | StreamParse | OtherFailure

  type Response = {
    status: Status,
    category: Category,
    rejected: bool,
    outputParsed: bool,
    outputValid: bool,
  }

  type Thrown =
    | Returned
    | ContractErr({ statusDone: bool, carriesOutput: bool })
    | FailureErr({ category: Category, carriesOutput: bool })
    // StructuredAgentResponseError with a non-done response
    | ResponseErr({ rateLimited: bool })

  type Outcome =
    | Pending
    | Proceed
    | Decision
    | NaturalTransition
    | Halt(Category)
    // true: the reason names the returned ids
    | Abort(bool)

  type Phase = Idle | Called | Consumed

  pure val PROVIDERS = Set(Native, PromptJson, ClaudeTerminal, AnyAdapter)
  pure val REPLIES = Set(Valid, SchemaViolation, Unparseable, NetworkError, NetworkErrorWithJson, RateLimited, Unclassified)
  pure val CONSUMERS = Set(Selector, LoopJudge)
  pure val STATUSES = Set(Done, Error, Blocked, RateLimitedStatus)
  pure val CATEGORIES = Set(NoCategory, ProviderError, StreamParse, OtherFailure)
  pure val REAL_FAILURES = Set(NetworkError, NetworkErrorWithJson, RateLimited, Unclassified)

  pure val NO_OUTPUT_FAILURE: Response =
    { status: Error, category: ProviderError, rejected: false, outputParsed: false, outputValid: false }

  // What today's adapters return. Native and prompt-JSON providers return `done` and leave the
  // schema check to the transport; Claude Terminal checks the schema itself, after its rate-limit
  // check.
  pure def providerResponse(p: Provider, r: Reply): Response = match r {
    | Valid => { status: Done, category: NoCategory, rejected: false, outputParsed: true, outputValid: true }
    | SchemaViolation =>
      if (p == ClaudeTerminal)
        { status: Error, category: ProviderError, rejected: true, outputParsed: true, outputValid: false }
      else
        { status: Done, category: NoCategory, rejected: false, outputParsed: true, outputValid: false }
    | Unparseable =>
      if (p == ClaudeTerminal) NO_OUTPUT_FAILURE
      else { status: Done, category: NoCategory, rejected: false, outputParsed: false, outputValid: false }
    | NetworkError => NO_OUTPUT_FAILURE
    | NetworkErrorWithJson => NO_OUTPUT_FAILURE
    | RateLimited => { ...NO_OUTPUT_FAILURE, status: RateLimitedStatus, category: NoCategory }
    | Unclassified => { ...NO_OUTPUT_FAILURE, category: NoCategory }
  }

  pure def baselineNonDone(resp: Response): Thrown =
    if (resp.category != NoCategory)
      FailureErr({ category: resp.category, carriesOutput: false })
    else
      ResponseErr({ rateLimited: resp.status == RateLimitedStatus })

  pure def transport(t: str, resp: Response): Thrown =
    if (resp.status == Done) {
      if (resp.outputValid) Returned
      // describeSelectorError reads structuredOutput, or parses the content.
      else ContractErr({ statusDone: true, carriesOutput: resp.outputParsed })
    } else if (t == "M7" and resp.rejected)
      Returned
    else if (t == "Pr162" and resp.rejected)
      ContractErr({ statusDone: false, carriesOutput: true })
    else if (
      t == "Fixed"
      and resp.rejected
      and resp.status != RateLimitedStatus
      and (resp.category == NoCategory or resp.category == ProviderError)
    )
      FailureErr({ category: ProviderError, carriesOutput: true })
    else
      baselineNonDone(resp)

  pure def consume(c: Consumer, th: Thrown): Outcome = match c {
    | Selector => match th {
      | Returned => Proceed
      | ContractErr(e) => Abort(e.carriesOutput)
      | FailureErr(e) => Abort(e.carriesOutput)
      | ResponseErr(_) => Abort(false)
    }
    // StepExecutor turns a StructuredAgentResponseError with a non-done response into that
    // response; LoopMonitorJudgeRunner then continues with the natural transition. Anything else
    // propagates and stops the run.
    | LoopJudge => match th {
      | Returned => Decision
      | ContractErr(e) => if (e.statusDone) Halt(NoCategory) else NaturalTransition
      | FailureErr(e) => Halt(e.category)
      | ResponseErr(_) => NaturalTransition
    }
  }

  pure def isStop(o: Outcome): bool = match o {
    | Halt(_) => true
    | Abort(_) => true
    | _ => false
  }

  pure def namesReturnedIds(o: Outcome): bool = match o {
    | Abort(named) => named
    | _ => false
  }

  pure def isContract(th: Thrown): bool = match th {
    | ContractErr(_) => true
    | _ => false
  }

  pure def carriesOutput(th: Thrown): bool = match th {
    | ContractErr(e) => e.carriesOutput
    | FailureErr(e) => e.carriesOutput
    | _ => false
  }

  var phase: Phase
  var provider: Provider
  var reply: Reply
  var consumer: Consumer
  var response: Response
  var thrown: Thrown
  var outcome: Outcome

  action initWithResponse(p: Provider, r: Reply, c: Consumer, resp: Response): bool = all {
    phase' = Idle,
    provider' = p,
    reply' = r,
    consumer' = c,
    response' = resp,
    thrown' = Returned,
    outcome' = Pending,
  }

  action initWith(p: Provider, r: Reply, c: Consumer): bool =
    initWithResponse(p, r, c, providerResponse(p, r))

  action init = {
    nondet p = PROVIDERS.oneOf()
    nondet r = REPLIES.oneOf()
    nondet c = CONSUMERS.oneOf()
    nondet st = STATUSES.oneOf()
    nondet cat = CATEGORIES.oneOf()
    nondet rejected = Set(true, false).oneOf()
    nondet parsed = Set(true, false).oneOf()
    nondet valid = Set(true, false).oneOf()
    if (p == AnyAdapter)
      initWithResponse(p, r, c, {
        status: st,
        category: cat,
        rejected: rejected,
        outputParsed: parsed or valid,
        outputValid: valid,
      })
    else
      initWith(p, r, c)
  }

  action call = all {
    phase == Idle,
    phase' = Called,
    thrown' = transport(TRANSPORT, response),
    outcome' = outcome,
    provider' = provider,
    reply' = reply,
    consumer' = consumer,
    response' = response,
  }

  action consumeThrown = all {
    phase == Called,
    phase' = Consumed,
    outcome' = consume(consumer, thrown),
    thrown' = thrown,
    provider' = provider,
    reply' = reply,
    consumer' = consumer,
    response' = response,
  }

  action stutter = all {
    phase == Consumed,
    phase' = phase,
    provider' = provider,
    reply' = reply,
    consumer' = consumer,
    response' = response,
    thrown' = thrown,
    outcome' = outcome,
  }

  action step = any { call, consumeThrown, stutter }

  val concrete = provider != AnyAdapter

  // M7 in general: a non-done response is never returned as a result.
  val nonDoneNeverReturns =
    (phase != Idle and response.status != Done) implies thrown != Returned

  // A schema violation from today's adapters never lets the run go on.
  val contractViolationStops =
    (phase == Consumed and concrete and reply == SchemaViolation) implies isStop(outcome)

  // Any error or blocked response that carries a rejected output stops, whatever adapter made it.
  val rejectedOutputStops =
    (phase == Consumed and response.rejected and (response.status == Error or response.status == Blocked))
      implies isStop(outcome)

  // A real provider failure from today's adapters is never taken for a contract violation and never
  // names returned ids.
  val realFailureIsNotContract =
    (phase != Idle and concrete and REAL_FAILURES.contains(reply)) implies all {
      not(isContract(thrown)),
      not(carriesOutput(thrown)),
      not(namesReturnedIds(outcome)),
    }

  // rate_limited keeps the path it had before #162 (the status stays rate_limited), even with a
  // rejected output. Today's adapters send it without a category (ResponseErr).
  val rateLimitKeepsPath =
    (phase != Idle and response.status == RateLimitedStatus) implies thrown == baselineNonDone(response)

  // A category other than provider_error keeps its own error (ProviderStreamParseError for
  // stream parse, the category prefix for external_abort and part_timeout), even with a rejected
  // output.
  val otherCategoryKeepsError =
    (
      phase != Idle
      and (response.status == Error or response.status == Blocked)
      and response.category != NoCategory
      and response.category != ProviderError
    ) implies thrown == FailureErr({ category: response.category, carriesOutput: false })

  // The point of #162: a selector that picks an id outside the pool names the ids it returned,
  // on every provider.
  val selectorNamesIdsOnViolation =
    (phase == Consumed and concrete and consumer == Selector and reply == SchemaViolation)
      implies outcome == Abort(true)

  // With today's adapters, the loop judge keeps the transitions it had before #162.
  val loopJudgeMatchesBaseline =
    (phase == Consumed and concrete and consumer == LoopJudge)
      implies outcome == consume(LoopJudge, transport("Baseline", response))

  val validOutputProceeds =
    (phase == Consumed and response.status == Done and response.outputValid)
      implies (outcome == Proceed or outcome == Decision)

  val allInvariants = all {
    nonDoneNeverReturns,
    contractViolationStops,
    rejectedOutputStops,
    realFailureIsNotContract,
    rateLimitKeepsPath,
    otherCategoryKeepsError,
    selectorNamesIdsOnViolation,
    loopJudgeMatchesBaseline,
    validOutputProceeds,
  }
}

module fixed {
  import structuredOutputRejection(TRANSPORT = "Fixed").*
}

module pr162 {
  import structuredOutputRejection(TRANSPORT = "Pr162").*
}

module baseline {
  import structuredOutputRejection(TRANSPORT = "Baseline").*
}

module m7 {
  import structuredOutputRejection(TRANSPORT = "M7").*
}

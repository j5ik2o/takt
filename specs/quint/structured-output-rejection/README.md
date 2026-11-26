# Structured output rejection

A Quint model of what a structured agent call does when the provider returns output that breaks
the requested schema, and how the dynamic selector and the loop monitor judge react to it.

| File | Content |
|---|---|
| `structuredOutputRejection.qnt` | The model. `fixed` is the implementation; `baseline` (before #162), `pr162` (#162 as first pushed) and `m7` (a mutation from the review of #162) are kept for comparison. |
| `structuredOutputRejection_test.qnt` | Scenario tests for each instance. |

## What is modelled

- `normalizeClaudeTerminalResponse` (`src/infra/claude-terminal/response-normalizer.ts`): Claude
  Terminal checks the schema itself, after its rate-limit check. When the JSON parses but breaks
  the schema, it returns a `provider_error` response and keeps the parsed object in
  `rejectedStructuredOutput`. Native and prompt-JSON providers return `done` and leave the check to
  the transport.
- `executeStructuredAgent` (`src/agents/structured-caller/transport.ts`): turns the response into a
  return value or one of three errors (`Thrown`).
- `describeSelectorError` / `validateSelectorResponse` (`src/core/workflow/selector-contract.ts`):
  every error aborts the selection; the reason names the returned ids only when the error carries
  the rejected output.
- The catch around `executeStructuredTextAgent` in `StepExecutor` and the non-done branch of
  `LoopMonitorJudgeRunner`: a `StructuredAgentResponseError` with a non-done response becomes "no
  decision" and the run continues with the natural transition. Any other error stops the run.

`rate_limited` is a `status` (`src/core/models/status.ts`), not a failure category: today's
adapters send it with no `failureCategory`, so the transport throws a `StructuredAgentResponseError`
for it.

The provider `AnyAdapter` returns any response at all (every status, category, rejected output,
parsed and valid flag), so the transport is also checked for responses no adapter makes today.

`TRANSPORT` chooses the transport:

| Value | Non-done response with a rejected output |
|---|---|
| `Baseline` | The rejected output is ignored: a category gives `AgentFailureError`, no category gives `StructuredAgentResponseError`. |
| `Pr162` | `StructuredAgentContractError` with the non-done response, before any other check. The loop judge swallows it. |
| `Fixed` | `rate_limited`, and a category other than `provider_error`, keep the `Baseline` path. Otherwise `StructuredOutputRejectedError`: a `provider_error` `AgentFailureError` that carries the rejected output. |
| `M7` | Returned as a result (mutation M7). |

The AI judge for rule conditions and the Team Leader decomposition are not modelled. Like the
loop judge, they catch only `StructuredAgentResponseError`, so `Fixed` gives them the `Baseline`
behaviour as well.

## Invariants

| Invariant | Meaning |
|---|---|
| `nonDoneNeverReturns` | A non-done response is never returned as a result. |
| `contractViolationStops` | A schema violation from today's adapters stops the run or aborts the selection. |
| `rejectedOutputStops` | An error or blocked response with a rejected output stops, from any adapter. |
| `realFailureIsNotContract` | A network, rate-limit or unclassified failure is never a contract error and never names returned ids. |
| `rateLimitKeepsPath` | `rate_limited` keeps its `Baseline` path, even with a rejected output. |
| `otherCategoryKeepsError` | A category other than `provider_error` (stream parse, abort, timeout) keeps its own error, even with a rejected output. |
| `selectorNamesIdsOnViolation` | A selector that returns an id outside the pool names the returned ids on every provider. |
| `loopJudgeMatchesBaseline` | With today's adapters, the loop judge reaches the same outcome as before #162. |
| `validOutputProceeds` | Valid output is used. |

`fixed` keeps all nine. `pr162` breaks `contractViolationStops`, `rejectedOutputStops`,
`rateLimitKeepsPath`, `otherCategoryKeepsError` and `loopJudgeMatchesBaseline`. `baseline` breaks
`rejectedOutputStops` and `selectorNamesIdsOnViolation`. `m7` breaks `nonDoneNeverReturns`,
among others.

## Running

```sh
quint test structuredOutputRejection_test.qnt --main fixedTest
quint test structuredOutputRejection_test.qnt --main pr162Test
quint test structuredOutputRejection_test.qnt --main baselineTest
quint test structuredOutputRejection_test.qnt --main m7Test
quint verify structuredOutputRejection.qnt --main fixed --invariant allInvariants --max-steps 3
quint run structuredOutputRejection.qnt --main fixed --invariant allInvariants --max-samples 100000 --max-steps 4
```

Every run reaches its last state in three steps (`call`, `consumeThrown`, `stutter`), so
`quint verify` with `--max-steps 3` checks every starting state.

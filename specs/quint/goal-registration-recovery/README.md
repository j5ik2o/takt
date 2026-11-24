# Goal registration recovery (issue #84)

This directory holds the Quint model of the goal registration state machine and the record of the runs that were made for issue #84. The model covers one approved proposal: its reservation in the conversation state, the saved goal, the goal branch, the `registered` event, and the registration verification record.

## Files

| File | Contents |
|---|---|
| `goalRegistrationRecovery.qnt` | The model. `goalRegistrationRecoveryCore` takes two constants; `currentCode`, `fixedCode`, and `revertedRetryFix` are its three instances. |
| `goalRegistrationRecovery_test.qnt` | Deterministic scenarios for `currentCode` and `fixedCode`. |

The header of the `.qnt` file maps each part of the model to its source file.

## Invariants

All three instances are checked against the same six invariants. None was weakened to make the fix pass.

| Invariant | Meaning |
|---|---|
| `noDuplicateRegistration` | One reservation creates at most one goal, one `registered` event, and one passed-verification work-log record. |
| `reservationMatchesArtifacts` | A registered approval has its goal, branch, and event. A released reservation has left no goal and no branch. |
| `noUnpassedConfirmation` | An approval is never registered while the saved verification is pending, failed, or error. |
| `savedGoalVerifiedOnlyOnRequest` | The verifier runs for a saved goal only when a person asks for it. |
| `reverificationCreatesNothing` | A verifier run that was asked for belongs to a goal that was saved before; it never creates a goal. |
| `interruptedVerificationRecoverable` | A reservation whose saved goal still needs verification has a command that the conversation accepts and that does not end in a recovery rejection. |

## Runs

All runs used `quint` 0.32.0 with `quint run goalRegistrationRecovery.qnt --seed=0x84`. "Reproduce seed" is the seed that Quint printed for the violating sample.

| `--main` | `--invariant` | Samples | `--max-steps` | Result |
|---|---|---|---|---|
| `currentCode` | `interruptedVerificationRecoverable` | 10000 | 30 | Violation in state 0 (reproduce seed `0x1152`) |
| `currentCode` | `noUnpassedConfirmation` | 10000 | 30 | Violation (reproduce seed `0x43ba`) |
| `currentCode` | `noDuplicateRegistration` | 10000 | 30 | No violation found |
| `currentCode` | `reservationMatchesArtifacts` | 10000 | 30 | No violation found |
| `currentCode` | `savedGoalVerifiedOnlyOnRequest` | 10000 | 30 | No violation found |
| `currentCode` | `reverificationCreatesNothing` | 10000 | 30 | No violation found |
| `revertedRetryFix` | `savedGoalVerifiedOnlyOnRequest` | 10000 | 30 | Violation (reproduce seed `0x18c6`) |
| `revertedRetryFix` | `interruptedVerificationRecoverable` | 10000 | 30 | No violation found |
| `fixedCode` | `safety` (all six) | 100000 | 40 | No violation found |

Every trace reached the step limit (31 or 41 states), so no run stopped in a deadlock.

The `fixedCode` run also passed `--witnesses`. Each witness was reached, so the invariants do not hold vacuously:

| Witness | Traces out of 100000 |
|---|---|
| `registeredAfterReverification` | 2538 |
| `registeredFresh` | 274 |
| `reverificationRejected` | 8976 |
| `reservationReleased` | 9510 |

`quint test goalRegistrationRecovery_test.qnt --main=currentCodeTest` passed 3 tests, and `--main=fixedCodeTest` passed 9 tests.

## Counterexamples in the code before the fix

**The reservation cannot leave the interrupted state.** The violating state is an inherited one, so the counterexample has no steps:

```text
approval: Reserved, proposalPending: true, goalExists: true, branch: true,
registeredEvents: 1, verification: Pending, pc: Idle
```

An earlier release saved `goal.json` with a pending verification and then stopped. From this state, `approve_summary` reaches `registerReservedGoal`, which throws `Reserved goal verification has not completed`. The conversation rejects every other command while the approval is reserved, and no command re-runs the verification. `pendingReservationStaysBlockedTest` replays this.

**A saved failed verdict is confirmed.** From the same state with `verification: Unpassed`, the retry returns the saved goal and the conversation commits `approval: Registered`. `savedFailedVerdictIsConfirmedTest` replays this in three steps.

The reverted commit d6871605f made every retry run the verifier. `revertedRetryFix` shows that this removes the first counterexample but violates `savedGoalVerifiedOnlyOnRequest`.

## The fix

`approve_summary` accepts the flag `reverifyRegistration`. The conversation admits it only for an existing reservation of the same revision. `registerReservedGoal` keeps rejecting a goal whose verification is pending, and now also rejects a saved failed or error verdict. `reverifyReservedGoal` passes the same reservation checks and then runs the verifier. A reservation without a saved goal is rejected and creates nothing; with no artifact left, the conversation releases the reservation. A verdict other than passed changes nothing. A passed verdict is written under the goal lock, and only if the record still needs verification.

The model and the code are not linked mechanically. The code regressions are in `src/__tests__/goal-service.test.ts`, `src/__tests__/manager-conversation-turn-service.test.ts`, `src/__tests__/daemon-conversation-events.integration.test.ts`, and `src/__tests__/manager-summary-dialog.test.ts`.

## Limits of the model

- Other conversations and tools that write the same goal are not modelled. The code handles the one case that matters here by checking the record again under the goal lock.
- Evidence of event delivery (tasks, work log, the daemon event store) is folded into `registeredEvents >= 1`.
- A reservation whose goal exists without confirmed event delivery, and a goal branch without `goal.json`, still need manual reconciliation. Both existed before this change and are out of scope for issue #84.
- A specification that can never pass keeps its reservation. Removing the saved goal and its branch by hand releases it on the next approval.

# Goal execution tools over an external takt-mcp

A Quint model of the four goal execution tools (`takt_pause_goal`, `takt_resume_goal`,
`takt_abort_goal`, `takt_finish_goal`) when an external `takt-mcp --tool-set all` and the manager
connection can drive the same goal (issue
[#179](https://github.com/j5ik2o/takt/issues/179)). Design:
`docs/design/external-goal-execution-tools.md`.

| File | Content |
|---|---|
| `goalExecutionTools.qnt` | The model. `DESIGN` picks `Current` or `Fixed`; the instances are at the end of the file. |
| `goalExecutionTools_test.qnt` | Scenario tests: the double drive on `Current`, and the lease, refusal, stale-lease recovery, aborted-resume and rejected-finish cases on `Fixed`. |

## What is modelled

- One goal with `executionStatus` (`Active`, `Paused`, `Aborted`) and `status` (`Created`,
  `AwaitingMerge`, `Completed`). The transition rules are those of
  `transitionGoalExecution` (`src/infra/goals/state.ts`): only an active goal pauses, only a paused
  goal resumes, an aborted goal never resumes, and only an aborted goal with status `created` or
  `awaiting_merge` finishes (leaving `executionStatus` aborted and setting `status` completed).
- Two drivers: `M` is the manager connection (the only caller the four tools are registered for on
  `integration/takt-mcp` at `e0d653c67`) and `X` is an external `takt-mcp --tool-set all`. Each
  operation is `begin` (read and validate), `commit` (save the transition and run the steps after
  the save), or `abandon` (the saved state rejects it, nothing is saved).
- `Current`: no interlock. `begin` never takes anything, so `M` and `X` can both be between
  `begin` and `commit` for the same goal. The saved goal write is still atomic (the goal-execution
  lock), so the defect is not a torn write; it is two controllers deciding on the same goal from
  the same old state. Current は、manager と外の両方に 4 つの道具があり lease が無い状態である。
  今のバイナリで外に道具が無いことそのものは表していない。
- `Fixed`: both drivers take a per-goal driver lease for the whole operation. A call that finds a
  live lease held by the other driver is refused (`refuse`) and names the holder. A lease left by
  a dead holder is reclaimed by the next `begin` (`beginAfterStaleLease`). `commit`, `abandon` and
  `crash` are modelled as in the design: `crash` clears the dead driver's operation slot and leaves
  its lease behind.
- `aliveM` / `aliveX` and `crash` model a process that dies between `begin` and `commit`. A dead
  driver cannot commit; its lease is stale and is reclaimed.
- `refusals` / `lastRefusal` model the clear error: a refused call names the lease it refused. The
  goal is unchanged by a refusal.

Not modelled:

- Running tasks (a pause interrupts them; an abort invalidates pending ones), the daemon and
  manager auto-run started by a resume, and the branch and unintegrated-result checks of finish.
  They run inside the same operation and are covered by the lease, but they do not change whether
  two drivers can be inside it at once.
- The goal-execution lock (`goal-execution.lock`) and the `goal.json` lock that make one `commit`
  atomic, and the release-failure handling of the driver lease (see the design; it reuses the #169
  posture).
- Lease acquisition and release as separate steps: in the model a lease is taken by `begin`, so
  there is no step where a live lease exists without its operation. Unit and integration tests
  cover the file itself.
- Multi-host and shared-filesystem behaviour: PID and process start time are checked on the host
  that runs the call, like the existing locks.
- The other goal tools that go through `goalWrite` (`takt_enqueue_goal_task`, `takt_merge_goal_task`,
  ...) are outside the four-tool guard; they already reject paused and aborted goals from the saved
  state. `takt_stop_goal_task` and `takt_remove_goal_task` follow their own rules.

## Properties

`safety` is the conjunction of the five below.

| Invariant | Meaning |
|---|---|
| `atMostOneWriter` | The manager connection and an external takt-mcp are never both inside an operation on the goal. |
| `everyOperationLeased` | Every in-flight operation holds the per-goal driver lease for its driver. |
| `abortedStaysAborted` | An aborted goal does not become active again. |
| `completedImpliesAborted` | `status` completed is reached only from an aborted goal and leaves `executionStatus` aborted. |
| `refusalNamesHolder` | Every refusal names the lease it refused, so the caller can tell who is driving the goal. |

Witnesses: `wDoubleDrive` (both drivers in flight; `Current` only), `wExternalRefusedByManager`,
`wExternalFinish`, `wStaleLeaseReclaimed`.

## Results

Run from this directory. quint 0.32.0.

| Command | Result |
|---|---|
| `quint typecheck goalExecutionTools.qnt` / `quint typecheck goalExecutionTools_test.qnt` | No errors. |
| `quint test goalExecutionTools_test.qnt --main currentTest` | 1 passing (`managerAndExternalBothBeginTest`: begin M Abort, begin X Pause, both in flight, no refusal). |
| `quint test goalExecutionTools_test.qnt --main fixedTest` | 6 passing (`managerBlocksExternalTest`, `externalBlocksManagerTest`, `staleLeaseReclaimedTest`, `abortedCannotResumeTest`, `finishRejectedWhenActiveTest`, `refusalKeepsGoalTest`). |
| `quint run goalExecutionTools.qnt --main current --invariant safety --max-samples 10000 --max-steps 16 --seed 0x2a` | `[violation]`. The first sample (2 steps, seed 0x2a): state 1 `crash` X, state 2 `begin` M Abort with `lease = Free`, so `everyOperationLeased` fails. With only `--invariant atMostOneWriter` the counterexample is state 1 `begin` M Abort, state 2 `begin` X Abort (`inflightM = Doing(Abort)`, `inflightX = Doing(Abort)`; seed 0x292), the double drive itself. |
| `quint run goalExecutionTools.qnt --main fixed --invariant safety --max-samples 10000 --max-steps 16 --seed 0x2a` | `[ok] No violation found`, 10,000 samples, max trace length 17, seed 0x2a. |
| `quint run goalExecutionTools.qnt --main fixed --max-samples 10000 --max-steps 16 --seed 0x2a --witnesses wDoubleDrive wExternalRefusedByManager wExternalFinish wStaleLeaseReclaimed` | No violation. `wExternalRefusedByManager` 697/10000, `wExternalFinish` 3/10000, `wStaleLeaseReclaimed` 1004/10000; `wDoubleDrive` 0/10000 (the fix). |

No other checks were run; `quint verify` and the Apalache backend were not used.

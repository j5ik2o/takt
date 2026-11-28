// -*- mode: Bluespec; -*-
// One attempt of a goal task that ends through the normal execution path (#216), from the save
// of its terminal record to the manager notification, the run's count, and the daemon's resend.
// Read with docs/design/issue-216-normal-completion-publication.md.
//
// The save is TaskLifecycleService.completeTask / failTask / prFailTask or TaskExceedService.exceedTask
// (src/infra/task/taskLifecycleService.ts:598-660, :736-765, taskExceedService.ts:25-40), reached from
// executeTaskAndCompleteWithDetails (src/features/tasks/execute/taskExecution.ts:114-130). Callers:
//   TaktRun    — fillSlots (src/features/tasks/execute/parallelExecution.ts:495-508). The run counts
//                the attempt (:270-303): a rejected promise is counted as a failure (:253).
//   WorkerPool — BuiltinProjectRuntime.startTask's .then (src/features/workerPool/builtinProjectRuntime.ts:219-239
//                on #193 601fb47ec). An exception calls the runtime's `failed`, which closes the project host.
//   Instruct   — the instruct re-execution (src/features/tasks/list/taskInstructionActions.ts:292). It saves
//                through the same functions and never publishes.
//
// SHAPE of what one attempt saves and returns (e626fcce3):
//   Normal               — the record keeps the run_slug that updateRunningTaskExecution wrote
//                          (taskExecution.ts:219 / :268, merge/index.ts:155), and the result carries the same runSlug.
//   PausedBeforeWorkflow — GoalPausedError before the workflow starts: failTask writes run_slug: undefined
//                          (taskExecution.ts:462-465 -> taskLifecycleService.ts:654), so the record has only its
//                          execution_id, while the result still carries runSlug (taskExecution.ts:217, :479).
//                          The caller publishes it today with that runSlug.
//   NoResult             — the result has no completion (e.g. merge/index.ts:155 throws before the terminal save,
//                          taskExecution.ts:155-158 reads back a running record). Nothing terminal is saved.
//
// The inbox eventId of a completion is (goal, task, 'run', runSlug) when it has a runSlug and
// (goal, task, 'execution', executionId) otherwise (src/features/daemon/inbox.ts:49-53). The caller sends
// the result's runSlug (RunId); the daemon sends the record's identity (RunId if the record has a run_slug,
// ExecId if not; pendingGoalTaskCompletions.ts:49-54). Two different ids are two manager events.
//
// DESIGN picks the shape:
//   "Current"       — e626fcce3. No mark; saveManagerEvent without a try.
//   "SameWrite"     — design A. The save writes completion_publication_pending in the same write when
//                     the caller asked for it (publishesGoalCompletion) and the record has a goal, a
//                     completion and a run slug. The caller reads back the marked record of its own attempt
//                     (name, goal and execution_id) and publishes it through publishAndClearPendingMark
//                     (claimTasks.ts:98-112); when the record is unmarked it publishes from its result; when the
//                     read-back throws, it publishes from its result, leaves any mark and warns. Every failure
//                     is caught and warned, and the caller returns the execution's own result.
//   "MarkOnFailure" — design B. The save writes no mark; only a failed notification writes the mark,
//                     in a second write.
// BREAK breaks "SameWrite" in one place, to show that each invariant can fail:
//   "None", "NoClear" (no clear after a publish), "NoCatch" (the notification is not caught),
//   "NoWarn" (a caught failure is not warned), "ResendUnmarked" (the daemon also resends an unmarked
//   old record), "MarkOnSchema" (the mark follows the schema's rule, run slug or execution id),
//   "MarkUnrequested" (the save marks for a caller that did not ask), "SilentReadBack" (a failed read-back
//   is not warned), "CallerForgetsRequest" (takt run does not pass publishesGoalCompletion),
//   "PoolThrowsWithoutResult" (the worker pool keeps throwing when the result has no completion, P6 not applied).
//
// The disk can fill and empty at any time (ENOSPC on saveManagerEvent and on every tasks.yaml write).
// The process can be killed after the save. The daemon resends a marked record when the disk lets it
// (watchSource.ts:125 / :157 -> readPendingGoalTaskCompletions, taskStateReader.ts:96-150), at any point
// after the save, also while the caller is still publishing.
module normalCompletionPublication {
  const DESIGN: str
  const BREAK: str

  type Caller = TaktRun | WorkerPool | Instruct
  type Shape = Normal | PausedBeforeWorkflow | NoResult
  type EventId = RunId | ExecId
  //   Idle        — nothing saved yet.
  //   Saved       — the terminal record is in tasks.yaml; the caller has not published yet.
  //   Published   — saveManagerEvent returned; the mark still needs clearing.
  //   FailMarkDue — (MarkOnFailure) the notification failed; the second write is next.
  //   Returned    — the caller returned to the run or the runtime without an exception.
  //   Escaped     — an exception left the caller.
  //   Killed      — the process died after the save.
  type Phase = Idle | Saved | Published | FailMarkDue | Returned | Escaped | Killed
  type Count = Uncounted | CountedSuccess | CountedFailure

  type St = {
    caller: Caller,
    phase: Phase,
    success: bool,          // the execution's own result
    shape: Shape,
    requested: bool,        // the caller passed publishesGoalCompletion to the save
    mark: bool,             // completion_publication_pending on the saved record
    markedAtSave: bool,     // ghost: the save wrote the mark
    inbox: Set[EventId],    // the manager events of this attempt (one per distinct eventId)
    publishedByCaller: bool,
    daemonSent: bool,       // ghost: the daemon resent this attempt
    notifyWarned: bool,
    clearWarned: bool,
    count: Count,           // TaktRun: how the run counted the attempt
    hostClosed: bool,       // WorkerPool: the project host was closed
    legacyMarked: bool,     // an old record saved by a version before the mark (always false)
    legacyDelivered: bool,  // the daemon sent that old record's completion
    full: bool,
    lastAction: str,
  }

  var s: St

  pure def sameWrite: bool = DESIGN == "SameWrite"
  pure def markOnFailure: bool = DESIGN == "MarkOnFailure"
  pure def catches: bool = (sameWrite and BREAK != "NoCatch") or markOnFailure
  pure def warns: bool = BREAK != "NoWarn"
  pure def clears: bool = BREAK != "NoClear"
  pure def publishes(c: Caller): bool = c != Instruct
  pure def recordRunSlug(sh: Shape): bool = sh == Normal
  pure def resultRunSlug(sh: Shape): bool = sh != NoResult
  pure def recordCompletion(sh: Shape): bool = sh != NoResult
  pure def recordId(sh: Shape): EventId = if (recordRunSlug(sh)) RunId else ExecId
  // The caller publishes this attempt today (parallelExecution.ts:499-506): a completion with a runSlug in the result.
  pure def publishesToday(c: Caller, sh: Shape): bool = publishes(c) and resultRunSlug(sh)
  pure def asks(c: Caller): bool = publishes(c) and not(BREAK == "CallerForgetsRequest" and c == TaktRun)
  pure def markedOnSave(requested: bool, sh: Shape): bool =
    sameWrite and (requested or BREAK == "MarkUnrequested") and recordCompletion(sh)
      and (recordRunSlug(sh) or BREAK == "MarkOnSchema")
  pure def resendsUnmarked: bool = BREAK == "ResendUnmarked"
  // 601fb47ec builtinProjectRuntime.ts:223 throws when the result has no completion; P6 makes it log and finish.
  pure def poolThrowsWithoutResult: bool = DESIGN == "Current" or BREAK == "PoolThrowsWithoutResult"

  // The caller returns normally; the run counts the execution's own result.
  pure def returned(st: St, name: str): St =
    { ...st, phase: Returned, count: if (st.caller == TaktRun) (if (st.success) CountedSuccess else CountedFailure) else Uncounted,
      lastAction: name }

  action init = {
    nondet caller = Set(TaktRun, WorkerPool, Instruct).oneOf()
    s' = { caller: caller, phase: Idle, success: false, shape: Normal, requested: false, mark: false,
           markedAtSave: false, inbox: Set(), publishedByCaller: false, daemonSent: false,
           notifyWarned: false, clearWarned: false, count: Uncounted, hostClosed: false,
           legacyMarked: false, legacyDelivered: false, full: false, lastAction: "init" }
  }

  // The terminal record is saved; the mark (if any) is part of the same write.
  action save: bool = {
    nondet shape = Set(Normal, PausedBeforeWorkflow, NoResult).oneOf()
    nondet ok = Set(true, false).oneOf()
    val requested = asks(s.caller)
    val mark = markedOnSave(requested, shape)
    all {
      s.phase == Idle, not(s.full),
      s' = { ...s, phase: Saved, success: shape == Normal and ok, shape: shape, requested: requested,
             mark: mark, markedAtSave: mark, lastAction: "save" },
    }
  }

  // No completion in the result. takt run logs an error and returns (parallelExecution.ts:499-502).
  // The worker pool throws on 601fb47ec (builtinProjectRuntime.ts:223); the design (P6) logs and finishes instead.
  action skipWithoutResult: bool = all {
    s.phase == Saved, publishes(s.caller), not(resultRunSlug(s.shape)),
    s' = if (s.caller == WorkerPool and poolThrowsWithoutResult)
           { ...s, phase: Escaped, hostClosed: true, lastAction: "skipWithoutResult" }
         else returned(s, "skipWithoutResult"),
  }

  // Instruct saves and returns without publishing (today and in the design).
  action returnWithoutPublishing: bool = all {
    s.phase == Saved, not(publishes(s.caller)),
    s' = returned(s, "returnWithoutPublishing"),
  }

  // SameWrite: the read-back of the saved record throws (tasks.yaml lock timeout). The caller
  // publishes from its own result, leaves any mark for the daemon and warns about it.
  action readBackFails: bool = all {
    sameWrite, s.phase == Saved, publishesToday(s.caller, s.shape), not(s.full),
    s' = returned({ ...s, inbox: s.inbox.union(Set(RunId)), publishedByCaller: true,
                    clearWarned: BREAK != "SilentReadBack" }, "readBackFails"),
  }

  // saveManagerEvent succeeds. SameWrite reads back the marked record of this attempt and sends its identity;
  // an unmarked record (paused, or the daemon already cleared it) is sent from the result.
  action publish: bool = {
    val id = if (sameWrite and s.mark) recordId(s.shape) else RunId
    val sent = { ...s, inbox: s.inbox.union(Set(id)), publishedByCaller: true }
    all {
      s.phase == Saved, publishesToday(s.caller, s.shape), not(s.full),
      s' = if (sameWrite and s.mark and clears) { ...sent, phase: Published, lastAction: "publish" }
           else returned(sent, "publish"),
    }
  }

  // saveManagerEvent throws ENOSPC.
  action publishFails: bool = all {
    s.phase == Saved, publishesToday(s.caller, s.shape), s.full,
    s' = if (markOnFailure) { ...s, phase: FailMarkDue, lastAction: "publishFails" }
         else if (catches) returned({ ...s, notifyWarned: warns }, "publishFails")
         else { ...s, phase: Escaped,
                count: if (s.caller == TaktRun) CountedFailure else Uncounted,
                hostClosed: s.caller == WorkerPool, lastAction: "publishFails" },
  }

  // MarkOnFailure: the second write that adds the mark.
  action markAfterFailure: bool = all {
    s.phase == FailMarkDue, not(s.full),
    s' = returned({ ...s, mark: recordRunSlug(s.shape), notifyWarned: true }, "markAfterFailure"),
  }

  action markAfterFailureFails: bool = all {
    s.phase == FailMarkDue, s.full,
    s' = returned({ ...s, notifyWarned: true }, "markAfterFailureFails"),
  }

  // clearCompletionPublicationPending after the caller published.
  action clearMark: bool = all {
    s.phase == Published, not(s.full),
    s' = returned({ ...s, mark: false }, "clearMark"),
  }

  // The clear throws; publishAndClearPendingMark warns and the daemon clears later.
  action clearFails: bool = all {
    s.phase == Published, s.full,
    s' = returned({ ...s, clearWarned: true }, "clearFails"),
  }

  action kill: bool = all {
    s.phase == Saved or s.phase == Published or s.phase == FailMarkDue,
    s' = { ...s, phase: Killed, lastAction: "kill" },
  }

  // The daemon reads a marked record, writes its completion to the inbox with the record's identity and clears the mark.
  action daemonResend: bool = all {
    s.phase != Idle, s.mark, not(s.full),
    s' = { ...s, mark: false, inbox: s.inbox.union(Set(recordId(s.shape))), daemonSent: true,
           lastAction: "daemonResend" },
  }

  // The daemon's read of the old record that a version before the mark saved.
  action daemonReadsLegacy: bool = all {
    s.legacyMarked or resendsUnmarked, not(s.legacyDelivered), not(s.full),
    s' = { ...s, legacyDelivered: true, lastAction: "daemonReadsLegacy" },
  }

  action diskFills: bool = all { not(s.full), s' = { ...s, full: true, lastAction: "diskFills" } }
  action diskFrees: bool = all { s.full, s' = { ...s, full: false, lastAction: "diskFrees" } }

  // The caller's own moves after the save (used by the liveness property).
  action callerStep = any {
    skipWithoutResult, returnWithoutPublishing, readBackFails, publish, publishFails, markAfterFailure,
    markAfterFailureFails, clearMark, clearFails,
  }

  action step = any {
    save, callerStep, kill, daemonResend, daemonReadsLegacy, diskFills, diskFrees,
  }

  pure def settled(p: Phase): bool = p == Returned or p == Escaped or p == Killed
  pure def inAttempt(p: Phase): bool = p == Saved or p == Published or p == FailMarkDue
  val delivered: bool = s.inbox.size() > 0

  // J1: once the caller is out of the attempt, a completion the caller publishes today and whose record
  // keeps its run slug is in the inbox, or its mark is still there for the daemon.
  // (PausedBeforeWorkflow is left out on purpose: see the design, raised point 6.)
  val deliveredOrMarked: bool =
    (settled(s.phase) and publishes(s.caller) and recordRunSlug(s.shape)) implies (delivered or s.mark)
  // J2: the run counts the execution's own result, whatever happened to the notification.
  val successCountedAsSuccess: bool =
    s.count != Uncounted implies (s.count == (if (s.success) CountedSuccess else CountedFailure))
  // J3 (worker pool only; takt run has no host): a notification failure never closes the project host.
  val hostStaysOpen: bool = not(s.hostClosed)
  // J4: after the caller published and neither the clear nor the read-back failed (both warn), no mark is left.
  val publishedClearsMark: bool =
    (s.phase == Returned and s.publishedByCaller and not(s.clearWarned)) implies not(s.mark)
  // J5: a completion the caller should have published and did not is warned.
  val unpublishedIsWarned: bool =
    (s.phase == Returned and publishesToday(s.caller, s.shape) and not(s.publishedByCaller)) implies s.notifyWarned
  // J6: an old record without the mark is never resent.
  val legacyNotResent: bool = not(s.legacyDelivered)
  // J7: nothing is marked or sent that is not published today (no completion in the result, or a caller that never publishes).
  val noNewSends: bool = (s.mark or delivered) implies publishesToday(s.caller, s.shape)
  // J8: the caller's notice and the daemon's resend of one attempt are one manager event (one eventId).
  val oneEventPerAttempt: bool = s.inbox.size() <= 1

  val safety: bool = deliveredOrMarked and successCountedAsSuccess and hostStaysOpen and publishedClearsMark
    and unpublishedIsWarned and legacyNotResent and noNewSends and oneEventPerAttempt

  // Liveness: under weak fairness of the caller's own moves, a caller that has saved always leaves the attempt.
  temporal callerSettles: bool =
    weakFair(callerStep, s) implies always(inAttempt(s.phase) implies eventually(settled(s.phase)))
  // The same property without fairness. It must fail (the caller may stutter at Saved forever), which shows
  // the check above is not vacuous.
  temporal callerSettlesUnfair: bool = always(inAttempt(s.phase) implies eventually(settled(s.phase)))

  // Witnesses of actions (each should be reached in some trace).
  val wSave: bool = s.lastAction == "save"
  val wSkip: bool = s.lastAction == "skipWithoutResult"
  val wInstruct: bool = s.lastAction == "returnWithoutPublishing"
  val wReadBackFails: bool = s.lastAction == "readBackFails"
  val wPublish: bool = s.lastAction == "publish"
  val wPublishFails: bool = s.lastAction == "publishFails"
  val wMarkAfterFailure: bool = s.lastAction == "markAfterFailure"
  val wMarkAfterFailureFails: bool = s.lastAction == "markAfterFailureFails"
  val wClear: bool = s.lastAction == "clearMark"
  val wClearFails: bool = s.lastAction == "clearFails"
  val wKill: bool = s.lastAction == "kill"
  val wResend: bool = s.lastAction == "daemonResend"
  val wLegacy: bool = s.lastAction == "daemonReadsLegacy"
  // Witnesses of the states each invariant constrains (the antecedent holds, so the invariant is not vacuous).
  val wJ1OnlyMark: bool = settled(s.phase) and publishes(s.caller) and recordRunSlug(s.shape) and not(delivered) and s.mark
  val wJ1Delivered: bool = settled(s.phase) and publishes(s.caller) and recordRunSlug(s.shape) and delivered and not(s.mark)
  val wJ2AfterFailure: bool = s.count == CountedSuccess and s.notifyWarned
  val wJ3PoolFailure: bool = s.caller == WorkerPool and s.lastAction == "publishFails"
  val wJ3PoolNoResult: bool = s.caller == WorkerPool and s.lastAction == "skipWithoutResult"
  val wJ4Cleared: bool = s.phase == Returned and s.publishedByCaller and not(s.clearWarned) and s.markedAtSave
  val wJ5Warned: bool = s.phase == Returned and publishesToday(s.caller, s.shape) and not(s.publishedByCaller)
  val wJ7Instruct: bool = s.caller == Instruct and s.phase == Returned and recordRunSlug(s.shape)
  val wJ7Paused: bool = s.shape == PausedBeforeWorkflow and settled(s.phase) and publishes(s.caller)
  val wJ8Overlap: bool = s.publishedByCaller and s.daemonSent
  val wPausedLost: bool = s.shape == PausedBeforeWorkflow and s.phase == Returned and not(delivered) and s.notifyWarned
  val wResendAfterFailure: bool = s.lastAction == "daemonResend" and s.notifyWarned
  val wResendAfterKill: bool = s.lastAction == "daemonResend" and s.phase == Killed
  val wPoolReturnedAfterFailure: bool = s.caller == WorkerPool and s.phase == Returned and s.notifyWarned
}

module current { import normalCompletionPublication(DESIGN = "Current", BREAK = "None").* }
module sameWrite { import normalCompletionPublication(DESIGN = "SameWrite", BREAK = "None").* }
module markOnFailure { import normalCompletionPublication(DESIGN = "MarkOnFailure", BREAK = "None").* }
module brokenNoClear { import normalCompletionPublication(DESIGN = "SameWrite", BREAK = "NoClear").* }
module brokenNoCatch { import normalCompletionPublication(DESIGN = "SameWrite", BREAK = "NoCatch").* }
module brokenNoWarn { import normalCompletionPublication(DESIGN = "SameWrite", BREAK = "NoWarn").* }
module brokenResendUnmarked { import normalCompletionPublication(DESIGN = "SameWrite", BREAK = "ResendUnmarked").* }
module brokenMarkOnSchema { import normalCompletionPublication(DESIGN = "SameWrite", BREAK = "MarkOnSchema").* }
module brokenMarkUnrequested { import normalCompletionPublication(DESIGN = "SameWrite", BREAK = "MarkUnrequested").* }
module brokenSilentReadBack { import normalCompletionPublication(DESIGN = "SameWrite", BREAK = "SilentReadBack").* }
module brokenCallerForgetsRequest { import normalCompletionPublication(DESIGN = "SameWrite", BREAK = "CallerForgetsRequest").* }
module brokenPoolThrowsWithoutResult { import normalCompletionPublication(DESIGN = "SameWrite", BREAK = "PoolThrowsWithoutResult").* }

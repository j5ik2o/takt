// -*- mode: Bluespec; -*-
// One attempt of a goal task that ends through the normal execution path (#216), from the save
// of its terminal record to the manager notification, the run's count, and the daemon's resend.
// Read with docs/design/issue-216-normal-completion-publication.md.
//
// The save is TaskLifecycleService.completeTask / failTask / prFailTask or TaskExceedService.exceedTask
// (src/infra/task/taskLifecycleService.ts:598-660, :736-765, taskExceedService.ts:25-40), reached from
// executeTaskAndCompleteWithDetails (src/features/tasks/execute/taskExecution.ts:114-130). Two callers
// publish after it:
//   TaktRun    — fillSlots (src/features/tasks/execute/parallelExecution.ts:495-508). The run counts
//                the attempt (:270-303): a rejected promise is counted as a failure (:253).
//   WorkerPool — BuiltinProjectRuntime.startTask's .then (src/features/workerPool/builtinProjectRuntime.ts:222-239
//                on #193). An exception calls the runtime's `failed`, which closes the project host.
//   Instruct   — the instruct re-execution (src/features/tasks/list/taskInstructionActions.ts:292). It saves
//                through the same functions and never publishes; it does not ask for the mark.
//
// The caller publishes only when the saved result has a run slug (parallelExecution.ts:499-502);
// a GoalPausedError before the workflow starts saves a completion without one (taskExecution.ts:462-465).
//
// DESIGN picks the shape:
//   "Current"       — e626fcce3. No mark; saveManagerEvent without a try.
//   "SameWrite"     — design A. The save writes completion_publication_pending in the same write when
//                     the caller asked for it (publishesGoalCompletion) and the record has a goal, a
//                     completion and a run slug. The caller reads the saved record back and publishes it
//                     through publishAndClearPendingMark (claimTasks.ts:98-112); when the read-back throws,
//                     it publishes from its own result, leaves the mark and warns. Every failure is caught
//                     and warned, and the caller returns the execution's own result.
//   "MarkOnFailure" — design B. The save writes no mark; only a failed notification writes the mark,
//                     in a second write.
// BREAK breaks "SameWrite" in one place, to show that each invariant can fail:
//   "None", "NoClear" (no clear after a publish), "NoCatch" (the notification is not caught),
//   "NoWarn" (a caught failure is not warned), "ResendUnmarked" (the daemon also resends an unmarked
//   old record), "MarkOnSchema" (the mark follows the schema's rule, run slug or execution id),
//   "MarkUnrequested" (the save marks for a caller that did not ask), "SilentReadBack" (a failed read-back
//   leaves the mark without a warning).
//
// The disk can fill and empty at any time (ENOSPC on saveManagerEvent and on every tasks.yaml write).
// The process can be killed after the save. The daemon resends a marked record when the disk lets it
// (watchSource.ts:125 / :157 -> readPendingGoalTaskCompletions, taskStateReader.ts:96-150).
module normalCompletionPublication {
  const DESIGN: str
  const BREAK: str

  type Caller = TaktRun | WorkerPool | Instruct
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
    success: bool,        // the execution's own result, saved as completed (true) or failed
    runSlug: bool,        // the saved record has a run slug
    executionId: bool,    // the saved record has an execution id
    mark: bool,           // completion_publication_pending on the saved record
    delivered: bool,      // the manager inbox has this attempt's completion
    publishedByCaller: bool,
    notifyWarned: bool,
    clearWarned: bool,
    count: Count,         // TaktRun: how the run counted the attempt
    hostClosed: bool,     // WorkerPool: the project host was closed
    legacyMarked: bool,   // an old record saved by a version before the mark (always false)
    legacyDelivered: bool,// the daemon sent that old record's completion
    full: bool,
    lastAction: str,
  }

  var s: St

  pure def sameWrite: bool = DESIGN == "SameWrite"
  pure def markOnFailure: bool = DESIGN == "MarkOnFailure"
  pure def catches: bool = (sameWrite and BREAK != "NoCatch") or markOnFailure
  pure def warns: bool = BREAK != "NoWarn"
  pure def clears: bool = BREAK != "NoClear"
  // The mark is written on save only where the caller publishes today.
  pure def publishes(c: Caller): bool = c != Instruct
  pure def markedOnSave(c: Caller, runSlug: bool, executionId: bool): bool =
    sameWrite and (publishes(c) or BREAK == "MarkUnrequested")
      and (runSlug or (BREAK == "MarkOnSchema" and executionId))
  pure def resendsUnmarked: bool = BREAK == "ResendUnmarked"

  // The caller returns normally; the run counts the execution's own result.
  pure def returned(st: St, name: str): St =
    { ...st, phase: Returned, count: if (st.caller == TaktRun) (if (st.success) CountedSuccess else CountedFailure) else Uncounted,
      lastAction: name }

  action init = {
    nondet caller = Set(TaktRun, WorkerPool, Instruct).oneOf()
    s' = { caller: caller, phase: Idle, success: false, runSlug: false, executionId: false, mark: false,
           delivered: false, publishedByCaller: false, notifyWarned: false, clearWarned: false,
           count: Uncounted, hostClosed: false, legacyMarked: false, legacyDelivered: false,
           full: false, lastAction: "init" }
  }

  // The terminal record is saved; the mark (if any) is part of the same write.
  action save: bool = {
    nondet success = Set(true, false).oneOf()
    nondet runSlug = Set(true, false).oneOf()
    nondet executionId = Set(true, false).oneOf()
    all {
      s.phase == Idle, not(s.full),
      s' = { ...s, phase: Saved, success: success, runSlug: runSlug, executionId: executionId,
             mark: markedOnSave(s.caller, runSlug, executionId), lastAction: "save" },
    }
  }

  // No run slug: the caller logs an error and returns without publishing (parallelExecution.ts:499-502).
  action skipWithoutRunSlug: bool = all {
    s.phase == Saved, publishes(s.caller), not(s.runSlug),
    s' = returned(s, "skipWithoutRunSlug"),
  }

  // Instruct saves and returns without publishing (today and in the design).
  action returnWithoutPublishing: bool = all {
    s.phase == Saved, not(publishes(s.caller)),
    s' = returned(s, "returnWithoutPublishing"),
  }

  // SameWrite: the read-back of the saved record throws (tasks.yaml lock timeout). The caller
  // publishes from its own result, leaves the mark for the daemon and warns about it.
  action readBackFails: bool = all {
    sameWrite, s.phase == Saved, publishes(s.caller), s.runSlug, s.mark, not(s.full),
    s' = returned({ ...s, delivered: true, publishedByCaller: true, clearWarned: BREAK != "SilentReadBack" },
                  "readBackFails"),
  }

  // saveManagerEvent succeeds.
  action publish: bool = all {
    s.phase == Saved, publishes(s.caller), s.runSlug, not(s.full),
    s' = if (sameWrite and s.mark and clears)
           { ...s, phase: Published, delivered: true, publishedByCaller: true, lastAction: "publish" }
         else returned({ ...s, delivered: true, publishedByCaller: true }, "publish"),
  }

  // saveManagerEvent throws ENOSPC.
  action publishFails: bool = all {
    s.phase == Saved, publishes(s.caller), s.runSlug, s.full,
    s' = if (markOnFailure) { ...s, phase: FailMarkDue, lastAction: "publishFails" }
         else if (catches) returned({ ...s, notifyWarned: warns }, "publishFails")
         else { ...s, phase: Escaped,
                count: if (s.caller == TaktRun) CountedFailure else Uncounted,
                hostClosed: s.caller == WorkerPool, lastAction: "publishFails" },
  }

  // MarkOnFailure: the second write that adds the mark.
  action markAfterFailure: bool = all {
    s.phase == FailMarkDue, not(s.full),
    s' = returned({ ...s, mark: true, notifyWarned: true }, "markAfterFailure"),
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

  // The daemon reads a marked record, writes its completion to the inbox and clears the mark.
  action daemonResend: bool = all {
    s.phase != Idle, s.mark, not(s.full),
    s' = { ...s, mark: false, delivered: true, lastAction: "daemonResend" },
  }

  // The daemon's read of the old record that a version before the mark saved.
  action daemonReadsLegacy: bool = all {
    s.legacyMarked or resendsUnmarked, not(s.legacyDelivered), not(s.full),
    s' = { ...s, legacyDelivered: true, lastAction: "daemonReadsLegacy" },
  }

  action diskFills: bool = all { not(s.full), s' = { ...s, full: true, lastAction: "diskFills" } }
  action diskFrees: bool = all { s.full, s' = { ...s, full: false, lastAction: "diskFrees" } }

  action step = any {
    save, skipWithoutRunSlug, returnWithoutPublishing, readBackFails, publish, publishFails, markAfterFailure, markAfterFailureFails,
    clearMark, clearFails, kill, daemonResend, daemonReadsLegacy, diskFills, diskFrees,
  }

  pure def settled(p: Phase): bool = p == Returned or p == Escaped or p == Killed

  // J1: once the caller is out of the attempt, a completion the caller would publish today is in the
  // inbox, or its mark is still there for the daemon.
  val deliveredOrMarked: bool =
    (settled(s.phase) and s.runSlug and publishes(s.caller)) implies (s.delivered or s.mark)
  // J2: the run counts the execution's own result, whatever happened to the notification.
  val successCountedAsSuccess: bool =
    s.count != Uncounted implies (s.count == (if (s.success) CountedSuccess else CountedFailure))
  // J3: a notification failure never closes the project host.
  val hostStaysOpen: bool = not(s.hostClosed)
  // J4: after the caller published and neither the clear nor the read-back failed (both warn), no mark is left.
  val publishedClearsMark: bool =
    (s.phase == Returned and s.publishedByCaller and not(s.clearWarned)) implies not(s.mark)
  // J5: a completion the caller should have published and did not is warned.
  val unpublishedIsWarned: bool =
    (s.phase == Returned and s.runSlug and publishes(s.caller) and not(s.publishedByCaller)) implies s.notifyWarned
  // J6: an old record without the mark is never resent.
  val legacyNotResent: bool = not(s.legacyDelivered)
  // J7: nothing is marked or sent that is not published today (no run slug, or a caller that never publishes).
  val noNewSends: bool = (s.mark or s.delivered) implies (s.runSlug and publishes(s.caller))

  val safety: bool = deliveredOrMarked and successCountedAsSuccess and hostStaysOpen and publishedClearsMark
    and unpublishedIsWarned and legacyNotResent and noNewSends

  // Witnesses (each should be reached in some trace).
  val wSave: bool = s.lastAction == "save"
  val wSkip: bool = s.lastAction == "skipWithoutRunSlug"
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
  val wResendAfterFailure: bool = s.lastAction == "daemonResend" and s.notifyWarned
  val wResendAfterKill: bool = s.lastAction == "daemonResend" and s.phase == Killed
  val wLegacy: bool = s.lastAction == "daemonReadsLegacy"
  val wSuccessCountedAfterFailure: bool = s.count == CountedSuccess and s.notifyWarned
  val wWorkerPoolReturnedAfterFailure: bool = s.caller == WorkerPool and s.phase == Returned and s.notifyWarned
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

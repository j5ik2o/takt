// -*- mode: Bluespec; -*-
// The completion of one failed goal-task attempt on the worker pool path, from the save of its
// terminal record to the manager notification, the finish hook, and the daemon's resend.
// Read with docs/design/worker-pool-completion-publication.md.
//
// The three saves on the worker pool path (595d6a826):
//   Unreadable  — BuiltinProjectRuntime.startTask / remote(): failUnreadableGoalTask
//                 (src/infra/task/taskLifecycleService.ts:290-317). Saved without the mark.
//   ClaimFailed — BuiltinProjectRuntime.startTask: claimTask -> buildSetupFailedTaskRecord
//                 (taskLifecycleService.ts:470-481). Saved with the mark.
//   Remote      — RemoteTaskLifecycle.request, finish / fail (src/infra/task/remoteTaskLifecycle.ts:120-156).
//                 Saved without the mark.
//
// DESIGN picks the code after the save:
//   "Current" — 595d6a826. saveCompletion (builtinProjectRuntime.ts:170-175) and
//               remoteTaskLifecycle.ts:163-166 call saveManagerEvent without a try, never clear the
//               mark and never call the finish hook. An exception from saveManagerEvent leaves the
//               runtime: start() rejects, BuiltinWorkerAdapter calls hostFailed and the project
//               host is closed, which aborts the tasks it is running.
//   "Design"  — docs/design/worker-pool-completion-publication.md. Every save writes the mark in
//               the same write. The runtime publishes through publishAndClearPendingMark
//               (src/features/tasks/execute/claimTasks.ts:100-112), catches and warns, and for the
//               two local saves calls runTaskFinishHooksForStates. The remote save calls no hook
//               (outside this design; the document lists it).
//
// The disk can fill and empty at any time (ENOSPC on saveManagerEvent and on the clear), and the
// runtime process can be killed at any time after the save. The daemon resends a marked record
// whenever the disk lets it (watchSource.ts:125 / :157 -> publishPendingGoalTaskCompletions).
module workerPoolCompletionPublication {
  const DESIGN: str

  type Kind = Unreadable | ClaimFailed | Remote
  // Where the runtime is in handling the saved attempt.
  //   Idle       — nothing saved yet.
  //   Saved      — the terminal record is in tasks.yaml; the runtime has not published yet.
  //   Published  — saveManagerEvent returned; the mark may still need clearing.
  //   HookDue    — publication handled (sent, or failed and warned); the hook is next.
  //   Done       — the runtime has returned from this attempt.
  //   Escaped    — an exception left the runtime (Current only); the project host is closed.
  //   Killed     — the runtime process died after the save.
  type Phase = Idle | Saved | Published | HookDue | Done | Escaped | Killed
  type Hook = HookNotCalled | HookCalled | HookLostWarned

  pure val KINDS: Set[Kind] = Set(Unreadable, ClaimFailed, Remote)

  var kind: Kind
  var phase: Phase
  // completion_publication_pending on the saved record
  var mark: bool
  // the manager's inbox has a completion for this attempt (copies are folded by the eventId)
  var delivered: bool
  // the runtime's own saveManagerEvent returned
  var publishedByRuntime: bool
  var notifyWarned: bool
  var clearWarned: bool
  var hook: Hook
  // the disk is full: saveManagerEvent and the clear throw ENOSPC
  var full: bool
  // ghost: the project host was closed by hostFailed, aborting the tasks it was running
  var projectClosed: bool
  var lastAction: str

  pure def marksOnSave(k: Kind): bool = DESIGN == "Design" or k == ClaimFailed
  pure def callsHook(k: Kind): bool = DESIGN == "Design" and k != Remote
  pure def clearsMark: bool = DESIGN == "Design"
  pure def catchesNotification: bool = DESIGN == "Design"

  action init = all {
    kind' = Unreadable, phase' = Idle, mark' = false, delivered' = false,
    publishedByRuntime' = false, notifyWarned' = false, clearWarned' = false,
    hook' = HookNotCalled, full' = false, projectClosed' = false, lastAction' = "init",
  }

  // The terminal record of the attempt is saved. The mark is part of the same write.
  action save(k: Kind): bool = all {
    phase == Idle,
    kind' = k, phase' = Saved, mark' = marksOnSave(k),
    delivered' = delivered, publishedByRuntime' = publishedByRuntime, notifyWarned' = notifyWarned,
    clearWarned' = clearWarned, hook' = hook, full' = full, projectClosed' = projectClosed,
    lastAction' = "save",
  }

  // The runtime's saveManagerEvent succeeds.
  action publish: bool = all {
    phase == Saved, not(full),
    phase' = if (clearsMark and mark) Published else HookDue,
    delivered' = true, publishedByRuntime' = true,
    kind' = kind, mark' = mark, notifyWarned' = notifyWarned, clearWarned' = clearWarned,
    hook' = hook, full' = full, projectClosed' = projectClosed,
    lastAction' = "publish",
  }

  // The runtime's saveManagerEvent throws ENOSPC. Design: caught and warned; the mark stays for the
  // daemon. Current: the exception leaves start() / remote(), hostFailed closes the project.
  action publishFails: bool = all {
    phase == Saved, full,
    phase' = if (catchesNotification) HookDue else Escaped,
    notifyWarned' = catchesNotification,
    projectClosed' = not(catchesNotification),
    kind' = kind, mark' = mark, delivered' = delivered, publishedByRuntime' = publishedByRuntime,
    clearWarned' = clearWarned, hook' = hook, full' = full,
    lastAction' = "publishFails",
  }

  // clearCompletionPublicationPending after the runtime published.
  action clearMark: bool = all {
    phase == Published, not(full),
    phase' = HookDue, mark' = false,
    kind' = kind, delivered' = delivered, publishedByRuntime' = publishedByRuntime,
    notifyWarned' = notifyWarned, clearWarned' = clearWarned, hook' = hook, full' = full,
    projectClosed' = projectClosed,
    lastAction' = "clearMark",
  }

  // The clear throws. publishAndClearPendingMark warns; the daemon clears the mark later.
  action clearFails: bool = all {
    phase == Published, full,
    phase' = HookDue, clearWarned' = true,
    kind' = kind, mark' = mark, delivered' = delivered, publishedByRuntime' = publishedByRuntime,
    notifyWarned' = notifyWarned, hook' = hook, full' = full, projectClosed' = projectClosed,
    lastAction' = "clearFails",
  }

  // runTaskFinishHooksForStates for the local saves. It never throws: the hook runs, or a lost-hook
  // warning names the task (taskFinishHook.ts:281-310). `lost` picks which.
  action finishAttempt(lost: bool): bool = all {
    phase == HookDue,
    phase' = Done,
    hook' = if (not(callsHook(kind))) hook else if (lost) HookLostWarned else HookCalled,
    kind' = kind, mark' = mark, delivered' = delivered, publishedByRuntime' = publishedByRuntime,
    notifyWarned' = notifyWarned, clearWarned' = clearWarned, full' = full, projectClosed' = projectClosed,
    lastAction' = "finishAttempt",
  }

  // The runtime process dies after the save and before it returns.
  action kill: bool = all {
    phase == Saved or phase == Published or phase == HookDue,
    phase' = Killed,
    kind' = kind, mark' = mark, delivered' = delivered, publishedByRuntime' = publishedByRuntime,
    notifyWarned' = notifyWarned, clearWarned' = clearWarned, hook' = hook, full' = full,
    projectClosed' = projectClosed,
    lastAction' = "kill",
  }

  // The daemon reads a marked record, writes the completion to the inbox and clears the mark.
  action daemonResend: bool = all {
    phase != Idle, mark, not(full),
    mark' = false, delivered' = true,
    kind' = kind, phase' = phase, publishedByRuntime' = publishedByRuntime, notifyWarned' = notifyWarned,
    clearWarned' = clearWarned, hook' = hook, full' = full, projectClosed' = projectClosed,
    lastAction' = "daemonResend",
  }

  action diskFills: bool = all {
    not(full), full' = true,
    kind' = kind, phase' = phase, mark' = mark, delivered' = delivered,
    publishedByRuntime' = publishedByRuntime, notifyWarned' = notifyWarned, clearWarned' = clearWarned,
    hook' = hook, projectClosed' = projectClosed,
    lastAction' = "diskFills",
  }

  action diskFrees: bool = all {
    full, full' = false,
    kind' = kind, phase' = phase, mark' = mark, delivered' = delivered,
    publishedByRuntime' = publishedByRuntime, notifyWarned' = notifyWarned, clearWarned' = clearWarned,
    hook' = hook, projectClosed' = projectClosed,
    lastAction' = "diskFrees",
  }

  action step = {
    nondet k = KINDS.oneOf()
    nondet lost = Set(true, false).oneOf()
    any {
      save(k), publish, publishFails, clearMark, clearFails, finishAttempt(lost), kill,
      daemonResend, diskFills, diskFrees,
    }
  }

  // ---------- properties ----------

  // I1. A saved completion reaches the manager, or its mark stays for the daemon's resend.
  val deliveredOrMarked: bool = phase != Idle implies (delivered or mark)

  // I2. A failed manager notification never leaves the runtime: the project host stays open and
  // the tasks it runs are not aborted.
  val notificationFailureStaysInside: bool = not(projectClosed)

  // I3. When the runtime returns from a local save, the finish hook ran or a warning named it.
  val localSaveCallsHook: bool =
    (phase == Done and kind != Remote) implies hook != HookNotCalled

  // I4. After the runtime's own publication, the mark is gone unless clearing it failed and warned.
  val publishedClearsMark: bool =
    (phase == Done and publishedByRuntime and not(clearWarned)) implies not(mark)

  // I5. When the runtime returns without publishing, it said so.
  val unpublishedIsWarned: bool =
    (phase == Done and not(publishedByRuntime)) implies notifyWarned

  val safety: bool = and {
    deliveredOrMarked, notificationFailureStaysInside, localSaveCallsHook, publishedClearsMark,
    unpublishedIsWarned,
  }

  // ---------- witnesses ----------
  val wSaveUnreadable: bool = kind == Unreadable and phase != Idle
  val wSaveClaimFailed: bool = kind == ClaimFailed and phase != Idle
  val wSaveRemote: bool = kind == Remote and phase != Idle
  val wPublish: bool = lastAction == "publish"
  val wPublishFails: bool = lastAction == "publishFails"
  val wClearMark: bool = lastAction == "clearMark"
  val wClearFails: bool = lastAction == "clearFails"
  val wHookCalled: bool = hook == HookCalled
  val wHookLost: bool = hook == HookLostWarned
  val wKill: bool = lastAction == "kill"
  val wResend: bool = lastAction == "daemonResend"
  val wResendAfterKill: bool = phase == Killed and delivered and not(publishedByRuntime)
  val wResendAfterFailure: bool = phase == Done and notifyWarned and delivered
  val wDone: bool = phase == Done
}

module current { import workerPoolCompletionPublication(DESIGN = "Current").* from "./workerPoolCompletionPublication" }
module design { import workerPoolCompletionPublication(DESIGN = "Design").* from "./workerPoolCompletionPublication" }

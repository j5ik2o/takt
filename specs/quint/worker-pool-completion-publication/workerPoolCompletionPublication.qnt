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
//               (src/features/tasks/execute/claimTasks.ts:100-112), catches and warns, and then calls
//               runTaskFinishHooksForStates for every save, the remote one included: the remote
//               child runs executeWorkflowForRun (remoteTaskProcess.ts:75) and never calls the hook,
//               so without the daemon's call nobody would. The hook runs after the runtime has
//               returned its reply, never inside it: a reply that waits for the hook would hold the
//               project host's request past its 30 s timeout (projectHost.ts:72-74) and the daemon's
//               remote tail past the other leases (workerPoolRemoteHookLease.qnt). The runtime's
//               close() waits for the hooks still running.
//
// A remote worker may send its finish again (a retry after a lost reply). The repeated request finds
// the record no longer running (remoteTaskLifecycle.ts:93, :123) and saves nothing, so it must not
// call the hook a second time.
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
  //   HookDue    — publication handled (sent, or failed and warned); the reply is next.
  //   Returned   — the runtime has returned its reply; the hook is scheduled and still to run.
  //   Done       — the hook has run (or was reported lost) after the reply, or close() waited for it.
  //   Escaped    — an exception left the runtime (Current only); the project host is closed.
  //   Killed     — the runtime process died after the save.
  type Phase = Idle | Saved | Published | HookDue | Returned | Done | Escaped | Killed
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
  // how many times the finish hook ran or was reported lost for this attempt
  var hookCalls: int
  // the disk is full: saveManagerEvent and the clear throw ENOSPC
  var full: bool
  // ghost: the project host was closed by hostFailed, aborting the tasks it was running
  var projectClosed: bool
  var lastAction: str

  pure def marksOnSave(k: Kind): bool = DESIGN == "Design" or k == ClaimFailed
  pure def callsHook(k: Kind): bool = DESIGN == "Design"
  // A repeated remote finish saves nothing and calls nothing.
  pure def repeatCallsHook: bool = false
  // close() waits for the hooks scheduled after a reply.
  pure def closeAwaitsHooks: bool = true
  pure def clearsMark: bool = DESIGN == "Design"
  pure def catchesNotification: bool = DESIGN == "Design"

  action init = all {
    kind' = Unreadable, phase' = Idle, mark' = false, delivered' = false,
    publishedByRuntime' = false, notifyWarned' = false, clearWarned' = false,
    hook' = HookNotCalled, hookCalls' = 0, full' = false, projectClosed' = false, lastAction' = "init",
  }

  // The terminal record of the attempt is saved. The mark is part of the same write.
  action save(k: Kind): bool = all {
    phase == Idle,
    kind' = k, phase' = Saved, mark' = marksOnSave(k),
    delivered' = delivered, publishedByRuntime' = publishedByRuntime, notifyWarned' = notifyWarned,
    clearWarned' = clearWarned, hook' = hook, hookCalls' = hookCalls, full' = full, projectClosed' = projectClosed,
    lastAction' = "save",
  }

  // The runtime's saveManagerEvent succeeds.
  action publish: bool = all {
    phase == Saved, not(full),
    phase' = if (clearsMark and mark) Published else HookDue,
    delivered' = true, publishedByRuntime' = true,
    kind' = kind, mark' = mark, notifyWarned' = notifyWarned, clearWarned' = clearWarned,
    hook' = hook, hookCalls' = hookCalls, full' = full, projectClosed' = projectClosed,
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
    clearWarned' = clearWarned, hook' = hook, hookCalls' = hookCalls, full' = full,
    lastAction' = "publishFails",
  }

  // clearCompletionPublicationPending after the runtime published.
  action clearMark: bool = all {
    phase == Published, not(full),
    phase' = HookDue, mark' = false,
    kind' = kind, delivered' = delivered, publishedByRuntime' = publishedByRuntime,
    notifyWarned' = notifyWarned, clearWarned' = clearWarned, hook' = hook, hookCalls' = hookCalls, full' = full,
    projectClosed' = projectClosed,
    lastAction' = "clearMark",
  }

  // The clear throws. publishAndClearPendingMark warns; the daemon clears the mark later.
  action clearFails: bool = all {
    phase == Published, full,
    phase' = HookDue, clearWarned' = true,
    kind' = kind, mark' = mark, delivered' = delivered, publishedByRuntime' = publishedByRuntime,
    notifyWarned' = notifyWarned, hook' = hook, hookCalls' = hookCalls, full' = full, projectClosed' = projectClosed,
    lastAction' = "clearFails",
  }

  // The runtime returns its reply. The hook is scheduled, not awaited.
  action returnReply: bool = all {
    phase == HookDue,
    phase' = Returned,
    kind' = kind, mark' = mark, delivered' = delivered, publishedByRuntime' = publishedByRuntime,
    notifyWarned' = notifyWarned, clearWarned' = clearWarned, hook' = hook, hookCalls' = hookCalls,
    full' = full, projectClosed' = projectClosed,
    lastAction' = "returnReply",
  }

  // The scheduled hook runs: runTaskFinishHooksForStates never throws, the hook runs or a lost-hook
  // warning names the task (taskFinishHook.ts:281-310). `lost` picks which.
  action runScheduledHook(lost: bool): bool = all {
    phase == Returned,
    phase' = Done,
    hook' = if (not(callsHook(kind))) hook else if (lost) HookLostWarned else HookCalled,
    hookCalls' = if (callsHook(kind)) hookCalls + 1 else hookCalls,
    kind' = kind, mark' = mark, delivered' = delivered, publishedByRuntime' = publishedByRuntime,
    notifyWarned' = notifyWarned, clearWarned' = clearWarned, full' = full, projectClosed' = projectClosed,
    lastAction' = "runScheduledHook",
  }

  // The runtime closes while the hook is still scheduled. close() waits for it, so it runs.
  action closeRuntime: bool = all {
    phase == Returned,
    phase' = Done,
    hook' = if (callsHook(kind) and closeAwaitsHooks) HookCalled else hook,
    hookCalls' = if (callsHook(kind) and closeAwaitsHooks) hookCalls + 1 else hookCalls,
    kind' = kind, mark' = mark, delivered' = delivered, publishedByRuntime' = publishedByRuntime,
    notifyWarned' = notifyWarned, clearWarned' = clearWarned, full' = full, projectClosed' = projectClosed,
    lastAction' = "closeRuntime",
  }

  // The runtime process dies after the save and before it returns.
  action kill: bool = all {
    phase == Saved or phase == Published or phase == HookDue or phase == Returned,
    phase' = Killed,
    kind' = kind, mark' = mark, delivered' = delivered, publishedByRuntime' = publishedByRuntime,
    notifyWarned' = notifyWarned, clearWarned' = clearWarned, hook' = hook, hookCalls' = hookCalls, full' = full,
    projectClosed' = projectClosed,
    lastAction' = "kill",
  }

  // The remote worker sends its finish again after the attempt is done. The record is no longer
  // running, so nothing is saved or published.
  action repeatRemoteFinish: bool = all {
    (phase == Done or phase == Returned), kind == Remote,
    hookCalls' = if (repeatCallsHook) hookCalls + 1 else hookCalls,
    kind' = kind, phase' = phase, mark' = mark, delivered' = delivered,
    publishedByRuntime' = publishedByRuntime, notifyWarned' = notifyWarned, clearWarned' = clearWarned,
    hook' = hook, full' = full, projectClosed' = projectClosed,
    lastAction' = "repeatRemoteFinish",
  }

  // The daemon reads a marked record, writes the completion to the inbox and clears the mark.
  action daemonResend: bool = all {
    phase != Idle, mark, not(full),
    mark' = false, delivered' = true,
    kind' = kind, phase' = phase, publishedByRuntime' = publishedByRuntime, notifyWarned' = notifyWarned,
    clearWarned' = clearWarned, hook' = hook, hookCalls' = hookCalls, full' = full, projectClosed' = projectClosed,
    lastAction' = "daemonResend",
  }

  action diskFills: bool = all {
    not(full), full' = true,
    kind' = kind, phase' = phase, mark' = mark, delivered' = delivered,
    publishedByRuntime' = publishedByRuntime, notifyWarned' = notifyWarned, clearWarned' = clearWarned,
    hook' = hook, hookCalls' = hookCalls, projectClosed' = projectClosed,
    lastAction' = "diskFills",
  }

  action diskFrees: bool = all {
    full, full' = false,
    kind' = kind, phase' = phase, mark' = mark, delivered' = delivered,
    publishedByRuntime' = publishedByRuntime, notifyWarned' = notifyWarned, clearWarned' = clearWarned,
    hook' = hook, hookCalls' = hookCalls, projectClosed' = projectClosed,
    lastAction' = "diskFrees",
  }

  action step = {
    nondet k = KINDS.oneOf()
    nondet lost = Set(true, false).oneOf()
    any {
      save(k), publish, publishFails, clearMark, clearFails, returnReply, runScheduledHook(lost),
      closeRuntime, kill,
      repeatRemoteFinish, daemonResend, diskFills, diskFrees,
    }
  }

  // ---------- properties ----------

  // I1. A saved completion reaches the manager, or its mark stays for the daemon's resend.
  val deliveredOrMarked: bool = phase != Idle implies (delivered or mark)

  // I2. A failed manager notification never leaves the runtime: the project host stays open and
  // the tasks it runs are not aborted.
  val notificationFailureStaysInside: bool = not(projectClosed)

  // I3. Once the attempt is done (the scheduled hook ran, or close() waited for it), the finish hook
  // ran or a warning named it, for local and remote saves alike. The reply itself comes first.
  val localSaveCallsHook: bool =
    phase == Done implies hook != HookNotCalled

  // I6. The finish hook runs at most once for an attempt, a repeated remote finish included.
  val hookAtMostOnce: bool = hookCalls <= 1

  // I4. After the runtime's own publication, the mark is gone unless clearing it failed and warned.
  val publishedClearsMark: bool =
    (phase == Done and publishedByRuntime and not(clearWarned)) implies not(mark)

  // I5. When the runtime returns without publishing, it said so.
  val unpublishedIsWarned: bool =
    (phase == Done and not(publishedByRuntime)) implies notifyWarned

  val safety: bool = and {
    deliveredOrMarked, notificationFailureStaysInside, localSaveCallsHook, publishedClearsMark,
    unpublishedIsWarned, hookAtMostOnce,
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
  val wReturned: bool = phase == Returned
  val wClosedWithHook: bool = lastAction == "closeRuntime" and hook == HookCalled
  val wRemoteHook: bool = kind == Remote and hook == HookCalled
  val wRepeatRemoteFinish: bool = lastAction == "repeatRemoteFinish"
}

module current { import workerPoolCompletionPublication(DESIGN = "Current").* from "./workerPoolCompletionPublication" }
module design { import workerPoolCompletionPublication(DESIGN = "Design").* from "./workerPoolCompletionPublication" }

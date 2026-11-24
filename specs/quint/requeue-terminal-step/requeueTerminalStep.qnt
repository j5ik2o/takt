// -*- mode: Bluespec; -*-
// Requeue of a failed task whose saved resume position is a step that only
// reports the failure and then aborts (issue j5ik2o/takt#117).
//
// Source of the model:
//   src/features/tasks/list/taskRetryStartSelection.ts  (default start = saved resume position)
//   src/features/mcp/goalTaskRetryOperations.ts         (resolveStart: omitted startStep takes the default)
//   builtins/*/workflows/merge-review.yaml              (work -> notify_failed -> ABORT shape)
//
// The workflow is reduced to the shape that matters:
//   Work   --ok-->   COMPLETE
//   Work   --fail--> Notify      (Notify only comments the failure)
//   Notify --any-->  ABORT
// `guardAbortOnly` selects the behaviour: false = code before the fix, true = after.
module requeueTerminalStep {
  type Step = Work | Notify
  type Status = Pending | Running | Failed | Completed
  type Start = SavedPosition | Explicit(Step)
  type Cause = NoCause | WorkFailed

  const guardAbortOnly: bool

  var status: Status
  var current: Step
  var savedPosition: Step
  var cause: Cause
  // Bookkeeping for the property: how the running attempt was started, and
  // whether it has executed a step that can change the outcome.
  var startedBy: Start
  var didWork: bool
  var refusals: int

  /// Every outcome of the step is ABORT.
  pure def onlyAborts(step: Step): bool = step == Notify

  action init = all {
    status' = Running,
    current' = Work,
    savedPosition' = Work,
    cause' = NoCause,
    startedBy' = Explicit(Work),
    didWork' = false,
    refusals' = 0,
  }

  action workSucceeds = all {
    status == Running, current == Work,
    status' = Completed,
    didWork' = true,
    current' = current, savedPosition' = savedPosition, cause' = cause,
    startedBy' = startedBy, refusals' = refusals,
  }

  action workFails = all {
    status == Running, current == Work,
    current' = Notify,
    savedPosition' = Notify,
    cause' = WorkFailed,
    didWork' = true,
    status' = status, startedBy' = startedBy, refusals' = refusals,
  }

  /// The notification step runs and aborts the workflow. The saved resume
  /// position stays on the notification step.
  action notifyAborts = all {
    status == Running, current == Notify,
    status' = Failed,
    current' = current, savedPosition' = savedPosition, cause' = cause,
    startedBy' = startedBy, didWork' = didWork, refusals' = refusals,
  }

  /// Requeue without a start position: resume from the saved position.
  action requeueDefault = all {
    status == Failed,
    if (guardAbortOnly and onlyAborts(savedPosition)) all {
      // Refused before anything is written: the task stays failed as it was.
      refusals' = refusals + 1,
      status' = status, current' = current, savedPosition' = savedPosition,
      cause' = cause, startedBy' = startedBy, didWork' = didWork,
    } else all {
      status' = Running,
      current' = savedPosition,
      startedBy' = SavedPosition,
      didWork' = false,
      savedPosition' = savedPosition, cause' = cause, refusals' = refusals,
    }
  }

  /// Requeue with an explicit restart position. Only steps that can be
  /// restarted are accepted; the notification step is not one of them
  /// (isWorkflowRestartTarget rejects system steps with effects).
  action requeueExplicit = all {
    status == Failed,
    status' = Running,
    current' = Work,
    startedBy' = Explicit(Work),
    didWork' = false,
    savedPosition' = Work,
    cause' = cause, refusals' = refusals,
  }

  action step = any {
    workSucceeds, workFails, notifyAborts, requeueDefault, requeueExplicit,
  }

  /// A requeue that named no start position must not end in an abort that
  /// executed nothing but the failure notification.
  val noBlindAbort = not(
    status == Failed and startedBy == SavedPosition and not(didWork)
  )
}

module current {
  import requeueTerminalStep(guardAbortOnly = false).*
}

module fixed {
  import requeueTerminalStep(guardAbortOnly = true).*
}

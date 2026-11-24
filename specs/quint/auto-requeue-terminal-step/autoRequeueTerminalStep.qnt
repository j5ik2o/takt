// -*- mode: Bluespec; -*-
// Automatic requeue of a failed task whose failed step only reports the
// failure and then aborts (issue j5ik2o/takt#127).
//
// Source of the model:
//   src/infra/task/taskRetryService.ts                  (autoRequeueFailedTask: start = failure.step)
//   src/features/tasks/execute/taskResultHandler.ts     (failure.step = last executed step)
//   src/features/tasks/execute/parallelExecution.ts     (attemptAutoRequeueTask)
//
// The workflow is reduced to the shape that matters:
//   Work   --ok-->    COMPLETE
//   Work   --fail-->  Notify      (Notify only reports the failure)
//   Work   --error--> (task fails at Work; a retry can change the outcome)
//   Notify --any-->   ABORT
// `guardAbortOnly` selects the behaviour: false = code before the fix, true = after.
module autoRequeueTerminalStep {
  type Step = Work | Notify
  type Status = Running | Failed | Completed
  type Start = FirstRun | AutoRequeue

  const guardAbortOnly: bool
  const maxAttempts: int

  var status: Status
  var current: Step
  // failure.step of the task record: the last step that ran.
  var failedStep: Step
  var autoRequeueCount: int
  // Bookkeeping for the property: how the running attempt was started, and
  // whether it has executed a step that can change the outcome.
  var startedBy: Start
  var didWork: bool
  var skips: int

  /// Every outcome of the step is ABORT.
  pure def onlyAborts(step: Step): bool = step == Notify

  action init = all {
    status' = Running,
    current' = Work,
    failedStep' = Work,
    autoRequeueCount' = 0,
    startedBy' = FirstRun,
    didWork' = false,
    skips' = 0,
  }

  action workSucceeds = all {
    status == Running, current == Work,
    status' = Completed,
    didWork' = true,
    current' = current, failedStep' = failedStep, autoRequeueCount' = autoRequeueCount,
    startedBy' = startedBy, skips' = skips,
  }

  /// Work routes to the notification step.
  action workFails = all {
    status == Running, current == Work,
    current' = Notify,
    didWork' = true,
    status' = status, failedStep' = failedStep, autoRequeueCount' = autoRequeueCount,
    startedBy' = startedBy, skips' = skips,
  }

  /// Work itself ends the run (provider error and the like): the task fails at Work.
  action workErrors = all {
    status == Running, current == Work,
    status' = Failed,
    failedStep' = Work,
    didWork' = true,
    current' = current, autoRequeueCount' = autoRequeueCount,
    startedBy' = startedBy, skips' = skips,
  }

  /// The notification step runs and aborts the workflow. failure.step is the
  /// notification step.
  action notifyAborts = all {
    status == Running, current == Notify,
    status' = Failed,
    failedStep' = Notify,
    current' = current, autoRequeueCount' = autoRequeueCount,
    startedBy' = startedBy, didWork' = didWork, skips' = skips,
  }

  /// Automatic requeue: restart from failure.step while attempts remain.
  action autoRequeue = all {
    status == Failed,
    autoRequeueCount < maxAttempts,
    if (guardAbortOnly and onlyAborts(failedStep)) all {
      // Skipped before anything is written: the task stays failed as it was.
      skips' = skips + 1,
      status' = status, current' = current, failedStep' = failedStep,
      autoRequeueCount' = autoRequeueCount, startedBy' = startedBy, didWork' = didWork,
    } else all {
      status' = Running,
      current' = failedStep,
      autoRequeueCount' = autoRequeueCount + 1,
      startedBy' = AutoRequeue,
      didWork' = false,
      failedStep' = failedStep, skips' = skips,
    }
  }

  action step = any {
    workSucceeds, workFails, workErrors, notifyAborts, autoRequeue,
  }

  /// An automatic requeue must not end in an abort that executed nothing but
  /// the failure notification.
  val noBlindAbort = not(
    status == Failed and startedBy == AutoRequeue and not(didWork)
  )

  /// The attempt counter never passes the configured limit.
  val attemptsBounded = autoRequeueCount <= maxAttempts
}

module current {
  import autoRequeueTerminalStep(guardAbortOnly = false, maxAttempts = 3).*
}

module fixed {
  import autoRequeueTerminalStep(guardAbortOnly = true, maxAttempts = 3).*
}

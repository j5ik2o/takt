// -*- mode: Bluespec; -*-
// Task claim, goal setup failure, and goal-abort invalidation (upstream/main merge, 2026-11-28).
//
// Code:
//   src/infra/task/taskLifecycleService.ts          claimNextTasks / claimTask / claimPendingTasks /
//                                                   buildSetupFailedTaskRecord / warnLockReleaseAfterWrite /
//                                                   invalidatePendingGoalTasks
//   src/features/tasks/execute/claimTasks.ts        claimTasksWithGoalCompletions
//   src/features/tasks/execute/parallelExecution.ts claim retry (CLAIM_RETRY_INTERVAL_MS)
//   src/features/tasks/execute/runAllTasks.ts       retryStartupLockTimeout
//
// The merge of upstream/main into integration/takt-mcp put two behaviours on one claim path:
//   - upstream (#2073, the cloud agent): a claim never takes a task that carries a remote
//     assignment; a single-task claim selects one task by name; a claim that saves a goal task as
//     failed returns that failed task to the caller; an aborted goal releases the retry
//     reservation of a remotely assigned task instead of leaving it reserved.
//   - the fork (#170): a goal task rejected by the setup guard is saved as failed and then
//     reported to onSetupFailed after the write; a lock release failure after the write warns
//     instead of losing the claim; a claim whose lock times out before anything is written is
//     retried, and one that times out after the write started is not.
//
// Both are modelled together. This file decides nothing: the merge keeps a provisional
// integration so the build and the tests run, and this model is the input to the design review.
//
// DESIGN picks the claim path:
//   "Fork"     — integration/takt-mcp at 6c18a0dea: claimNextTasks(count, goalSetupGuard,
//                onSetupFailed), no remote assignment rule, no single-task selection.
//   "Upstream" — nrslib/takt main at a1794751a: claimNextTasks(count, goalSetupFailure) and
//                claimTask(name, worker) over one claimPendingTasks, the remote assignment rule,
//                and invalidatePendingGoalTasks releasing the retry reservation.
//   "Merged"   — the provisional integration of this branch: both sets of rules on one path.
module taskClaim {
  const DESIGN: str
  pure val UPSTREAM: bool = DESIGN == "Upstream" or DESIGN == "Merged"

  type Kind = Local | Remote
  type Saved = Pending | Claimed | Failed | Running
  type Task = { kind: Kind, saved: Saved, goal: bool, retryReserved: bool }

  // The tasks.yaml lock: Free, Held (inside the write callback), Written (the update returned),
  // Released (the release returned), Lost (the release threw; the next acquisition removes it).
  type Lock = Free | Held | Written | Released | Lost
  type Outcome = Ok | ClaimError | RetryTimeout | ReleaseWarning
  // A claim is for any pending task or for one named task (the upstream claimTask).
  type Mode = ClaimNext | ClaimOne

  var tasks: List[Task]
  var lock: Lock
  var selection: int
  var setupFailurePending: Set[int]
  var setupReported: Set[int]
  var outcome: Outcome
  var writeStarted: bool
  var goalAborted: bool
  // Whether the claim's lock acquisition times out. Fixed by init, so a scenario can pin it.
  var timesOut: bool
  // Which step produced the current state, for the scenario tests.
  var lastStep: str

  // The two tasks the model covers: task 0 is a local goal task, task 1 a remote assignment
  // (a goal task that a remote worker holds). `goalBlocked` applies to goal tasks only.
  pure val LOCAL: int = 0
  pure val REMOTE: int = 1

  def accepted(i: int): bool =
    i.in(tasks.indices())
    and tasks[i].saved == Pending
    and not(UPSTREAM and tasks[i].kind == Remote)
    and (selection == -1 or selection == i)
  def goalBlocked(i: int): bool = goalAborted and tasks[i].goal

  action init = all {
    tasks' = List({ kind: Local, saved: Pending, goal: true, retryReserved: false },
                  { kind: Remote, saved: Pending, goal: false, retryReserved: true }),
    lock' = Free,
    selection' = -1,
    setupFailurePending' = Set(),
    setupReported' = Set(),
    outcome' = Ok,
    writeStarted' = false,
    goalAborted' = false,
    timesOut' = false,
    lastStep' = "init",
  }

  // Take the goal-execution lock and the tasks.yaml lock. A timeout here is before the write.
  action lockClaim = all {
    lastStep' = "lockClaim",
    lock == Free,
    timesOut,
    lock' = Free, outcome' = RetryTimeout, writeStarted' = false,
    tasks' = tasks, selection' = selection, setupFailurePending' = setupFailurePending,
    setupReported' = setupReported, goalAborted' = goalAborted, timesOut' = timesOut,
  }

  action lockClaimOk = all {
    lastStep' = "lockClaimOk",
    lock == Free and not(timesOut),
    lock' = Held, outcome' = Ok, writeStarted' = false,
    tasks' = tasks, selection' = selection, setupFailurePending' = setupFailurePending,
    setupReported' = setupReported, goalAborted' = goalAborted, timesOut' = timesOut,
  }

  // The write callback runs: the write has started, so a later timeout is no longer retryable.
  action beginWrite = all {
    lastStep' = "beginWrite",
    lock == Held,
    writeStarted' = true,
    lock' = Held, tasks' = tasks, selection' = selection, setupFailurePending' = setupFailurePending,
    setupReported' = setupReported, outcome' = Ok, goalAborted' = goalAborted, timesOut' = timesOut,
  }

  // Claim one accepted task that is not blocked by its goal.
  action claimTask = all {
    lastStep' = "claimTask",
    lock == Held,
    accepted(LOCAL) and not(goalBlocked(LOCAL)),
    tasks' = tasks.replaceAt(LOCAL, { ...tasks[LOCAL], saved: Claimed }),
    lock' = Held, selection' = selection, setupFailurePending' = setupFailurePending,
    setupReported' = setupReported, outcome' = Ok, writeStarted' = true, goalAborted' = goalAborted, timesOut' = timesOut,
  }

  // Save a goal task the setup guard rejects as failed and remember to report it after the write.
  action saveSetupFailure = all {
    lastStep' = "saveSetupFailure",
    lock == Held,
    accepted(LOCAL) and not(goalBlocked(LOCAL)),
    tasks' = tasks.replaceAt(LOCAL, { ...tasks[LOCAL], saved: Failed }),
    setupFailurePending' = setupFailurePending.union(Set(LOCAL)),
    lock' = Held, selection' = selection, setupReported' = setupReported,
    outcome' = Ok, writeStarted' = true, goalAborted' = goalAborted, timesOut' = timesOut,
  }

  // The update returns: the write is saved.
  action markWritten = all {
    lastStep' = "markWritten",
    lock == Held and writeStarted,
    lock' = Written,
    tasks' = tasks, selection' = selection, setupFailurePending' = setupFailurePending,
    setupReported' = setupReported, outcome' = Ok, writeStarted' = true, goalAborted' = goalAborted, timesOut' = timesOut,
  }

  // Release the lock. A failure here only warns: the claim is already saved.
  action release = all {
    lastStep' = "release",
    lock == Written,
    nondet releaseFails = Set(false, true).oneOf()
    all {
      lock' = if (releaseFails) Lost else Released,
      outcome' = if (releaseFails) ReleaseWarning else Ok,
    },
    tasks' = tasks, selection' = selection, setupFailurePending' = setupFailurePending,
    setupReported' = setupReported, writeStarted' = true, goalAborted' = goalAborted, timesOut' = timesOut,
  }

  // Report one saved setup failure after the write. A report that throws is warned and dropped.
  action reportSetupFailure = all {
    lastStep' = "reportSetupFailure",
    lock != Held,
    setupFailurePending.size() > 0,
    nondet reported = setupFailurePending.oneOf()
    all {
      setupReported' = setupReported.union(Set(reported)),
      setupFailurePending' = setupFailurePending.exclude(Set(reported)),
    },
    tasks' = tasks, lock' = lock, selection' = selection,
    outcome' = outcome, writeStarted' = writeStarted, goalAborted' = goalAborted, timesOut' = timesOut,
  }

  // Abort the goal: pending tasks fail, a remotely assigned task that is not running has its
  // retry reservation released (upstream); the fork's callback still receives every invalidated task.
  // The first invalidation of a goal releases the reservation of its remote task (upstream); a
  // second one still finds the task the first one saved as failed.
  action abortGoal = all {
    // `alreadyAborted` records whether this is the first invalidation: a second one finds the
    // remote task the first one saved as failed, and releases its reservation too.
    nondet alreadyAborted = Set(goalAborted, not(goalAborted)).oneOf()
    all {
    lastStep' = "abortGoal",
    lock == Free,
    goalAborted' = goalAborted or not(alreadyAborted),
    tasks' = tasks.indices().map(i =>
      if (UPSTREAM and tasks[i].kind == Remote and tasks[i].saved != Running) {
        if (tasks[i].saved == Pending) { ...tasks[i], saved: Failed, retryReserved: false }
        else { ...tasks[i], retryReserved: false }
      }
      else if (tasks[i].kind == Remote) { ...tasks[i], retryReserved: true }
      else if (tasks[i].goal and tasks[i].saved == Pending) { ...tasks[i], saved: Failed }
      else tasks[i]).fold(List(), (acc, t) => acc.append(t)),
    lock' = Free, selection' = selection, setupFailurePending' = setupFailurePending,
    setupReported' = setupReported, outcome' = Ok, writeStarted' = false, timesOut' = timesOut,
    }
  }

  // A single-task claim names one task before the lock is taken.
  action selectOne = all {
    lastStep' = "selectOne",
    lock == Free and selection == -1,
    nondet i = tasks.indices().oneOf()
    all {
      selection' = i, lock' = lock, tasks' = tasks, setupFailurePending' = setupFailurePending,
      setupReported' = setupReported, outcome' = Ok, writeStarted' = writeStarted,
      goalAborted' = goalAborted, timesOut' = timesOut,
    },
  }

  // A lost release leaves the lock file behind; the next acquisition removes it (#169).
  action removeOrphanLock = all {
    lastStep' = "removeOrphanLock",
    lock == Lost,
    lock' = Free,
    tasks' = tasks, selection' = selection, setupFailurePending' = setupFailurePending,
    setupReported' = setupReported, outcome' = Ok, writeStarted' = writeStarted,
    goalAborted' = goalAborted, timesOut' = timesOut,
  }

  action step = any {
    selectOne,
    lockClaim,
    lockClaimOk,
    beginWrite,
    claimTask,
    saveSetupFailure,
    markWritten,
    release,
    reportSetupFailure,
    abortGoal,
    removeOrphanLock,
  }

  run main = init.then(10.reps(_ => step))

  // ---------------------------------------------------------------- properties

  // A setup failure is reported only after the write has finished (the lock is no longer Held),
  // and the same failure is never reported twice.
  val reportsOnlyAfterWriteOneEach: bool =
    setupReported.size() <= 1
    and (setupReported.size() > 0 implies lock != Held or lastStep != "reportSetupFailure")
    and setupReported.intersect(setupFailurePending) == Set()

  // A claim that completed its write keeps its tasks: a release failure is warned, not returned.
  val keepsClaimOnReleaseFailure: bool =
    outcome == ReleaseWarning implies lock == Lost

  // Only a lock timeout before anything was written is retryable.
  val retriesOnlyBeforeWrite: bool =
    outcome == RetryTimeout implies not(writeStarted)

  // An aborted goal leaves no remotely assigned task outside a run with its retry reservation held.
  val abortedGoalReleasesReservation: bool =
    goalAborted implies tasks.indices().forall(i =>
      tasks[i].kind != Remote or tasks[i].saved == Running or not(tasks[i].retryReserved))

  // No claim error is raised once the write has started.
  val noClaimErrorAfterWrite: bool =
    outcome == ClaimError implies not(writeStarted)

  // An invariant set for the review: all five together.
  val claimSafety: bool =
    reportsOnlyAfterWriteOneEach and keepsClaimOnReleaseFailure and retriesOnlyBeforeWrite
    and abortedGoalReleasesReservation and noClaimErrorAfterWrite
}

module fork { import taskClaim(DESIGN = "Fork").* from "./taskClaim" }
module upstream { import taskClaim(DESIGN = "Upstream").* from "./taskClaim" }
module merged { import taskClaim(DESIGN = "Merged").* from "./taskClaim" }

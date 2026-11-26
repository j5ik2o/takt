// -*- mode: Bluespec; -*-
// Claiming goal tasks from tasks.yaml, and reporting the goal tasks that the claim saved as failed
// (setup failures). Two processes share one tasks.yaml.
//
// Code:
//   src/features/tasks/execute/claimTasks.ts       claimTasksWithGoalCompletions
//   src/infra/task/taskLifecycleService.ts         TaskLifecycleService.claimNextTasks
//   src/features/tasks/execute/parallelExecution.ts claimPreparedTasks / claimAvailableTasks
//
// DESIGN picks the implementation:
//   "Merged" — d2bd16a30: snapshot, claim, then a second read of tasks.yaml (afterClaim) in the same
//              try as the claim; setup failures are found by comparing the two reads.
//   "ForkP1" — 337062193 (PR #50): the claim reports its own setup failures through onSetupFailed,
//              inside the same call that saved them; no second read. A failed manager-event write in
//              the callback escapes the claim.
//   "Fixed"  — ForkP1, plus: nothing thrown in the callback escapes the claim (the callback catches a
//              failed manager-event write and warns; claimNextTasks catches anything else per call
//              and warns); a goal-execution.lock timeout before the write is a retryable claim
//              failure.
//
// POST_WRITE adds an exception thrown after the tasks.yaml write and before claimNextTasks returns
// (a lock release that fails). "None": no such exception (the main instances). "Stops": it is an
// unclassified error, so claiming stops (the code after this fix; the claim itself is the separate
// issue). "Retried": it is wrongly classified as a retryable claim failure (what a timeout
// conversion around the write would do).
module goalTaskClaim {
  const DESIGN: str
  const POST_WRITE: str

  type Proc = str
  type TaskId = str

  type Status = Absent | Pending | Running | Failed | Done
  type TaskRec = { status: Status, owner: Proc }

  // Idle: waiting for the next poll tick. Snapped: the first listTaskStateItems() has returned.
  // AwaitReread: (Merged only) claimNextTasks() has returned, afterClaim is not read yet.
  // Stopped: preparationFailure is set; this process never claims again.
  // Ended: `takt run` left the worker pool loop as a normal end (no active task, empty queue, no
  // claim retry waiting) and reports its success/fail counts.
  type Phase = Idle | Snapped | AwaitReread | Stopped | Ended

  type Local = {
    phase: Phase,
    snapPending: Set[TaskId],  // pending goal tasks in the first read (Merged uses it)
    inFlight: Set[TaskId],     // claimed (saved as running) but not yet in the queue
    queue: Set[TaskId],
    retrying: bool,            // claimRetryAt is set
    attempted: bool,           // the last claim attempt completed (claimAvailableTasks returned)
  }

  // A claim fails before it writes anything: a tasks.yaml.lock timeout or ENOSPC while pending
  // tasks exist (both classified as retryable today), or a goal-execution.lock timeout.
  type LockFailure = TasksLockTransient | GoalLockTimeout

  pure val NONE: Proc = ""
  pure val PROCS: Set[Proc] = Set("A", "B")
  pure val TASKS: Set[TaskId] = Set("t1", "t2", "t3")
  // Goal tasks whose runtime_assignment cannot be selected: the claim saves them as failed.
  pure val SETUP_BROKEN: Set[TaskId] = Set("t2", "t3")
  // t3 is added while the processes run (the 2b race needs a task missing from the first read).
  pure val ADDED_LATER: Set[TaskId] = Set("t3")

  var tasks: TaskId -> TaskRec
  var procs: Proc -> Local
  var hooks: TaskId -> int           // entries in setupFailedTaskNames (finish hook + failCount)
  var events: TaskId -> int          // manager completion events written
  var publishLogged: TaskId -> int   // manager completion writes that failed and were logged (Fixed)
  var setupFailedBy: TaskId -> Proc  // ghost: which process's claim saved the setup failure
  var lastAction: str

  // ---------- functional layer ----------

  pure def pendingIn(ts: TaskId -> TaskRec): Set[TaskId] =
    ts.keys().filter(t => ts.get(t).status == Pending)

  pure def applyClaim(ts: TaskId -> TaskRec, p: Proc): TaskId -> TaskRec =
    ts.keys().mapBy(t =>
      if (ts.get(t).status != Pending) ts.get(t)
      else if (SETUP_BROKEN.contains(t)) { status: Failed, owner: NONE }
      else { status: Running, owner: p })

  pure def inc(m: TaskId -> int, s: Set[TaskId]): TaskId -> int =
    m.keys().mapBy(t => if (s.contains(t)) m.get(t) + 1 else m.get(t))

  pure def claimFailurePhase(kind: LockFailure): Phase =
    match kind {
      | TasksLockTransient => Idle
      | GoalLockTimeout => if (DESIGN == "Fixed") Idle else Stopped
    }

  // ---------- state machine ----------

  action init = all {
    tasks' = TASKS.mapBy(t => { status: if (ADDED_LATER.contains(t)) Absent else Pending, owner: NONE }),
    procs' = PROCS.mapBy(_ => { phase: Idle, snapPending: Set(), inFlight: Set(), queue: Set(), retrying: false, attempted: false }),
    hooks' = TASKS.mapBy(_ => 0),
    events' = TASKS.mapBy(_ => 0),
    publishLogged' = TASKS.mapBy(_ => 0),
    setupFailedBy' = TASKS.mapBy(_ => NONE),
    lastAction' = "init",
  }

  action addTask(t: TaskId): bool = all {
    tasks.get(t).status == Absent,
    tasks' = tasks.set(t, { status: Pending, owner: NONE }),
    procs' = procs, hooks' = hooks, events' = events, publishLogged' = publishLogged,
    setupFailedBy' = setupFailedBy, lastAction' = "addTask",
  }

  // First listTaskStateItems(). A failed read writes nothing and is retried: no state change.
  action snapshot(p: Proc): bool = all {
    procs.get(p).phase == Idle,
    procs' = procs.setBy(p, l => { ...l, phase: Snapped, snapPending: pendingIn(tasks), attempted: false }),
    tasks' = tasks, hooks' = hooks, events' = events, publishLogged' = publishLogged,
    setupFailedBy' = setupFailedBy, lastAction' = "snapshot",
  }

  // claimNextTasks() fails before writing tasks.yaml.
  action claimFails(p: Proc, kind: LockFailure): bool = all {
    procs.get(p).phase == Snapped,
    procs' = procs.setBy(p, l => { ...l, phase: claimFailurePhase(kind), retrying: true }),
    tasks' = tasks, hooks' = hooks, events' = events, publishLogged' = publishLogged,
    setupFailedBy' = setupFailedBy,
    lastAction' = match kind { | TasksLockTransient => "claimFailsTransient" | GoalLockTimeout => "claimFailsGoalLock" },
  }

  // claimNextTasks() saves the claim in one tasks.yaml write under both locks. `callbackFails`:
  // something in onSetupFailed throws for the setup failures of this claim — the manager completion
  // write (saveManagerEvent), or anything after the name is recorded (warn() on a closed stdout).
  action claimSaved(p: Proc, callbackFails: bool): bool = {
    val pend = pendingIn(tasks)
    val claimed = pend.exclude(SETUP_BROKEN)
    val failed = pend.intersect(SETUP_BROKEN)
    val publishThrows = callbackFails and failed != Set()
    all {
      procs.get(p).phase == Snapped,
      tasks' = applyClaim(tasks, p),
      setupFailedBy' = setupFailedBy.keys().mapBy(t => if (failed.contains(t)) p else setupFailedBy.get(t)),
      if (DESIGN == "Merged") all {
        // The claim returns; the second read has not happened yet.
        procs' = procs.setBy(p, l => { ...l, phase: AwaitReread, inFlight: claimed }),
        hooks' = hooks, events' = events, publishLogged' = publishLogged,
        lastAction' = "claimSaved",
      } else if (DESIGN == "ForkP1" and publishThrows) all {
        // The callback's error escapes claimNextTasks after the write: the claimed tasks are never
        // returned, and the raw error becomes a preparationFailure.
        procs' = procs.setBy(p, l => { ...l, phase: Stopped }),
        hooks' = hooks, events' = events, publishLogged' = publishLogged,
        lastAction' = "claimSavedPublishEscaped",
      } else all {
        // onSetupFailed: record the name (finish hook) first, then write the event. A throw is
        // caught (in the callback, or at the per-call boundary in claimNextTasks) and warned.
        procs' = procs.setBy(p, l => { ...l, phase: Idle, queue: l.queue.union(claimed), retrying: false, attempted: true }),
        hooks' = inc(hooks, failed),
        events' = if (publishThrows) events else inc(events, failed),
        publishLogged' = if (publishThrows) inc(publishLogged, failed) else publishLogged,
        lastAction' = if (publishThrows) "claimSavedPublishLogged" else "claimSaved",
      },
    }
  }

  // The tasks.yaml write succeeds, then an exception leaves claimNextTasks before it returns or
  // calls onSetupFailed (POST_WRITE).
  action claimSavedThenThrows(p: Proc): bool = {
    val failed = pendingIn(tasks).intersect(SETUP_BROKEN)
    all {
      POST_WRITE != "None",
      procs.get(p).phase == Snapped,
      tasks' = applyClaim(tasks, p),
      setupFailedBy' = setupFailedBy.keys().mapBy(t => if (failed.contains(t)) p else setupFailedBy.get(t)),
      procs' = procs.setBy(p, l =>
        if (POST_WRITE == "Retried") { ...l, phase: Idle, retrying: true } else { ...l, phase: Stopped }),
      hooks' = hooks, events' = events, publishLogged' = publishLogged,
      lastAction' = "claimSavedThenThrows",
    }
  }

  // Merged: afterClaim = listTaskStateItems() succeeds; a pending-at-first-read goal task that is
  // now failed is reported, whoever saved it.
  action rereadOk(p: Proc): bool = {
    val l = procs.get(p)
    val reported = l.snapPending.filter(t => tasks.get(t).status == Failed)
    all {
      DESIGN == "Merged",
      l.phase == AwaitReread,
      procs' = procs.set(p, { ...l, phase: Idle, queue: l.queue.union(l.inFlight), inFlight: Set(), retrying: false, attempted: true }),
      hooks' = inc(hooks, reported),
      events' = inc(events, reported),
      tasks' = tasks, publishLogged' = publishLogged, setupFailedBy' = setupFailedBy,
      lastAction' = "rereadOk",
    }
  }

  // Merged: afterClaim times out (or ENOSPC). The catch classifies it as retryable and the claimed
  // tasks are dropped.
  action rereadFails(p: Proc): bool = all {
    DESIGN == "Merged",
    procs.get(p).phase == AwaitReread,
    procs' = procs.setBy(p, l => { ...l, phase: Idle, inFlight: Set(), retrying: true }),
    tasks' = tasks, hooks' = hooks, events' = events, publishLogged' = publishLogged,
    setupFailedBy' = setupFailedBy, lastAction' = "rereadFails",
  }

  action runTask(p: Proc, t: TaskId): bool = all {
    procs.get(p).queue.contains(t),
    tasks' = tasks.set(t, { status: Done, owner: NONE }),
    procs' = procs.setBy(p, l => { ...l, queue: l.queue.exclude(Set(t)) }),
    hooks' = hooks, events' = events, publishLogged' = publishLogged,
    setupFailedBy' = setupFailedBy, lastAction' = "runTask",
  }

  // `takt run` ends normally: the loop condition of runWithWorkerPool (active.size === 0,
  // claimRetryAt === undefined, queue.length === 0) after a claim attempt. Running tasks of this
  // process are its active executions; an empty queue with none of them active is modelled as
  // "every task it queued has run" (runTask), so the guard needs only the queue.
  action endRun(p: Proc): bool = {
    val l = procs.get(p)
    all {
      l.phase == Idle, l.attempted, not(l.retrying), l.queue == Set(), l.inFlight == Set(),
      procs' = procs.set(p, { ...l, phase: Ended }),
      tasks' = tasks, hooks' = hooks, events' = events, publishLogged' = publishLogged,
      setupFailedBy' = setupFailedBy, lastAction' = "endRun",
    }
  }

  action step = {
    nondet p = PROCS.oneOf()
    nondet t = TASKS.oneOf()
    nondet kind = Set(TasksLockTransient, GoalLockTimeout).oneOf()
    nondet callbackFails = Set(true, false).oneOf()
    any {
      addTask(t),
      snapshot(p),
      claimFails(p, kind),
      claimSaved(p, callbackFails),
      claimSavedThenThrows(p),
      rereadOk(p),
      rereadFails(p),
      runTask(p, t),
      endRun(p),
    }
  }

  // ---------- properties ----------

  // A claim that has finished for `p`: it is not between claimNextTasks() and the second read.
  def claimFinished(p: Proc): bool = p == NONE or procs.get(p).phase != AwaitReread

  // Every task saved as running is in its owner's queue, or on its way there in the same call.
  val noOrphanRunning: bool = TASKS.forall(t =>
    tasks.get(t).status == Running implies {
      val l = procs.get(tasks.get(t).owner)
      l.queue.contains(t) or l.inFlight.contains(t)
    })

  // A task is queued by its owner only.
  val queuedByOwnerOnly: bool = PROCS.forall(p => procs.get(p).queue.forall(t => tasks.get(t).owner == p))

  // The finish hook and the manager event of a setup failure fire at most once, and only for a
  // task some claim saved as a setup failure.
  val noDuplicateSetupReport: bool = TASKS.forall(t => hooks.get(t) <= 1 and events.get(t) <= 1)
  val noFalseSetupReport: bool = TASKS.forall(t => hooks.get(t) > 0 implies setupFailedBy.get(t) != NONE)

  // Once the claim that saved a setup failure has finished, its finish hook has fired, and its
  // manager event has been written or its write failure logged.
  val noMissedSetupReport: bool = TASKS.forall(t =>
    (setupFailedBy.get(t) != NONE and claimFinished(setupFailedBy.get(t))) implies
      (hooks.get(t) == 1 and events.get(t) + publishLogged.get(t) == 1))

  // A transient failure never stops claiming for the rest of the run.
  val claimingNeverStops: bool = PROCS.forall(p => procs.get(p).phase != Stopped)

  // `takt run` never ends normally while a task it saved as running has not run: such an end
  // reports success 0 / fail 0 ("No pending tasks") and leaves the task running in tasks.yaml.
  val noFalseCleanEnd: bool = PROCS.forall(p =>
    procs.get(p).phase == Ended implies TASKS.forall(t => tasks.get(t) != { status: Running, owner: p }))

  val safety: bool = and {
    noOrphanRunning, queuedByOwnerOnly, noDuplicateSetupReport, noFalseSetupReport,
    noMissedSetupReport, claimingNeverStops, noFalseCleanEnd,
  }

  // ---------- witnesses ----------
  val wSetupReported: bool = TASKS.exists(t => hooks.get(t) == 1)
  val wLateTaskSetupReported: bool = hooks.get("t3") == 1
  val wTaskRan: bool = tasks.get("t1").status == Done
  val wPublishLogged: bool = TASKS.exists(t => publishLogged.get(t) == 1)
  val wGoalLockRetried: bool = lastAction == "claimFailsGoalLock" and PROCS.forall(p => procs.get(p).phase != Stopped)
  val wTransientRetried: bool = lastAction == "claimFailsTransient"
  val wRunEnded: bool = PROCS.exists(p => procs.get(p).phase == Ended)
  val wRunEndedAfterWork: bool = lastAction == "endRun" and tasks.get("t1").status == Done
  val wPostWriteThrew: bool = lastAction == "claimSavedThenThrows"
  val wOtherProcReported: bool = TASKS.exists(t => setupFailedBy.get(t) == "B") and TASKS.exists(t => setupFailedBy.get(t) == "A")
}

module merged { import goalTaskClaim(DESIGN = "Merged", POST_WRITE = "None").* from "./goalTaskClaim" }
module forkP1 { import goalTaskClaim(DESIGN = "ForkP1", POST_WRITE = "None").* from "./goalTaskClaim" }
module fixed { import goalTaskClaim(DESIGN = "Fixed", POST_WRITE = "None").* from "./goalTaskClaim" }
// The fix with a lock release that fails after the write (left to the separate issue).
module fixedReleaseFails { import goalTaskClaim(DESIGN = "Fixed", POST_WRITE = "Stops").* from "./goalTaskClaim" }
// The fix if the timeout conversion also covered the code after the write (rejected).
module fixedPostWriteRetried { import goalTaskClaim(DESIGN = "Fixed", POST_WRITE = "Retried").* from "./goalTaskClaim" }

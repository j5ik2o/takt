// -*- mode: Bluespec; -*-
// A lock release that fails after a tasks.yaml write (issue #169).
//
// Two `takt run` processes (A, B) and one long-lived manager/daemon process (M) share tasks.yaml
// and its locks. A write runs under goal-execution.lock and tasks.yaml.lock; the model treats the
// pair as one lock, because both release the same way and the write is the same commit point.
//
// Code:
//   src/infra/task/taskLifecycleService.ts   claimNextTasks / failInterruptedRunningTasks /
//                                            invalidatePendingGoalTasks
//   src/features/daemonTurn/reconcileLostRun.ts
//   src/infra/fs/file-lock.ts                withFileLock / recoverStaleLock (tasks.yaml.lock)
//   src/shared/utils/private-file-lock.ts    runWithAcquiredLock (goal-execution.lock)
//   src/features/tasks/execute/parallelExecution.ts  claimPreparedTasks / runWithWorkerPool
//
// DESIGN picks the implementation:
//   "Current"    — integration/takt-mcp at ce641a0ce. A release error after the write leaves the
//                  operation: the claim returns nothing and stops claiming, the interrupted-task
//                  recovery and the invalidation drop their notices. A lock file the process failed
//                  to remove names a live owner (itself), so the process waits on it until it exits.
//   "ReturnOnly" — the issue's first idea alone: after the write, a release error is warned (or
//                  thrown after the notices) and the operation keeps its result. Nothing removes the
//                  lock file the process failed to remove.
//   "Fixed"      — ReturnOnly, plus each process records a lock file it failed to remove and
//                  removes it at its next acquisition of that lock; if removing it fails again, the
//                  acquisition throws that error instead of timing out.
module claimLockRelease {
  const DESIGN: str

  type Actor = str
  type TaskId = str

  type Status = Pending | Running | Failed | Done
  type TaskRec = { status: Status, owner: Actor }

  // Idle: between poll ticks. Stopped: preparationFailure is set (claiming never resumes; queued
  // tasks are not started, and the process exits once its active tasks settle). Ended: `takt run`
  // left the worker pool loop as a normal end.
  type Phase = Idle | Stopped | Ended

  // Why a process stopped. Unlink: a lock file could not be removed, so nothing can be written.
  // ReleaseError: an unclassified error from a lock release after the write.
  type StopReason = NoStop | Unlink | ReleaseError

  type Local = {
    phase: Phase,
    stopReason: StopReason,
    queue: Set[TaskId],
    retrying: bool,   // claimRetryAt is set
    attempted: bool,  // the last claim attempt completed
  }

  // How the lock release after the write ends. Gone: the lock file was removed or replaced by
  // someone else ("ownership changed before release"); it throws, but no lock is left. Stuck: the
  // unlink fails (EIO, EACCES) and the lock file stays; a later unlink succeeds. StuckForGood: the
  // lock file stays and every later unlink fails too.
  type ReleaseOutcome = Ok | Gone | Stuck | StuckForGood

  // What an acquisition sees. Timeout: the lock names a live owner for the whole wait. UnlinkFails:
  // removing a lock file that may be removed (dead owner, or Fixed's own recorded one) fails.
  type Acquire = Acquired | Timeout | UnlinkFails

  pure val NONE: Actor = ""
  pure val DEAD: Actor = "D"  // the owner of an interrupted run; never alive
  pure val M: Actor = "M"
  pure val PROCS: Set[Actor] = Set("A", "B")
  pure val ACTORS: Set[Actor] = Set("A", "B", "M")
  pure val TASKS: Set[TaskId] = Set("t1", "t2", "t3")
  // t2: a goal task whose runtime_assignment cannot be selected; the claim saves it as failed.
  pure val SETUP_BROKEN: Set[TaskId] = Set("t2")
  pure val RELEASES: Set[ReleaseOutcome] = Set(Ok, Gone, Stuck, StuckForGood)

  var tasks: TaskId -> TaskRec
  var procs: Actor -> Local
  // The lock file left behind by a failed release: its owner (NONE when there is none), and whether
  // every later unlink of it fails.
  var orphanOf: Actor
  var orphanForGood: bool
  var savedFailed: TaskId -> bool     // ghost: an operation saved this task as failed
  var notices: TaskId -> int          // finish hook / manager completion event delivered
  var releaseFailures: Actor -> int   // releases after a write that threw
  var releaseReported: Actor -> int   // of those, warned or thrown to the caller
  var waitingOnSelf: Actor -> bool    // the last acquisition timed out on a lock this actor left
  var lastAction: str

  // ---------- functional layer ----------

  def alive(a: Actor): bool =
    if (a == M) true
    else if (PROCS.contains(a)) procs.get(a).phase == Idle
    else false

  // The acquisition of the lock pair by `a`, given the lock file left behind (if any).
  def acquire(a: Actor): Acquire =
    if (orphanOf == NONE) Acquired
    else if (orphanOf == a) {
      if (DESIGN == "Fixed") { if (orphanForGood) UnlinkFails else Acquired }
      else Timeout  // the record names this live process: it waits on itself
    }
    else if (alive(orphanOf)) Timeout
    else if (orphanForGood) UnlinkFails  // dead-owner recovery; its unlink fails
    else Acquired

  pure def orphanAfter(r: ReleaseOutcome, a: Actor): Actor =
    match r { | Stuck => a | StuckForGood => a | _ => NONE }
  pure def forGoodAfter(r: ReleaseOutcome): bool = r == StuckForGood
  pure def released(r: ReleaseOutcome): bool = r == Ok

  pure def incIf(m: Actor -> int, a: Actor, c: bool): Actor -> int =
    if (c) m.set(a, m.get(a) + 1) else m

  pure def noticeAll(m: TaskId -> int, s: Set[TaskId]): TaskId -> int =
    m.keys().mapBy(t => if (s.contains(t)) m.get(t) + 1 else m.get(t))

  pure def markFailed(m: TaskId -> bool, s: Set[TaskId]): TaskId -> bool =
    m.keys().mapBy(t => s.contains(t) or m.get(t))

  pure def failAll(ts: TaskId -> TaskRec, s: Set[TaskId]): TaskId -> TaskRec =
    ts.keys().mapBy(t => if (s.contains(t)) { status: Failed, owner: NONE } else ts.get(t))

  // After the write, does the operation keep its result when the release throws?
  pure val keepsResult: bool = DESIGN != "Current"

  // ---------- state machine ----------

  action init = all {
    tasks' = Map("t1" -> { status: Pending, owner: NONE }, "t2" -> { status: Pending, owner: NONE },
      "t3" -> { status: Running, owner: DEAD }),
    procs' = ACTORS.mapBy(_ => { phase: Idle, stopReason: NoStop, queue: Set(), retrying: false, attempted: false }),
    orphanOf' = NONE,
    orphanForGood' = false,
    savedFailed' = TASKS.mapBy(_ => false),
    notices' = TASKS.mapBy(_ => 0),
    releaseFailures' = ACTORS.mapBy(_ => 0),
    releaseReported' = ACTORS.mapBy(_ => 0),
    waitingOnSelf' = ACTORS.mapBy(_ => false),
    lastAction' = "init",
  }

  // An acquisition that did not get the lock: nothing is written.
  action notAcquired(a: Actor, how: Acquire, name: str): bool = all {
    if (how == Timeout and PROCS.contains(a))
      // Classified as retryable: claimRetryAt is set and the run keeps waiting.
      procs' = procs.setBy(a, l => { ...l, retrying: true })
    else if (how == UnlinkFails and PROCS.contains(a))
      // An unclassified error: claiming stops; queued tasks are left for interrupted recovery.
      procs' = procs.setBy(a, l => { ...l, phase: Stopped, stopReason: Unlink, queue: Set() })
    else procs' = procs,  // M: the error goes to the caller (MCP tool, daemon turn)
    waitingOnSelf' = waitingOnSelf.set(a, how == Timeout and orphanOf == a),
    tasks' = tasks, orphanOf' = orphanOf, orphanForGood' = orphanForGood,
    savedFailed' = savedFailed, notices' = notices,
    releaseFailures' = releaseFailures, releaseReported' = releaseReported,
    lastAction' = name,
  }

  // claimNextTasks(): one write saves the runnable pending tasks as running (owner p) and the
  // setup-broken ones as failed, then releases the locks (outcome r).
  action claim(p: Actor, r: ReleaseOutcome): bool = {
    val how = acquire(p)
    val pend = TASKS.filter(t => tasks.get(t).status == Pending)
    val claimed = pend.exclude(SETUP_BROKEN)
    val failed = pend.intersect(SETUP_BROKEN)
    val keep = released(r) or keepsResult
    all {
      PROCS.contains(p),
      procs.get(p).phase == Idle,
      if (how != Acquired) notAcquired(p, how, if (how == Timeout) "claimTimeout" else "claimUnlinkFails")
      else all {
        tasks' = tasks.keys().mapBy(t =>
          if (claimed.contains(t)) { status: Running, owner: p }
          else if (failed.contains(t)) { status: Failed, owner: NONE }
          else tasks.get(t)),
        savedFailed' = markFailed(savedFailed, failed),
        orphanOf' = orphanAfter(r, p),
        orphanForGood' = forGoodAfter(r),
        releaseFailures' = incIf(releaseFailures, p, not(released(r))),
        // Current: the error becomes preparationFailure ("Cannot prepare pending tasks"). The others
        // warn through onWarning.
        releaseReported' = incIf(releaseReported, p, not(released(r))),
        waitingOnSelf' = waitingOnSelf.set(p, false),
        if (keep) all {
          procs' = procs.setBy(p, l => { ...l, queue: l.queue.union(claimed), retrying: false, attempted: true }),
          notices' = noticeAll(notices, failed),
        } else all {
          procs' = procs.setBy(p, l => { ...l, phase: Stopped, stopReason: ReleaseError, queue: Set() }),
          notices' = notices,
        },
        lastAction' =
          if (orphanOf == p and DESIGN == "Fixed") "claimAfterSelfRecovery"
          else if (released(r)) "claim" else if (keep) "claimReleaseFailedKept" else "claimReleaseFailedStopped",
      },
    }
  }

  // failInterruptedRunningTasks() at the start of a run or watch (a in PROCS), or reconcileLostRun()
  // in the daemon (a = M): running tasks whose owner is dead become failed, then each is notified.
  action recover(a: Actor, r: ReleaseOutcome): bool = {
    val how = acquire(a)
    val lost = TASKS.filter(t => tasks.get(t).status == Running and not(alive(tasks.get(t).owner)))
    val keep = released(r) or keepsResult
    all {
      alive(a),
      lost != Set(),
      if (how != Acquired) notAcquired(a, how, "recoverNotAcquired")
      else all {
        tasks' = failAll(tasks, lost),
        savedFailed' = markFailed(savedFailed, lost),
        orphanOf' = orphanAfter(r, a),
        orphanForGood' = forGoodAfter(r),
        releaseFailures' = incIf(releaseFailures, a, not(released(r))),
        // Run start: Current throws out of runAllTasks / watch; the others warn. Daemon: thrown to the
        // daemon turn in every design (Fixed throws after the event).
        releaseReported' = incIf(releaseReported, a, not(released(r))),
        waitingOnSelf' = waitingOnSelf.set(a, false),
        notices' = if (keep) noticeAll(notices, lost) else notices,
        procs' = if (keep or a == M) procs
          else procs.setBy(a, l => { ...l, phase: Stopped, stopReason: ReleaseError, queue: Set() }),
        lastAction' = if (released(r)) "recover" else "recoverReleaseFailed",
      },
    }
  }

  // invalidatePendingGoalTasks() for an aborted goal (MCP / manager, a = M): pending goal tasks become
  // failed, then the finish hook runs for each. A release error reaches the caller in every design.
  action invalidate(r: ReleaseOutcome): bool = {
    val how = acquire(M)
    val pend = TASKS.filter(t => tasks.get(t).status == Pending)
    val keep = released(r) or keepsResult
    all {
      pend != Set(),
      if (how != Acquired) notAcquired(M, how, "invalidateNotAcquired")
      else all {
        tasks' = failAll(tasks, pend),
        savedFailed' = markFailed(savedFailed, pend),
        orphanOf' = orphanAfter(r, M),
        orphanForGood' = forGoodAfter(r),
        releaseFailures' = incIf(releaseFailures, M, not(released(r))),
        releaseReported' = incIf(releaseReported, M, not(released(r))),
        waitingOnSelf' = waitingOnSelf.set(M, false),
        notices' = if (keep) noticeAll(notices, pend) else notices,
        procs' = procs,
        lastAction' = if (released(r)) "invalidate" else "invalidateReleaseFailed",
      },
    }
  }

  // The completion write of a task is outside this model (see README).
  action runTask(p: Actor, t: TaskId): bool = all {
    PROCS.contains(p),
    procs.get(p).phase == Idle,
    procs.get(p).queue.contains(t),
    tasks' = tasks.set(t, { status: Done, owner: NONE }),
    procs' = procs.setBy(p, l => { ...l, queue: l.queue.exclude(Set(t)) }),
    orphanOf' = orphanOf, orphanForGood' = orphanForGood, savedFailed' = savedFailed,
    notices' = notices, releaseFailures' = releaseFailures, releaseReported' = releaseReported,
    waitingOnSelf' = waitingOnSelf, lastAction' = "runTask",
  }

  // `takt run` ends normally (runWithWorkerPool: nothing active, no claimRetryAt, empty queue).
  action endRun(p: Actor): bool = {
    val l = procs.get(p)
    all {
      PROCS.contains(p),
      l.phase == Idle, l.attempted, not(l.retrying), l.queue == Set(),
      procs' = procs.set(p, { ...l, phase: Ended }),
      tasks' = tasks, orphanOf' = orphanOf, orphanForGood' = orphanForGood, savedFailed' = savedFailed,
      notices' = notices, releaseFailures' = releaseFailures, releaseReported' = releaseReported,
      waitingOnSelf' = waitingOnSelf, lastAction' = "endRun",
    }
  }

  action step = {
    nondet p = PROCS.oneOf()
    nondet a = ACTORS.oneOf()
    nondet t = TASKS.oneOf()
    nondet r = RELEASES.oneOf()
    any {
      claim(p, r),
      recover(a, r),
      invalidate(r),
      runTask(p, t),
      endRun(p),
    }
  }

  // ---------- properties ----------

  // A task saved as running by p is in p's queue, unless p stopped because a lock file cannot be
  // removed (then nothing can be written; the task is failed as interrupted after p exits).
  def runningOwnedBy(p: Actor): Set[TaskId] = TASKS.filter(t => tasks.get(t) == { status: Running, owner: p })
  val noOrphanRunning: bool = PROCS.forall(p =>
    runningOwnedBy(p).forall(t => procs.get(p).queue.contains(t) or procs.get(p).stopReason == Unlink))

  val queuedByOwnerOnly: bool = PROCS.forall(p => procs.get(p).queue.forall(t => tasks.get(t).owner == p))

  // Every task an operation saved as failed is notified exactly once (finish hook or manager
  // completion event), whatever the release after the write did.
  val noLostNotice: bool = TASKS.forall(t => savedFailed.get(t) implies notices.get(t) == 1)
  val noDuplicateNotice: bool = TASKS.forall(t => notices.get(t) <= 1)
  val noFalseNotice: bool = TASKS.forall(t => notices.get(t) > 0 implies savedFailed.get(t))

  // A release that failed after a write is never silent: it is warned or thrown to the caller.
  val releaseFailureReported: bool = ACTORS.forall(a => releaseReported.get(a) == releaseFailures.get(a))

  // No process waits on a lock file it left behind itself.
  val noSelfWait: bool = ACTORS.forall(a => not(waitingOnSelf.get(a)))

  // Claiming stops only when a lock file cannot be removed.
  val stopsOnlyWhenUnlinkFails: bool = PROCS.forall(p =>
    procs.get(p).phase == Stopped implies procs.get(p).stopReason == Unlink)

  // `takt run` never ends normally while a task it saved as running has not run.
  val noFalseCleanEnd: bool = PROCS.forall(p =>
    procs.get(p).phase == Ended implies TASKS.forall(t => tasks.get(t) != { status: Running, owner: p }))

  val safety: bool = and {
    noOrphanRunning, queuedByOwnerOnly, noLostNotice, noDuplicateNotice, noFalseNotice,
    releaseFailureReported, noSelfWait, stopsOnlyWhenUnlinkFails, noFalseCleanEnd,
  }

  // ---------- witnesses (each should be reachable: `--invariant` on its negation finds a trace) ----------
  val wClaimKeptAfterReleaseFailure: bool = lastAction == "claimReleaseFailedKept"
  val wTaskRanAfterReleaseFailure: bool = lastAction == "runTask" and releaseFailures.get("A") + releaseFailures.get("B") > 0
  val wSelfRecovered: bool = lastAction == "claimAfterSelfRecovery"
  val wUnlinkStop: bool = PROCS.exists(p => procs.get(p).stopReason == Unlink)
  val wOtherWaitsOnLiveOrphan: bool = lastAction == "claimTimeout" and orphanOf != NONE
  val wRecoverReleaseFailed: bool = lastAction == "recoverReleaseFailed"
  val wInvalidateReleaseFailed: bool = lastAction == "invalidateReleaseFailed"
  val wSetupNoticeAfterReleaseFailure: bool = lastAction == "claimReleaseFailedKept" and notices.get("t2") == 1
  val wRunEnded: bool = PROCS.exists(p => procs.get(p).phase == Ended)
  val wRunEndedAfterReleaseFailure: bool = lastAction == "endRun" and releaseFailures.get("A") + releaseFailures.get("B") > 0
}

module current { import claimLockRelease(DESIGN = "Current").* from "./claimLockRelease" }
module returnOnly { import claimLockRelease(DESIGN = "ReturnOnly").* from "./claimLockRelease" }
module fixed { import claimLockRelease(DESIGN = "Fixed").* from "./claimLockRelease" }

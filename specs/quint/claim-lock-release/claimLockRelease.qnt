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
//   src/features/tasks/execute/taskFinishHook.ts  runTaskFinishHooks / invalidate...WithFinishHook
//   src/infra/fs/file-lock.ts                withFileLock / readSnapshot / unlinkSnapshot /
//                                            recoverStaleLock (tasks.yaml.lock)
//   src/shared/utils/private-file-lock.ts    runWithAcquiredLock (goal-execution.lock)
//   src/features/tasks/execute/parallelExecution.ts  claimPreparedTasks / runWithWorkerPool
//
// DESIGN picks the implementation:
//   "Current"     — integration/takt-mcp at ce641a0ce. A release error after the write leaves the
//                   operation: the claim returns nothing and stops claiming, the interrupted-task
//                   recovery and the invalidation drop their notices. A lock file the process failed
//                   to remove names a live owner (itself), so the process waits on it until it exits.
//                   A release that cannot read its own lock file returns silently and leaves it.
//   "ReturnOnly"  — the issue's first idea alone: after the write, a release error is warned (or
//                   thrown after the notices) and the operation keeps its result. Nothing removes the
//                   lock file the process failed to remove.
//   "FirstDesign" — the design as first reviewed (237703e8e): ReturnOnly, plus a process records a
//                   lock file whose release threw and removes it at its next acquisition. A release
//                   that cannot read its own lock file still returns silently (not recorded), and
//                   the finish hooks of setup failures and invalidations re-read tasks.yaml under
//                   tasks.yaml.lock (runTaskFinishHooks).
//   "SecondDesign" — the design after the first review (b82a56d2a): FirstDesign, plus the release
//                   throws (and records) when its own lock file is there but cannot be read, and the
//                   finish hooks get the saved task states instead of re-reading tasks.yaml. Its
//                   recovery of a recorded file throws when the first read cannot read it, and
//                   removes it with unlinkSnapshot, which returns silently when its own re-read
//                   fails; the record is then dropped as if removed.
//   "Fixed"       — SecondDesign, plus the recovery of a recorded file keeps the record and goes on
//                   waiting (the rule for an unreadable lock: stale after STALE_MS) when either read
//                   fails, and reports "removed" only when unlinkSync succeeded.
module claimLockRelease {
  const DESIGN: str

  type Actor = str
  type TaskId = str

  type Status = Pending | Running | Failed | Done
  type TaskRec = { status: Status, owner: Actor }

  // Idle: between poll ticks. Stopped: preparationFailure is set (claiming never resumes; queued
  // tasks are not started). Ended: `takt run` left the worker pool loop as a normal end. Both
  // Stopped and Ended count as dead for dead-owner recovery (see README).
  type Phase = Idle | Stopped | Ended

  // Why a process stopped. Unlink: a lock file could not be removed, so nothing can be written.
  // ReleaseError: an unclassified error from a lock release after the write.
  // ReadStop: the recovery of a recorded own lock file could not read it and threw (SecondDesign).
  type StopReason = NoStop | Unlink | ReleaseError | ReadStop

  type Local = {
    phase: Phase,
    stopReason: StopReason,
    queue: Set[TaskId],
    retrying: bool,   // claimRetryAt is set
    attempted: bool,  // the last claim attempt completed
  }

  // How the lock release after the write ends.
  //   Ok: removed.
  //   Gone: someone else removed or replaced the lock file ("ownership changed before release");
  //         it throws, and no lock of this process is left.
  //   Stuck: the unlink fails (EIO, EACCES) and the file stays; a later unlink succeeds.
  //   StuckForGood: the file stays and every later unlink fails too.
  //   Unseen: the release cannot open or read its own lock file (EACCES / EPERM on open, EIO on
  //           read) and the file stays; a later read and unlink succeed. Before Fixed,
  //           file-lock.ts returns silently here.
  type ReleaseOutcome = Ok | Gone | Stuck | StuckForGood | Unseen

  // What an acquisition sees. Timeout: the lock names a live owner for the whole wait. UnlinkFails:
  // removing a lock file that may be removed (dead owner, or a recorded own one) fails.
  // UnreadableWait: a recorded own lock file could not be read at recovery; the record is kept and
  // the acquisition waits under the rule for an unreadable lock (removed once older than STALE_MS),
  // so the wait is bounded. RecordLost: the recovery dropped the record without removing the file;
  // the file now names this live process with no record, so the acquisition waits on itself.
  // ReadFailed: the recovery threw the read error, an unclassified error.
  type Acquire = Acquired | Timeout | UnlinkFails | UnreadableWait | RecordLost | ReadFailed

  // A transient read failure during the recovery of a recorded own lock file: in recoverStaleLock's
  // first read, or in the re-read just before the unlink. The next read succeeds.
  type Glitch = NoGlitch | FirstReadFails | SecondReadFails

  pure val NONE: Actor = ""
  pure val DEAD: Actor = "D"  // the owner of an interrupted run; never alive
  pure val M: Actor = "M"
  pure val PROCS: Set[Actor] = Set("A", "B")
  pure val ACTORS: Set[Actor] = Set("A", "B", "M")
  pure val TASKS: Set[TaskId] = Set("t1", "t2", "t3")
  // t2: a goal task whose runtime_assignment cannot be selected; the claim saves it as failed.
  pure val SETUP_BROKEN: Set[TaskId] = Set("t2")
  pure val RELEASES: Set[ReleaseOutcome] = Set(Ok, Gone, Stuck, StuckForGood, Unseen)
  pure val GLITCHES: Set[Glitch] = Set(NoGlitch, FirstReadFails, SecondReadFails)

  // Which designs record a lock file whose release threw, and which also report an unreadable own
  // lock file at release and pass saved states to the finish hooks.
  pure val recordsReleases: bool = DESIGN == "FirstDesign" or DESIGN == "SecondDesign" or DESIGN == "Fixed"
  pure val afterFirstReview: bool = DESIGN == "SecondDesign" or DESIGN == "Fixed"

  var tasks: TaskId -> TaskRec
  var procs: Actor -> Local
  // The lock file left behind by a failed release: its owner (NONE when there is none), whether
  // every later unlink of it fails, and whether its owner recorded it (orphanedLocks).
  var orphanOf: Actor
  var orphanForGood: bool
  var orphanRecorded: bool
  var needHook: TaskId -> bool     // ghost: saved as failed by a claim (setup) or an invalidation
  var needEvent: TaskId -> bool    // ghost: saved as failed by a claim (setup) or a recovery
  var hooks: TaskId -> int         // finish hook runs
  var events: TaskId -> int        // manager completion events written
  var releaseFailures: Actor -> int   // releases after a write that did not remove the lock cleanly
  var releaseReported: Actor -> int   // of those, warned or thrown to the caller
  var waitingOnSelf: Actor -> bool    // the last acquisition timed out on a lock this actor left
  var lastAction: str

  // ---------- functional layer ----------

  def alive(a: Actor): bool =
    if (a == M) true
    else if (PROCS.contains(a)) procs.get(a).phase == Idle
    else false

  // The acquisition by `a` of the lock pair, given a lock file left behind (`o`, `forGood`,
  // `recorded`).
  def acquireAt(a: Actor, o: Actor, forGood: bool, recorded: bool, g: Glitch): Acquire =
    if (o == NONE) Acquired
    else if (o == a) {
      if (not(recorded)) Timeout  // the file names this live process and nothing marks it as left behind
      else if (g == NoGlitch) { if (forGood) UnlinkFails else Acquired }
      else if (DESIGN == "Fixed") UnreadableWait
      else if (DESIGN == "SecondDesign" and g == FirstReadFails) ReadFailed
      // FirstDesign: an unreadable file does not match the record, which is dropped. SecondDesign's
      // unlinkSnapshot returns silently on a failed re-read, and the record is dropped as removed.
      else RecordLost
    }
    else if (alive(o)) Timeout
    else if (forGood) UnlinkFails  // dead-owner recovery; its unlink fails
    else Acquired

  def acquire(a: Actor, g: Glitch): Acquire = acquireAt(a, orphanOf, orphanForGood, orphanRecorded, g)

  pure def leavesFile(r: ReleaseOutcome): bool = r == Stuck or r == StuckForGood or r == Unseen
  pure def orphanAfter(r: ReleaseOutcome, a: Actor): Actor = if (leavesFile(r)) a else NONE
  pure def forGoodAfter(r: ReleaseOutcome): bool = r == StuckForGood

  // The release throws to the operation. Before Fixed, an unreadable own lock file is skipped
  // silently (file-lock.ts unlinkSnapshot sees `content !== expected.content` and returns).
  pure def throws(r: ReleaseOutcome): bool =
    r == Gone or r == Stuck or r == StuckForGood or (r == Unseen and afterFirstReview)

  // The process records the lock file it left (FirstDesign and Fixed record what throws).
  pure def recordedAfter(r: ReleaseOutcome): bool =
    leavesFile(r) and throws(r) and recordsReleases

  // After the write, the operation keeps its result: the release did not throw, or the design
  // keeps results across a release error.
  pure def keeps(r: ReleaseOutcome): bool = not(throws(r)) or DESIGN != "Current"

  // Do the finish hooks of this write run? Fixed passes the saved states. The others re-read
  // tasks.yaml (runTaskFinishHooks -> listTaskStateItems -> TaskStore.read) under tasks.yaml.lock;
  // a failed re-read is only logged (log.error), so the hooks are lost.
  def hooksRun(a: Actor, r: ReleaseOutcome): bool =
    keeps(r) and (afterFirstReview
      or acquireAt(a, orphanAfter(r, a), forGoodAfter(r), recordedAfter(r), NoGlitch) == Acquired)

  // The re-read for the hooks may itself remove the recorded own lock file (FirstDesign).
  def orphanAfterHooks(a: Actor, r: ReleaseOutcome, rereads: bool): Actor =
    if (rereads and not(afterFirstReview) and keeps(r) and orphanAfter(r, a) == a and recordedAfter(r)
      and not(forGoodAfter(r))) NONE
    else orphanAfter(r, a)

  pure def incIf(m: Actor -> int, a: Actor, c: bool): Actor -> int =
    if (c) m.set(a, m.get(a) + 1) else m

  pure def bump(m: TaskId -> int, s: Set[TaskId], c: bool): TaskId -> int =
    m.keys().mapBy(t => if (c and s.contains(t)) m.get(t) + 1 else m.get(t))

  pure def mark(m: TaskId -> bool, s: Set[TaskId]): TaskId -> bool =
    m.keys().mapBy(t => s.contains(t) or m.get(t))

  pure def failAll(ts: TaskId -> TaskRec, s: Set[TaskId]): TaskId -> TaskRec =
    ts.keys().mapBy(t => if (s.contains(t)) { status: Failed, owner: NONE } else ts.get(t))

  // ---------- state machine ----------

  action init = all {
    tasks' = Map("t1" -> { status: Pending, owner: NONE }, "t2" -> { status: Pending, owner: NONE },
      "t3" -> { status: Running, owner: DEAD }),
    procs' = ACTORS.mapBy(_ => { phase: Idle, stopReason: NoStop, queue: Set(), retrying: false, attempted: false }),
    orphanOf' = NONE,
    orphanForGood' = false,
    orphanRecorded' = false,
    needHook' = TASKS.mapBy(_ => false),
    needEvent' = TASKS.mapBy(_ => false),
    hooks' = TASKS.mapBy(_ => 0),
    events' = TASKS.mapBy(_ => 0),
    releaseFailures' = ACTORS.mapBy(_ => 0),
    releaseReported' = ACTORS.mapBy(_ => 0),
    waitingOnSelf' = ACTORS.mapBy(_ => false),
    lastAction' = "init",
  }

  // An acquisition that did not get the lock: nothing is written.
  action notAcquired(a: Actor, how: Acquire, name: str): bool = all {
    if (PROCS.contains(a) and (how == Timeout or how == UnreadableWait or how == RecordLost))
      // Classified as retryable: claimRetryAt is set and the run keeps waiting.
      procs' = procs.setBy(a, l => { ...l, retrying: true })
    else if (PROCS.contains(a) and how == UnlinkFails)
      // An unclassified error: claiming stops; queued tasks are left for interrupted recovery.
      procs' = procs.setBy(a, l => { ...l, phase: Stopped, stopReason: Unlink, queue: Set() })
    else if (PROCS.contains(a) and how == ReadFailed)
      procs' = procs.setBy(a, l => { ...l, phase: Stopped, stopReason: ReadStop, queue: Set() })
    else procs' = procs,  // M: the error goes to the caller (MCP tool, daemon turn)
    // Waiting on an unreadable recorded file is bounded (STALE_MS) and is not a self-wait.
    waitingOnSelf' = waitingOnSelf.set(a, (how == Timeout and orphanOf == a) or how == RecordLost),
    orphanRecorded' = if (how == RecordLost) false else orphanRecorded,
    tasks' = tasks, orphanOf' = orphanOf, orphanForGood' = orphanForGood,
    needHook' = needHook, needEvent' = needEvent, hooks' = hooks, events' = events,
    releaseFailures' = releaseFailures, releaseReported' = releaseReported,
    lastAction' = name,
  }

  // The lock state and report counters after a write by `a` with release outcome `r`.
  action afterWrite(a: Actor, r: ReleaseOutcome, rereads: bool): bool = all {
    orphanOf' = orphanAfterHooks(a, r, rereads),
    orphanForGood' = (forGoodAfter(r) and leavesFile(r)),
    orphanRecorded' = (recordedAfter(r) and orphanAfterHooks(a, r, rereads) == a),
    releaseFailures' = incIf(releaseFailures, a, r != Ok),
    // Current: the error becomes preparationFailure, the run-start failure, or the caller's error.
    // The others warn (claim, run-start recovery) or throw after the notices (M).
    releaseReported' = incIf(releaseReported, a, throws(r)),
    waitingOnSelf' = waitingOnSelf.set(a, false),
  }

  // claimNextTasks(): one write saves the runnable pending tasks as running (owner p) and the
  // setup-broken ones as failed, then releases the locks (outcome r). Each setup failure gets a
  // finish hook (claimAvailableTasks) and a manager event (onSetupFailed).
  action claim(p: Actor, r: ReleaseOutcome, g: Glitch): bool = {
    val how = acquire(p, g)
    val pend = TASKS.filter(t => tasks.get(t).status == Pending)
    val claimed = pend.exclude(SETUP_BROKEN)
    val failed = pend.intersect(SETUP_BROKEN)
    all {
      PROCS.contains(p),
      procs.get(p).phase == Idle,
      if (how != Acquired) notAcquired(p, how, if (how == Timeout) "claimTimeout" else if (how == UnreadableWait) "claimWaitsUnreadable"
        else if (how == RecordLost) "claimRecordLost" else if (how == ReadFailed) "claimReadFailed" else "claimUnlinkFails")
      else all {
        tasks' = tasks.keys().mapBy(t =>
          if (claimed.contains(t)) { status: Running, owner: p }
          else if (failed.contains(t)) { status: Failed, owner: NONE }
          else tasks.get(t)),
        needHook' = mark(needHook, failed),
        needEvent' = mark(needEvent, failed),
        afterWrite(p, r, failed != Set()),
        hooks' = bump(hooks, failed, hooksRun(p, r)),
        events' = bump(events, failed, keeps(r)),
        procs' = if (keeps(r))
          procs.setBy(p, l => { ...l, queue: l.queue.union(claimed), retrying: false, attempted: true })
          else procs.setBy(p, l => { ...l, phase: Stopped, stopReason: ReleaseError, queue: Set() }),
        lastAction' =
          if (orphanOf == p and orphanRecorded) "claimAfterSelfRecovery"
          else if (r == Ok) "claim" else if (keeps(r)) "claimReleaseFailedKept" else "claimReleaseFailedStopped",
      },
    }
  }

  // failInterruptedRunningTasks() at the start of a run or watch (a in PROCS), or reconcileLostRun()
  // in the daemon (a = M): running tasks whose owner is dead become failed, then each gets a manager
  // event. (failInterruptedRunningTasks takes tasks.yaml.lock only; the model's lock pair covers it.)
  action recover(a: Actor, r: ReleaseOutcome, g: Glitch): bool = {
    val how = acquire(a, g)
    val lost = TASKS.filter(t => tasks.get(t).status == Running and not(alive(tasks.get(t).owner)))
    all {
      alive(a),
      lost != Set(),
      if (how != Acquired) notAcquired(a, how, "recoverNotAcquired")
      else all {
        tasks' = failAll(tasks, lost),
        needHook' = needHook,
        needEvent' = mark(needEvent, lost),
        afterWrite(a, r, false),
        hooks' = hooks,
        events' = bump(events, lost, keeps(r)),
        procs' = if (keeps(r) or a == M) procs
          else procs.setBy(a, l => { ...l, phase: Stopped, stopReason: ReleaseError, queue: Set() }),
        lastAction' = if (r == Ok) "recover" else "recoverReleaseFailed",
      },
    }
  }

  // invalidatePendingGoalTasks() for an aborted goal (MCP / manager, a = M): pending goal tasks become
  // failed, then the finish hook runs for each.
  action invalidate(r: ReleaseOutcome, g: Glitch): bool = {
    val how = acquire(M, g)
    val pend = TASKS.filter(t => tasks.get(t).status == Pending)
    all {
      pend != Set(),
      if (how != Acquired) notAcquired(M, how, "invalidateNotAcquired")
      else all {
        tasks' = failAll(tasks, pend),
        needHook' = mark(needHook, pend),
        needEvent' = needEvent,
        afterWrite(M, r, true),
        hooks' = bump(hooks, pend, hooksRun(M, r)),
        events' = events,
        procs' = procs,
        lastAction' = if (r == Ok) "invalidate" else "invalidateReleaseFailed",
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
    orphanOf' = orphanOf, orphanForGood' = orphanForGood, orphanRecorded' = orphanRecorded,
    needHook' = needHook, needEvent' = needEvent, hooks' = hooks, events' = events,
    releaseFailures' = releaseFailures, releaseReported' = releaseReported,
    waitingOnSelf' = waitingOnSelf, lastAction' = "runTask",
  }

  // `takt run` ends normally (runWithWorkerPool: nothing active, no claimRetryAt, empty queue).
  action endRun(p: Actor): bool = {
    val l = procs.get(p)
    all {
      PROCS.contains(p),
      l.phase == Idle, l.attempted, not(l.retrying), l.queue == Set(),
      procs' = procs.set(p, { ...l, phase: Ended }),
      tasks' = tasks, orphanOf' = orphanOf, orphanForGood' = orphanForGood, orphanRecorded' = orphanRecorded,
      needHook' = needHook, needEvent' = needEvent, hooks' = hooks, events' = events,
      releaseFailures' = releaseFailures, releaseReported' = releaseReported,
      waitingOnSelf' = waitingOnSelf, lastAction' = "endRun",
    }
  }

  action step = {
    nondet p = PROCS.oneOf()
    nondet a = ACTORS.oneOf()
    nondet t = TASKS.oneOf()
    nondet r = RELEASES.oneOf()
    nondet g = GLITCHES.oneOf()
    any {
      claim(p, r, g),
      recover(a, r, g),
      invalidate(r, g),
      runTask(p, t),
      endRun(p),
    }
  }

  // ---------- properties ----------

  def runningOwnedBy(p: Actor): Set[TaskId] = TASKS.filter(t => tasks.get(t) == { status: Running, owner: p })

  // A task saved as running by p is in p's queue, unless p stopped because a lock file cannot be
  // removed (then nothing can be written; the task is failed as interrupted after p exits).
  val noOrphanRunning: bool = PROCS.forall(p =>
    runningOwnedBy(p).forall(t => procs.get(p).queue.contains(t) or procs.get(p).stopReason == Unlink))

  val queuedByOwnerOnly: bool = PROCS.forall(p => procs.get(p).queue.forall(t => tasks.get(t).owner == p))

  // Every task an operation saved as failed gets its finish hook and its manager event exactly
  // once, whatever the release after the write did.
  val noLostNotice: bool = TASKS.forall(t =>
    (needHook.get(t) implies hooks.get(t) == 1) and (needEvent.get(t) implies events.get(t) == 1))
  val noDuplicateNotice: bool = TASKS.forall(t => hooks.get(t) <= 1 and events.get(t) <= 1)
  val noFalseNotice: bool = TASKS.forall(t =>
    (hooks.get(t) > 0 implies needHook.get(t)) and (events.get(t) > 0 implies needEvent.get(t)))

  // A release that did not remove the lock cleanly after a write is never silent: it is warned or
  // thrown to the caller.
  val releaseFailureReported: bool = ACTORS.forall(a => releaseReported.get(a) == releaseFailures.get(a))

  // No process waits on a lock file it left behind itself, except while that file cannot be read
  // (bounded by STALE_MS; see UnreadableWait).
  val noSelfWait: bool = ACTORS.forall(a => not(waitingOnSelf.get(a)))

  // Claiming stops only when a lock file cannot be removed (for writes; see README for reads). A read
  // that fails once does not stop it.
  val stopsOnlyWhenUnlinkFails: bool = PROCS.forall(p =>
    procs.get(p).phase == Stopped implies procs.get(p).stopReason == Unlink)

  // `takt run` never ends normally while a task it saved as running has not run.
  val noFalseCleanEnd: bool = PROCS.forall(p =>
    procs.get(p).phase == Ended implies TASKS.forall(t => tasks.get(t) != { status: Running, owner: p }))

  val safety: bool = and {
    noOrphanRunning, queuedByOwnerOnly, noLostNotice, noDuplicateNotice, noFalseNotice,
    releaseFailureReported, noSelfWait, stopsOnlyWhenUnlinkFails, noFalseCleanEnd,
  }

  // ---------- witnesses (each should be reachable) ----------
  val wClaimKeptAfterReleaseFailure: bool = lastAction == "claimReleaseFailedKept"
  val wTaskRanAfterReleaseFailure: bool = lastAction == "runTask" and releaseFailures.get("A") + releaseFailures.get("B") > 0
  val wSelfRecovered: bool = lastAction == "claimAfterSelfRecovery"
  val wUnlinkStop: bool = PROCS.exists(p => procs.get(p).stopReason == Unlink)
  val wOtherWaitsOnLiveOrphan: bool = lastAction == "claimTimeout" and orphanOf != NONE
  val wRecoverReleaseFailed: bool = lastAction == "recoverReleaseFailed"
  val wInvalidateReleaseFailed: bool = lastAction == "invalidateReleaseFailed"
  val wSetupHookAfterReleaseFailure: bool = lastAction == "claimReleaseFailedKept" and hooks.get("t2") == 1
  val wHookAfterStuckForGood: bool = orphanForGood and hooks.get("t1") + hooks.get("t2") > 0
  val wUnseenReported: bool = orphanOf != NONE and orphanRecorded and not(orphanForGood)
    and releaseReported.get("A") + releaseReported.get("B") + releaseReported.get(M) > 0
  val wWaitedOnUnreadableOwn: bool = lastAction == "claimWaitsUnreadable"
  val wRunEnded: bool = PROCS.exists(p => procs.get(p).phase == Ended)
  val wRunEndedAfterReleaseFailure: bool = lastAction == "endRun" and releaseFailures.get("A") + releaseFailures.get("B") > 0
}

module current { import claimLockRelease(DESIGN = "Current").* from "./claimLockRelease" }
module returnOnly { import claimLockRelease(DESIGN = "ReturnOnly").* from "./claimLockRelease" }
module firstDesign { import claimLockRelease(DESIGN = "FirstDesign").* from "./claimLockRelease" }
module secondDesign { import claimLockRelease(DESIGN = "SecondDesign").* from "./claimLockRelease" }
module fixed { import claimLockRelease(DESIGN = "Fixed").* from "./claimLockRelease" }

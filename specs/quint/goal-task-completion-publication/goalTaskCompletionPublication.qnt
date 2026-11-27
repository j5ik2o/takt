// -*- mode: Bluespec; -*-
// Durable outbox publication of goal task completion notices (issue #170).
// Covers setup failures in claimNextTasks, interrupted running task recovery in
// failInterruptedRunningTasks, and lost-run reconciliation in reconcileLostRun.
//
// Code:
//   src/infra/task/taskRecordSchemas.ts             TaskRecordSchema (completion_publication_pending normalization)
//   src/infra/task/taskLifecycleService.ts          claimNextTasks, failInterruptedRunningTasks, clearCompletionPublicationPending
//   src/features/tasks/execute/claimTasks.ts        publishSetupFailure, failInterruptedTasksWithGoalEvents
//   src/features/daemonTurn/reconcileLostRun.ts     reconcileLostRun
//   src/infra/task/taskStateReader.ts               WatchTaskSchema, readPendingGoalTaskCompletions
//   src/infra/daemon/persistedFiles.ts              saveGoalTaskCompletion, markGoalTaskCompletionPublished
//   src/features/daemon/pendingGoalTaskCompletions.ts publishPendingGoalTaskCompletions
//   src/features/daemon/watchSource.ts              FileDaemonWatchSource (hasWork, taskCompletions)
//   src/features/daemon/inbox.ts                    receiveInboxChange (deterministic eventId)
//
// DESIGN picks the implementation (single-ablation negative controls + Before + Fixed):
//   "Before"                   — current code: no completion_publication_pending mark, no daemon
//                                republisher, no pending hasWork, random per-file inbox eventId.
//   "FixedNoRepublisher"       — adds completion_publication_pending, hasWork, dedup, checked clear,
//                                and stale-deletion recovery, but disables daemon republishing.
//                                quiescentDelivery fails here only because the flag also enters
//                                republisherAccepts; drainedDelivery fails because no action delivers.
//   "FixedNoHasWork"           — full fix except hasWork ignores pendingPub, allowing premature
//                                daemon idle exit while pendingPub remains unsettled.
//   "FixedStaleDeletionBlocks" — full fix except daemon treats a dead deletion owner as blocking
//                                instead of recovering stale deletion reservations.
//   "FixedNoDedup"             — full fix except inbox.ts keeps random per-file eventId (proves
//                                deterministic dedup is load-bearing).
//   "FixedUncheckedClear"      — full fix except clear matches by task name without attempt
//                                identity (proves attempt-matched clearing is load-bearing).
//   "Fixed"                    — full fix: durable completion_publication_pending mark, daemon
//                                republisher, hasWork keeping daemon alive for pending marks,
//                                stale-deletion recovery, deterministic eventId per (task, attempt),
//                                attempt-matched clear, live-deletion guard, and aborted/deleted
//                                goal settlement.
//
// Two ways to check delivery:
//   safety (init/step)          — seven state invariants. quiescentDelivery reads the same guard
//                                 expressions the actions use, so it cannot see an action that keeps
//                                 its guard but stops doing its work.
//   drainedDelivery (initD/stepD) — after a drain phase that only allows forward progress actions,
//                                 the actions themselves must have delivered or settled every notice.
//                                 Run: quint run --init initD --step stepD --invariant drainedDelivery
//                                      --max-steps 70
module goalTaskCompletionPublication {
  const DESIGN: str

  type TaskId = str
  type Attempt = int
  type FailureKind = SetupFail | InterruptedFail | ReconcileFail
  type TaskStatus = Absent | Pending | Running | Failed
  type GoalStatus = Active | Paused | Aborted | Deleted
  type DeletionState = DelNone | DelAlive | DelDead

  type TaskRec = {
    status: TaskStatus,
    attempt: Attempt,
    hasCompletion: bool,
    pendingPub: bool,
    deletion: DeletionState,
    hasRunSlug: bool,
    hasExecId: bool,
  }

  type WriterPhase = WriterIdle | WriterSaved | WriterPublished
  type WriterState = {
    phase: WriterPhase,
    task: TaskId,
    attempt: Attempt,
    kind: FailureKind,
    hasRunSlug: bool,
    hasExecId: bool,
  }

  type DaemonPhase = DaemonIdle | DaemonRead | DaemonPublished
  type DaemonState = {
    phase: DaemonPhase,
    task: TaskId,
    attempt: Attempt,
    hasRunSlug: bool,
    hasExecId: bool,
  }

  type InboxFile = {
    fileId: int,
    task: TaskId,
    attempt: Attempt,
    hasRunSlug: bool,
    hasExecId: bool,
  }

  type EventKey =
    | FileKey(int)
    | RunKey((TaskId, Attempt))
    | ExecKey((TaskId, Attempt))

  pure val NONE_TASK: TaskId = ""
  pure val TASKS: Set[TaskId] = Set("t1", "t2")
  pure val MAX_ATTEMPTS: int = 2
  pure val MAX_FILES: int = 32
  pure val ATTEMPT_KEYS: Set[(TaskId, Attempt)] = tuples(TASKS, 1.to(MAX_ATTEMPTS))

  pure val IDLE_WRITER: WriterState = {
    phase: WriterIdle, task: NONE_TASK, attempt: 0, kind: SetupFail, hasRunSlug: false, hasExecId: false,
  }
  pure val IDLE_DAEMON: DaemonState = {
    phase: DaemonIdle, task: NONE_TASK, attempt: 0, hasRunSlug: false, hasExecId: false,
  }

  var tasks: TaskId -> TaskRec
  var goal: GoalStatus
  var writer: WriterState
  var daemon: DaemonState
  var daemonRunning: bool
  var inbox: Set[InboxFile]
  var nextFileId: int
  var acceptedKeys: Set[EventKey]
  var deferred: Set[(TaskId, Attempt)]
  var wakes: (TaskId, Attempt) -> int
  var failedAttempts: Set[(TaskId, Attempt)]
  var attemptKind: (TaskId, Attempt) -> str
  var writerPublished: Set[(TaskId, Attempt)]
  var daemonRepublished: Set[(TaskId, Attempt)]
  var staleDeletionRecovered: bool
  var lastAction: str

  // ---------- functional layer ----------

  pure def usesOutbox(design: str): bool = design != "Before"
  pure def usesRepublisher(design: str): bool = design != "Before" and design != "FixedNoRepublisher"
  pure def usesPendingHasWork(design: str): bool = design != "Before" and design != "FixedNoHasWork"
  pure def usesDedup(design: str): bool = design != "Before" and design != "FixedNoDedup"
  pure def usesCheckedClear(design: str): bool = design != "Before" and design != "FixedUncheckedClear"
  pure def usesStaleDeletionRecovery(design: str): bool = design != "Before" and design != "FixedStaleDeletionBlocks"

  pure def eventKeyFor(design: str, f: InboxFile): EventKey =
    if (not(usesDedup(design))) FileKey(f.fileId)
    else if (f.hasRunSlug) RunKey((f.task, f.attempt))
    else if (f.hasExecId) ExecKey((f.task, f.attempt))
    else FileKey(f.fileId)

  pure def deletionBlocks(allowStaleRecovery: bool, d: DeletionState): bool =
    if (allowStaleRecovery) d == DelAlive
    else d != DelNone

  pure def canClearPending(allowStaleRecovery: bool, design: str, rec: TaskRec, expectedAttempt: Attempt): bool =
    rec.status == Failed
      and rec.pendingPub
      and not(deletionBlocks(allowStaleRecovery, rec.deletion))
      and (not(usesCheckedClear(design)) or rec.attempt == expectedAttempt)

  pure def applyClearPending(
    ts: TaskId -> TaskRec,
    allowStaleRecovery: bool,
    design: str,
    t: TaskId,
    expectedAttempt: Attempt,
  ): TaskId -> TaskRec = {
    val rec = ts.get(t)
    if (canClearPending(allowStaleRecovery, design, rec, expectedAttempt))
      ts.set(t, { ...rec, pendingPub: false, deletion: DelNone })
    else ts
  }

  pure def clearsStaleDeletion(
    ts: TaskId -> TaskRec,
    allowStaleRecovery: bool,
    design: str,
    t: TaskId,
    expectedAttempt: Attempt,
  ): bool = {
    val rec = ts.get(t)
    canClearPending(allowStaleRecovery, design, rec, expectedAttempt) and (rec.deletion == DelDead)
  }

  pure def canReadPending(design: str, rec: TaskRec): bool =
    rec.status == Failed
      and rec.hasCompletion
      and rec.pendingPub
      and not(deletionBlocks(usesStaleDeletionRecovery(design), rec.deletion))
      and (rec.hasRunSlug or rec.hasExecId)

  pure def republisherAccepts(design: str, rec: TaskRec): bool =
    usesRepublisher(design) and canReadPending(design, rec)

  pure def daemonHasWork(
    design: str,
    g: GoalStatus,
    ts: TaskId -> TaskRec,
    ib: Set[InboxFile],
  ): bool = or {
    g == Active or g == Paused,
    ib.size() > 0,
    TASKS.exists(t => ts.get(t).status == Pending or ts.get(t).status == Running),
    usesPendingHasWork(design) and TASKS.exists(t => ts.get(t).pendingPub),
  }

  pure def kindLabel(k: FailureKind): str =
    match k {
      | SetupFail => "setup"
      | InterruptedFail => "interrupted"
      | ReconcileFail => "reconcile"
    }

  // ---------- state machine ----------

  action init = all {
    tasks' = TASKS.mapBy(_ => {
      status: Pending,
      attempt: 0,
      hasCompletion: false,
      pendingPub: false,
      deletion: DelNone,
      hasRunSlug: false,
      hasExecId: false,
    }),
    goal' = Active,
    writer' = IDLE_WRITER,
    daemon' = IDLE_DAEMON,
    daemonRunning' = true,
    inbox' = Set(),
    nextFileId' = 1,
    acceptedKeys' = Set(),
    deferred' = Set(),
    wakes' = ATTEMPT_KEYS.mapBy(_ => 0),
    failedAttempts' = Set(),
    attemptKind' = ATTEMPT_KEYS.mapBy(_ => "none"),
    writerPublished' = Set(),
    daemonRepublished' = Set(),
    staleDeletionRecovered' = false,
    lastAction' = "init",
  }

  // Normal claim starts a pending task (moves it to Running), enabling interrupted/reconcile failures.
  action startTask(t: TaskId, withRunSlug: bool): bool = {
    val rec = tasks.get(t)
    val nextAttempt = rec.attempt + 1
    all {
      goal == Active,
      rec.status == Pending,
      rec.deletion != DelAlive,
      nextAttempt <= MAX_ATTEMPTS,
      tasks' = tasks.set(t, {
        status: Running,
        attempt: nextAttempt,
        hasCompletion: false,
        pendingPub: false,
        deletion: DelNone,
        hasRunSlug: withRunSlug,
        hasExecId: true,
      }),
      goal' = goal, writer' = writer, daemon' = daemon, daemonRunning' = daemonRunning,
      inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
      wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
      staleDeletionRecovered' = staleDeletionRecovered,
      lastAction' = "startTask",
    }
  }

  // 1. Setup failure in claimNextTasks: Pending -> Failed directly, always has setup-<uuid> run_slug and execution_id.
  action writeSetupFailure(t: TaskId): bool = {
    val rec = tasks.get(t)
    val nextAttempt = rec.attempt + 1
    all {
      writer.phase == WriterIdle,
      goal == Active,
      rec.status == Pending,
      rec.deletion != DelAlive,
      nextAttempt <= MAX_ATTEMPTS,
      tasks' = tasks.set(t, {
        status: Failed,
        attempt: nextAttempt,
        hasCompletion: true,
        pendingPub: usesOutbox(DESIGN),
        deletion: DelNone,
        hasRunSlug: true,
        hasExecId: true,
      }),
      writer' = { phase: WriterSaved, task: t, attempt: nextAttempt, kind: SetupFail, hasRunSlug: true, hasExecId: true },
      failedAttempts' = failedAttempts.union(Set((t, nextAttempt))),
      attemptKind' = attemptKind.set((t, nextAttempt), kindLabel(SetupFail)),
      goal' = goal, daemon' = daemon, daemonRunning' = daemonRunning, inbox' = inbox,
      nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
      writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
      staleDeletionRecovered' = staleDeletionRecovered,
      lastAction' = "writeSetupFailure",
    }
  }

  // 2. Interrupted running task recovery in failInterruptedRunningTasks: Running -> Failed, guarantees run_slug.
  action writeInterruptedFailure(t: TaskId): bool = {
    val rec = tasks.get(t)
    all {
      writer.phase == WriterIdle,
      rec.status == Running,
      rec.deletion != DelAlive,
      tasks' = tasks.set(t, {
        ...rec,
        status: Failed,
        hasCompletion: true,
        pendingPub: usesOutbox(DESIGN),
        deletion: DelNone,
        hasRunSlug: true,
      }),
      writer' = { phase: WriterSaved, task: t, attempt: rec.attempt, kind: InterruptedFail, hasRunSlug: true, hasExecId: rec.hasExecId },
      failedAttempts' = failedAttempts.union(Set((t, rec.attempt))),
      attemptKind' = attemptKind.set((t, rec.attempt), kindLabel(InterruptedFail)),
      goal' = goal, daemon' = daemon, daemonRunning' = daemonRunning, inbox' = inbox,
      nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
      writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
      staleDeletionRecovered' = staleDeletionRecovered,
      lastAction' = "writeInterruptedFailure",
    }
  }

  // 3. Lost run reconciliation in reconcileLostRun: Running -> Failed; run_slug may be absent if process
  //    died before updateRunningTaskExecution, while Fixed ensures execution_id is present.
  action writeReconcileFailure(t: TaskId): bool = {
    val rec = tasks.get(t)
    val ensuredExecId = rec.hasExecId or (usesOutbox(DESIGN) and not(rec.hasRunSlug))
    all {
      writer.phase == WriterIdle,
      rec.status == Running,
      rec.deletion != DelAlive,
      tasks' = tasks.set(t, {
        ...rec,
        status: Failed,
        hasCompletion: true,
        pendingPub: usesOutbox(DESIGN),
        deletion: DelNone,
        hasExecId: ensuredExecId,
      }),
      writer' = { phase: WriterSaved, task: t, attempt: rec.attempt, kind: ReconcileFail, hasRunSlug: rec.hasRunSlug, hasExecId: ensuredExecId },
      failedAttempts' = failedAttempts.union(Set((t, rec.attempt))),
      attemptKind' = attemptKind.set((t, rec.attempt), kindLabel(ReconcileFail)),
      goal' = goal, daemon' = daemon, daemonRunning' = daemonRunning, inbox' = inbox,
      nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
      writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
      staleDeletionRecovered' = staleDeletionRecovered,
      lastAction' = "writeReconcileFailure",
    }
  }

  // Writer calls saveManagerEvent and succeeds: skips inbox write when goal is Aborted, throws on Deleted
  // (modelled in writerPublishFails); otherwise writes a new inbox file.
  action writerPublishOk: bool = all {
    writer.phase == WriterSaved,
    goal != Deleted,
    nextFileId <= MAX_FILES,
    if (goal == Aborted) all {
      inbox' = inbox,
      nextFileId' = nextFileId,
      writerPublished' = writerPublished,
    } else all {
      inbox' = inbox.union(Set({
        fileId: nextFileId,
        task: writer.task,
        attempt: writer.attempt,
        hasRunSlug: writer.hasRunSlug,
        hasExecId: writer.hasExecId,
      })),
      nextFileId' = nextFileId + 1,
      writerPublished' = writerPublished.union(Set((writer.task, writer.attempt))),
    },
    writer' = if (usesOutbox(DESIGN)) { ...writer, phase: WriterPublished } else IDLE_WRITER,
    tasks' = tasks, goal' = goal, daemon' = daemon, daemonRunning' = daemonRunning,
    acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    daemonRepublished' = daemonRepublished, staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "writerPublishOk",
  }

  // Writer's saveManagerEvent fails (ENOSPC, unreadable/missing goal.json, permission error).
  // In Fixed, pendingPub remains true so daemon will republish.
  action writerPublishFails: bool = all {
    writer.phase == WriterSaved,
    writer' = IDLE_WRITER,
    tasks' = tasks, goal' = goal, daemon' = daemon, daemonRunning' = daemonRunning,
    inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
    wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "writerPublishFails",
  }

  // Writer crashes after writing tasks.yaml (before saveManagerEvent) OR after saveManagerEvent (before clearing pendingPub).
  action writerCrash: bool = all {
    writer.phase != WriterIdle,
    writer' = IDLE_WRITER,
    tasks' = tasks, goal' = goal, daemon' = daemon, daemonRunning' = daemonRunning,
    inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
    wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "writerCrash",
  }

  // Writer clears completion_publication_pending after saveManagerEvent succeeded (via TaskStore.update,
  // which always clears stale dead deletions before running the mutator).
  action writerClearOk: bool = all {
    usesOutbox(DESIGN),
    writer.phase == WriterPublished,
    tasks' = applyClearPending(tasks, true, DESIGN, writer.task, writer.attempt),
    writer' = IDLE_WRITER,
    goal' = goal, daemon' = daemon, daemonRunning' = daemonRunning, inbox' = inbox,
    nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "writerClearOk",
  }

  // Writer fails to clear completion_publication_pending (tasks.yaml.lock timeout / ENOSPC).
  action writerClearFails: bool = all {
    usesOutbox(DESIGN),
    writer.phase == WriterPublished,
    writer' = IDLE_WRITER,
    tasks' = tasks, goal' = goal, daemon' = daemon, daemonRunning' = daemonRunning,
    inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
    wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "writerClearFails",
  }

  // Daemon watch tick reads tasks.yaml and picks a task with completion_publication_pending == true.
  action daemonReadPending(t: TaskId): bool = {
    val rec = tasks.get(t)
    all {
      daemonRunning,
      daemon.phase == DaemonIdle,
      republisherAccepts(DESIGN, rec),
      daemon' = { phase: DaemonRead, task: t, attempt: rec.attempt, hasRunSlug: rec.hasRunSlug, hasExecId: rec.hasExecId },
      tasks' = tasks, goal' = goal, writer' = writer, daemonRunning' = daemonRunning,
      inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
      wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
      staleDeletionRecovered' = staleDeletionRecovered,
      lastAction' = "daemonReadPending",
    }
  }

  // Daemon checks goal.json and writes the inbox event (if Active/Paused) or skips inbox write (if Aborted/Deleted).
  action daemonPublishOk: bool = all {
    daemonRunning,
    usesRepublisher(DESIGN),
    daemon.phase == DaemonRead,
    nextFileId <= MAX_FILES,
    if (goal == Aborted or goal == Deleted) all {
      inbox' = inbox,
      nextFileId' = nextFileId,
      daemonRepublished' = daemonRepublished,
    } else all {
      inbox' = inbox.union(Set({
        fileId: nextFileId,
        task: daemon.task,
        attempt: daemon.attempt,
        hasRunSlug: daemon.hasRunSlug,
        hasExecId: daemon.hasExecId,
      })),
      nextFileId' = nextFileId + 1,
      daemonRepublished' = daemonRepublished.union(Set((daemon.task, daemon.attempt))),
    },
    daemon' = { ...daemon, phase: DaemonPublished },
    tasks' = tasks, goal' = goal, writer' = writer, daemonRunning' = daemonRunning,
    acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "daemonPublishOk",
  }

  // Daemon fails reading goal.json (corrupt/EACCES/timeout) or writing inbox (ENOSPC): keeps pendingPub untouched.
  action daemonPublishFails: bool = all {
    daemonRunning,
    usesRepublisher(DESIGN),
    daemon.phase == DaemonRead,
    daemon' = IDLE_DAEMON,
    tasks' = tasks, goal' = goal, writer' = writer, daemonRunning' = daemonRunning,
    inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
    wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "daemonPublishFails",
  }

  // Daemon clears completion_publication_pending (and any stale dead deletion) under tasks.yaml.lock.
  action daemonClearOk: bool = all {
    daemonRunning,
    usesRepublisher(DESIGN),
    daemon.phase == DaemonPublished,
    tasks' = applyClearPending(tasks, usesStaleDeletionRecovery(DESIGN), DESIGN, daemon.task, daemon.attempt),
    daemon' = IDLE_DAEMON,
    staleDeletionRecovered' = (staleDeletionRecovered or clearsStaleDeletion(
      tasks, usesStaleDeletionRecovery(DESIGN), DESIGN, daemon.task, daemon.attempt
    )),
    goal' = goal, writer' = writer, daemonRunning' = daemonRunning, inbox' = inbox,
    nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    lastAction' = "daemonClearOk",
  }

  // Daemon fails to clear completion_publication_pending (lock timeout / ENOSPC / restart).
  action daemonClearFails: bool = all {
    daemonRunning,
    usesRepublisher(DESIGN),
    daemon.phase == DaemonPublished,
    daemon' = IDLE_DAEMON,
    tasks' = tasks, goal' = goal, writer' = writer, daemonRunning' = daemonRunning,
    inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
    wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "daemonClearFails",
  }

  // Daemon idle shutdown (runDaemon.ts idleCheck -> watchSource.hasWork):
  // exits when idle and hasWork returns false.
  action daemonIdleExit: bool = all {
    daemonRunning,
    daemon.phase == DaemonIdle,
    not(daemonHasWork(DESIGN, goal, tasks, inbox)),
    daemonRunning' = false,
    tasks' = tasks, goal' = goal, writer' = writer, daemon' = daemon, inbox' = inbox,
    nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "daemonIdleExit",
  }

  // receiveInboxChange + FileEventStore.accept + conversationService handling:
  // consumes one inbox file, deduplicates by eventKeyFor, wakes manager (Active), defers (Paused),
  // or discards (Aborted/Deleted), and unlinks the inbox file.
  action consumeInbox(f: InboxFile): bool = {
    val key = eventKeyFor(DESIGN, f)
    val isNew = not(acceptedKeys.contains(key))
    val pair = (f.task, f.attempt)
    all {
      daemonRunning,
      inbox.contains(f),
      inbox' = inbox.exclude(Set(f)),
      acceptedKeys' = acceptedKeys.union(Set(key)),
      if (isNew and goal == Active) all {
        wakes' = wakes.setBy(pair, n => n + 1),
        deferred' = deferred,
      } else if (isNew and goal == Paused) all {
        wakes' = wakes,
        deferred' = deferred.union(Set(pair)),
      } else all {
        // Duplicate, or Aborted/Deleted (discarded by conversationService without waking manager).
        wakes' = wakes,
        deferred' = deferred,
      },
      tasks' = tasks, goal' = goal, writer' = writer, daemon' = daemon, daemonRunning' = daemonRunning,
      nextFileId' = nextFileId, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
      staleDeletionRecovered' = staleDeletionRecovered,
      lastAction' = "consumeInbox",
    }
  }

  action consumeAnyInbox: bool = all {
    daemonRunning,
    inbox.size() > 0,
    nondet f = inbox.oneOf()
    consumeInbox(f),
  }

  // Requeue a failed task (clears completion, run_slug, execution_id, completion_publication_pending,
  // and any stale dead deletion reservation via TaskStore.update).
  action requeueTask(t: TaskId): bool = {
    val rec = tasks.get(t)
    all {
      goal == Active or goal == Paused,
      rec.status == Failed,
      rec.deletion != DelAlive,
      rec.attempt < MAX_ATTEMPTS,
      tasks' = tasks.set(t, {
        status: Pending,
        attempt: rec.attempt,
        hasCompletion: false,
        pendingPub: false,
        deletion: DelNone,
        hasRunSlug: false,
        hasExecId: false,
      }),
      goal' = goal, writer' = writer, daemon' = daemon, daemonRunning' = daemonRunning,
      inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
      wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
      staleDeletionRecovered' = staleDeletionRecovered,
      lastAction' = "requeueTask",
    }
  }

  // Task deletion reservation (deleteTaskWithCleanup step 1 / rollback / step 3 / owner crash).
  action reserveDeletion(t: TaskId): bool = {
    val rec = tasks.get(t)
    all {
      rec.status == Failed,
      rec.deletion != DelAlive,
      tasks' = tasks.set(t, { ...rec, deletion: DelAlive }),
      goal' = goal, writer' = writer, daemon' = daemon, daemonRunning' = daemonRunning,
      inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
      wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
      staleDeletionRecovered' = staleDeletionRecovered,
      lastAction' = "reserveDeletion",
    }
  }

  action cancelDeletion(t: TaskId): bool = {
    val rec = tasks.get(t)
    all {
      rec.deletion == DelAlive,
      tasks' = tasks.set(t, { ...rec, deletion: DelNone }),
      goal' = goal, writer' = writer, daemon' = daemon, daemonRunning' = daemonRunning,
      inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
      wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
      staleDeletionRecovered' = staleDeletionRecovered,
      lastAction' = "cancelDeletion",
    }
  }

  action deletionOwnerCrash(t: TaskId): bool = {
    val rec = tasks.get(t)
    all {
      rec.deletion == DelAlive,
      tasks' = tasks.set(t, { ...rec, deletion: DelDead }),
      goal' = goal, writer' = writer, daemon' = daemon, daemonRunning' = daemonRunning,
      inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
      wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
      staleDeletionRecovered' = staleDeletionRecovered,
      lastAction' = "deletionOwnerCrash",
    }
  }

  action finishDeletion(t: TaskId): bool = {
    val rec = tasks.get(t)
    all {
      rec.deletion == DelAlive,
      tasks' = tasks.set(t, {
        status: Absent,
        attempt: rec.attempt,
        hasCompletion: false,
        pendingPub: false,
        deletion: DelNone,
        hasRunSlug: false,
        hasExecId: false,
      }),
      goal' = goal, writer' = writer, daemon' = daemon, daemonRunning' = daemonRunning,
      inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
      wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
      staleDeletionRecovered' = staleDeletionRecovered,
      lastAction' = "finishDeletion",
    }
  }

  // Goal lifecycle transitions.
  action pauseGoal: bool = all {
    goal == Active,
    goal' = Paused,
    tasks' = tasks, writer' = writer, daemon' = daemon, daemonRunning' = daemonRunning,
    inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
    wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "pauseGoal",
  }

  action resumeGoal: bool = all {
    goal == Paused,
    goal' = Active,
    tasks' = tasks, writer' = writer, daemon' = daemon, daemonRunning' = daemonRunning,
    inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
    wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "resumeGoal",
  }

  // Deliver one deferred completion after the goal resumed.
  action deliverDeferred(pair: (TaskId, Attempt)): bool = all {
    daemonRunning,
    goal == Active,
    deferred.contains(pair),
    deferred' = deferred.exclude(Set(pair)),
    wakes' = wakes.setBy(pair, n => n + 1),
    tasks' = tasks, goal' = goal, writer' = writer, daemon' = daemon, daemonRunning' = daemonRunning,
    inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "deliverDeferred",
  }

  action deliverAnyDeferred: bool = all {
    daemonRunning,
    deferred.size() > 0,
    nondet pair = deferred.oneOf()
    deliverDeferred(pair),
  }

  // setGoalExecutionStatus(..., 'aborted'): deletes queued inbox files for the goal.
  action abortGoal: bool = all {
    goal == Active or goal == Paused,
    goal' = Aborted,
    inbox' = Set(),
    deferred' = Set(),
    tasks' = tasks, writer' = writer, daemon' = daemon, daemonRunning' = daemonRunning,
    nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "abortGoal",
  }

  // Goal directory deleted (either via deleteFinishedGoal or manually).
  action deleteGoal: bool = all {
    goal == Aborted,
    goal' = Deleted,
    inbox' = Set(),
    deferred' = Set(),
    tasks' = tasks, writer' = writer, daemon' = daemon, daemonRunning' = daemonRunning,
    nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    staleDeletionRecovered' = staleDeletionRecovered,
    lastAction' = "deleteGoal",
  }

  action step = {
    nondet t = TASKS.oneOf()
    nondet withRunSlug = Set(true, false).oneOf()
    any {
      startTask(t, withRunSlug),
      writeSetupFailure(t),
      writeInterruptedFailure(t),
      writeReconcileFailure(t),
      writerPublishOk,
      writerPublishFails,
      writerCrash,
      writerClearOk,
      writerClearFails,
      daemonReadPending(t),
      daemonPublishOk,
      daemonPublishFails,
      daemonClearOk,
      daemonClearFails,
      daemonIdleExit,
      consumeAnyInbox,
      deliverAnyDeferred,
      requeueTask(t),
      reserveDeletion(t),
      cancelDeletion(t),
      deletionOwnerCrash(t),
      finishDeletion(t),
      pauseGoal,
      resumeGoal,
      abortGoal,
      deleteGoal,
    }
  }

  // ---------- drain phase (bounded progress check) ----------
  // stepD runs the ordinary step until it nondeterministically enters the drain phase. From then on,
  // failures (publish/clear failures, crashes) and outside changes (new tasks, requeue, pause, abort,
  // delete, new deletion reservations) stop, and only actions that move a notice forward may run.
  // Each drain step may also stutter, so the simulator never deadlocks once everything is settled.
  // drainedDelivery then checks the effect of the actions, not their guards: if an action keeps its
  // guard but stops publishing or clearing, the notice is never delivered or settled.
  var drain: bool
  var dsteps: int

  pure val DRAIN_STEPS: int = 40

  action initD: bool = all { init, drain' = false, dsteps' = 0 }

  action unchangedModel: bool = all {
    tasks' = tasks, goal' = goal, writer' = writer, daemon' = daemon, daemonRunning' = daemonRunning,
    inbox' = inbox, nextFileId' = nextFileId, acceptedKeys' = acceptedKeys, deferred' = deferred,
    wakes' = wakes, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    writerPublished' = writerPublished, daemonRepublished' = daemonRepublished,
    staleDeletionRecovered' = staleDeletionRecovered, lastAction' = lastAction,
  }

  action progress: bool = {
    nondet t = TASKS.oneOf()
    any {
      writerPublishOk,
      writerClearOk,
      daemonReadPending(t),
      daemonPublishOk,
      daemonClearOk,
      daemonIdleExit,
      consumeAnyInbox,
      deliverAnyDeferred,
      cancelDeletion(t),
      finishDeletion(t),
      deletionOwnerCrash(t),
      resumeGoal,
    }
  }

  action stepD: bool = any {
    all { not(drain), step, drain' = false, dsteps' = 0 },
    all { not(drain), unchangedModel, drain' = true, dsteps' = 0 },
    all { drain, progress, drain' = true, dsteps' = dsteps + 1 },
    all { drain, unchangedModel, drain' = true, dsteps' = dsteps + 1 },
  }

  val drainSettled: bool = TASKS.forall(t => {
    val rec = tasks.get(t)
    and {
      (goal == Active and rec.status == Failed and rec.hasCompletion) implies wakes.get((t, rec.attempt)) >= 1,
      (goal == Aborted or goal == Deleted) implies not(rec.pendingPub),
    }
  })

  // 8. Drained delivery: DRAIN_STEPS drain steps after the drain began, every failed goal task with
  //    completion under an Active goal has woken the manager, and no pendingPub mark remains under an
  //    Aborted or Deleted goal. (A Paused goal is resumed by resumeGoal during the drain.)
  val drainedDelivery: bool = (drain and dsteps >= DRAIN_STEPS) implies drainSettled

  // Drain witnesses: the drain reached DRAIN_STEPS after a delivery, after a daemon-only delivery,
  // and after an Aborted/Deleted settlement with the daemon idle-exited.
  val wDrainedWoke: bool = drain and dsteps >= DRAIN_STEPS and ATTEMPT_KEYS.exists(p => wakes.get(p) == 1)
  val wDrainedDaemonOnlyWoke: bool = drain and dsteps >= DRAIN_STEPS
    and ATTEMPT_KEYS.exists(p => wakes.get(p) == 1 and daemonRepublished.contains(p) and not(writerPublished.contains(p)))
  val wDrainedSettledExit: bool = drain and dsteps >= DRAIN_STEPS and not(daemonRunning)
    and (goal == Aborted or goal == Deleted) and failedAttempts != Set()

  // ---------- properties ----------

  // 1. At-most-once manager wake per (task, attempt).
  val noDuplicateManagerWake: bool =
    ATTEMPT_KEYS.forall(pair => wakes.get(pair) <= 1)

  // 2. No lost completion notice: any current failed goal task with completion under a live
  //    (Active or Paused) goal is either already woken/deferred, in inbox, held by a live
  //    pre-publish writer, or durably marked pendingPub in tasks.yaml.
  val noUnrecoverableLoss: bool =
    (goal == Active or goal == Paused) implies TASKS.forall(t => {
      val rec = tasks.get(t)
      (rec.status == Failed and rec.hasCompletion) implies or {
        wakes.get((t, rec.attempt)) >= 1,
        deferred.contains((t, rec.attempt)),
        inbox.exists(f => f.task == t and f.attempt == rec.attempt),
        writer.phase == WriterSaved and writer.task == t and writer.attempt == rec.attempt,
        rec.pendingPub,
      }
    })

  // 3. Schema invariant: pendingPub is only set on a Failed task with completion and an attempt key.
  val pendingPubSchemaValid: bool =
    TASKS.forall(t => {
      val rec = tasks.get(t)
      rec.pendingPub implies (rec.status == Failed and rec.hasCompletion and rec.attempt > 0 and (rec.hasRunSlug or rec.hasExecId))
    })

  // 4. Manager never wakes for an attempt that was not saved as Failed.
  val noPhantomWake: bool =
    ATTEMPT_KEYS.forall(pair => (wakes.get(pair) > 0 or deferred.contains(pair)) implies failedAttempts.contains(pair))

  // 5. No deferred completions remain once a goal is Aborted or Deleted.
  val noDeferredWhenAbortedOrDeleted: bool =
    (goal == Aborted or goal == Deleted) implies deferred == Set()

  // 6. Daemon never idle-exits while live goal work, inbox files, active tasks, or pendingPub marks remain.
  val noDaemonExitWithWork: bool =
    not(daemonRunning) implies and {
      goal == Aborted or goal == Deleted,
      inbox == Set(),
      deferred == Set(),
      TASKS.forall(t => {
        val rec = tasks.get(t)
        rec.status != Pending and rec.status != Running and not(rec.pendingPub)
      }),
    }

  // 7. Quiescent delivery (state property):
  //    taskRecoveryEnabled is true when a recovery, delivery, or live-deletion guard holds for task t.
  //    It does NOT assume not(rec.pendingPub): if pendingPub is set but no republisher guard accepts it
  //    (daemon exited early, or a dead deletion blocks it), quiescentDelivery fails.
  //    Limit: taskRecoveryEnabled copies the action guards (e.g. republisherAccepts). An action that
  //    keeps its guard but stops doing its work (daemonReadPending never firing, daemonClearOk not
  //    clearing) still passes. drainedDelivery covers that case.
  pure def taskRecoveryEnabled(
    design: str,
    dRunning: bool,
    g: GoalStatus,
    w: WriterState,
    d: DaemonState,
    ib: Set[InboxFile],
    defSet: Set[(TaskId, Attempt)],
    t: TaskId,
    rec: TaskRec,
  ): bool = or {
    w.phase != WriterIdle and w.task == t and w.attempt == rec.attempt,
    dRunning and d.phase != DaemonIdle and d.task == t and d.attempt == rec.attempt,
    dRunning and republisherAccepts(design, rec),
    dRunning and ib.exists(f => f.task == t and f.attempt == rec.attempt),
    dRunning and g == Active and defSet.contains((t, rec.attempt)),
    rec.deletion == DelAlive,
  }

  val quiescentDelivery: bool =
    TASKS.forall(t => {
      val rec = tasks.get(t)
      not(taskRecoveryEnabled(DESIGN, daemonRunning, goal, writer, daemon, inbox, deferred, t, rec)) implies and {
        (goal == Active and rec.status == Failed and rec.hasCompletion) implies wakes.get((t, rec.attempt)) >= 1,
        (goal == Paused and rec.status == Failed and rec.hasCompletion) implies
          (wakes.get((t, rec.attempt)) >= 1 or deferred.contains((t, rec.attempt))),
        (goal == Aborted or goal == Deleted) implies not(rec.pendingPub),
      }
    })

  val safety: bool = and {
    noDuplicateManagerWake,
    noUnrecoverableLoss,
    pendingPubSchemaValid,
    noPhantomWake,
    noDeferredWhenAbortedOrDeleted,
    noDaemonExitWithWork,
    quiescentDelivery,
  }

  // ---------- witnesses ----------
  val wSetupFailWoke: bool = ATTEMPT_KEYS.exists(p => attemptKind.get(p) == "setup" and wakes.get(p) == 1)
  val wInterruptedFailWoke: bool = ATTEMPT_KEYS.exists(p => attemptKind.get(p) == "interrupted" and wakes.get(p) == 1)
  val wReconcileFailWoke: bool = ATTEMPT_KEYS.exists(p => attemptKind.get(p) == "reconcile" and wakes.get(p) == 1)
  val wReconcileWithoutRunSlugWoke: bool = TASKS.exists(t =>
    tasks.get(t).status == Failed and not(tasks.get(t).hasRunSlug) and wakes.get((t, tasks.get(t).attempt)) == 1)
  val wDaemonRepublished: bool = lastAction == "daemonClearOk" and ATTEMPT_KEYS.exists(p => wakes.get(p) == 1)
  val wDaemonSoleRepublishWoke: bool =
    TASKS.exists(t => {
      val rec = tasks.get(t)
      val pair = (t, rec.attempt)
      and {
        goal == Active,
        rec.status == Failed,
        not(rec.pendingPub),
        not(writerPublished.contains(pair)),
        daemonRepublished.contains(pair),
        wakes.get(pair) == 1,
        not(taskRecoveryEnabled(DESIGN, daemonRunning, goal, writer, daemon, inbox, deferred, t, rec)),
      }
    })
  val wSecondAttemptWoke: bool = TASKS.exists(t => wakes.get((t, 2)) == 1)
  val wDeferredDelivered: bool = lastAction == "deliverDeferred"
  val wAbortedSettled: bool = goal == Aborted and lastAction == "daemonClearOk"
  val wDeletedSettled: bool = goal == Deleted and lastAction == "daemonClearOk"
  val wDeletionReserved: bool = lastAction == "finishDeletion"
  val wStaleDeletionRecovered: bool = staleDeletionRecovered
  val wDaemonIdleExitedAfterSettle: bool =
    not(daemonRunning)
      and (goal == Aborted or goal == Deleted)
      and TASKS.forall(t => not(tasks.get(t).pendingPub))
}

module before { import goalTaskCompletionPublication(DESIGN = "Before").* from "./goalTaskCompletionPublication" }
module fixedNoRepublisher { import goalTaskCompletionPublication(DESIGN = "FixedNoRepublisher").* from "./goalTaskCompletionPublication" }
module fixedNoHasWork { import goalTaskCompletionPublication(DESIGN = "FixedNoHasWork").* from "./goalTaskCompletionPublication" }
module fixedStaleDeletionBlocks { import goalTaskCompletionPublication(DESIGN = "FixedStaleDeletionBlocks").* from "./goalTaskCompletionPublication" }
module fixedNoDedup { import goalTaskCompletionPublication(DESIGN = "FixedNoDedup").* from "./goalTaskCompletionPublication" }
module fixedUncheckedClear { import goalTaskCompletionPublication(DESIGN = "FixedUncheckedClear").* from "./goalTaskCompletionPublication" }
module fixed { import goalTaskCompletionPublication(DESIGN = "Fixed").* from "./goalTaskCompletionPublication" }

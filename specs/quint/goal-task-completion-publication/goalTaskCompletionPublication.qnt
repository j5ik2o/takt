// -*- mode: Bluespec; -*-
// Durable outbox publication of goal task completion notices (issue #170).
// Covers setup failures in claimNextTasks, interrupted running task recovery in
// failInterruptedRunningTasks, and lost-run reconciliation in reconcileLostRun.
//
// Code:
//   src/infra/task/taskRecordSchemas.ts             TaskRecordSchema (completion_publication_pending)
//   src/infra/task/taskLifecycleService.ts          claimNextTasks, failInterruptedRunningTasks, clearCompletionPublicationPending
//   src/features/tasks/execute/claimTasks.ts        publishSetupFailure, failInterruptedTasksWithGoalEvents
//   src/features/daemonTurn/reconcileLostRun.ts     reconcileLostRun
//   src/infra/task/taskStateReader.ts               WatchTaskSchema, readWatchTasks
//   src/infra/daemon/persistedFiles.ts              saveGoalTaskCompletion, markGoalTaskCompletionPublished
//   src/features/daemon/pendingGoalTaskCompletions.ts publishPendingGoalTaskCompletions
//   src/features/daemon/watchSource.ts              FileDaemonWatchSource (hasWork, taskCompletions)
//   src/features/daemon/inbox.ts                    receiveInboxChange (deterministic eventId)
//
// DESIGN picks the implementation:
//   "Before"              — current code: no completion_publication_pending mark, no daemon
//                           republisher for terminal failed tasks, random per-file inbox eventId.
//   "FixedNoDedup"        — adds completion_publication_pending and daemon republisher, but keeps
//                           random per-file inbox eventId in inbox.ts (proves dedup is load-bearing).
//   "FixedUncheckedClear" — adds completion_publication_pending, daemon republisher, and dedup, but
//                           clears the pending mark by task name without matching attempt identity
//                           (proves attempt-matched clearing is load-bearing).
//   "Fixed"               — full fix: durable completion_publication_pending mark, daemon
//                           republisher, deterministic eventId per (task, attempt), attempt-matched
//                           clear, deletion-reservation guard, and aborted/deleted goal settlement.
module goalTaskCompletionPublication {
  const DESIGN: str

  type TaskId = str
  type Attempt = int
  type FailureKind = SetupFail | InterruptedFail | ReconcileFail
  type TaskStatus = Absent | Pending | Running | Failed
  type GoalStatus = Active | Paused | Aborted | Deleted

  type TaskRec = {
    status: TaskStatus,
    attempt: Attempt,
    hasCompletion: bool,
    pendingPub: bool,
    deleting: bool,
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
  pure val MAX_FILES: int = 16
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
  var inbox: Set[InboxFile]
  var nextFileId: int
  var acceptedKeys: Set[EventKey]
  var deferred: Set[(TaskId, Attempt)]
  var wakes: (TaskId, Attempt) -> int
  var failedAttempts: Set[(TaskId, Attempt)]
  var attemptKind: (TaskId, Attempt) -> str
  var lastAction: str

  // ---------- functional layer ----------

  pure def usesOutbox(design: str): bool = design != "Before"
  pure def usesDedup(design: str): bool = design == "Fixed" or design == "FixedUncheckedClear"
  pure def usesCheckedClear(design: str): bool = design == "Fixed" or design == "FixedNoDedup"

  pure def eventKeyFor(design: str, f: InboxFile): EventKey =
    if (not(usesDedup(design))) FileKey(f.fileId)
    else if (f.hasRunSlug) RunKey((f.task, f.attempt))
    else if (f.hasExecId) ExecKey((f.task, f.attempt))
    else FileKey(f.fileId)

  pure def canClearPending(design: str, rec: TaskRec, expectedAttempt: Attempt): bool =
    rec.status == Failed
      and rec.pendingPub
      and not(rec.deleting)
      and (not(usesCheckedClear(design)) or rec.attempt == expectedAttempt)

  pure def applyClearPending(ts: TaskId -> TaskRec, design: str, t: TaskId, expectedAttempt: Attempt): TaskId -> TaskRec = {
    val rec = ts.get(t)
    if (canClearPending(design, rec, expectedAttempt)) ts.set(t, { ...rec, pendingPub: false })
    else ts
  }

  pure def canReadPending(rec: TaskRec): bool =
    rec.status == Failed
      and rec.hasCompletion
      and rec.pendingPub
      and not(rec.deleting)
      and (rec.hasRunSlug or rec.hasExecId)

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
      deleting: false,
      hasRunSlug: false,
      hasExecId: false,
    }),
    goal' = Active,
    writer' = IDLE_WRITER,
    daemon' = IDLE_DAEMON,
    inbox' = Set(),
    nextFileId' = 1,
    acceptedKeys' = Set(),
    deferred' = Set(),
    wakes' = ATTEMPT_KEYS.mapBy(_ => 0),
    failedAttempts' = Set(),
    attemptKind' = ATTEMPT_KEYS.mapBy(_ => "none"),
    lastAction' = "init",
  }

  // Normal claim starts a pending task (moves it to Running), enabling interrupted/reconcile failures.
  action startTask(t: TaskId, withRunSlug: bool): bool = {
    val rec = tasks.get(t)
    val nextAttempt = rec.attempt + 1
    all {
      goal == Active,
      rec.status == Pending,
      not(rec.deleting),
      nextAttempt <= MAX_ATTEMPTS,
      tasks' = tasks.set(t, {
        status: Running,
        attempt: nextAttempt,
        hasCompletion: false,
        pendingPub: false,
        deleting: false,
        hasRunSlug: withRunSlug,
        hasExecId: true,
      }),
      goal' = goal, writer' = writer, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
      acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
      failedAttempts' = failedAttempts, attemptKind' = attemptKind,
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
      not(rec.deleting),
      nextAttempt <= MAX_ATTEMPTS,
      tasks' = tasks.set(t, {
        status: Failed,
        attempt: nextAttempt,
        hasCompletion: true,
        pendingPub: usesOutbox(DESIGN),
        deleting: false,
        hasRunSlug: true,
        hasExecId: true,
      }),
      writer' = { phase: WriterSaved, task: t, attempt: nextAttempt, kind: SetupFail, hasRunSlug: true, hasExecId: true },
      failedAttempts' = failedAttempts.union(Set((t, nextAttempt))),
      attemptKind' = attemptKind.set((t, nextAttempt), kindLabel(SetupFail)),
      goal' = goal, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
      acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
      lastAction' = "writeSetupFailure",
    }
  }

  // 2. Interrupted running task recovery in failInterruptedRunningTasks: Running -> Failed, guarantees run_slug.
  action writeInterruptedFailure(t: TaskId): bool = {
    val rec = tasks.get(t)
    all {
      writer.phase == WriterIdle,
      rec.status == Running,
      not(rec.deleting),
      tasks' = tasks.set(t, {
        ...rec,
        status: Failed,
        hasCompletion: true,
        pendingPub: usesOutbox(DESIGN),
        hasRunSlug: true,
      }),
      writer' = { phase: WriterSaved, task: t, attempt: rec.attempt, kind: InterruptedFail, hasRunSlug: true, hasExecId: rec.hasExecId },
      failedAttempts' = failedAttempts.union(Set((t, rec.attempt))),
      attemptKind' = attemptKind.set((t, rec.attempt), kindLabel(InterruptedFail)),
      goal' = goal, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
      acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
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
      not(rec.deleting),
      tasks' = tasks.set(t, {
        ...rec,
        status: Failed,
        hasCompletion: true,
        pendingPub: usesOutbox(DESIGN),
        hasExecId: ensuredExecId,
      }),
      writer' = { phase: WriterSaved, task: t, attempt: rec.attempt, kind: ReconcileFail, hasRunSlug: rec.hasRunSlug, hasExecId: ensuredExecId },
      failedAttempts' = failedAttempts.union(Set((t, rec.attempt))),
      attemptKind' = attemptKind.set((t, rec.attempt), kindLabel(ReconcileFail)),
      goal' = goal, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
      acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
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
    } else all {
      inbox' = inbox.union(Set({
        fileId: nextFileId,
        task: writer.task,
        attempt: writer.attempt,
        hasRunSlug: writer.hasRunSlug,
        hasExecId: writer.hasExecId,
      })),
      nextFileId' = nextFileId + 1,
    },
    writer' = if (usesOutbox(DESIGN)) { ...writer, phase: WriterPublished } else IDLE_WRITER,
    tasks' = tasks, goal' = goal, daemon' = daemon,
    acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    lastAction' = "writerPublishOk",
  }

  // Writer's saveManagerEvent fails (ENOSPC, unreadable/missing goal.json, permission error).
  // In Fixed, pendingPub remains true so daemon will republish.
  action writerPublishFails: bool = all {
    writer.phase == WriterSaved,
    writer' = IDLE_WRITER,
    tasks' = tasks, goal' = goal, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
    acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    lastAction' = "writerPublishFails",
  }

  // Writer crashes after writing tasks.yaml (before saveManagerEvent) OR after saveManagerEvent (before clearing pendingPub).
  action writerCrash: bool = all {
    writer.phase != WriterIdle,
    writer' = IDLE_WRITER,
    tasks' = tasks, goal' = goal, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
    acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    lastAction' = "writerCrash",
  }

  // Writer clears completion_publication_pending after saveManagerEvent succeeded.
  action writerClearOk: bool = all {
    usesOutbox(DESIGN),
    writer.phase == WriterPublished,
    tasks' = applyClearPending(tasks, DESIGN, writer.task, writer.attempt),
    writer' = IDLE_WRITER,
    goal' = goal, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
    acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    lastAction' = "writerClearOk",
  }

  // Writer fails to clear completion_publication_pending (tasks.yaml.lock timeout / ENOSPC).
  action writerClearFails: bool = all {
    usesOutbox(DESIGN),
    writer.phase == WriterPublished,
    writer' = IDLE_WRITER,
    tasks' = tasks, goal' = goal, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
    acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    lastAction' = "writerClearFails",
  }

  // Daemon watch tick reads tasks.yaml and picks a task with completion_publication_pending == true.
  action daemonReadPending(t: TaskId): bool = {
    val rec = tasks.get(t)
    all {
      usesOutbox(DESIGN),
      daemon.phase == DaemonIdle,
      canReadPending(rec),
      daemon' = { phase: DaemonRead, task: t, attempt: rec.attempt, hasRunSlug: rec.hasRunSlug, hasExecId: rec.hasExecId },
      tasks' = tasks, goal' = goal, writer' = writer, inbox' = inbox, nextFileId' = nextFileId,
      acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
      failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      lastAction' = "daemonReadPending",
    }
  }

  // Daemon checks goal.json and writes the inbox event (if Active/Paused) or skips inbox write (if Aborted/Deleted).
  action daemonPublishOk: bool = all {
    usesOutbox(DESIGN),
    daemon.phase == DaemonRead,
    nextFileId <= MAX_FILES,
    if (goal == Aborted or goal == Deleted) all {
      inbox' = inbox,
      nextFileId' = nextFileId,
    } else all {
      inbox' = inbox.union(Set({
        fileId: nextFileId,
        task: daemon.task,
        attempt: daemon.attempt,
        hasRunSlug: daemon.hasRunSlug,
        hasExecId: daemon.hasExecId,
      })),
      nextFileId' = nextFileId + 1,
    },
    daemon' = { ...daemon, phase: DaemonPublished },
    tasks' = tasks, goal' = goal, writer' = writer,
    acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    lastAction' = "daemonPublishOk",
  }

  // Daemon fails reading goal.json (corrupt/EACCES/timeout) or writing inbox (ENOSPC): keeps pendingPub untouched.
  action daemonPublishFails: bool = all {
    usesOutbox(DESIGN),
    daemon.phase == DaemonRead,
    daemon' = IDLE_DAEMON,
    tasks' = tasks, goal' = goal, writer' = writer, inbox' = inbox, nextFileId' = nextFileId,
    acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    lastAction' = "daemonPublishFails",
  }

  // Daemon clears completion_publication_pending in tasks.yaml under tasks.yaml.lock.
  action daemonClearOk: bool = all {
    usesOutbox(DESIGN),
    daemon.phase == DaemonPublished,
    tasks' = applyClearPending(tasks, DESIGN, daemon.task, daemon.attempt),
    daemon' = IDLE_DAEMON,
    goal' = goal, writer' = writer, inbox' = inbox, nextFileId' = nextFileId,
    acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    lastAction' = "daemonClearOk",
  }

  // Daemon fails to clear completion_publication_pending (lock timeout / ENOSPC / restart).
  action daemonClearFails: bool = all {
    usesOutbox(DESIGN),
    daemon.phase == DaemonPublished,
    daemon' = IDLE_DAEMON,
    tasks' = tasks, goal' = goal, writer' = writer, inbox' = inbox, nextFileId' = nextFileId,
    acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    lastAction' = "daemonClearFails",
  }

  // receiveInboxChange + FileEventStore.accept + conversationService handling:
  // consumes one inbox file, deduplicates by eventKeyFor, wakes manager (Active), defers (Paused),
  // or discards (Aborted/Deleted), and unlinks the inbox file.
  action consumeInbox(f: InboxFile): bool = {
    val key = eventKeyFor(DESIGN, f)
    val isNew = not(acceptedKeys.contains(key))
    val pair = (f.task, f.attempt)
    all {
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
      tasks' = tasks, goal' = goal, writer' = writer, daemon' = daemon, nextFileId' = nextFileId,
      failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      lastAction' = "consumeInbox",
    }
  }

  action consumeAnyInbox: bool = all {
    inbox.size() > 0,
    nondet f = inbox.oneOf()
    consumeInbox(f),
  }

  // Requeue a failed task (clears completion, run_slug, execution_id, completion_publication_pending).
  action requeueTask(t: TaskId): bool = {
    val rec = tasks.get(t)
    all {
      rec.status == Failed,
      not(rec.deleting),
      rec.attempt < MAX_ATTEMPTS,
      tasks' = tasks.set(t, {
        status: Pending,
        attempt: rec.attempt,
        hasCompletion: false,
        pendingPub: false,
        deleting: false,
        hasRunSlug: false,
        hasExecId: false,
      }),
      goal' = goal, writer' = writer, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
      acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
      failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      lastAction' = "requeueTask",
    }
  }

  // Task deletion reservation (deleteTaskWithCleanup step 1 / rollback / step 3).
  action reserveDeletion(t: TaskId): bool = {
    val rec = tasks.get(t)
    all {
      rec.status == Failed,
      not(rec.deleting),
      tasks' = tasks.set(t, { ...rec, deleting: true }),
      goal' = goal, writer' = writer, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
      acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
      failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      lastAction' = "reserveDeletion",
    }
  }

  action cancelDeletion(t: TaskId): bool = {
    val rec = tasks.get(t)
    all {
      rec.deleting,
      tasks' = tasks.set(t, { ...rec, deleting: false }),
      goal' = goal, writer' = writer, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
      acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
      failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      lastAction' = "cancelDeletion",
    }
  }

  action finishDeletion(t: TaskId): bool = {
    val rec = tasks.get(t)
    all {
      rec.deleting,
      tasks' = tasks.set(t, {
        status: Absent,
        attempt: rec.attempt,
        hasCompletion: false,
        pendingPub: false,
        deleting: false,
        hasRunSlug: false,
        hasExecId: false,
      }),
      goal' = goal, writer' = writer, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
      acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
      failedAttempts' = failedAttempts, attemptKind' = attemptKind,
      lastAction' = "finishDeletion",
    }
  }

  // Goal lifecycle transitions.
  action pauseGoal: bool = all {
    goal == Active,
    goal' = Paused,
    tasks' = tasks, writer' = writer, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
    acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    lastAction' = "pauseGoal",
  }

  action resumeGoal: bool = all {
    goal == Paused,
    goal' = Active,
    tasks' = tasks, writer' = writer, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
    acceptedKeys' = acceptedKeys, deferred' = deferred, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    lastAction' = "resumeGoal",
  }

  // Deliver one deferred completion after the goal resumed.
  action deliverDeferred(pair: (TaskId, Attempt)): bool = all {
    goal == Active,
    deferred.contains(pair),
    deferred' = deferred.exclude(Set(pair)),
    wakes' = wakes.setBy(pair, n => n + 1),
    tasks' = tasks, goal' = goal, writer' = writer, daemon' = daemon, inbox' = inbox, nextFileId' = nextFileId,
    acceptedKeys' = acceptedKeys, failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    lastAction' = "deliverDeferred",
  }

  action deliverAnyDeferred: bool = all {
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
    tasks' = tasks, writer' = writer, daemon' = daemon, nextFileId' = nextFileId,
    acceptedKeys' = acceptedKeys, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
    lastAction' = "abortGoal",
  }

  // Goal directory deleted (either via deleteFinishedGoal or manually).
  action deleteGoal: bool = all {
    goal == Aborted,
    goal' = Deleted,
    inbox' = Set(),
    deferred' = Set(),
    tasks' = tasks, writer' = writer, daemon' = daemon, nextFileId' = nextFileId,
    acceptedKeys' = acceptedKeys, wakes' = wakes,
    failedAttempts' = failedAttempts, attemptKind' = attemptKind,
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
      consumeAnyInbox,
      deliverAnyDeferred,
      requeueTask(t),
      reserveDeletion(t),
      cancelDeletion(t),
      finishDeletion(t),
      pauseGoal,
      resumeGoal,
      abortGoal,
      deleteGoal,
    }
  }

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

  val safety: bool = and {
    noDuplicateManagerWake,
    noUnrecoverableLoss,
    pendingPubSchemaValid,
    noPhantomWake,
    noDeferredWhenAbortedOrDeleted,
  }

  // ---------- witnesses ----------
  val wSetupFailWoke: bool = ATTEMPT_KEYS.exists(p => attemptKind.get(p) == "setup" and wakes.get(p) == 1)
  val wInterruptedFailWoke: bool = ATTEMPT_KEYS.exists(p => attemptKind.get(p) == "interrupted" and wakes.get(p) == 1)
  val wReconcileFailWoke: bool = ATTEMPT_KEYS.exists(p => attemptKind.get(p) == "reconcile" and wakes.get(p) == 1)
  val wReconcileWithoutRunSlugWoke: bool = TASKS.exists(t =>
    tasks.get(t).status == Failed and not(tasks.get(t).hasRunSlug) and wakes.get((t, tasks.get(t).attempt)) == 1)
  val wDaemonRepublished: bool = lastAction == "daemonClearOk" and ATTEMPT_KEYS.exists(p => wakes.get(p) == 1)
  val wSecondAttemptWoke: bool = TASKS.exists(t => wakes.get((t, 2)) == 1)
  val wDeferredDelivered: bool = lastAction == "deliverDeferred"
  val wAbortedSettled: bool = goal == Aborted and lastAction == "daemonClearOk"
  val wDeletedSettled: bool = goal == Deleted and lastAction == "daemonClearOk"
  val wDeletionReserved: bool = lastAction == "finishDeletion"
}

module before { import goalTaskCompletionPublication(DESIGN = "Before").* from "./goalTaskCompletionPublication" }
module fixedNoDedup { import goalTaskCompletionPublication(DESIGN = "FixedNoDedup").* from "./goalTaskCompletionPublication" }
module fixedUncheckedClear { import goalTaskCompletionPublication(DESIGN = "FixedUncheckedClear").* from "./goalTaskCompletionPublication" }
module fixed { import goalTaskCompletionPublication(DESIGN = "Fixed").* from "./goalTaskCompletionPublication" }

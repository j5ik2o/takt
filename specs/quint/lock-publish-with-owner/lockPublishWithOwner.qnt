// -*- mode: Bluespec; -*-
// The publication of a lock together with its owner record: the shape after the fix.
// Read with specs/quint/lock-publish-with-owner/README.md.
//
// Scope of this model: one writer and one run. No trace has two writers in flight at the same
// time, and no trace attempts the run twice. `Writer` is a plain acquisition by a process that is
// not the run, the enqueue, or the abort.
//
// Guarded property: a killed writer publishes no lock that has no owner record.
//
// The writer creates a candidate that is not at the lock path, writes its owner record into that
// candidate, and then publishes once. A writer killed before the record leaves the path empty, and
// the next acquisition succeeds. directCreate is kept: the candidate stays outside the path.
//
// Run 2 and run 14 share the prefix up to the written record. Run 2 kills the writer there and the
// publication cannot be written; run 14 does not kill it and publishes with the record. The test
// module asserts that disabledness on a candidate that already carries the record, so the kill is
// the only difference from the state that can publish.
//
// The operation that created the candidate is `op`. The run never writes `op`, and `Op` has no
// value for the run: the run's progress is `acquire` alone. Once `acquire` is no longer `NotTried`
// the publication, the enqueue success, and the abort success are closed by that one condition,
// not by a caller that the run overwrote.
//
// A failure before the owner record is written is not an acquisition. It is terminal for this
// attempt: `failedBeforeWrite` never coexists with `acquire != NotTried` or with a published lock,
// and every transition that could publish, succeed, or acquire also reads it.
//
// No transition discards an empty lock file after 30 s, and no constant for such a wait is
// declared. An empty lock that is already at the path stays there, and the run fails instead of
// waiting it out or succeeding over it.
//
// The properties are not `val`s here: a guarded `val` reads as true just from its guard. Each
// property is asserted on the concrete state in lockPublishWithOwner_test.qnt. The `...Enabled`
// vals below are transition guards, not properties.
module lockPublishWithOwner {
  pure val NO_OWNER: int = 0
  pure val WRITER_PID: int = 4000
  pure val ENQUEUE_PID: int = 4001
  pure val ABORT_PID: int = 4002

  // What sits at the lock path.
  //   Absent    — nothing.
  //   Ownerless — an empty file, no owner record. Only Leftover can put this at the path.
  //   Owned     — a file with an owner record.
  type Lock = Absent | Ownerless | Owned

  // Where the file at the path came from.
  //   NoOrigin  — nothing is at the path.
  //   Leftover  — it was there before this publication; no transition here put it there.
  //   Published — a publication transition put it there.
  type Origin = NoOrigin | Leftover | Published

  // The writer's own file, not at the lock path.
  //   NoCandidate — none.
  //   Unwritten   — created exclusively, the owner record is not written yet.
  //   Written     — the owner record is in it, not published yet.
  type Candidate = NoCandidate | Unwritten | Written

  // How the run's own acquisition of the path ended. `Acquired` and `FailedEmpty` both mean the
  // run has taken the path: no success transition can run afterwards.
  //   FailedEmpty — an ownerless lock is at the path; the run fails and the file stays.
  type Acquire = NotTried | Acquired | FailedEmpty

  // How the enqueue or the abort ended. Each keeps its own variable. An enqueue never takes
  // ResolvedUndefined and an abort never takes Succeeded; the transitions assign only the values
  // each operation can reach.
  //   ResolvedUndefined — the abort's promise resolved with undefined after its write.
  type Outcome = NotRun | Succeeded | Rejected | ResolvedUndefined

  // Whether a finish hook was called.
  type Hook = NotCalled | Called

  // What happened to the goal task the operation was about.
  type TaskState = Pending | Enqueued | Invalidated

  // Which operation created the candidate. The run is not a value here: it creates no candidate,
  // and no transition overwrites this variable with the run. `NoOp` means no candidate has been
  // created yet. The run's own state is `acquire`.
  type Op = NoOp | Writer | Enqueue | Abort

  var lock: Lock
  var origin: Origin
  var owner: int
  var candidate: Candidate
  var candidateOwner: int
  var writerPid: int
  var writerAlive: bool
  var writerKilled: bool
  var op: Op
  var failedBeforeWrite: bool
  var acquire: Acquire
  var enqueueOutcome: Outcome
  var abortOutcome: Outcome
  var hook: Hook
  var taskState: TaskState
  var lastAction: str

  action init = all {
    lock' = Absent, origin' = NoOrigin, owner' = NO_OWNER,
    candidate' = NoCandidate, candidateOwner' = NO_OWNER,
    writerPid' = NO_OWNER, writerAlive' = false, writerKilled' = false,
    op' = NoOp,
    failedBeforeWrite' = false, acquire' = NotTried,
    enqueueOutcome' = NotRun, abortOutcome' = NotRun,
    hook' = NotCalled, taskState' = Pending,
    lastAction' = "init",
  }

  // ---------- transition guards ----------
  //
  // `publishEnabled` is the whole guard of `publish`, and likewise for the others. The test module
  // asserts `fail(...Enabled)` on a concrete state, so "the transition cannot be written" is the
  // same statement as "its guard is false".
  //
  // `publishEnabled` does not read `candidateOwner`: the record is what the body places, not a
  // condition on which the kill would be hidden. It also does not read `op`; after the run has
  // taken the path, `acquire == NotTried` is the condition that closes it.

  val publishEnabled: bool = and {
    candidate == Written,
    lock == Absent,
    writerAlive,
    not(failedBeforeWrite),
    acquire == NotTried,
  }

  val enqueueSucceedsEnabled: bool = and {
    op == Enqueue,
    lock == Owned,
    origin == Published,
    enqueueOutcome == NotRun,
    hook == NotCalled,
    taskState == Pending,
    not(failedBeforeWrite),
    acquire == NotTried,
  }

  val abortSucceedsEnabled: bool = and {
    op == Abort,
    lock == Owned,
    origin == Published,
    abortOutcome == NotRun,
    hook == NotCalled,
    taskState == Pending,
    not(failedBeforeWrite),
    acquire == NotTried,
  }

  // The run is attempted once. It takes an empty or ownerless path; a path with an owner is out of
  // scope. It does not read `op`: the run can be attempted while a candidate is in flight, and the
  // publication is closed afterwards by `acquire`, not by who created the candidate.
  val runAttemptEnabled: bool = and {
    acquire == NotTried,
    lock != Owned,
    not(failedBeforeWrite),
  }

  def directCreateEnabled(pid: int, c: Op): bool = and {
    candidate == NoCandidate,
    lock == Absent,
    pid != NO_OWNER,
    not(writerKilled),
    not(failedBeforeWrite),
    acquire == NotTried,
    enqueueOutcome == NotRun,
    abortOutcome == NotRun,
  }

  // ---------- transitions ----------

  // An ownerless lock that is already at the path before this publication starts.
  action leftoverEmptyLock: bool = all {
    lock == Absent,
    origin == NoOrigin,
    candidate == NoCandidate,
    acquire == NotTried,
    not(failedBeforeWrite),
    enqueueOutcome == NotRun,
    abortOutcome == NotRun,
    lock' = Ownerless,
    owner' = NO_OWNER,
    origin' = Leftover,
    candidate' = candidate, candidateOwner' = candidateOwner,
    writerPid' = writerPid, writerAlive' = writerAlive, writerKilled' = writerKilled,
    op' = op,
    failedBeforeWrite' = failedBeforeWrite, acquire' = acquire,
    enqueueOutcome' = enqueueOutcome, abortOutcome' = abortOutcome,
    hook' = hook, taskState' = taskState,
    lastAction' = "leftoverEmptyLock",
  }

  // directCreate, kept: the writer creates its candidate file exclusively. The candidate is not at
  // the lock path, so nothing is published yet. The run does not create a candidate; it has its
  // own action, runAttempt. A pid of NO_OWNER creates no candidate, and no writer starts after the
  // run has taken the path or after a failure before the write.
  action directCreate(pid: int, c: Op): bool = all {
    directCreateEnabled(pid, c),
    candidate' = Unwritten,
    candidateOwner' = NO_OWNER,
    writerPid' = pid,
    writerAlive' = true,
    op' = c,
    lock' = lock, origin' = origin, owner' = owner,
    writerKilled' = writerKilled, failedBeforeWrite' = failedBeforeWrite,
    acquire' = acquire, enqueueOutcome' = enqueueOutcome, abortOutcome' = abortOutcome,
    hook' = hook, taskState' = taskState,
    lastAction' = "directCreateUnwritten",
  }

  // The exclusive creation fails. Nothing is at the path and no lock is taken. The run has its
  // own failure path in runAttempt. This failure is terminal for the attempt.
  action createFails(c: Op): bool = all {
    candidate == NoCandidate,
    lock == Absent,
    acquire == NotTried,
    not(failedBeforeWrite),
    enqueueOutcome == NotRun,
    abortOutcome == NotRun,
    candidate' = NoCandidate,
    candidateOwner' = NO_OWNER,
    writerPid' = NO_OWNER,
    writerAlive' = false,
    op' = c,
    failedBeforeWrite' = true,
    enqueueOutcome' = if (c == Enqueue) Rejected else NotRun,
    abortOutcome' = if (c == Abort) Rejected else NotRun,
    hook' = NotCalled,
    taskState' = Pending,
    lock' = lock, origin' = origin, owner' = owner,
    writerKilled' = writerKilled, acquire' = acquire,
    lastAction' = "createFailedRejects",
  }

  // The owner record is written into the candidate. It happens before the run takes the path and
  // before a failure before the write.
  action writeOwnerRecord: bool = all {
    candidate == Unwritten,
    writerAlive,
    acquire == NotTried,
    not(failedBeforeWrite),
    enqueueOutcome == NotRun,
    abortOutcome == NotRun,
    candidate' = Written,
    candidateOwner' = writerPid,
    lock' = lock, origin' = origin, owner' = owner, writerPid' = writerPid,
    writerAlive' = writerAlive, writerKilled' = writerKilled, op' = op,
    failedBeforeWrite' = failedBeforeWrite, acquire' = acquire,
    enqueueOutcome' = enqueueOutcome, abortOutcome' = abortOutcome,
    hook' = hook, taskState' = taskState,
    lastAction' = "ownerRecordWritten",
  }

  // The owner record write fails. The candidate is dropped, nothing is at the path, and the
  // operation is rejected: the lock was not taken, no hook is called, the task stays pending.
  // The attempt is over, so no writer is in flight afterwards and no acquisition can follow.
  action writeOwnerRecordFails: bool = all {
    candidate == Unwritten,
    writerAlive,
    acquire == NotTried,
    not(failedBeforeWrite),
    enqueueOutcome == NotRun,
    abortOutcome == NotRun,
    candidate' = NoCandidate,
    candidateOwner' = NO_OWNER,
    writerAlive' = false,
    failedBeforeWrite' = true,
    enqueueOutcome' = if (op == Enqueue) Rejected else NotRun,
    abortOutcome' = if (op == Abort) Rejected else NotRun,
    hook' = NotCalled,
    taskState' = Pending,
    lock' = lock, origin' = origin, owner' = owner, writerPid' = writerPid,
    writerKilled' = writerKilled, acquire' = acquire, op' = op,
    lastAction' = "preWriteFailureRejects",
  }

  // The publication. It places the recorded candidate once, and only while the writer is alive. It
  // writes the candidate's record into the lock as the candidate has it: `owner' = candidateOwner`.
  // Run 2 and run 14 are the comparison after the record: a killed writer cannot publish, and an
  // unkilled writer publishes with the record. A killed writer is not enabled because `writerAlive`
  // is false, and after the run has taken the path it is disabled by `acquire`.
  action publish: bool = all {
    publishEnabled,
    lock' = Owned,
    owner' = candidateOwner,
    origin' = Published,
    candidate' = NoCandidate,
    candidateOwner' = NO_OWNER,
    writerPid' = writerPid, writerAlive' = writerAlive, writerKilled' = writerKilled,
    op' = op,
    failedBeforeWrite' = failedBeforeWrite, acquire' = acquire,
    enqueueOutcome' = enqueueOutcome, abortOutcome' = abortOutcome,
    hook' = hook, taskState' = taskState,
    lastAction' = "publishedWithOwner",
  }

  // SIGKILL. Only the plain writer is killed, at any point while it is alive: before its record,
  // between the record and the publication, or after the publication. It reads `op`, which the run
  // never overwrites, so the writer is still identifiable after runAttempt. Whatever the writer had
  // is left where it was. Before the publication the lock path holds nothing that this writer put
  // there; after it, the path holds the lock with the writer's record.
  //
  // The kill is not limited to "before the publication". With that limit, a model in which the
  // file reaches the path before its record (the shape before b86f10c49) could not kill the writer
  // inside that window, and killedWriterPublishesNoOwnerlessLock would hold for that shape too.
  action killWriter: bool = all {
    op == Writer,
    writerAlive,
    writerAlive' = false,
    writerKilled' = true,
    lock' = lock, origin' = origin, owner' = owner,
    candidate' = candidate, candidateOwner' = candidateOwner, writerPid' = writerPid,
    op' = op,
    failedBeforeWrite' = failedBeforeWrite, acquire' = acquire,
    enqueueOutcome' = enqueueOutcome, abortOutcome' = abortOutcome,
    hook' = hook, taskState' = taskState,
    lastAction' = "writerKilledBeforePublish",
  }

  // `takt run` acquires the path. A run is attempted once. An ownerless lock at the path makes
  // it fail; the file stays. Once `acquire` is no longer NotTried, the run holds the path and no
  // publication, enqueue success, or abort success can run. How a lock with a live owner is
  // handled is outside this spec.
  action runAttempt: bool = {
    val result = if (lock == Absent) Acquired else FailedEmpty
    all {
      runAttemptEnabled,
      acquire' = result,
      lock' = lock, origin' = origin, owner' = owner,
      candidate' = candidate, candidateOwner' = candidateOwner, writerPid' = writerPid,
      writerAlive' = writerAlive, writerKilled' = writerKilled, op' = op,
      failedBeforeWrite' = failedBeforeWrite, enqueueOutcome' = enqueueOutcome,
      abortOutcome' = abortOutcome, hook' = hook, taskState' = taskState,
      lastAction' = if (result == Acquired) "runSucceeded" else "runFailedEmptyLock",
    }
  }

  // The enqueue's write after the publication, then its release. Its ending is its own, and its
  // identity is `op`, which the run never overwrites. It can only run while the run has not taken
  // the path, so a run's acquisition and this success never line up on the same path.
  action enqueueSucceeds: bool = all {
    enqueueSucceedsEnabled,
    lock' = Absent,
    owner' = NO_OWNER,
    origin' = NoOrigin,
    enqueueOutcome' = Succeeded,
    taskState' = Enqueued,
    candidate' = candidate, candidateOwner' = candidateOwner, writerPid' = writerPid,
    writerAlive' = writerAlive, writerKilled' = writerKilled, op' = op,
    failedBeforeWrite' = failedBeforeWrite, acquire' = acquire, abortOutcome' = abortOutcome,
    hook' = hook,
    lastAction' = "enqueueSucceeded",
  }

  // The abort's invalidation after the publication: the finish hook runs, the task is invalidated.
  // Like the enqueue's success, it cannot run after the run has taken the path.
  action abortSucceeds: bool = all {
    abortSucceedsEnabled,
    lock' = Absent,
    owner' = NO_OWNER,
    origin' = NoOrigin,
    abortOutcome' = ResolvedUndefined,
    taskState' = Invalidated,
    hook' = Called,
    candidate' = candidate, candidateOwner' = candidateOwner, writerPid' = writerPid,
    writerAlive' = writerAlive, writerKilled' = writerKilled, op' = op,
    failedBeforeWrite' = failedBeforeWrite, acquire' = acquire,
    enqueueOutcome' = enqueueOutcome,
    lastAction' = "abortInvalidatedWithHook",
  }
}

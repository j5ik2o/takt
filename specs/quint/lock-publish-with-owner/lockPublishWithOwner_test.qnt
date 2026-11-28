// -*- mode: Bluespec; -*-
// Fourteen runs of the publication after the fix. Run from this directory:
//   quint test lockPublishWithOwner_test.qnt --main lockPublishWithOwnerTest
//
// The properties of lockPublishWithOwner.qnt are not `val`s: a guarded `val` reads as true from
// its guard alone. Each property is written out below on the concrete state of the run that shows
// it. The `no...` actions assert that a transition's whole guard is false and leave the state
// unchanged; they are how "the transition cannot be written" is stated. `publishEnabledHolds`
// does the opposite and is used where the enabledness itself is the point.
//
//   P1  a killed writer publishes no lock that has no owner record
//   P2  a publication carries the candidate's owner record
//   P3  a failure before the write publishes nothing at the lock path
//   P4  a rejected pre-write failure calls no hook and leaves the task pending
//   P5  no run succeeds while an ownerless lock is at the path
//   P6  after a run takes the path, no enqueue or abort success can pass
//   P7  a pre-write failure and a taken lock never coexist
//
//   run                                          reads
//   runKilledBeforeOwnerRecordTest               P1: killed before the record; publish cannot be written
//   runKilledAfterOwnerRecordTest                P1: enabled with the record, then killed; publish cannot be written
//   runLeftoverEmptyLockFailsTest                P5, P6: the failed run stays on the empty lock; no success can be written
//   publishWithOwnerTest                         P2: a publication carries the owner record
//   writerPreWriteFailureIsNotAcquisitionTest    P3, P4, P7: no publication, no run acquisition, no new candidate
//   enqueuePreWriteFailureRejectsTest            P3, P4: enqueue rejects on a failed record write, no hook, pending
//   abortPreWriteFailureRejectsTest              P3, P4: abort rejects on a failed record write, no hook, pending
//   enqueueCreateFailureRejectsTest              P3, P4: enqueue rejects when the candidate is not created
//   abortCreateFailureRejectsTest                P3, P4: abort rejects when the candidate is not created
//   enqueuePublishedWithOwnerSucceedsTest        the enqueue's own ending is Succeeded, not the run's
//   abortPublishedWithOwnerCallsHookTest         the abort's own ending is ResolvedUndefined, not the run's
//   runTakeThenKillBeforePublishTest             P6: run takes the path; only acquire closes publish, and the pre-publish writer is still killed
//   directCreateWithoutPidCreatesNoCandidateTest P3: a pid of NO_OWNER creates no candidate
//   writerPublishCarriesOwnerRecordTest          P2: the same prefix as run 2, not killed; publish is enabled and the lock's owner is the record
//
// Run 3 also checks the empty lock is not discarded: after the failed run it is still Ownerless,
// and no publication, enqueue success, or abort success can be written from that state.
module lockPublishWithOwnerTest {
  import lockPublishWithOwner.* from "./lockPublishWithOwner"

  // A step that leaves every variable as it is.
  action stutter = all {
    lock' = lock, origin' = origin, owner' = owner,
    candidate' = candidate, candidateOwner' = candidateOwner,
    writerPid' = writerPid, writerAlive' = writerAlive, writerKilled' = writerKilled,
    op' = op,
    failedBeforeWrite' = failedBeforeWrite,
    acquire' = acquire, enqueueOutcome' = enqueueOutcome, abortOutcome' = abortOutcome,
    hook' = hook, taskState' = taskState,
    lastAction' = lastAction,
  }

  action noPublish = all { fail(publishEnabled), stutter }
  // The other direction: the publication's whole guard holds, and the state does not move.
  action publishEnabledHolds = all { publishEnabled, stutter }
  action noEnqueueSuccess = all { fail(enqueueSucceedsEnabled), stutter }
  action noAbortSuccess = all { fail(abortSucceedsEnabled), stutter }
  action noRunAttempt = all { fail(runAttemptEnabled), stutter }
  action noDirectCreate(pid: int, c: Op): bool = all {
    fail(directCreateEnabled(pid, c)), stutter,
  }

  // 1. The writer is killed after directCreate and before the owner record. The candidate is not
  // at the lock path, so the path is empty, publication cannot be written, and the once-only run
  // acquires it.
  run runKilledBeforeOwnerRecordTest =
    init
      .then(directCreate(WRITER_PID, Writer))
      .then(killWriter)
      .then(noPublish)
      .then(runAttempt)
      .expect(and {
        // P1: the killed writer published nothing at the path.
        lock == Absent,
        origin == NoOrigin,
        owner == NO_OWNER,
        // Its candidate is its own file, not at the path.
        candidate == Unwritten,
        candidateOwner == NO_OWNER,
        writerKilled,
        not(writerAlive),
        op == Writer,
        // The path is empty, so the run acquires it. The success needs an empty path.
        acquire == Acquired,
        enqueueOutcome == NotRun,
        abortOutcome == NotRun,
        hook == NotCalled,
        taskState == Pending,
        not(failedBeforeWrite),
        lastAction == "runSucceeded",
      })

  // 2. The same prefix as run 14, then killed. Before the kill, with the record already
  // written, `publish` is enabled: the state is one from which a publication can be written. The
  // kill is the one change; afterwards `publish` cannot be written, and the path stays empty.
  run runKilledAfterOwnerRecordTest =
    init
      .then(directCreate(WRITER_PID, Writer))
      .then(writeOwnerRecord)
      // The live state, record written: the publication's whole guard holds.
      .then(publishEnabledHolds)
      .then(killWriter)
      .then(noPublish)
      .then(runAttempt)
      .expect(and {
        // P1: the killed writer published nothing at the path; its record is in the candidate.
        lock == Absent,
        origin == NoOrigin,
        owner == NO_OWNER,
        candidate == Written,
        candidateOwner == WRITER_PID,
        writerKilled,
        not(writerAlive),
        op == Writer,
        // The empty path is still acquirable.
        acquire == Acquired,
        enqueueOutcome == NotRun,
        abortOutcome == NotRun,
        hook == NotCalled,
        taskState == Pending,
        not(failedBeforeWrite),
        lastAction == "runSucceeded",
      })

  // 3. An ownerless lock is at the path before the run. The run fails; the empty file stays, and
  // no publication, enqueue success, or abort success can be written from that state.
  run runLeftoverEmptyLockFailsTest =
    init
      .then(leftoverEmptyLock)
      .then(runAttempt)
      .then(noPublish)
      .then(noEnqueueSuccess)
      .then(noAbortSuccess)
      .expect(and {
        // P5: the run fails on the ownerless lock and succeeds nowhere.
        acquire == FailedEmpty,
        // No transition discards the empty lock: after the failed run it is still at the path,
        // with the same origin. There is no 30 s wait and no removal.
        lock == Ownerless,
        origin == Leftover,
        owner == NO_OWNER,
        candidate == NoCandidate,
        enqueueOutcome == NotRun,
        abortOutcome == NotRun,
        hook == NotCalled,
        taskState == Pending,
        not(failedBeforeWrite),
        // The run has no value in Op; it did not write the candidate's operation.
        op == NoOp,
        lastAction == "runFailedEmptyLock",
      })

  // 4. The publication carries the owner record.
  run publishWithOwnerTest =
    init
      .then(directCreate(ENQUEUE_PID, Enqueue))
      .then(writeOwnerRecord)
      .then(publish)
      .expect(and {
        // P2: the published lock carries its owner record.
        lock == Owned,
        origin == Published,
        owner == ENQUEUE_PID,
        // The candidate is gone after the publication.
        candidate == NoCandidate,
        candidateOwner == NO_OWNER,
        acquire == NotTried,
        enqueueOutcome == NotRun,
        abortOutcome == NotRun,
        not(failedBeforeWrite),
        op == Enqueue,
        lastAction == "publishedWithOwner",
      })

  // 5. A plain writer's owner record write fails. The failure is not an acquisition: publication
  // cannot be written, the run cannot acquire afterwards, and no new candidate can start.
  run writerPreWriteFailureIsNotAcquisitionTest =
    init
      .then(directCreate(WRITER_PID, Writer))
      .then(writeOwnerRecordFails)
      .then(noPublish)
      .then(noRunAttempt)
      .then(noDirectCreate(WRITER_PID, Writer))
      .expect(and {
        // P3: the failure before the write publishes nothing and takes no lock.
        lock == Absent,
        origin == NoOrigin,
        owner == NO_OWNER,
        candidate == NoCandidate,
        candidateOwner == NO_OWNER,
        writerAlive == false,
        writerKilled == false,
        op == Writer,
        failedBeforeWrite,
        acquire == NotTried,
        // P4: the operation is not an enqueue or an abort, so neither ending moves; no hook, and
        // the task stays pending.
        enqueueOutcome == NotRun,
        abortOutcome == NotRun,
        hook == NotCalled,
        taskState == Pending,
        // P7: failedBeforeWrite and a taken lock do not coexist; the run cannot follow.
        lastAction == "preWriteFailureRejects",
      })

  // 6. The enqueue's owner record write fails. The operation is rejected, no hook is called, and
  // the task stays pending. Publication and the run are closed by the failure.
  run enqueuePreWriteFailureRejectsTest =
    init
      .then(directCreate(ENQUEUE_PID, Enqueue))
      .then(writeOwnerRecordFails)
      .then(noPublish)
      .then(noRunAttempt)
      .expect(and {
        // P3: the failure before the write publishes nothing and takes no lock.
        lock == Absent,
        origin == NoOrigin,
        owner == NO_OWNER,
        candidate == NoCandidate,
        candidateOwner == NO_OWNER,
        failedBeforeWrite,
        acquire == NotTried,
        // P4: the enqueue is rejected, no hook, the task stays pending.
        enqueueOutcome == Rejected,
        abortOutcome == NotRun,
        hook == NotCalled,
        taskState == Pending,
        op == Enqueue,
        lastAction == "preWriteFailureRejects",
      })

  // 7. The abort's owner record write fails, the same way.
  run abortPreWriteFailureRejectsTest =
    init
      .then(directCreate(ABORT_PID, Abort))
      .then(writeOwnerRecordFails)
      .then(noPublish)
      .then(noRunAttempt)
      .expect(and {
        // P3
        lock == Absent,
        origin == NoOrigin,
        owner == NO_OWNER,
        candidate == NoCandidate,
        candidateOwner == NO_OWNER,
        failedBeforeWrite,
        acquire == NotTried,
        // P4: the abort is rejected, no hook, the task stays pending.
        enqueueOutcome == NotRun,
        abortOutcome == Rejected,
        hook == NotCalled,
        taskState == Pending,
        op == Abort,
        lastAction == "preWriteFailureRejects",
      })

  // 8. The enqueue's exclusive creation fails. Nothing is at the path, the operation is rejected,
  // no hook is called, and the task stays pending.
  run enqueueCreateFailureRejectsTest =
    init
      .then(createFails(Enqueue))
      .then(noPublish)
      .then(noRunAttempt)
      .expect(and {
        // P3
        lock == Absent,
        origin == NoOrigin,
        owner == NO_OWNER,
        candidate == NoCandidate,
        candidateOwner == NO_OWNER,
        failedBeforeWrite,
        acquire == NotTried,
        // P4
        enqueueOutcome == Rejected,
        abortOutcome == NotRun,
        hook == NotCalled,
        taskState == Pending,
        op == Enqueue,
        lastAction == "createFailedRejects",
      })

  // 9. The abort's exclusive creation fails, the same way.
  run abortCreateFailureRejectsTest =
    init
      .then(createFails(Abort))
      .then(noPublish)
      .then(noRunAttempt)
      .expect(and {
        // P3
        lock == Absent,
        origin == NoOrigin,
        owner == NO_OWNER,
        candidate == NoCandidate,
        candidateOwner == NO_OWNER,
        failedBeforeWrite,
        acquire == NotTried,
        // P4: the abort is rejected, no hook, the task stays pending.
        enqueueOutcome == NotRun,
        abortOutcome == Rejected,
        hook == NotCalled,
        taskState == Pending,
        op == Abort,
        lastAction == "createFailedRejects",
      })

  // 10. The enqueue publishes with the owner record, then its write and release succeed.
  run enqueuePublishedWithOwnerSucceedsTest =
    init
      .then(directCreate(ENQUEUE_PID, Enqueue))
      .then(writeOwnerRecord)
      .then(publish)
      .then(enqueueSucceeds)
      .expect(and {
        lock == Absent,
        origin == NoOrigin,
        owner == NO_OWNER,
        // The enqueue's own ending; the run was not attempted.
        enqueueOutcome == Succeeded,
        abortOutcome == NotRun,
        acquire == NotTried,
        taskState == Enqueued,
        hook == NotCalled,
        not(failedBeforeWrite),
        op == Enqueue,
        lastAction == "enqueueSucceeded",
      })

  // 11. The abort publishes with the owner record, then invalidates the task and calls its hook.
  run abortPublishedWithOwnerCallsHookTest =
    init
      .then(directCreate(ABORT_PID, Abort))
      .then(writeOwnerRecord)
      .then(publish)
      .then(abortSucceeds)
      .expect(and {
        lock == Absent,
        origin == NoOrigin,
        owner == NO_OWNER,
        // The abort's own ending; the run was not attempted.
        abortOutcome == ResolvedUndefined,
        enqueueOutcome == NotRun,
        acquire == NotTried,
        taskState == Invalidated,
        hook == Called,
        not(failedBeforeWrite),
        op == Abort,
        lastAction == "abortInvalidatedWithHook",
      })

  // 12. The run takes the path while the writer has a written candidate. The state that follows has
  // the record in the candidate, a live writer, an empty path, and no failure: `acquire` is the
  // only false condition of the publication's guard, so the run's acquisition itself is what
  // closes it, not a caller that the run overwrote. No enqueue success, no new enqueue candidate,
  // and no publication can follow. The pre-publish writer is still killed afterwards, and the
  // publication is still unwritable for that reason too.
  run runTakeThenKillBeforePublishTest =
    init
      .then(directCreate(WRITER_PID, Writer))
      .then(writeOwnerRecord)
      .then(runAttempt)
      .then(noEnqueueSuccess)
      .then(noAbortSuccess)
      .then(noDirectCreate(ENQUEUE_PID, Enqueue))
      .then(noPublish)
      .then(killWriter)
      .then(noPublish)
      .expect(and {
        // P6: the run's acquisition and the enqueue's success do not line up on the path.
        acquire == Acquired,
        // The run did not overwrite the writer's operation.
        op == Writer,
        lock == Absent,
        origin == NoOrigin,
        owner == NO_OWNER,
        // The writer's record stays in its candidate, never at the path.
        candidate == Written,
        candidateOwner == WRITER_PID,
        // The writer is killed after the run has taken the path.
        writerKilled,
        not(writerAlive),
        enqueueOutcome == NotRun,
        abortOutcome == NotRun,
        hook == NotCalled,
        taskState == Pending,
        not(failedBeforeWrite),
        lastAction == "writerKilledBeforePublish",
      })

  // 13. directCreate with a pid of NO_OWNER creates no candidate. The state is still init.
  run directCreateWithoutPidCreatesNoCandidateTest =
    init
      .then(noDirectCreate(NO_OWNER, Writer))
      .expect(and {
        lock == Absent,
        origin == NoOrigin,
        owner == NO_OWNER,
        candidate == NoCandidate,
        candidateOwner == NO_OWNER,
        writerPid == NO_OWNER,
        writerAlive == false,
        writerKilled == false,
        op == NoOp,
        not(failedBeforeWrite),
        acquire == NotTried,
        enqueueOutcome == NotRun,
        abortOutcome == NotRun,
        hook == NotCalled,
        taskState == Pending,
        lastAction == "init",
      })

  // 14. The same prefix as run 2, not killed: the record is written into the candidate and the
  // publication's whole guard holds. Publishing places the lock with the owner record that the
  // candidate carries. The kill in run 2, and not the record's absence, is what makes the same
  // publication unwritable there.
  run writerPublishCarriesOwnerRecordTest =
    init
      .then(directCreate(WRITER_PID, Writer))
      .then(writeOwnerRecord)
      .then(publishEnabledHolds)
      .then(publish)
      .expect(and {
        // P2: the publication carries the candidate's owner record.
        lock == Owned,
        origin == Published,
        owner == WRITER_PID,
        // The candidate is gone after the publication.
        candidate == NoCandidate,
        candidateOwner == NO_OWNER,
        writerAlive,
        not(writerKilled),
        op == Writer,
        acquire == NotTried,
        enqueueOutcome == NotRun,
        abortOutcome == NotRun,
        hook == NotCalled,
        taskState == Pending,
        not(failedBeforeWrite),
        lastAction == "publishedWithOwner",
      })
}

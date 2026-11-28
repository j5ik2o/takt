// -*- mode: Bluespec; -*-
// Random exploration of lockPublishWithOwner.qnt: a `step` over every transition, the README's
// properties as invariants, and one witness per transition.
// Read with specs/quint/lock-publish-with-owner/README.md ("確かめ").
//
// The model file has no `step` and no invariant `val`s; its 14 runs check fixed traces only.
// This module adds the random traces. It does not change the model: it imports it and adds one
// ghost variable, `tookThenSucceeded`, because "after the run takes the path, nothing succeeds"
// is about the order of two events and cannot be read from one state.
module lockPublishWithOwnerCheck {
  import lockPublishWithOwner.* from "./lockPublishWithOwner"

  pure val PIDS: Set[int] = Set(NO_OWNER, WRITER_PID, ENQUEUE_PID, ABORT_PID)
  pure val OPS: Set[Op] = Set(Writer, Enqueue, Abort)

  // ghost: a publication, an enqueue success or an abort success happened after the run had
  // already taken the path.
  var tookThenSucceeded: bool

  action initCheck = all { init, tookThenSucceeded' = false }

  action stepCheck = {
    nondet pid = PIDS.oneOf()
    nondet c = OPS.oneOf()
    all {
      any {
        leftoverEmptyLock,
        directCreate(pid, c),
        createFails(c),
        writeOwnerRecord,
        writeOwnerRecordFails,
        publish,
        killWriter,
        runAttempt,
        enqueueSucceeds,
        abortSucceeds,
      },
      // Parenthesised: `x' = a or b` parses as `(x' = a) or b`.
      tookThenSucceeded' = (tookThenSucceeded or (acquire != NotTried and or {
        publishEnabled, enqueueSucceedsEnabled, abortSucceedsEnabled,
      })),
    }
  }

  // ---------- the README's properties ----------

  // A killed writer leaves no ownerless lock that it put there. An ownerless lock beside a killed
  // writer can only be a leftover from before this publication.
  val killedWriterPublishesNoOwnerlessLock: bool =
    (writerKilled and lock == Ownerless) implies origin == Leftover

  // A published lock carries an owner record.
  val publishedLockHasOwner: bool =
    origin == Published implies (lock == Owned and owner != NO_OWNER)

  // A failure before the owner record publishes nothing and is not an acquisition.
  val preWriteFailurePublishesNothing: bool =
    failedBeforeWrite implies (origin != Published and acquire == NotTried)

  // A rejected enqueue or abort calls no hook and leaves the task pending.
  val rejectedKeepsTaskPendingWithoutHook: bool =
    (enqueueOutcome == Rejected or abortOutcome == Rejected) implies (hook == NotCalled and taskState == Pending)

  // While an ownerless lock is at the path, no run, enqueue or abort has succeeded over it.
  val noSuccessWithEmptyLock: bool =
    lock == Ownerless implies (acquire != Acquired and enqueueOutcome != Succeeded and abortOutcome != ResolvedUndefined)

  // After the run has taken the path, nothing publishes or succeeds.
  val runTakeClosesSuccess: bool = not(tookThenSucceeded)

  // A candidate always has a writer pid.
  val directCreateRequiresPid: bool =
    candidate != NoCandidate implies writerPid != NO_OWNER

  val safety: bool = and {
    killedWriterPublishesNoOwnerlessLock,
    publishedLockHasOwner,
    preWriteFailurePublishesNothing,
    rejectedKeepsTaskPendingWithoutHook,
    noSuccessWithEmptyLock,
    runTakeClosesSuccess,
    directCreateRequiresPid,
  }

  // ---------- one witness per transition ----------
  // `quint run --witnesses` counts the traces in which the expression becomes true.

  val wLeftover: bool = lastAction == "leftoverEmptyLock"
  val wDirectCreate: bool = lastAction == "directCreateUnwritten"
  val wCreateFails: bool = lastAction == "createFailedRejects"
  val wWriteOwnerRecord: bool = lastAction == "ownerRecordWritten"
  val wWriteOwnerRecordFails: bool = lastAction == "preWriteFailureRejects"
  val wPublish: bool = lastAction == "publishedWithOwner"
  val wKillWriter: bool = lastAction == "writerKilledBeforePublish"
  val wRunAcquired: bool = lastAction == "runSucceeded"
  val wRunFailedEmpty: bool = lastAction == "runFailedEmptyLock"
  val wEnqueueSucceeds: bool = lastAction == "enqueueSucceeded"
  val wAbortSucceeds: bool = lastAction == "abortInvalidatedWithHook"
  // the comparisons the README names: killed after the record or after the publication, and the
  // run over a leftover
  val wKilledAfterRecord: bool = writerKilled and candidate == Written
  val wKilledAfterPublish: bool = writerKilled and origin == Published
  val wRunOverLeftover: bool = acquire == FailedEmpty and origin == Leftover
}

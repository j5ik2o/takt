// -*- mode: Bluespec; -*-
// Scenario tests for durable goal task completion publication (issue #170).
// Run:
//   quint test goalTaskCompletionPublication_test.qnt --main beforeTest
//   quint test goalTaskCompletionPublication_test.qnt --main fixedNoRepublisherTest
//   quint test goalTaskCompletionPublication_test.qnt --main fixedNoHasWorkTest
//   quint test goalTaskCompletionPublication_test.qnt --main fixedStaleDeletionBlocksTest
//   quint test goalTaskCompletionPublication_test.qnt --main fixedNoDedupTest
//   quint test goalTaskCompletionPublication_test.qnt --main fixedUncheckedClearTest
//   quint test goalTaskCompletionPublication_test.qnt --main fixedTest

// Current code (before the fix): all three failure paths lose their completion notice on
// saveManagerEvent failure or process crash after tasks.yaml write.
module beforeTest {
  import goalTaskCompletionPublication(DESIGN = "Before").* from "./goalTaskCompletionPublication"

  // Setup failure: saveManagerEvent fails -> task stays Failed, manager never wakes.
  run setupFailurePublishErrorLosesNoticeTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .expect(and {
        tasks.get("t1").status == Failed,
        inbox == Set(),
        wakes.get(("t1", 1)) == 0,
        not(noUnrecoverableLoss),
        not(quiescentDelivery),
      })

  // Setup failure: process crashes between tasks.yaml write and saveManagerEvent.
  run setupFailureCrashLosesNoticeTest =
    init.then(writeSetupFailure("t1")).then(writerCrash)
      .expect(and {
        tasks.get("t1").status == Failed,
        wakes.get(("t1", 1)) == 0,
        not(noUnrecoverableLoss),
        not(quiescentDelivery),
      })

  // failInterruptedTasksWithGoalEvents: saveManagerEvent fails -> notice lost.
  run interruptedFailurePublishErrorLosesNoticeTest =
    init.then(startTask("t1", true)).then(writeInterruptedFailure("t1")).then(writerPublishFails)
      .expect(and {
        tasks.get("t1").status == Failed,
        wakes.get(("t1", 1)) == 0,
        not(noUnrecoverableLoss),
        not(quiescentDelivery),
      })

  // reconcileLostRun: crash after tasks.yaml write (even without run_slug) -> notice lost.
  run reconcileLostRunCrashLosesNoticeTest =
    init.then(startTask("t1", false)).then(writeReconcileFailure("t1")).then(writerCrash)
      .expect(and {
        tasks.get("t1").status == Failed,
        wakes.get(("t1", 1)) == 0,
        not(noUnrecoverableLoss),
        not(quiescentDelivery),
      })
}

// Medium-1 probe: writing pendingPub without a daemon republisher still satisfies noUnrecoverableLoss
// (because pendingPub stays true), yet violates quiescentDelivery because nothing can deliver it.
module fixedNoRepublisherTest {
  import goalTaskCompletionPublication(DESIGN = "FixedNoRepublisher").* from "./goalTaskCompletionPublication"

  run disabledRepublisherStrandsPendingMarkTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .expect(and {
        tasks.get("t1").status == Failed,
        tasks.get("t1").pendingPub,
        wakes.get(("t1", 1)) == 0,
        noUnrecoverableLoss,
        not(quiescentDelivery),
        not(safety),
      })

  run disabledRepublisherStrandsAbortedMarkTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(abortGoal)
      .expect(and {
        goal == Aborted,
        tasks.get("t1").pendingPub,
        not(quiescentDelivery),
        not(safety),
      })
}

// Medium-1 hasWork ablation: if hasWork ignores pendingPub, daemon idle-exits after goal abort
// while pendingPub is still set in tasks.yaml.
module fixedNoHasWorkTest {
  import goalTaskCompletionPublication(DESIGN = "FixedNoHasWork").* from "./goalTaskCompletionPublication"

  run idleExitBeforeSettlingPendingMarkTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(writeSetupFailure("t2")).then(writerPublishOk).then(writerClearOk)
      .then(abortGoal)
      .then(daemonIdleExit)
      .expect(and {
        not(daemonRunning),
        tasks.get("t1").pendingPub,
        not(noDaemonExitWithWork),
        not(quiescentDelivery),
        not(safety),
      })
}

// Low-5 ablation: if daemon skips any deletion reservation without checking owner liveness,
// a crashed deletion owner strands pendingPub forever.
module fixedStaleDeletionBlocksTest {
  import goalTaskCompletionPublication(DESIGN = "FixedStaleDeletionBlocks").* from "./goalTaskCompletionPublication"

  run deadDeletionOwnerStrandsPendingMarkTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(reserveDeletion("t1")).then(deletionOwnerCrash("t1"))
      .expect(and {
        tasks.get("t1").pendingPub,
        tasks.get("t1").deletion == DelDead,
        wakes.get(("t1", 1)) == 0,
        noUnrecoverableLoss,
        not(quiescentDelivery),
        not(safety),
      })
}

// Adding the outbox mark without deterministic inbox eventId causes duplicate manager wakes.
module fixedNoDedupTest {
  import goalTaskCompletionPublication(DESIGN = "FixedNoDedup").* from "./goalTaskCompletionPublication"

  // Writer writes inbox file, then crashes before clearing pendingPub; daemon republishes a second
  // inbox file with a different random eventId -> manager wakes twice for the same failure.
  run crashBeforeClearCausesDuplicateWakeTest =
    init.then(writeSetupFailure("t1")).then(writerPublishOk).then(writerCrash)
      .then(consumeInbox({ fileId: 1, task: "t1", attempt: 1, hasRunSlug: true, hasExecId: true }))
      .then(daemonReadPending("t1")).then(daemonPublishOk).then(daemonClearOk)
      .then(consumeInbox({ fileId: 2, task: "t1", attempt: 1, hasRunSlug: true, hasExecId: true }))
      .expect(and {
        wakes.get(("t1", 1)) == 2,
        not(noDuplicateManagerWake),
      })
}

// Clearing completion_publication_pending by task name alone can erase a newer attempt's pending mark.
module fixedUncheckedClearTest {
  import goalTaskCompletionPublication(DESIGN = "FixedUncheckedClear").* from "./goalTaskCompletionPublication"

  // Attempt 1 is read and published by daemon; meanwhile task is requeued and fails attempt 2
  // whose immediate saveManagerEvent fails; daemon's stale clear wipes attempt 2's pendingPub.
  run staleClearDropsSecondAttemptNoticeTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(daemonReadPending("t1")).then(daemonPublishOk)
      .then(requeueTask("t1"))
      .then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(daemonClearOk)
      .expect(and {
        tasks.get("t1").status == Failed,
        tasks.get("t1").attempt == 2,
        not(tasks.get("t1").pendingPub),
        wakes.get(("t1", 2)) == 0,
        not(noUnrecoverableLoss),
        not(quiescentDelivery),
      })
}

// Full fix: durable pendingPub, daemon republisher, hasWork, stale-deletion recovery,
// deterministic eventId, attempt-matched clear, live-deletion guard, and aborted/deleted/paused handling.
module fixedTest {
  import goalTaskCompletionPublication(DESIGN = "Fixed").* from "./goalTaskCompletionPublication"

  // Setup failure publish fails -> daemon republishes -> manager wakes once -> mark cleared.
  run setupFailureRecoveredByDaemonTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(daemonReadPending("t1")).then(daemonPublishOk).then(daemonClearOk)
      .then(consumeInbox({ fileId: 1, task: "t1", attempt: 1, hasRunSlug: true, hasExecId: true }))
      .expect(and {
        not(tasks.get("t1").pendingPub),
        wakes.get(("t1", 1)) == 1,
        wDaemonSoleRepublishWoke,
        safety,
      })

  // failInterruptedTasksWithGoalEvents crashes after tasks.yaml write -> daemon recovers.
  run interruptedFailureRecoveredByDaemonTest =
    init.then(startTask("t1", false)).then(writeInterruptedFailure("t1")).then(writerCrash)
      .then(daemonReadPending("t1")).then(daemonPublishOk).then(daemonClearOk)
      .then(consumeInbox({ fileId: 1, task: "t1", attempt: 1, hasRunSlug: true, hasExecId: true }))
      .expect(and {
        not(tasks.get("t1").pendingPub),
        wakes.get(("t1", 1)) == 1,
        wDaemonSoleRepublishWoke,
        safety,
      })

  // reconcileLostRun without run_slug: crashes after saveManagerEvent before clear -> daemon
  // republishes with executionId -> EventStore deduplicates -> manager wakes exactly once.
  run reconcileWithoutRunSlugDeduplicatedTest =
    init.then(startTask("t1", false)).then(writeReconcileFailure("t1")).then(writerPublishOk).then(writerCrash)
      .then(consumeInbox({ fileId: 1, task: "t1", attempt: 1, hasRunSlug: false, hasExecId: true }))
      .then(daemonReadPending("t1")).then(daemonPublishOk).then(daemonClearOk)
      .then(consumeInbox({ fileId: 2, task: "t1", attempt: 1, hasRunSlug: false, hasExecId: true }))
      .expect(and {
        not(tasks.get("t1").pendingPub),
        wakes.get(("t1", 1)) == 1,
        safety,
      })

  // Writer and daemon race to publish the same failure -> both files deduplicate to one wake.
  run writerDaemonRaceDeduplicatesTest =
    init.then(writeSetupFailure("t1"))
      .then(daemonReadPending("t1")).then(daemonPublishOk)
      .then(writerPublishOk).then(writerClearOk).then(daemonClearOk)
      .then(consumeInbox({ fileId: 1, task: "t1", attempt: 1, hasRunSlug: true, hasExecId: true }))
      .then(consumeInbox({ fileId: 2, task: "t1", attempt: 1, hasRunSlug: true, hasExecId: true }))
      .expect(and {
        not(tasks.get("t1").pendingPub),
        wakes.get(("t1", 1)) == 1,
        safety,
      })

  // Attempt-matched clear preserves attempt 2's pendingPub after requeue and second failure;
  // attempt 2 gets its own distinct eventId and wakes the manager once too.
  run requeueAndSecondFailurePreservesPendingMarkTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(daemonReadPending("t1")).then(daemonPublishOk)
      .then(requeueTask("t1"))
      .then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(daemonClearOk)
      .expect(tasks.get("t1").pendingPub and tasks.get("t1").attempt == 2 and safety)
      .then(daemonReadPending("t1")).then(daemonPublishOk).then(daemonClearOk)
      .then(consumeInbox({ fileId: 1, task: "t1", attempt: 1, hasRunSlug: true, hasExecId: true }))
      .then(consumeInbox({ fileId: 2, task: "t1", attempt: 2, hasRunSlug: true, hasExecId: true }))
      .expect(and {
        not(tasks.get("t1").pendingPub),
        wakes.get(("t1", 1)) == 1,
        wakes.get(("t1", 2)) == 1,
        safety,
      })

  // Transient daemon publish error keeps pendingPub intact so a later tick succeeds.
  run transientDaemonFailureRetriesAndSucceedsTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(daemonReadPending("t1")).then(daemonPublishFails)
      .expect(tasks.get("t1").pendingPub and safety)
      .then(daemonReadPending("t1")).then(daemonPublishOk).then(daemonClearOk)
      .then(consumeInbox({ fileId: 1, task: "t1", attempt: 1, hasRunSlug: true, hasExecId: true }))
      .expect(not(tasks.get("t1").pendingPub) and wakes.get(("t1", 1)) == 1 and safety)

  // Aborted goal: daemon keeps running while pendingPub exists, clears pendingPub without
  // writing an inbox file, and then cleanly idle-exits once all tasks are terminal.
  run abortedGoalClearsPendingThenIdleExitsTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(writeSetupFailure("t2")).then(writerPublishOk).then(writerClearOk)
      .then(abortGoal)
      .expect(daemonHasWork(DESIGN, goal, tasks, inbox) and daemonRunning and safety)
      .then(daemonReadPending("t1")).then(daemonPublishOk).then(daemonClearOk)
      .expect(and {
        inbox == Set(),
        not(tasks.get("t1").pendingPub),
        not(daemonHasWork(DESIGN, goal, tasks, inbox)),
        wakes.get(("t1", 1)) == 0,
        safety,
      })
      .then(daemonIdleExit)
      .expect(and {
        not(daemonRunning),
        wDaemonIdleExitedAfterSettle,
        safety,
      })

  // Deleted goal: daemon clears pendingPub without writing an inbox file, then idle-exits.
  run deletedGoalClearsPendingThenIdleExitsTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(writeSetupFailure("t2")).then(writerPublishOk).then(writerClearOk)
      .then(abortGoal).then(deleteGoal)
      .expect(daemonHasWork(DESIGN, goal, tasks, inbox) and daemonRunning and safety)
      .then(daemonReadPending("t1")).then(daemonPublishOk).then(daemonClearOk)
      .then(daemonIdleExit)
      .expect(and {
        inbox == Set(),
        not(tasks.get("t1").pendingPub),
        not(daemonRunning),
        wakes.get(("t1", 1)) == 0,
        wDaemonIdleExitedAfterSettle,
        safety,
      })

  // Paused goal: daemon publishes to inbox, EventStore defers it, resume delivers once.
  run pausedGoalDefersUntilResumedTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(pauseGoal)
      .then(daemonReadPending("t1")).then(daemonPublishOk).then(daemonClearOk)
      .then(consumeInbox({ fileId: 1, task: "t1", attempt: 1, hasRunSlug: true, hasExecId: true }))
      .expect(wakes.get(("t1", 1)) == 0 and deferred.contains(("t1", 1)) and safety)
      .then(resumeGoal).then(deliverDeferred(("t1", 1)))
      .expect(wakes.get(("t1", 1)) == 1 and deferred == Set() and safety)

  // Live deletion reservation prevents daemon from mutating the task until deletion completes or cancels.
  run liveDeletionReservationBlocksClearUntilCancelledTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(daemonReadPending("t1")).then(daemonPublishOk)
      .then(reserveDeletion("t1"))
      .then(daemonClearOk)
      .expect(tasks.get("t1").pendingPub and tasks.get("t1").deletion == DelAlive and safety)
      .then(cancelDeletion("t1"))
      .then(daemonReadPending("t1")).then(daemonPublishOk).then(daemonClearOk)
      .then(consumeInbox({ fileId: 1, task: "t1", attempt: 1, hasRunSlug: true, hasExecId: true }))
      .then(consumeInbox({ fileId: 2, task: "t1", attempt: 1, hasRunSlug: true, hasExecId: true }))
      .expect(not(tasks.get("t1").pendingPub) and wakes.get(("t1", 1)) == 1 and safety)

  // Dead deletion owner (Low-5): daemon detects stale deletion, republishes, clears both
  // pendingPub and stale deletion, and wakes manager once.
  run deadDeletionOwnerRecoveredUnderActiveGoalTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(reserveDeletion("t1")).then(deletionOwnerCrash("t1"))
      .expect(tasks.get("t1").deletion == DelDead and safety)
      .then(daemonReadPending("t1")).then(daemonPublishOk).then(daemonClearOk)
      .then(consumeInbox({ fileId: 1, task: "t1", attempt: 1, hasRunSlug: true, hasExecId: true }))
      .expect(and {
        not(tasks.get("t1").pendingPub),
        tasks.get("t1").deletion == DelNone,
        wakes.get(("t1", 1)) == 1,
        wStaleDeletionRecovered,
        wDaemonSoleRepublishWoke,
        safety,
      })

  // Dead deletion owner under Aborted goal: hasWork keeps daemon alive, daemon clears pendingPub
  // and stale deletion without waking manager, and then idle-exits cleanly.
  run deadDeletionOwnerSettledUnderAbortedGoalTest =
    init.then(writeSetupFailure("t1")).then(writerPublishFails)
      .then(writeSetupFailure("t2")).then(writerPublishOk).then(writerClearOk)
      .then(reserveDeletion("t1")).then(abortGoal)
      .expect(daemonHasWork(DESIGN, goal, tasks, inbox) and safety)
      .then(deletionOwnerCrash("t1"))
      .then(daemonReadPending("t1")).then(daemonPublishOk).then(daemonClearOk)
      .then(daemonIdleExit)
      .expect(and {
        not(tasks.get("t1").pendingPub),
        tasks.get("t1").deletion == DelNone,
        not(daemonRunning),
        wStaleDeletionRecovered,
        wDaemonIdleExitedAfterSettle,
        safety,
      })
}

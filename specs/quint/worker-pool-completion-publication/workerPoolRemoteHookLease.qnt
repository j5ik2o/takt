// -*- mode: Bluespec; -*-
// The finish hook of a remote attempt and the leases of the other remote attempts.
// Read with docs/design/worker-pool-completion-publication.md ("3. 終了フックを呼ぶ場所と警告").
//
// Two remote attempts run on one connected worker: X finishes, B keeps running. The daemon handles
// every remote request and its periodic check on one serialized tail
// (src/features/workerPool/remoteWorkerRuntime.ts:46-51). The worker sends a heartbeat every
// WORKER_HEARTBEAT_MS (remoteProtocol.ts:5); the daemon renews B's lease when it handles the
// heartbeat (remoteWorkerRuntime.ts:267-274) and fails a running attempt whose lease has expired
// (:100-113). A request from the daemon to the project host times out after 30 s and closes the
// host (src/infra/worker-pool/projectHost.ts:72-74).
//
// DESIGN picks where the finish hook of X runs:
//   "HookBeforeReply" — the hook is awaited inside the finish request (the stage-5 draft of the
//                        design): the project host's reply and the daemon's tail wait for it.
//   "HookAfterReply"  — the design: the finish request saves, publishes and replies; the hook runs
//                        afterwards, once, and the runtime's close() waits for it.
module workerPoolRemoteHookLease {
  const DESIGN: str

  pure val LEASE: int = 60          // WORKER_LEASE_MS
  pure val HEARTBEAT: int = 5       // WORKER_HEARTBEAT_MS
  pure val IPC_TIMEOUT: int = 30    // projectHost.ts request timer
  pure val HORIZON: int = 140
  pure val HOOK_DURATIONS: Set[int] = Set(0, 10, 31, 60)   // TASK_FINISH_HOOK_MAX_TIMEOUT_MS = 60 s

  type Status = Running | Saved | FailedByLease

  var clock: int
  // the daemon's tail is busy until this time (a request awaiting the hook)
  var tailBusyUntil: int
  var lastHeartbeat: int
  var renewQueued: bool
  var bLease: int
  var x: Status
  var b: Status
  // the hook of X: -1 not scheduled, otherwise the time it ends
  var hookEndsAt: int
  var hookCalls: int
  var hostClosed: bool
  var lastAction: str

  pure def hookBlocksReply: bool = DESIGN == "HookBeforeReply"

  action init = all {
    clock' = 0, tailBusyUntil' = 0, lastHeartbeat' = 0, renewQueued' = false, bLease' = LEASE,
    x' = Running, b' = Running, hookEndsAt' = -1, hookCalls' = 0, hostClosed' = false,
    lastAction' = "init",
  }

  // Time passes one second. The worker never lets a heartbeat fall due without sending it, and a
  // free tail handles a queued renew before time moves on.
  action tick: bool = all {
    clock < HORIZON,
    clock - lastHeartbeat < HEARTBEAT,
    not(renewQueued and tailBusyUntil <= clock and b == Running),
    clock' = clock + 1,
    hookCalls' = if (hookEndsAt == clock + 1) hookCalls + 1 else hookCalls,
    tailBusyUntil' = tailBusyUntil, lastHeartbeat' = lastHeartbeat, renewQueued' = renewQueued,
    bLease' = bLease, x' = x, b' = b, hookEndsAt' = hookEndsAt, hostClosed' = hostClosed,
    lastAction' = "tick",
  }

  action sendHeartbeat: bool = all {
    clock - lastHeartbeat >= HEARTBEAT or clock == 0,
    lastHeartbeat' = clock, renewQueued' = true,
    clock' = clock, tailBusyUntil' = tailBusyUntil, bLease' = bLease, x' = x, b' = b,
    hookEndsAt' = hookEndsAt, hookCalls' = hookCalls, hostClosed' = hostClosed,
    lastAction' = "sendHeartbeat",
  }

  // The tail handles the heartbeat: B's lease is renewed.
  action processRenew: bool = all {
    tailBusyUntil <= clock, renewQueued, b == Running,
    bLease' = clock + LEASE, renewQueued' = false,
    clock' = clock, tailBusyUntil' = tailBusyUntil, lastHeartbeat' = lastHeartbeat, x' = x, b' = b,
    hookEndsAt' = hookEndsAt, hookCalls' = hookCalls, hostClosed' = hostClosed,
    lastAction' = "processRenew",
  }

  // The tail handles X's finish: the record is saved and published, then the reply goes back.
  action finishX(d: int): bool = all {
    tailBusyUntil <= clock, x == Running, clock < 10, not(hostClosed),
    x' = Saved,
    hookEndsAt' = clock + d,
    hookCalls' = if (d == 0) hookCalls + 1 else hookCalls,
    tailBusyUntil' = if (hookBlocksReply) clock + d else tailBusyUntil,
    hostClosed' = hookBlocksReply and d > IPC_TIMEOUT,
    clock' = clock, lastHeartbeat' = lastHeartbeat, renewQueued' = renewQueued, bLease' = bLease, b' = b,
    lastAction' = "finishX",
  }

  // The periodic check on the tail fails a running attempt whose lease has expired.
  action periodicCheck: bool = all {
    tailBusyUntil <= clock, b == Running, bLease <= clock,
    b' = FailedByLease,
    clock' = clock, tailBusyUntil' = tailBusyUntil, lastHeartbeat' = lastHeartbeat, renewQueued' = renewQueued,
    bLease' = bLease, x' = x, hookEndsAt' = hookEndsAt, hookCalls' = hookCalls, hostClosed' = hostClosed,
    lastAction' = "periodicCheck",
  }

  action step = {
    nondet d = HOOK_DURATIONS.oneOf()
    any { tick, sendHeartbeat, processRenew, finishX(d), periodicCheck }
  }

  // ---------- properties ----------

  // A slow hook never lets B's lease lapse while B runs and its worker stays connected. A lapsed
  // lease is what both losses start from: the periodic check fails B (:100-113), and B's own finish
  // is dropped with `record: null` (remoteTaskLifecycle.ts:97, :124).
  val noLeaseLossWhileConnected: bool = b == Running implies bLease > clock
  // A slow hook never times out the project host's request (which closes the host).
  val hostStaysOpen: bool = not(hostClosed)
  // The hook runs at most once, and only after X's record is saved.
  val hookOnceAfterSave: bool = hookCalls <= 1 and (hookCalls == 1 implies x == Saved)

  val safety: bool = and { noLeaseLossWhileConnected, hostStaysOpen, hookOnceAfterSave }

  // ---------- witnesses ----------
  val wLongHookDone: bool = hookCalls == 1 and hookEndsAt >= 60
  val wRenewDuringHook: bool = lastAction == "processRenew" and hookEndsAt > clock and x == Saved
  val wFinished: bool = x == Saved
  val wReachedHorizon: bool = clock == HORIZON
}

module hookBeforeReply { import workerPoolRemoteHookLease(DESIGN = "HookBeforeReply").* from "./workerPoolRemoteHookLease" }
module hookAfterReply { import workerPoolRemoteHookLease(DESIGN = "HookAfterReply").* from "./workerPoolRemoteHookLease" }

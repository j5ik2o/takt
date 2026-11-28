// -*- mode: Bluespec; -*-
// Goal execution tools over an external takt-mcp (issue #179).
//
// Code:
//   src/features/mcp/server.ts                   createTaktMcpServer, the goalExecutionConnection gate
//   src/features/mcp/goalExecutionOperations.ts  pauseTaktGoal / resumeTaktGoal / abortTaktGoal
//   src/features/mcp/goalFinishOperations.ts     finishTaktAbortedGoal
//   src/infra/goals/execution.ts                 setGoalExecutionStatus
//   src/infra/goals/state.ts                     transitionGoalExecution
//   src/app/mcp/index.ts                         --tool-set all / manager / read-only
//
// Two callers drive one goal: M is the manager connection (the only caller the tools are
// registered for today) and X is an external takt-mcp started with --tool-set all. Each operation
// is a begin (validate and read the saved goal), a commit (save the transition and run the steps
// after the save: invalidate pending work, start the daemon and manager run, resolve the branch and
// check the unintegrated results for finish), and, when the saved state rejects the operation, an
// abandon that saves nothing. The saved goal can only be changed through the goal-execution lock,
// so one commit is atomic; the window the model is about is between begin and commit.
//
// DESIGN picks the implementation:
//   "Current" — integration/takt-mcp at e0d653c67. The four tools are registered only when
//               options.goalExecutionConnection is set, which only the manager connection does, so
//               --tool-set all answers "Tool not found". No interlock keeps M and X from being
//               between begin and commit for the same goal at once.
//   "Fixed"   — the four tools are registered for --tool-set all as well, and every caller takes a
//               per-goal driver lease for the whole operation (begin to commit/abandon). A caller
//               that finds a live lease held by the other caller is refused with an error naming
//               the holder; a lease whose holder died is reclaimed by the next caller.
module goalExecutionTools {
  const DESIGN: str
  pure val FIXED: bool = DESIGN == "Fixed"

  type Driver = M | X
  type Op = Pause | Resume | Abort | Finish
  type Exec = Active | Paused | Aborted
  type GoalStatus = Created | AwaitingMerge | Completed

  // A driver's operation slot: Empty between operations, Doing while begin..commit/abandon.
  type Slot = Empty | Doing(Op)
  // The per-goal driver lease: Free or held by one driver.
  type Lease = Free | Held(Driver)

  pure val DRIVERS: Set[Driver] = Set(M, X)
  pure val OPS: Set[Op] = Set(Pause, Resume, Abort, Finish)

  var exec: Exec
  var goalStatus: GoalStatus
  var lease: Lease
  var inflightM: Slot
  var inflightX: Slot
  var aliveM: bool
  var aliveX: bool
  // Set by an abort, never cleared: an aborted goal cannot resume.
  var everAborted: bool
  // How many calls were refused by a live lease, and the last lease they named.
  var refusals: int
  var lastRefusal: Lease
  var lastAction: str

  def slotOf(d: Driver): Slot = if (d == M) inflightM else inflightX

  def aliveOf(d: Driver): bool = if (d == M) aliveM else aliveX

  def busy(d: Driver): bool = match slotOf(d) {
    | Doing(_) => true
    | Empty => false
  }

  def inFlight(d: Driver, op: Op): bool = match slotOf(d) {
    | Doing(o) => o == op
    | Empty => false
  }

  def heldBy(d: Driver): bool = match lease {
    | Held(h) => h == d
    | Free => false
  }

  def namesHolder(l: Lease): bool = match l {
    | Held(_) => true
    | Free => false
  }

  // A lease left by a dead holder is stale and may be reclaimed by the next caller.
  def deadHolderLease: bool = match lease {
    | Held(h) => not(aliveOf(h))
    | Free => false
  }

  // transitionGoalExecution: only these saved states accept each operation.
  def applicable(op: Op): bool = match op {
    | Pause => exec == Active
    | Resume => exec == Paused
    | Abort => exec == Active or exec == Paused
    | Finish => exec == Aborted and (goalStatus == Created or goalStatus == AwaitingMerge)
  }

  action init: bool = all {
    exec' = Active,
    goalStatus' = Created,
    lease' = Free,
    inflightM' = Empty,
    inflightX' = Empty,
    aliveM' = true,
    aliveX' = true,
    everAborted' = false,
    refusals' = 0,
    lastRefusal' = Free,
    lastAction' = "init",
  }

  // Read the goal and start the operation. Fixed additionally takes the lease; a stale lease is
  // reclaimed here (the dead holder cannot save anything any more).
  action begin(d: Driver, op: Op): bool = all {
    aliveOf(d),
    not(busy(d)),
    if (FIXED) (lease == Free or deadHolderLease) else true,
    inflightM' = if (d == M) Doing(op) else inflightM,
    inflightX' = if (d == X) Doing(op) else inflightX,
    lease' = if (FIXED) Held(d) else lease,
    exec' = exec,
    goalStatus' = goalStatus,
    aliveM' = aliveM,
    aliveX' = aliveX,
    everAborted' = everAborted,
    refusals' = refusals,
    lastRefusal' = lastRefusal,
    lastAction' = if (FIXED and deadHolderLease) "beginAfterStaleLease" else "begin",
  }

  // Fixed: a call that finds a live lease held by the other driver fails without changing the goal.
  action refuse(d: Driver): bool = all {
    FIXED,
    aliveOf(d),
    not(busy(d)),
    namesHolder(lease),
    not(deadHolderLease),
    exec' = exec,
    goalStatus' = goalStatus,
    lease' = lease,
    inflightM' = inflightM,
    inflightX' = inflightX,
    aliveM' = aliveM,
    aliveX' = aliveX,
    everAborted' = everAborted,
    refusals' = refusals + 1,
    lastRefusal' = lease,
    lastAction' = if (d == X and heldBy(M)) "externalRefusedByManager" else "refused",
  }

  // Save the transition and run the steps after the save.
  action commit(d: Driver, op: Op): bool = all {
    aliveOf(d),
    inFlight(d, op),
    FIXED implies heldBy(d),
    applicable(op),
    exec' = if (op == Pause) Paused else if (op == Resume) Active else if (op == Abort) Aborted else exec,
    goalStatus' = if (op == Finish) Completed else goalStatus,
    everAborted' = (everAborted or op == Abort),
    inflightM' = if (d == M) Empty else inflightM,
    inflightX' = if (d == X) Empty else inflightX,
    lease' = if (FIXED) Free else lease,
    aliveM' = aliveM,
    aliveX' = aliveX,
    refusals' = refusals,
    lastRefusal' = lastRefusal,
    lastAction' = if (d == X and op == Finish) "externalFinish" else "commit",
  }

  // The saved state rejects the operation (transitionGoalExecution throws): nothing is saved and
  // the lease is released.
  action abandon(d: Driver): bool = all {
    aliveOf(d),
    busy(d),
    exec' = exec,
    goalStatus' = goalStatus,
    lease' = if (FIXED) Free else lease,
    inflightM' = if (d == M) Empty else inflightM,
    inflightX' = if (d == X) Empty else inflightX,
    aliveM' = aliveM,
    aliveX' = aliveX,
    everAborted' = everAborted,
    refusals' = refusals,
    lastRefusal' = lastRefusal,
    lastAction' = "abandon",
  }

  // The process dies between begin and commit: its operation slot is gone, its lease stays behind.
  action crash(d: Driver): bool = all {
    aliveOf(d),
    aliveM' = if (d == M) false else aliveM,
    aliveX' = if (d == X) false else aliveX,
    inflightM' = if (d == M) Empty else inflightM,
    inflightX' = if (d == X) Empty else inflightX,
    lease' = lease,
    exec' = exec,
    goalStatus' = goalStatus,
    everAborted' = everAborted,
    refusals' = refusals,
    lastRefusal' = lastRefusal,
    lastAction' = "crash",
  }

  action step = {
    nondet d = DRIVERS.oneOf()
    nondet op = OPS.oneOf()
    any { begin(d, op), refuse(d), commit(d, op), abandon(d), crash(d) }
  }

  // ---------- properties ----------

  // The manager connection and an external takt-mcp are never both inside an operation on the goal.
  val atMostOneWriter: bool = not(busy(M) and busy(X))

  // Every operation that is in flight holds the per-goal lease.
  val everyOperationLeased: bool = (busy(M) implies heldBy(M)) and (busy(X) implies heldBy(X))

  // An aborted goal does not become active again.
  val abortedStaysAborted: bool = not(everAborted and exec == Active)

  // Finish moves to completed only from an aborted goal and leaves executionStatus aborted.
  val completedImpliesAborted: bool = goalStatus == Completed implies (exec == Aborted and everAborted)

  // A refusal names the lease it refused, so the caller can tell who is driving the goal.
  val refusalNamesHolder: bool = refusals == 0 or namesHolder(lastRefusal)

  val safety: bool = and {
    atMostOneWriter, everyOperationLeased, abortedStaysAborted, completedImpliesAborted, refusalNamesHolder,
  }

  // ---------- witnesses (each should be reachable) ----------

  // Current: both drivers are between begin and commit.
  val wDoubleDrive: bool = busy(M) and busy(X)
  // Fixed: the external call is refused because the manager connection holds the lease.
  val wExternalRefusedByManager: bool = lastAction == "externalRefusedByManager"
  // Fixed: after the manager's operation ends, the external call runs.
  val wExternalFinish: bool = lastAction == "externalFinish"
  // Fixed: a lease left by a dead holder is reclaimed by the next caller.
  val wStaleLeaseReclaimed: bool = lastAction == "beginAfterStaleLease"
}

module current { import goalExecutionTools(DESIGN = "Current").* from "./goalExecutionTools" }
module fixed { import goalExecutionTools(DESIGN = "Fixed").* from "./goalExecutionTools" }

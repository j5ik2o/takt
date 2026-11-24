// -*- mode: Bluespec; -*-
// Goal registration recovery for one approved proposal (one reservation, one goal ID).
//
// Source correspondence (src/ at the time of writing):
//   features/manager/conversationService.ts  approve_summary turn: reserved gate, durable
//                                            reservation, commit of approval=registered,
//                                            release of the reservation when no artifact remains
//   infra/goals/service.ts                   registerReservedGoal, createGoal
//   infra/goals/registrationVerification.ts  verification before save, explicit re-verification
//   infra/goals/schema.ts                    registrationVerification: pending | not_required |
//                                            completed(verdict passed | failed | error | absent)
//
// One proposal revision owns at most one reservation, so the model has a single goal.
// A crash or an aborted turn can stop a turn between any two durable writes.
// Not modelled: other conversations writing the same goal, task/work-log evidence of delivery
// (folded into `registeredEvents >= 1`), and changes to the verification configuration mid-trace.

module goalRegistrationRecoveryCore {
  // false: the retry path as it is on integration/takt-mcp before the fix.
  // true:  approve_summary accepts `reverifyRegistration`, and only that flag re-runs verification.
  const EXPLICIT_REVERIFY: bool
  // true models the reverted commit d6871605f: every retry re-runs verification by itself.
  const IMPLICIT_REVERIFY: bool

  type Approval = NoApproval | Reserved | Registered
  // goal.json registrationVerification. `Unpassed` is completed with verdict failed or error,
  // which only releases before "verify before saving" (6d0074c9b) could write.
  type Verification = NoRecord | Pending | NotRequired | Passed | Unpassed
  type Verdict = VerdictPassed | VerdictFailed | VerdictError
  type Command = Approve | ApproveWithReverify | OtherCommand
  type Decision = RejectUndelivered | RejectUnverified | RunVerification | Confirm
  type Pc =
    | Idle
    | ReservationSaved   // approval=reserved is durable; registerReservedGoal not yet called
    | Creating           // createGoal: verification done, nothing written yet
    | BranchCreated
    | GoalStored
    | Reverifying        // existing goal: about to run the verifier
    | ReverifyPassed     // verifier passed; goal.json not yet updated
    | Committing         // registerReservedGoal returned; conversation change not yet saved

  type State = {
    approval: Approval,
    proposalPending: bool,
    goalExists: bool,
    verification: Verification,
    branch: bool,
    registeredEvents: int,
    goalCreates: int,
    passedLogs: int,          // work-log entries that record a passed registration verification
    freshRuns: int,           // verifier runs by createGoal, before anything is saved
    explicitRuns: int,        // verifier runs requested with reverifyRegistration
    implicitRuns: int,        // verifier runs for a saved goal that nobody requested
    verificationRequired: bool,
    pc: Pc,
    turnReverify: bool,
    confirmedByReverify: bool,
  }

  var s: State

  pure val VERDICTS = Set(VerdictPassed, VerdictFailed, VerdictError)
  pure val COMMANDS = Set(Approve, ApproveWithReverify, OtherCommand)

  pure def needsVerification(v: Verification): bool = v == Pending or v == Unpassed

  /// conversationService: which commands pass the gate while the approval is reserved.
  pure def admittedWhileReserved(c: Command): bool = match c {
    | Approve => true
    | ApproveWithReverify => EXPLICIT_REVERIFY
    | OtherCommand => false
  }

  /// registerReservedGoal for a goal that already exists and matches the reservation.
  pure def existingGoalDecision(v: Verification, events: int, reverify: bool): Decision =
    if (events == 0) RejectUndelivered
    else if (not(needsVerification(v))) Confirm
    else if (IMPLICIT_REVERIFY or (EXPLICIT_REVERIFY and reverify)) RunVerification
    else if (v == Pending or EXPLICIT_REVERIFY) RejectUnverified
    else Confirm  // before the fix a saved failed/error verdict is returned as registered

  pure def fresh(required: bool): State = {
    approval: NoApproval, proposalPending: true, goalExists: false, verification: NoRecord,
    branch: false, registeredEvents: 0, goalCreates: 0, passedLogs: 0, freshRuns: 0,
    explicitRuns: 0, implicitRuns: 0, verificationRequired: required, pc: Idle,
    turnReverify: false, confirmedByReverify: false,
  }

  /// A fresh proposal, or a registration that an earlier release left interrupted:
  /// goal.json and its branch exist, the reservation is still held, and the verification is
  /// pending (interrupted) or completed without passing.
  action initWith(required: bool, interrupted: bool, left: Verification, delivered: int): bool =
    s' = if (interrupted) {
      ...fresh(required), approval: Reserved, goalExists: true, verification: left, branch: true,
      registeredEvents: delivered, goalCreates: 1,
    } else fresh(required)

  action init = {
    nondet required = Set(true, false).oneOf()
    nondet interrupted = Set(true, false).oneOf()
    nondet left = Set(Pending, Unpassed).oneOf()
    nondet delivered = Set(0, 1).oneOf()
    initWith(required, interrupted, left, delivered)
  }

  /// approve_summary accepted. The reservation is saved before any goal resource is created.
  action startApprove(reverify: bool): bool = all {
    s.pc == Idle,
    s.approval != Registered,
    s.proposalPending,
    not(reverify) or (EXPLICIT_REVERIFY and s.approval == Reserved),
    s' = { ...s, approval: Reserved, pc: ReservationSaved, turnReverify: reverify },
  }

  /// Any other human command. It is rejected while reserved; otherwise it dismisses the proposal.
  action otherCommand = all {
    s.pc == Idle,
    s' = if (s.approval == Reserved) s else { ...s, proposalPending: false },
  }

  action registerExisting = all {
    s.pc == ReservationSaved,
    s.goalExists,
    s' = match existingGoalDecision(s.verification, s.registeredEvents, s.turnReverify) {
      | RejectUndelivered => { ...s, pc: Idle }
      | RejectUnverified => { ...s, pc: Idle }
      | RunVerification => { ...s, pc: Reverifying }
      | Confirm => { ...s, pc: Committing }
    },
  }

  /// A branch without goal.json needs manual reconciliation; the reservation stays held.
  action rejectOrphanBranch = all {
    s.pc == ReservationSaved,
    not(s.goalExists),
    s.branch,
    s' = { ...s, pc: Idle },
  }

  /// createGoal verifies before it saves. A verdict other than passed leaves no artifact, so the
  /// conversation releases the reservation.
  action verifyBeforeCreateWith(verdict: Verdict): bool = all {
    s.pc == ReservationSaved,
    not(s.goalExists),
    not(s.branch),
    s' = if (not(s.verificationRequired)) { ...s, pc: Creating }
      else if (verdict == VerdictPassed) { ...s, pc: Creating, freshRuns: s.freshRuns + 1 }
      else { ...s, pc: Idle, approval: NoApproval, freshRuns: s.freshRuns + 1 },
  }

  action verifyBeforeCreate = {
    nondet verdict = VERDICTS.oneOf()
    verifyBeforeCreateWith(verdict)
  }

  action createBranch = all {
    s.pc == Creating,
    s' = { ...s, branch: true, pc: BranchCreated },
  }

  action storeGoal = all {
    s.pc == BranchCreated,
    s' = {
      ...s, goalExists: true, goalCreates: s.goalCreates + 1, pc: GoalStored,
      verification: if (s.verificationRequired) Passed else NotRequired,
      passedLogs: if (s.verificationRequired) s.passedLogs + 1 else s.passedLogs,
    },
  }

  /// store.create failed: createGoal removes the branch, and no artifact remains.
  action storeGoalFails = all {
    s.pc == BranchCreated,
    s' = { ...s, branch: false, approval: NoApproval, pc: Idle },
  }

  action saveRegisteredEvent = all {
    s.pc == GoalStored,
    s' = { ...s, registeredEvents: s.registeredEvents + 1, pc: Committing },
  }

  /// The verifier runs for a saved goal. A verdict other than passed changes nothing.
  /// When verification is no longer required, the record becomes not_required without a run.
  action runReverificationWith(verdict: Verdict): bool = all {
    s.pc == Reverifying,
    val counted = if (s.turnReverify) { ...s, explicitRuns: s.explicitRuns + 1 }
      else { ...s, implicitRuns: s.implicitRuns + 1 }
    s' = if (not(s.verificationRequired)) {
        ...s, pc: Committing, confirmedByReverify: true,
        verification: if (needsVerification(s.verification)) NotRequired else s.verification,
      }
      else if (verdict == VerdictPassed) { ...counted, pc: ReverifyPassed }
      else { ...counted, pc: Idle },
  }

  action runReverification = {
    nondet verdict = VERDICTS.oneOf()
    runReverificationWith(verdict)
  }

  /// store.update under the goal lock: only a record that still needs verification is replaced.
  action recordReverification = all {
    s.pc == ReverifyPassed,
    s' = if (needsVerification(s.verification)) {
        ...s, verification: Passed, passedLogs: s.passedLogs + 1, pc: Committing, confirmedByReverify: true,
      } else { ...s, pc: Committing },
  }

  action commitRegistration = all {
    s.pc == Committing,
    s' = { ...s, approval: Registered, proposalPending: false, pc: Idle },
  }

  /// Process exit or turn abort between two durable writes. Saved state stays as it is.
  action crash = all {
    s.pc != Idle,
    s' = { ...s, pc: Idle },
  }

  action step = any {
    startApprove(false),
    startApprove(true),
    otherCommand,
    registerExisting,
    rejectOrphanBranch,
    verifyBeforeCreate,
    createBranch,
    storeGoal,
    storeGoalFails,
    saveRegisteredEvent,
    runReverification,
    recordReverification,
    commitRegistration,
    crash,
  }

  // ---- Invariants -------------------------------------------------------------------------

  /// A reservation never produces a second goal, a second registered event, or a second
  /// passed-verification record.
  val noDuplicateRegistration =
    s.goalCreates <= 1 and s.registeredEvents <= 1 and s.passedLogs <= 1

  /// The reservation and the saved artifacts agree: a registered approval has its goal, branch
  /// and registered event; a released reservation has left no goal and no branch.
  val reservationMatchesArtifacts = and {
    s.approval == Registered implies (s.goalExists and s.branch and s.registeredEvents >= 1),
    s.approval == NoApproval implies (not(s.goalExists) and not(s.branch)),
  }

  /// A registration is never confirmed while its verification is pending or did not pass.
  val noUnpassedConfirmation =
    s.approval == Registered implies not(needsVerification(s.verification))

  /// Verification of a saved goal runs only when a person asks for it.
  val savedGoalVerifiedOnlyOnRequest = s.implicitRuns == 0

  /// Issue #84: a reservation whose saved goal still needs verification has a command that the
  /// conversation accepts and that does not end in a recovery rejection.
  val interruptedVerificationRecoverable =
    (s.pc == Idle and s.approval == Reserved and s.proposalPending and s.goalExists
      and needsVerification(s.verification) and s.registeredEvents >= 1)
    implies COMMANDS.exists(c => and {
      admittedWhileReserved(c),
      existingGoalDecision(s.verification, s.registeredEvents, c == ApproveWithReverify) != RejectUnverified,
    })

  val safety = and {
    noDuplicateRegistration,
    reservationMatchesArtifacts,
    noUnpassedConfirmation,
    savedGoalVerifiedOnlyOnRequest,
    interruptedVerificationRecoverable,
  }

  // ---- Witnesses (reachability; checked with --witnesses, a count above 0 means reachable) ---

  val registeredAfterReverification = s.approval == Registered and s.confirmedByReverify and s.verification == Passed
  val registeredFresh = s.approval == Registered and not(s.confirmedByReverify) and s.freshRuns == 1
  val reverificationRejected = s.pc == Idle and s.approval == Reserved and s.explicitRuns >= 1 and needsVerification(s.verification)
  val reservationReleased = s.approval == NoApproval and s.freshRuns >= 1
}

/// integration/takt-mcp before the fix (f6c0d505b).
module currentCode {
  import goalRegistrationRecoveryCore(EXPLICIT_REVERIFY = false, IMPLICIT_REVERIFY = false).*
}

/// The fix: verification of a saved goal runs only for approve_summary with reverifyRegistration.
module fixedCode {
  import goalRegistrationRecoveryCore(EXPLICIT_REVERIFY = true, IMPLICIT_REVERIFY = false).*
}

/// The reverted fix d6871605f: every retry re-runs verification without being asked.
module revertedRetryFix {
  import goalRegistrationRecoveryCore(EXPLICIT_REVERIFY = false, IMPLICIT_REVERIFY = true).*
}

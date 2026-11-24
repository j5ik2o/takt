// -*- mode: Bluespec; -*-
// Deterministic scenarios for goalRegistrationRecovery.qnt.
// Run each module with: quint test goalRegistrationRecovery_test.qnt --main=<module>

/// integration/takt-mcp before the fix: the reservation cannot leave the interrupted state.
module currentCodeTest {
  import goalRegistrationRecoveryCore(EXPLICIT_REVERIFY = false, IMPLICIT_REVERIFY = false).* from "./goalRegistrationRecovery"

  run pendingReservationStaysBlockedTest =
    initWith(true, true, Pending, 1)
      .then(startApprove(false))
      .then(registerExisting)
      .expect(s.pc == Idle and s.approval == Reserved and s.verification == Pending)
      .expect(s.freshRuns + s.explicitRuns + s.implicitRuns == 0)
      .expect(not(interruptedVerificationRecoverable))
      .then(otherCommand)
      .expect(s.approval == Reserved and s.proposalPending)

  run reverifyCommandDoesNotExistTest =
    initWith(true, true, Pending, 1)
      .then(startApprove(true))
      .fail()

  run savedFailedVerdictIsConfirmedTest =
    initWith(true, true, Unpassed, 1)
      .then(startApprove(false))
      .then(registerExisting)
      .then(commitRegistration)
      .expect(not(noUnpassedConfirmation))
}

module fixedCodeTest {
  import goalRegistrationRecoveryCore(EXPLICIT_REVERIFY = true, IMPLICIT_REVERIFY = false).* from "./goalRegistrationRecovery"

  run plainRetryNeverVerifiesTest =
    initWith(true, true, Pending, 1)
      .then(startApprove(false))
      .then(registerExisting)
      .expect(s.pc == Idle and s.approval == Reserved and s.verification == Pending)
      .expect(s.freshRuns + s.explicitRuns + s.implicitRuns == 0)
      .expect(safety)

  run reverifyPassedRegistersTest =
    initWith(true, true, Pending, 1)
      .then(startApprove(true))
      .then(registerExisting)
      .then(runReverificationWith(VerdictPassed))
      .then(recordReverification)
      .then(commitRegistration)
      .expect(s.approval == Registered and s.verification == Passed)
      .expect(s.passedLogs == 1 and s.registeredEvents == 1 and s.goalCreates == 1 and s.explicitRuns == 1)
      .expect(safety)

  run reverifyFailedKeepsReservationTest =
    initWith(true, true, Pending, 1)
      .then(startApprove(true))
      .then(registerExisting)
      .then(runReverificationWith(VerdictFailed))
      .expect(s.pc == Idle and s.approval == Reserved and s.verification == Pending and s.passedLogs == 0)
      .expect(safety)

  run crashAfterRecordingConvergesWithoutSecondRecordTest =
    initWith(true, true, Pending, 1)
      .then(startApprove(true))
      .then(registerExisting)
      .then(runReverificationWith(VerdictPassed))
      .then(recordReverification)
      .then(crash)
      .expect(s.approval == Reserved and s.verification == Passed)
      .then(startApprove(true))
      .then(registerExisting)
      .then(commitRegistration)
      .expect(s.approval == Registered and s.passedLogs == 1 and s.explicitRuns == 1)
      .expect(safety)

  run savedFailedVerdictNeedsReverificationTest =
    initWith(true, true, Unpassed, 1)
      .then(startApprove(false))
      .then(registerExisting)
      .expect(s.pc == Idle and s.approval == Reserved and s.verification == Unpassed)
      .then(startApprove(true))
      .then(registerExisting)
      .then(runReverificationWith(VerdictPassed))
      .then(recordReverification)
      .then(commitRegistration)
      .expect(s.approval == Registered and s.verification == Passed and s.passedLogs == 1)
      .expect(safety)

  run verificationNoLongerRequiredTest =
    initWith(false, true, Pending, 1)
      .then(startApprove(true))
      .then(registerExisting)
      .then(runReverificationWith(VerdictFailed))
      .then(commitRegistration)
      .expect(s.approval == Registered and s.verification == NotRequired)
      .expect(s.explicitRuns == 0 and s.passedLogs == 0)
      .expect(safety)

  run undeliveredRegistrationStaysOutOfScopeTest =
    initWith(true, true, Pending, 0)
      .then(startApprove(true))
      .then(registerExisting)
      .expect(s.pc == Idle and s.approval == Reserved and s.verification == Pending and s.explicitRuns == 0)

  /// A reservation without a saved goal: the turn stopped after the reservation was saved.
  run reverifyWithoutSavedGoalCreatesNothingTest =
    initWith(true, false, Pending, 0)
      .then(startApprove(false))
      .then(crash)
      .expect(s.approval == Reserved and not(s.goalExists))
      .then(startApprove(true))
      .then(rejectReverifyWithoutGoal)
      .expect(s.approval == NoApproval and not(s.goalExists) and not(s.branch) and s.goalCreates == 0)
      .expect(s.freshRuns + s.explicitRuns == 0)
      .expect(safety)

  run freshFailedVerificationReleasesReservationTest =
    initWith(true, false, Pending, 0)
      .then(startApprove(false))
      .then(verifyBeforeCreateWith(VerdictFailed))
      .expect(s.approval == NoApproval and not(s.goalExists) and not(s.branch))
      .expect(safety)
}

// -*- mode: Bluespec; -*-
// The path of issue j5ik2o/takt#111, step by step.
module currentTest {
  import resumeRecordsByName(matchByName = false).* from "./resumeRecordsByName"

  /// Before the fix: resume at final-gate after the definition changed,
  /// REJECT, and remediation aborts although the adjudication was saved.
  run abortsAfterDefinitionChangeTest =
    init.then(adjudicate).then(interrupt).then(definitionChanges).then(requeue)
      .then(gateRejects).then(remediate)
      .expect(status == Aborted and reason == InputNotProduced and adjudicationSaved)

  /// Before the fix the same path works when the hash is unchanged.
  run sameDefinitionContinuesTest =
    init.then(adjudicate).then(interrupt).then(requeue)
      .then(gateRejects).then(remediate)
      .expect(status == Running and current == Gate)
}

module fixedTest {
  import resumeRecordsByName(matchByName = true).* from "./resumeRecordsByName"

  run continuesAfterDefinitionChangeTest =
    init.then(adjudicate).then(interrupt).then(definitionChanges).then(requeue)
      .then(gateRejects).then(remediate)
      .expect(status == Running and current == Gate and inherited.contains(Adjudicate))
      .then(gateApproves)
      .expect(status == Completed)

  run sameDefinitionContinuesTest =
    init.then(adjudicate).then(interrupt).then(requeue)
      .then(gateRejects).then(remediate)
      .expect(status == Running and current == Gate)
}

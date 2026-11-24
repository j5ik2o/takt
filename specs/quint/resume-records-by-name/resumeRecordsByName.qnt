// -*- mode: Bluespec; -*-
// Resuming an interrupted run after the workflow definition changed
// (issue j5ik2o/takt#111).
//
// Source of the model:
//   src/core/workflow/workflow-reference.ts                (workflow reference = name, or "builtin:v2:sha256:..." of the content)
//   src/core/workflow/workflow-step-participation-index.ts (participation records keyed by workflow reference + step + call position)
//   src/core/workflow/review-report-discovery.ts           (workflow_report_input_not_produced when the producer has no record)
//   src/core/workflow/workflow-resume-records.ts           (after the fix: saved records are matched by name and position)
//   builtins/*/workflows/peer-review.yaml                  (review-adjudication -> final-gate -> remediation shape)
//
// The workflow is reduced to the steps that matter:
//   Adjudicate --always--> Gate          (writes review-resolution.md)
//   Gate       --approve-> COMPLETE
//   Gate       --reject--> Remediate
//   Remediate  --always--> Gate          (requires Adjudicate's report as input)
// `matchByName` selects the behaviour: false = code before the fix, true = after.
module resumeRecordsByName {
  type Step = Adjudicate | Gate | Remediate
  type Status = Running | Stopped | Completed | Aborted
  type Reason = NoReason | InputNotProduced
  // The workflow name never changes in this model, so a record identity is
  // the content hash of the definition plus the step.
  type Record = { hash: int, step: Step }

  const matchByName: bool

  var status: Status
  var current: Step
  var reason: Reason
  /// Content hash of the workflow definition the next step is run with.
  var defHash: int
  /// Participation records visible to the current run.
  var records: Set[Record]
  /// Producers whose record was carried over from the source run (fix only).
  var inherited: Set[Step]
  var resumes: int

  action init = all {
    status' = Running,
    current' = Adjudicate,
    reason' = NoReason,
    defHash' = 0,
    records' = Set(),
    inherited' = Set(),
    resumes' = 0,
  }

  /// review-adjudication runs and records its participation under the
  /// reference of the definition it ran with.
  action adjudicate = all {
    status == Running, current == Adjudicate,
    records' = records.union(Set({ hash: defHash, step: Adjudicate })),
    inherited' = inherited.exclude(Set(Adjudicate)),
    current' = Gate,
    status' = status, reason' = reason, defHash' = defHash, resumes' = resumes,
  }

  action gateApproves = all {
    status == Running, current == Gate,
    status' = Completed,
    current' = current, reason' = reason, defHash' = defHash,
    records' = records, inherited' = inherited, resumes' = resumes,
  }

  action gateRejects = all {
    status == Running, current == Gate,
    current' = Remediate,
    status' = status, reason' = reason, defHash' = defHash,
    records' = records, inherited' = inherited, resumes' = resumes,
  }

  /// The declared input is looked up with the reference of the definition in
  /// use now. Without a record the step aborts before it runs.
  action remediate = all {
    status == Running, current == Remediate,
    if (records.contains({ hash: defHash, step: Adjudicate })) all {
      current' = Gate,
      status' = status, reason' = reason,
    } else all {
      status' = Aborted,
      reason' = InputNotProduced,
      current' = current,
    },
    defHash' = defHash, records' = records, inherited' = inherited, resumes' = resumes,
  }

  /// The run stops (failure, cancellation, daemon restart). The resume point
  /// is the step that was about to run.
  action interrupt = all {
    status == Running,
    status' = Stopped,
    current' = current, reason' = reason, defHash' = defHash,
    records' = records, inherited' = inherited, resumes' = resumes,
  }

  /// The definition changes while the task is stopped (takt rebuilt, builtin
  /// or project workflow edited). The name stays the same.
  action definitionChanges = all {
    status == Stopped,
    defHash' = 1 - defHash,
    status' = status, current' = current, reason' = reason,
    records' = records, inherited' = inherited, resumes' = resumes,
  }

  /// Requeue from the saved position. Steps before it are not run again.
  action requeue = all {
    status == Stopped,
    status' = Running,
    resumes' = resumes + 1,
    if (matchByName) all {
      // Saved records are located by name and position and re-keyed to the
      // current definition; their producers are marked as inherited.
      records' = records.map(r => { hash: defHash, step: r.step }),
      inherited' = records.map(r => r.step),
    } else all {
      // Saved records keep the hash of the definition that wrote them.
      records' = records,
      inherited' = inherited,
    },
    current' = current, reason' = reason, defHash' = defHash,
  }

  action step = any {
    adjudicate, gateApproves, gateRejects, remediate,
    interrupt, definitionChanges, requeue,
  }

  /// Remediate is reachable only after Adjudicate wrote its report in this
  /// run or in a run it was resumed from, so the input always exists.
  val adjudicationSaved = records.exists(r => r.step == Adjudicate)
  val noLostAdjudication = not(status == Aborted and reason == InputNotProduced and adjudicationSaved)
}

module current {
  import resumeRecordsByName(matchByName = false).*
}

module fixed {
  import resumeRecordsByName(matchByName = true).*
}

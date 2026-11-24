// -*- mode: Bluespec; -*-
// Task finish hook: one external command per saved terminal task state.
//
// Sources modelled:
//   src/features/tasks/execute/taskExecution.ts   executeTaskAndCompleteWithDetails (queue entry)
//   src/features/merge/index.ts                   executePrWorkflow (direct `takt merge` entry),
//                                                 executePersistedPrMergeTask (shared by both entries)
//   src/features/tasks/execute/taskFinishHook.ts  withTaskFinishHook
//
// PLACEMENT (a string) is where the hook call is attached:
//   AtNormalEnd    after the last `persistTaskResult` of the queue path only (the first idea)
//   AtEverySave    next to every terminal save, including the one inside executePersistedPrMergeTask,
//                  plus the queue entry (so a queued merge task passes two call sites)
//   AtEntryPoints  one wrapper around each of the two entry points, comparing the saved state
//                  before and after (the implementation)
module taskFinishHook {
  const PLACEMENT: str

  type Status = Running | Completed | Failed | Exceeded | PrFailed
  // How one execution leaves the code.
  type Exit =
    | Success          // workflow completed, state saved as completed
    | WorkflowFailed   // workflow aborted, saved as failed
    | Interrupted      // stop / goal abort / goal pause / SIGINT, saved as failed with interrupted = true
    | ThrownError      // setup or execution threw, saved as failed in the catch block
    | LimitExceeded    // iteration limit, saved as exceeded (early return)
    | PrCreateFailed   // work done but PR creation failed, saved as pr_failed (early return)
    | PostExecFailed   // auto-commit or push failed, saved as failed (early return)
    | SaveThrew        // the terminal save itself threw: nothing saved, the error propagates
  type Entry = QueueTask | QueueMergeTask | DirectMerge
  type HookOutcome = HookOk | HookNonZero | HookTimeout | HookSpawnError
  type Phase = Executing | Saved | Hooking | Returned

  pure val EXITS: Set[Exit] =
    Set(Success, WorkflowFailed, Interrupted, ThrownError, LimitExceeded, PrCreateFailed, PostExecFailed, SaveThrew)
  pure val MERGE_EXITS: Set[Exit] = Set(Success, WorkflowFailed, Interrupted, ThrownError, SaveThrew)
  pure val ENTRIES: Set[Entry] = Set(QueueTask, QueueMergeTask, DirectMerge)
  pure val OUTCOMES: Set[HookOutcome] = Set(HookOk, HookNonZero, HookTimeout, HookSpawnError)

  var entry: Entry
  var configured: bool        // task_finish_hook is set in the project's config
  var phase: Phase
  var status: Status          // tasks.yaml status
  var resumePoint: int        // stands for everything saved with the terminal state (resume point, result)
  var savedResume: int        // resumePoint as written by the terminal save
  var exit: Exit
  var pendingCalls: int       // hook call sites still to pass before returning
  var hookRuns: int
  var slotHeld: bool          // the caller's execution slot

  pure def savedStatus(e: Exit): Status = match e {
    | Success => Completed
    | WorkflowFailed => Failed
    | Interrupted => Failed
    | ThrownError => Failed
    | LimitExceeded => Exceeded
    | PrCreateFailed => PrFailed
    | PostExecFailed => Failed
    | SaveThrew => Running
  }

  pure def isTerminal(s: Status): bool = s != Running

  // Number of hook call sites an execution passes after its terminal save.
  pure def callSites(p: str, en: Entry, e: Exit): int =
    if (p == "AtNormalEnd")
      if (en == QueueTask and (e == Success or e == WorkflowFailed)) 1 else 0
    else if (p == "AtEverySave")
      if (e == SaveThrew) 0 else if (en == QueueMergeTask) 2 else 1
    else
      // The wrapper always runs; it calls the command only for a newly saved terminal state.
      if (e == SaveThrew) 0 else 1

  action initWith(en: Entry, cfg: bool): bool = all {
    entry' = en, configured' = cfg, phase' = Executing, status' = Running,
    resumePoint' = 0, savedResume' = 0, exit' = Success, pendingCalls' = 0, hookRuns' = 0, slotHeld' = true,
  }

  action init = {
    nondet en = ENTRIES.oneOf()
    nondet cfg = Set(true, false).oneOf()
    initWith(en, cfg)
  }

  // The execution reaches one of its exits and saves the terminal state (or fails to).
  action finishAs(e: Exit, resume: int): bool = all {
    phase == Executing,
    if (entry == QueueTask) EXITS.contains(e) else MERGE_EXITS.contains(e),
    exit' = e,
    status' = savedStatus(e),
    resumePoint' = if (e == SaveThrew) resumePoint else resume,
    savedResume' = if (e == SaveThrew) savedResume else resume,
    pendingCalls' = if (configured) callSites(PLACEMENT, entry, e) else 0,
    phase' = Saved,
    entry' = entry, configured' = configured, hookRuns' = hookRuns, slotHeld' = slotHeld,
  }

  action finish = {
    nondet e = EXITS.oneOf()
    nondet resume = 1.to(3).oneOf()
    finishAs(e, resume)
  }

  // One hook call site starts the command. The slot stays held while it runs.
  action startHook = all {
    phase == Saved, pendingCalls > 0,
    phase' = Hooking,
    pendingCalls' = pendingCalls - 1,
    hookRuns' = hookRuns + 1,
    entry' = entry, configured' = configured, status' = status, resumePoint' = resumePoint,
    savedResume' = savedResume, exit' = exit, slotHeld' = slotHeld,
  }

  // The command ends in any way (exit 0, non-zero, killed at the timeout, could not start).
  // No outcome writes to the task state.
  action endHookAs(o: HookOutcome): bool = all {
    phase == Hooking,
    phase' = Saved,
    entry' = entry, configured' = configured, status' = status, resumePoint' = resumePoint,
    savedResume' = savedResume, exit' = exit, pendingCalls' = pendingCalls, hookRuns' = hookRuns,
    slotHeld' = slotHeld,
  }

  action endHook = {
    nondet o = OUTCOMES.oneOf()
    endHookAs(o)
  }

  // The entry point returns (or rethrows) to its caller and the slot is released.
  action returnToCaller = all {
    phase == Saved, pendingCalls == 0,
    phase' = Returned, slotHeld' = false,
    entry' = entry, configured' = configured, status' = status, resumePoint' = resumePoint,
    savedResume' = savedResume, exit' = exit, pendingCalls' = pendingCalls, hookRuns' = hookRuns,
  }

  action stutter = all {
    phase == Returned,
    entry' = entry, configured' = configured, phase' = phase, status' = status, resumePoint' = resumePoint,
    savedResume' = savedResume, exit' = exit, pendingCalls' = pendingCalls, hookRuns' = hookRuns,
    slotHeld' = slotHeld,
  }

  action step = any { finish, startHook, endHook, returnToCaller, stutter }

  // The command runs at most once per execution.
  val atMostOnce = hookRuns <= 1
  // The command never runs before a terminal state is saved, and never without configuration.
  val onlyAfterTerminalSave = hookRuns > 0 implies (isTerminal(status) and configured)
  // Every execution that saved a terminal state has called the command by the time it returns.
  val noMissedExit = (phase == Returned and isTerminal(status) and configured) implies hookRuns == 1
  // The command never changes what the terminal save wrote.
  val savedStateUntouched = (phase != Executing) implies (resumePoint == savedResume and status == savedStatus(exit))
  // The slot is held exactly until the entry point returns, including while the command runs.
  val slotHeldUntilReturn = slotHeld == (phase != Returned)

  val safety = and {
    atMostOnce, onlyAfterTerminalSave, noMissedExit, savedStateUntouched, slotHeldUntilReturn,
  }

  // Witnesses (reachability): each must be reachable under the implementation's placement.
  val hookRanForExceeded = hookRuns == 1 and status == Exceeded and phase == Returned
  val hookRanForPrFailed = hookRuns == 1 and status == PrFailed and phase == Returned
  val hookRanForDirectMerge = hookRuns == 1 and entry == DirectMerge and phase == Returned
  val hookRanForInterrupted = hookRuns == 1 and exit == Interrupted and phase == Returned
  val returnedWithoutSave = phase == Returned and status == Running
}

module normalEndOnly {
  import taskFinishHook(PLACEMENT = "AtNormalEnd").*
}

module everySave {
  import taskFinishHook(PLACEMENT = "AtEverySave").*
}

module entryPoints {
  import taskFinishHook(PLACEMENT = "AtEntryPoints").*
}

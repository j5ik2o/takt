// -*- mode: Bluespec; -*-
// Task finish hook: the read/configuration prelude of runTaskFinishHooks and the notice that a
// hook was not run.
//
// This model is deliberately separate from taskFinishHook.qnt. That model answers "where is the
// hook attached, and may it change the saved state?"; it leaves the read of tasks.yaml and the
// project configuration out. This model answers "what happens when that read or the configuration
// cannot be obtained, and what does the user see?".
//
// Sources modelled:
//   src/features/tasks/execute/taskFinishHook.ts
//     runTaskFinishHooks        named path; reads tasks.yaml after the caller saved a terminal state
//                               (Path = NamedHook)
//     runTaskFinishHooksForStates  states path; the caller hands the saved states over
//                               (Path = StatesHook)
//   runHook (the wrapper around one execution) is not modelled. The design applies the same bounded
//   retry to its post-execution read; that path is covered by the code tests.
//
// NOTICE (a string) is the loss notice:
//   Silent   only log.error, which is written only when logging.debug is enabled (the old code)
//   Fixed    one stderr warning, with the task names, for each invocation that lost the hook
// RETRY (a string) is the read retry:
//   None       one read attempt; a lock timeout loses the hook
//   Bounded    at most MAX_READ_ATTEMPTS, MAX_RETRIES waits (the design)
//   Unbounded  keeps waiting after a timeout (the rejected alternative)
module taskFinishHookNotice {
  const NOTICE: str
  const RETRY: str

  type Path = NamedHook | StatesHook
  type Config = ConfigOk | ConfigMissing | ConfigUnreadable
  // The result of reading tasks.yaml for the named task.
  type Read = ReadOk | ReadNotTerminal | ReadTimeout | ReadBroken
  type Phase = Configuring | Reading | Waiting | Calling | Done

  pure val MAX_READ_ATTEMPTS: int = 2
  pure val MAX_RETRIES: int = 1
  pure val PATHS: Set[Path] = Set(NamedHook, StatesHook)
  pure val CONFIGS: Set[Config] = Set(ConfigOk, ConfigMissing, ConfigUnreadable)
  pure val READS: Set[Read] = Set(ReadOk, ReadNotTerminal, ReadTimeout, ReadBroken)

  var path: Path
  var config: Config
  var phase: Phase
  var readAttempts: int
  var retries: int
  var hookRuns: int
  var notices: int              // stderr warnings for a lost hook, one per invocation at most
  var loss: bool                // the hook was not run although a terminal state may have been saved
  var timedOut: bool            // at least one read ended in ReadTimeout
  var lastReadTimedOut: bool    // the last read ended in ReadTimeout (not just some earlier one)
  var sawNotTerminal: bool      // at least one read returned ReadNotTerminal

  // A timed-out read may be tried again only while the bound allows it.
  pure def canRetry(r: Read, attempts: int): bool =
    r == ReadTimeout and RETRY != "None"
      and (RETRY == "Unbounded" or attempts + 1 < MAX_READ_ATTEMPTS)

  action initWith(p: Path, c: Config): bool = all {
    path' = p, config' = c, phase' = Configuring,
    readAttempts' = 0, retries' = 0, hookRuns' = 0, notices' = 0,
    loss' = false, timedOut' = false, lastReadTimedOut' = false, sawNotTerminal' = false,
  }

  action init = {
    nondet p = PATHS.oneOf()
    nondet c = CONFIGS.oneOf()
    initWith(p, c)
  }

  // The project configuration is read first. Without a hook there is nothing to lose; an
  // unreadable configuration means the hook cannot be known, so it is a loss.
  action resolveConfig = all {
    phase == Configuring,
    phase' = if (config == ConfigMissing or config == ConfigUnreadable) Done
      else if (path == StatesHook) Calling
      else Reading,
    loss' = config == ConfigUnreadable,
    notices' = if (config == ConfigUnreadable and NOTICE == "Fixed") 1 else 0,
    path' = path, config' = config, readAttempts' = readAttempts, retries' = retries,
    hookRuns' = hookRuns, timedOut' = timedOut, lastReadTimedOut' = lastReadTimedOut,
    sawNotTerminal' = sawNotTerminal,
  }

  // One read of tasks.yaml. ReadNotTerminal is a state another process already moved on (retry or
  // requeue); it is not a lost hook for this design.
  action readStateAs(r: Read): bool = all {
    phase == Reading,
    readAttempts' = readAttempts + 1,
    timedOut' = (timedOut or r == ReadTimeout),
    lastReadTimedOut' = r == ReadTimeout,
    sawNotTerminal' = (sawNotTerminal or r == ReadNotTerminal),
    retries' = if (canRetry(r, readAttempts)) retries + 1 else retries,
    phase' = if (r == ReadOk) Calling
      else if (canRetry(r, readAttempts)) Waiting
      else Done,
    loss' = if (r == ReadOk or r == ReadNotTerminal) false
      else if (canRetry(r, readAttempts)) false
      else true,
    notices' = if (r == ReadOk or r == ReadNotTerminal) notices
      else if (canRetry(r, readAttempts)) notices
      else if (NOTICE == "Fixed") 1 else notices,
    path' = path, config' = config, hookRuns' = hookRuns,
  }

  action readState = {
    nondet r = READS.oneOf()
    readStateAs(r)
  }

  // The bounded interval between a timed-out read and its one retry.
  action waitThenRead = all {
    phase == Waiting,
    phase' = Reading,
    path' = path, config' = config, readAttempts' = readAttempts, retries' = retries,
    hookRuns' = hookRuns, notices' = notices, loss' = loss, timedOut' = timedOut,
    lastReadTimedOut' = lastReadTimedOut, sawNotTerminal' = sawNotTerminal,
  }

  // The saved terminal state exists and the hook command is invoked once.
  action callHook = all {
    phase == Calling,
    phase' = Done, hookRuns' = hookRuns + 1,
    loss' = false, notices' = notices,
    path' = path, config' = config, readAttempts' = readAttempts, retries' = retries,
    timedOut' = timedOut, lastReadTimedOut' = lastReadTimedOut, sawNotTerminal' = sawNotTerminal,
  }

  action stutter = all {
    phase == Done,
    path' = path, config' = config, phase' = phase, readAttempts' = readAttempts,
    retries' = retries, hookRuns' = hookRuns, notices' = notices, loss' = loss,
    timedOut' = timedOut, lastReadTimedOut' = lastReadTimedOut, sawNotTerminal' = sawNotTerminal,
  }

  action step = any { resolveConfig, readState, waitThenRead, callHook, stutter }

  // A lost hook is reported exactly once.
  val noUnnoticedLoss = (phase == Done and loss) implies notices == 1
  // A report is never produced when no hook was lost.
  val noFalseNotice = notices > 0 implies (phase == Done and loss)
  val noticeAtMostOnce = notices <= 1
  // Retrying stops at the bound; an unbounded retry fails this.
  val retryBounded = readAttempts <= MAX_READ_ATTEMPTS and retries <= MAX_RETRIES
  // The read modeled here is the post-save read of runTaskFinishHooks (NamedHook). The pre-execution
  // stamp read and runHook's post-execution read are not modeled; this invariant does not speak
  // about them. The code applies the same retry to runHook's post-execution read.
  // A timeout is always retried to the bound before the hook is given up (except ReadBroken, which
  // makes the next attempt pointless).
  val retriesTimeouts = (phase == Done and loss and timedOut) implies readAttempts == MAX_READ_ATTEMPTS
  // A retry (or a lost read) never invokes the command.
  val noHookOnLoss = loss implies hookRuns == 0
  val atMostOnceHook = hookRuns <= 1

  val safety = and {
    noUnnoticedLoss, noFalseNotice, noticeAtMostOnce, retryBounded, retriesTimeouts,
    noHookOnLoss, atMostOnceHook,
  }

  // Witnesses: each must be reachable under the fixed design.
  val wRetriedThenCalled = phase == Done and hookRuns == 1 and notices == 0 and readAttempts == 2
  // Two timeouts: the last read is a timeout, so the retry was exhausted.
  val wExhaustedWarned =
    phase == Done and loss and notices == 1 and hookRuns == 0 and readAttempts == 2 and lastReadTimedOut
  // A broken read on the retry: the earlier read timed out, but the last read did not, so this is
  // not the exhausted-timeout witness.
  val wTimeoutThenBrokenWarned =
    phase == Done and loss and notices == 1 and hookRuns == 0 and readAttempts == 2 and not(lastReadTimedOut)
  val wBrokenWarned =
    phase == Done and loss and notices == 1 and readAttempts == 1 and not(lastReadTimedOut)
  val wReadNotTerminalNoNotice =
    phase == Done and sawNotTerminal and not(loss) and notices == 0 and hookRuns == 0
  val wConfigMissingNoNotice = phase == Done and config == ConfigMissing and notices == 0 and hookRuns == 0
  val wStatesConfigErrorWarned =
    phase == Done and path == StatesHook and config == ConfigUnreadable and notices == 1 and hookRuns == 0
}

module noticeBefore {
  import taskFinishHookNotice(NOTICE = "Silent", RETRY = "None").*
}

module noticeNoRetry {
  import taskFinishHookNotice(NOTICE = "Fixed", RETRY = "None").*
}

module noticeUnbounded {
  import taskFinishHookNotice(NOTICE = "Fixed", RETRY = "Unbounded").*
}

module noticeFixed {
  import taskFinishHookNotice(NOTICE = "Fixed", RETRY = "Bounded").*
}

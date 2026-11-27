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
//     runTaskFinishHooksForStates  states path; the caller hands the saved states over
//     runHook                   the wrapper around one execution; reads tasks.yaml again
//
// NOTICE (a string) is the loss notice:
//   Silent   only log.error, which is written only when logging.debug is enabled (the old code)
//   Fixed    one warn(), with the task names, for each invocation that lost the hook
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
  var notices: int              // warn() calls for a lost hook, one per invocation at most
  var loss: bool                // the hook was not run although a terminal state may have been saved
  var timedOut: bool            // at least one read ended in ReadTimeout

  // A timed-out read may be tried again only while the bound allows it.
  pure def canRetry(r: Read, attempts: int): bool =
    r == ReadTimeout and RETRY != "None"
      and (RETRY == "Unbounded" or attempts + 1 < MAX_READ_ATTEMPTS)

  action initWith(p: Path, c: Config): bool = all {
    path' = p, config' = c, phase' = Configuring,
    readAttempts' = 0, retries' = 0, hookRuns' = 0, notices' = 0,
    loss' = false, timedOut' = false,
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
    hookRuns' = hookRuns, timedOut' = timedOut,
  }

  // One read of tasks.yaml. ReadNotTerminal is a state another process already moved on (retry or
  // requeue); it is not a lost hook for this design.
  action readStateAs(r: Read): bool = all {
    phase == Reading,
    readAttempts' = readAttempts + 1,
    timedOut' = (timedOut or r == ReadTimeout),
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
  }

  // The saved terminal state exists and the hook command is invoked once.
  action callHook = all {
    phase == Calling,
    phase' = Done, hookRuns' = hookRuns + 1,
    loss' = false, notices' = notices,
    path' = path, config' = config, readAttempts' = readAttempts, retries' = retries,
    timedOut' = timedOut,
  }

  action stutter = all {
    phase == Done,
    path' = path, config' = config, phase' = phase, readAttempts' = readAttempts,
    retries' = retries, hookRuns' = hookRuns, notices' = notices, loss' = loss,
    timedOut' = timedOut,
  }

  action step = any { resolveConfig, readState, waitThenRead, callHook, stutter }

  // A lost hook is reported exactly once.
  val noUnnoticedLoss = (phase == Done and loss) implies notices == 1
  // A report is never produced when no hook was lost.
  val noFalseNotice = notices > 0 implies (phase == Done and loss)
  val noticeAtMostOnce = notices <= 1
  // Retrying stops at the bound; an unbounded retry fails this.
  val retryBounded = readAttempts <= MAX_READ_ATTEMPTS and retries <= MAX_RETRIES
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
  val wExhaustedWarned = phase == Done and loss and notices == 1 and hookRuns == 0 and readAttempts == 2
  val wBrokenWarned = phase == Done and loss and notices == 1 and readAttempts == 1
  val wReadNotTerminalNoNotice = phase == Done and not(loss) and notices == 0 and hookRuns == 0
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

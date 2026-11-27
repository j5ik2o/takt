// -*- mode: Bluespec; -*-
// Scenario tests for the finish hook read/configuration prelude and the loss notice. Run:
//   quint test taskFinishHookNotice_test.qnt --main noticeFixedTest
//   quint test taskFinishHookNotice_test.qnt --main noticeBeforeTest
//   quint test taskFinishHookNotice_test.qnt --main noticeNoRetryTest
//   quint test taskFinishHookNotice_test.qnt --main noticeUnboundedTest
module noticeFixedTest {
  import taskFinishHookNotice(NOTICE = "Fixed", RETRY = "Bounded").* from "./taskFinishHookNotice"

  // A lock timeout is retried once; the successful read then runs the hook once, with no warning.
  run timeoutThenSuccessTest =
    initWith(NamedHook, ConfigOk).then(resolveConfig)
      .then(readStateAs(ReadTimeout))
      .expect(phase == Waiting and readAttempts == 1 and retries == 1 and notices == 0 and not(loss))
      .then(waitThenRead)
      .then(readStateAs(ReadOk))
      .then(callHook)
      .expect(phase == Done and hookRuns == 1 and notices == 0 and not(loss) and retryBounded)

  // Two timeouts exhaust the bound: no hook, one warning, and no further wait.
  run exhaustedWarnsOnceTest =
    initWith(NamedHook, ConfigOk).then(resolveConfig)
      .then(readStateAs(ReadTimeout)).then(waitThenRead)
      .then(readStateAs(ReadTimeout))
      .expect(phase == Done and loss and notices == 1 and hookRuns == 0 and readAttempts == 2 and retryBounded)

  // A broken tasks.yaml is not retried; the hook is lost and reported once.
  run brokenWarnsOnceTest =
    initWith(NamedHook, ConfigOk).then(resolveConfig)
      .then(readStateAs(ReadBroken))
      .expect(phase == Done and loss and notices == 1 and hookRuns == 0 and readAttempts == 1 and retries == 0)

  // A task another process already moved on is not this invocation's lost hook.
  run readNotTerminalDoesNotWarnTest =
    initWith(NamedHook, ConfigOk).then(resolveConfig)
      .then(readStateAs(ReadNotTerminal))
      .expect(phase == Done and not(loss) and notices == 0 and hookRuns == 0)

  // No configured hook: nothing is lost.
  run configMissingDoesNotWarnTest =
    initWith(NamedHook, ConfigMissing).then(resolveConfig)
      .expect(phase == Done and not(loss) and notices == 0 and hookRuns == 0)

  // The configuration cannot be read: no hook can be known, so one warning.
  run configUnreadableWarnsTest =
    initWith(NamedHook, ConfigUnreadable).then(resolveConfig)
      .expect(phase == Done and loss and notices == 1 and hookRuns == 0)

  // runTaskFinishHooksForStates was handed the terminal states, so it does not read tasks.yaml.
  run statesPathSkipsReadTest =
    initWith(StatesHook, ConfigOk).then(resolveConfig)
      .expect(phase == Calling and readAttempts == 0)
      .then(callHook)
      .expect(phase == Done and hookRuns == 1 and notices == 0)

  // A handed-over states path with an unreadable configuration still reports the loss once.
  run statesConfigErrorWarnsTest =
    initWith(StatesHook, ConfigUnreadable).then(resolveConfig)
      .expect(phase == Done and loss and notices == 1 and hookRuns == 0)

  // The command is not invoked a second time after it has been called.
  run noSecondCallTest =
    initWith(NamedHook, ConfigOk).then(resolveConfig)
      .then(readStateAs(ReadOk)).then(callHook).then(stutter)
      .expect(phase == Done and hookRuns == 1 and notices == 0)
}

module noticeBeforeTest {
  import taskFinishHookNotice(NOTICE = "Silent", RETRY = "None").* from "./taskFinishHookNotice"

  // Without a warning, a timeout loses the hook silently.
  run silentTimeoutTest =
    initWith(NamedHook, ConfigOk).then(resolveConfig)
      .then(readStateAs(ReadTimeout))
      .expect(phase == Done and loss and notices == 0 and not(noUnnoticedLoss))

  // The unreadable configuration is silent too.
  run silentConfigErrorTest =
    initWith(NamedHook, ConfigUnreadable).then(resolveConfig)
      .expect(phase == Done and loss and notices == 0 and not(noUnnoticedLoss))
}

module noticeNoRetryTest {
  import taskFinishHookNotice(NOTICE = "Fixed", RETRY = "None").* from "./taskFinishHookNotice"

  // A warning is not enough: a timeout is given up without using the retry bound.
  run timeoutNotRetriedTest =
    initWith(NamedHook, ConfigOk).then(resolveConfig)
      .then(readStateAs(ReadTimeout))
      .expect(phase == Done and loss and notices == 1 and readAttempts == 1 and not(retriesTimeouts))
}

module noticeUnboundedTest {
  import taskFinishHookNotice(NOTICE = "Fixed", RETRY = "Unbounded").* from "./taskFinishHookNotice"

  // Unbounded retrying passes the attempt bound and waits again.
  run retryExceedsBoundTest =
    initWith(NamedHook, ConfigOk).then(resolveConfig)
      .then(readStateAs(ReadTimeout)).then(waitThenRead)
      .then(readStateAs(ReadTimeout)).then(waitThenRead)
      .then(readStateAs(ReadTimeout))
      .expect(readAttempts == 3 and retries == 3 and not(retryBounded))
}

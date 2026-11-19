import { beforeEach, expect, it, vi } from 'vitest';
import {
  approveTaktGoalRegistration,
  listTaktGoalRegistrationProposals,
  rejectTaktGoalRegistration,
} from '../features/mcp/goalRegistrationProposalOperations.js';
import type { ConversationCommand, PortOutput } from '../features/manager/conversationPort.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ConversationRecordSchema } from '../infra/conversations/schema.js';
import { goalInput, goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

const doubles = vi.hoisted(() => ({
  allowed: vi.fn(), configDir: vi.fn(), daemonDir: vi.fn(), assignment: vi.fn(),
  constructStore: vi.fn(), read: vi.fn(),
  constructClient: vi.fn(), connect: vi.fn(), submit: vi.fn(), output: vi.fn(), close: vi.fn(),
  repositoryDirectory: vi.fn(), subscribe: vi.fn(), snapshot: vi.fn(),
}));
vi.mock('../features/mcp/operations.js', async (original) => ({
  ...await original<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: doubles.allowed,
}));
vi.mock('../infra/config/paths.js', async (original) => ({
  ...await original<typeof import('../infra/config/paths.js')>(), getGlobalConfigDir: doubles.configDir,
}));
vi.mock('../infra/daemon/ipcEndpoint.js', async (original) => ({
  ...await original<typeof import('../infra/daemon/ipcEndpoint.js')>(), resolveDaemonConfigDirectory: doubles.daemonDir,
}));
vi.mock('../features/manager/assignment.js', async (original) => ({
  ...await original<typeof import('../features/manager/assignment.js')>(), resolveCurrentManagerAssignment: doubles.assignment,
}));
vi.mock('../infra/task/repositoryDirectory.js', async (original) => ({
  ...await original<typeof import('../infra/task/repositoryDirectory.js')>(), resolveGitRepositoryDirectory: doubles.repositoryDirectory,
}));
vi.mock('../infra/daemon/conversationStateStore.js', () => ({ ConversationStateStore: class {
  constructor(directory: string) { doubles.constructStore(directory); }
  read = doubles.read;
} }));
vi.mock('../features/manager/conversationIpcClient.js', () => ({ ConversationIpcClient: class {
  constructor(...args: unknown[]) { doubles.constructClient(...args); }
  connect = doubles.connect;
  submit = doubles.submit;
  onOutput = doubles.output;
  subscribe = doubles.subscribe;
  getSnapshot = doubles.snapshot;
  close = doubles.close;
} }));

const cwd = '/project';
const revision = 3;
const operationId = '750e8400-e29b-41d4-a716-446655440077';
const signal = new AbortController().signal;
const repositoryAssignment = { kind: 'repository' as const, repositoryDirectory: cwd };
const summary = {
  objective: 'MCP からゴール登録を承認できる',
  outOfScope: ['takt-dash の実装'],
  acceptanceCriteria: ['承認した登録案がゴールとして登録される'],
  constraints: [],
};

function recordFixture(
  assignment: { kind: 'repository'; repositoryDirectory: string } | { kind: 'workspace'; workspaceId: string },
  pending: { revision: number; repositoryDirectory: string; summary: typeof summary } | null,
) {
  return ConversationRecordSchema.parse({
    schemaVersion: 1, id: conversationId(assignment), agent: 'manager', assignment,
    counterpart: { namespace: 'local', id: 'operator' }, lastSpeaker: null,
    provider: 'mock', model: null, sessionId: null, bindings: [],
    revision, pending, approval: null, running: null,
  });
}

let emit: ((output: PortOutput) => void) | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  emit = undefined;
  doubles.configDir.mockReturnValue('/global-config');
  doubles.daemonDir.mockResolvedValue('/daemon-config');
  doubles.repositoryDirectory.mockImplementation(async (directory: string) => directory);
  doubles.assignment.mockResolvedValue({ ...repositoryAssignment, repositoryDirectories: [cwd] });
  doubles.connect.mockResolvedValue(undefined);
  doubles.subscribe.mockReturnValue(vi.fn());
  doubles.snapshot.mockReturnValue({ connection: 'connected' });
  doubles.output.mockImplementation((listener: (output: PortOutput) => void) => {
    emit = listener;
    return () => { emit = undefined; };
  });
});

function acceptSubmission(): void {
  doubles.submit.mockImplementation(async (_command: ConversationCommand, onAccepted?: (operationId: string) => void) => {
    onAccepted?.(operationId);
    return { kind: 'accepted' as const, operationId };
  });
}

it('lists the pending registration proposal of the current repository conversation', async () => {
  const record = recordFixture(repositoryAssignment, { revision, repositoryDirectory: cwd, summary });
  doubles.read.mockResolvedValue({ record });

  const result = await listTaktGoalRegistrationProposals({ cwd }, {});

  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  expect(doubles.assignment).toHaveBeenCalledWith({ kind: 'repository', repositoryDirectory: cwd }, '/global-config');
  expect(doubles.constructStore).toHaveBeenCalledWith('/daemon-config');
  expect(doubles.read).toHaveBeenCalledWith(conversationId(repositoryAssignment));
  expect(doubles.constructClient).not.toHaveBeenCalled();
  expect(JSON.parse(firstTextContent(result.content))).toEqual({ proposals: [record.pending] });
});

it('reads the repository conversation from the normalized git root when the cwd is a subdirectory', async () => {
  const record = recordFixture(repositoryAssignment, { revision, repositoryDirectory: cwd, summary });
  doubles.read.mockResolvedValue({ record });
  doubles.repositoryDirectory.mockResolvedValue(cwd);
  doubles.assignment.mockImplementation(async (identity: { kind: 'repository'; repositoryDirectory: string }) =>
    ({ ...identity, repositoryDirectories: [identity.repositoryDirectory] }));

  const result = await listTaktGoalRegistrationProposals({ cwd: '/project/packages/app' }, {});

  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  expect(doubles.repositoryDirectory).toHaveBeenCalledWith('/project/packages/app');
  expect(doubles.assignment).toHaveBeenCalledWith({ kind: 'repository', repositoryDirectory: cwd }, '/global-config');
  expect(doubles.read).toHaveBeenCalledWith(conversationId(repositoryAssignment));
  expect(JSON.parse(firstTextContent(result.content))).toEqual({ proposals: [record.pending] });
});

it('returns an empty list when no registration proposal is pending', async () => {
  doubles.read.mockResolvedValue({ record: recordFixture(repositoryAssignment, null) });

  const result = await listTaktGoalRegistrationProposals({ cwd }, {});

  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  expect(JSON.parse(firstTextContent(result.content))).toEqual({ proposals: [] });
});

it('returns an empty list when the conversation has never been stored', async () => {
  doubles.read.mockResolvedValue(undefined);

  const result = await listTaktGoalRegistrationProposals({ cwd }, {});

  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  expect(JSON.parse(firstTextContent(result.content))).toEqual({ proposals: [] });
});

it('reads the resolved workspace conversation when the repository belongs to one', async () => {
  const workspaceAssignment = { kind: 'workspace' as const, workspaceId: '750e8400-e29b-41d4-a716-446655440001' };
  doubles.assignment.mockResolvedValue({ ...workspaceAssignment, name: 'Workspace', repositoryDirectories: [cwd] });
  const record = recordFixture(workspaceAssignment, { revision, repositoryDirectory: cwd, summary });
  doubles.read.mockResolvedValue({ record });

  const result = await listTaktGoalRegistrationProposals({ cwd }, {});

  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  expect(doubles.read).toHaveBeenCalledWith(conversationId(workspaceAssignment));
  expect(JSON.parse(firstTextContent(result.content))).toEqual({ proposals: [record.pending] });
});

it('rejects a root outside the MCP scope before reading conversations', async () => {
  doubles.allowed.mockImplementation(() => { throw new Error('outside root'); });

  const result = await listTaktGoalRegistrationProposals({ cwd }, {});

  expect(result.isError).toBe(true);
  expect(doubles.read).not.toHaveBeenCalled();
});

it('approves the pending proposal through the same command as the manager screen', async () => {
  acceptSubmission();
  const registered = goalRecord();

  const pending = approveTaktGoalRegistration({ cwd, revision }, {}, signal);
  await vi.waitFor(() => expect(emit).toBeDefined());
  emit!({ kind: 'result', operationId, result: { kind: 'goal_registered', goal: registered } });
  const result = await pending;

  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  expect(doubles.constructClient.mock.calls[0]![0]).toEqual(repositoryAssignment);
  expect(doubles.connect).toHaveBeenCalledOnce();
  const command = doubles.submit.mock.calls[0]![0] as ConversationCommand;
  expect(command).toEqual({ kind: 'approve_summary', revision });
  expect(command).not.toHaveProperty('requirePending');
  expect(JSON.parse(firstTextContent(result.content))).toMatchObject({
    goal: expect.objectContaining({ id: registered.id }),
  });
  expect(doubles.close).toHaveBeenCalledOnce();
});

it('rejects the pending proposal through a dismissal without a reason field', async () => {
  acceptSubmission();

  const pending = rejectTaktGoalRegistration({ cwd, revision }, {}, signal);
  await vi.waitFor(() => expect(emit).toBeDefined());
  emit!({ kind: 'result', operationId, result: { kind: 'notice', message: '登録案を取り下げました' } });
  const result = await pending;

  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  expect(doubles.constructClient.mock.calls[0]![0]).toEqual(repositoryAssignment);
  const command = doubles.submit.mock.calls[0]![0] as ConversationCommand;
  expect(command).toEqual({ kind: 'dismiss_summary', revision });
  expect(command).not.toHaveProperty('reason');
  expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ revision });
  expect(doubles.close).toHaveBeenCalledOnce();
});

it('reports a stale approval like the manager screen when the daemon rejects the submission', async () => {
  doubles.submit.mockResolvedValue({ kind: 'error', code: 'stale_summary', message: 'The displayed proposal has changed' });

  const result = await approveTaktGoalRegistration({ cwd, revision }, {}, signal);

  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toMatch(/stale/iu);
  expect(doubles.output).not.toHaveBeenCalled();
  expect(doubles.close).toHaveBeenCalledOnce();
});

it('reports a stale rejection delivered as the turn result', async () => {
  acceptSubmission();

  const pending = rejectTaktGoalRegistration({ cwd, revision }, {}, signal);
  await vi.waitFor(() => expect(emit).toBeDefined());
  emit!({ kind: 'result', operationId, result: { kind: 'error', code: 'stale_summary', message: 'The displayed proposal has changed' } });
  const result = await pending;

  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toMatch(/stale/iu);
  expect(doubles.close).toHaveBeenCalledOnce();
});

it('ignores results of other operations while waiting for the approval result', async () => {
  acceptSubmission();
  const registered = goalRecord();

  const pending = approveTaktGoalRegistration({ cwd, revision }, {}, signal);
  await vi.waitFor(() => expect(emit).toBeDefined());
  emit!({ kind: 'result', operationId: '750e8400-e29b-41d4-a716-446655440088',
    result: { kind: 'error', code: 'stale_summary', message: '別の操作の結果' } });
  emit!({ kind: 'result', operationId, result: { kind: 'goal_registered', goal: registered } });
  const result = await pending;

  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  expect(JSON.parse(firstTextContent(result.content))).toMatchObject({
    goal: expect.objectContaining({ id: registered.id }),
  });
});

it('keeps the bounded wait for a rejected proposal whose result never arrives', async () => {
  vi.useFakeTimers();
  try {
    acceptSubmission();

    const resultPromise = rejectTaktGoalRegistration({ cwd, revision }, {}, signal);
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(firstTextContent(result.content)).toMatch(/accepted/iu);
    expect(firstTextContent(result.content)).toMatch(/result|observ/iu);
    expect(doubles.close).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it.each([119_000, 121_000])('waits for the same approval operation to complete after %s milliseconds', async (delay) => {
  vi.useFakeTimers();
  try {
    acceptSubmission();
    let settled = false;
    const pending = approveTaktGoalRegistration({ cwd, revision }, {}, signal).then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(delay);
    expect(settled).toBe(false);
    const goal = goalRecord();
    emit!({ kind: 'result', operationId, result: { kind: 'goal_registered', goal } });
    const result = await pending;
    expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ revision, goal: { id: goal.id } });
    expect(doubles.submit).toHaveBeenCalledOnce();
    expect(emit).toBeUndefined();
    expect(doubles.close).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it('releases approval subscriptions on caller cancellation without resubmitting', async () => {
  acceptSubmission();
  const controller = new AbortController();
  const pending = approveTaktGoalRegistration({ cwd, revision }, {}, controller.signal);
  await vi.waitFor(() => expect(emit).toBeDefined());
  controller.abort(new Error('caller cancelled'));
  expect((await pending).isError).toBe(true);
  expect(emit).toBeUndefined();
  expect(doubles.submit).toHaveBeenCalledOnce();
  expect(doubles.close).toHaveBeenCalledOnce();
});

it('ends approval after a failed reconnection and does not resend it', async () => {
  acceptSubmission();
  const pending = approveTaktGoalRegistration({ cwd, revision }, {}, signal);
  await vi.waitFor(() => expect(emit).toBeDefined());
  doubles.snapshot.mockReturnValue({ connection: 'disconnected' });
  doubles.connect.mockRejectedValueOnce(new Error('daemon unavailable'));
  doubles.subscribe.mock.calls[0]![0]();
  expect((await pending).isError).toBe(true);
  expect(emit).toBeUndefined();
  expect(doubles.submit).toHaveBeenCalledOnce();
  expect(doubles.close).toHaveBeenCalledOnce();
});

it('receives the original approval result after reconnecting without resubmitting', async () => {
  acceptSubmission();
  const pending = approveTaktGoalRegistration({ cwd, revision }, {}, signal);
  await vi.waitFor(() => expect(emit).toBeDefined());
  doubles.snapshot.mockReturnValue({ connection: 'disconnected' });
  doubles.subscribe.mock.calls[0]![0]();
  await vi.waitFor(() => expect(doubles.connect).toHaveBeenCalledTimes(2));
  const goal = goalRecord();
  emit!({ kind: 'result', operationId, result: { kind: 'goal_registered', goal } });
  expect(JSON.parse(firstTextContent((await pending).content))).toMatchObject({ revision, goal: { id: goal.id } });
  expect(doubles.submit).toHaveBeenCalledOnce();
  expect(emit).toBeUndefined();
  expect(doubles.subscribe.mock.results[0]!.value).toHaveBeenCalledOnce();
  expect(doubles.close).toHaveBeenCalledOnce();
});

it('returns the saved result when approval completes during a disconnection', async () => {
  acceptSubmission();
  const pending = approveTaktGoalRegistration({ cwd, revision }, {}, signal);
  await vi.waitFor(() => expect(emit).toBeDefined());
  doubles.snapshot.mockReturnValue({ connection: 'disconnected' });
  doubles.subscribe.mock.calls[0]![0]();
  await vi.waitFor(() => expect(doubles.connect).toHaveBeenCalledTimes(2));
  const goal = { ...goalRecord(), workLog: [{ id: operationId, recordedAt: '2026-11-19T00:00:00Z', summary: 'Formal specification verification: passed' }] };
  doubles.snapshot.mockReturnValue({ connection: 'connected', readStatus: 'complete', items: [
    { kind: 'turn_result', operationId, acceptedSequence: 1, result: { kind: 'goal_registered', goal } },
  ] });
  doubles.subscribe.mock.calls[0]![0]();
  expect(JSON.parse(firstTextContent((await pending).content))).toEqual({ revision, goal });
  expect(doubles.submit).toHaveBeenCalledOnce();
  expect(emit).toBeUndefined();
  expect(doubles.close).toHaveBeenCalledOnce();
});

it('returns a goal verified and recorded once when registration takes 121 seconds', async () => {
  vi.useFakeTimers();
  const { createGoal } = await import('../infra/goals/service.js');
  const { GoalStore } = await import('../infra/goals/store.js');
  const { GoalSchema } = await import('../infra/goals/schema.js');
  const git = await import('../infra/goals/git.js');
  const events = await import('../infra/goals/events.js');
  const registry = await import('../infra/config/global/projectRegistry.js');
  const manager = await import('../infra/config/managerConfig.js');
  const formal = await import('../infra/config/formalSpecConfig.js');
  const verification = await import('../infra/formal-spec/formalSpecVerifier.js');
  let saved: import('../infra/goals/schema.js').Goal | undefined;
  vi.spyOn(GoalStore.prototype, 'assertAbsent').mockImplementation(() => {});
  vi.spyOn(GoalStore.prototype, 'create').mockImplementation(async (goal) => { saved = GoalSchema.parse(goal); return saved; });
  vi.spyOn(GoalStore.prototype, 'update').mockImplementation(async (_id, transform) => { saved = GoalSchema.parse(transform(saved!)); return saved; });
  vi.spyOn(registry, 'registerProject').mockResolvedValue({ version: 2, locationId: 'a'.repeat(64), stateId: goalRecord().id,
    canonicalDirectory: cwd, displayName: 'test', createdAt: goalRecord().createdAt, lastSeenAt: goalRecord().createdAt,
    lastCommand: 'test', available: true, id: 'a'.repeat(64), projectDirectory: cwd });
  vi.spyOn(git, 'prepareGoalBranch').mockResolvedValue({ branch: goalRecord().branch, startBranch: 'main', integrationBranch: 'main', commit: 'a'.repeat(40) });
  vi.spyOn(git, 'createGoalBranch').mockImplementation(() => {});
  const registered = vi.spyOn(events, 'saveManagerEvent').mockImplementation(() => {});
  vi.spyOn(manager, 'resolveManagerConfig').mockReturnValue({ ...manager.resolveManagerConfig(cwd), verifyOnRegister: true });
  vi.spyOn(formal, 'resolveFormalSpecConfigurationWithoutPrompt').mockReturnValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 900 });
  const verify = vi.spyOn(verification, 'runFormalSpecVerification').mockImplementation(async () => {
    expect(registered).toHaveBeenCalledOnce();
    return new Promise((resolve) => setTimeout(() => resolve({ verdict: 'passed', verificationStarted: true,
      quint: { status: 'passed' }, alloy: { status: 'skipped' } }), 121_000));
  });
  doubles.submit.mockImplementation(async (_command: ConversationCommand, onAccepted?: (id: string) => void) => {
    onAccepted!(operationId);
    void createGoal({ cwd, ...goalInput(), id: goalRecord().id, specifications: { quint: 'module test {}' } }, signal)
      .then((goal) => emit!({ kind: 'result', operationId, result: { kind: 'goal_registered', goal } }),
        (error: unknown) => emit!({ kind: 'result', operationId, result: { kind: 'error', code: 'operation_failed', message: String(error) } }));
    return { kind: 'accepted', operationId };
  });
  try {
    let settled = false;
    const pending = approveTaktGoalRegistration({ cwd, revision }, {}, signal).then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    expect(saved!.workLog).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(firstTextContent(result.content))).toEqual({ revision, goal: saved });
    expect(verify).toHaveBeenCalledOnce();
    expect(saved!.workLog).toHaveLength(1);
    expect(saved!.registrationVerification).toEqual({ status: 'completed', workLogId: saved!.workLog[0]!.id });
    expect(doubles.submit).toHaveBeenCalledOnce();
    expect(doubles.close).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
});

it.each(['complete', 'incomplete after open', 'incomplete before open'] as const)(
  'settles approval from a %s snapshot after registration completes while disconnected', async (transfer) => {
    const { createGoal } = await import('../infra/goals/service.js');
    const { GoalStore } = await import('../infra/goals/store.js');
    const { GoalSchema } = await import('../infra/goals/schema.js');
    const git = await import('../infra/goals/git.js');
    const events = await import('../infra/goals/events.js');
    const registry = await import('../infra/config/global/projectRegistry.js');
    const manager = await import('../infra/config/managerConfig.js');
    const formal = await import('../infra/config/formalSpecConfig.js');
    const verification = await import('../infra/formal-spec/formalSpecVerifier.js');
    let saved: import('../infra/goals/schema.js').Goal | undefined;
    vi.spyOn(GoalStore.prototype, 'assertAbsent').mockImplementation(() => {});
    vi.spyOn(GoalStore.prototype, 'create').mockImplementation(async (goal) => { saved = GoalSchema.parse(goal); return saved; });
    vi.spyOn(GoalStore.prototype, 'update').mockImplementation(async (_id, transform) => { saved = GoalSchema.parse(transform(saved!)); return saved; });
    vi.spyOn(registry, 'registerProject').mockResolvedValue({ version: 2, locationId: 'a'.repeat(64), stateId: goalRecord().id,
      canonicalDirectory: cwd, displayName: 'test', createdAt: goalRecord().createdAt, lastSeenAt: goalRecord().createdAt,
      lastCommand: 'test', available: true, id: 'a'.repeat(64), projectDirectory: cwd });
    vi.spyOn(git, 'prepareGoalBranch').mockResolvedValue({ branch: goalRecord().branch, startBranch: 'main', integrationBranch: 'main', commit: 'a'.repeat(40) });
    vi.spyOn(git, 'createGoalBranch').mockImplementation(() => {});
    vi.spyOn(events, 'saveManagerEvent').mockImplementation(() => {});
    vi.spyOn(manager, 'resolveManagerConfig').mockReturnValue({ ...manager.resolveManagerConfig(cwd), verifyOnRegister: true });
    vi.spyOn(formal, 'resolveFormalSpecConfigurationWithoutPrompt').mockReturnValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 900 });
    let finishVerification!: () => void;
    const verificationReady = new Promise<void>((resolve) => { finishVerification = resolve; });
    const verify = vi.spyOn(verification, 'runFormalSpecVerification').mockImplementation(async () => {
      await verificationReady;
      return { verdict: 'passed', verificationStarted: true, quint: { status: 'passed' }, alloy: { status: 'skipped' } };
    });
    let registration: Promise<import('../infra/goals/schema.js').Goal> | undefined;
    doubles.submit.mockImplementation(async (_command: ConversationCommand, onAccepted?: (id: string) => void) => {
      onAccepted!(operationId);
      registration = createGoal({ cwd, ...goalInput(), id: goalRecord().id, specifications: { quint: 'module test {}' } }, signal);
      return { kind: 'accepted', operationId };
    });
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
    const unsubscribeOutput = vi.fn(() => { emit = undefined; });
    doubles.output.mockImplementation((listener: (output: PortOutput) => void) => { emit = listener; return unsubscribeOutput; });
    let settled = false;
    const pending = approveTaktGoalRegistration({ cwd, revision }, {}, controller.signal).then((result) => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
      const notify = doubles.subscribe.mock.calls[0]![0] as () => void;
      const lateOutput = emit!;
      // disconnect() reports the interrupted read before publishing disconnected.
      doubles.snapshot.mockReturnValue({ connection: 'connected', readStatus: 'incomplete', items: [] });
      notify();
      doubles.snapshot.mockReturnValue({ connection: 'disconnected', readStatus: 'incomplete', items: [] });
      notify();
      finishVerification();
      const goal = await registration!;
      expect(settled).toBe(false);
      await vi.waitFor(() => expect(doubles.connect).toHaveBeenCalledTimes(2));
      const completeSnapshot = { connection: 'connected', readStatus: 'complete', items: [
        { kind: 'turn_result', operationId, acceptedSequence: 1, result: { kind: 'goal_registered', goal } },
      ] };
      if (transfer === 'incomplete before open') {
        doubles.snapshot.mockReturnValue({ connection: 'connecting', readStatus: 'incomplete', items: [] });
        notify();
      } else {
        doubles.snapshot.mockReturnValue({ connection: 'connected', readStatus: 'reading', items: [] });
        notify();
      }
      doubles.snapshot.mockReturnValue(transfer === 'complete' ? completeSnapshot
        : { connection: 'connected', readStatus: 'incomplete', items: [] });
      notify();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
      const result = await pending;
      if (transfer === 'complete') expect(JSON.parse(firstTextContent(result.content))).toEqual({ revision, goal });
      else {
        expect(result.isError).toBe(true);
        expect(firstTextContent(result.content)).toMatch(/accepted.*result.*confirm/iu);
      }
      expect(saved!.workLog).toHaveLength(1);
      expect(saved!.registrationVerification).toEqual({ status: 'completed', workLogId: saved!.workLog[0]!.id });
      expect(verify).toHaveBeenCalledOnce();
      expect(doubles.submit).toHaveBeenCalledOnce();
      expect(unsubscribeOutput).toHaveBeenCalledOnce();
      expect(doubles.subscribe.mock.results[0]!.value).toHaveBeenCalledOnce();
      expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(doubles.close).toHaveBeenCalledOnce();
      doubles.snapshot.mockReturnValue(completeSnapshot);
      notify();
      lateOutput({ kind: 'result', operationId, result: { kind: 'goal_registered', goal } });
      await Promise.resolve();
      expect(doubles.submit).toHaveBeenCalledOnce();
      expect(doubles.close).toHaveBeenCalledOnce();
    } finally {
      controller.abort(new Error('test cleanup'));
      finishVerification();
      await pending;
      vi.restoreAllMocks();
    }
  });

it.each(['result', 'abort', 'disconnect'] as const)('rechecks an incomplete recovery after the synchronous %s notification', async (next) => {
  acceptSubmission();
  const controller = new AbortController();
  const pending = approveTaktGoalRegistration({ cwd, revision }, {}, controller.signal);
  await vi.waitFor(() => expect(emit).toBeDefined());
  const notify = doubles.subscribe.mock.calls[0]![0] as () => void;
  doubles.snapshot.mockReturnValue({ connection: 'disconnected', readStatus: 'incomplete', items: [] });
  notify();
  await vi.waitFor(() => expect(doubles.connect).toHaveBeenCalledTimes(2));
  doubles.snapshot.mockReturnValue({ connection: 'connected', readStatus: 'incomplete', items: [] });
  notify();
  const goal = goalRecord();
  if (next === 'result') emit!({ kind: 'result', operationId, result: { kind: 'goal_registered', goal } });
  else if (next === 'abort') controller.abort(new Error('caller cancelled during recovery'));
  else {
    doubles.snapshot.mockReturnValue({ connection: 'disconnected', readStatus: 'incomplete', items: [] });
    notify();
    await Promise.resolve();
    expect(emit).toBeDefined();
    doubles.snapshot.mockReturnValue({ connection: 'connected', readStatus: 'complete', items: [] });
    notify();
    emit!({ kind: 'result', operationId, result: { kind: 'goal_registered', goal } });
  }
  const result = await pending;
  if (next === 'abort') expect(firstTextContent(result.content)).toMatch(/caller cancelled during recovery/iu);
  else expect(JSON.parse(firstTextContent(result.content))).toEqual({ revision, goal });
  expect(doubles.submit).toHaveBeenCalledOnce();
  expect(emit).toBeUndefined();
  expect(doubles.subscribe.mock.results[0]!.value).toHaveBeenCalledOnce();
  expect(doubles.close).toHaveBeenCalledOnce();
});

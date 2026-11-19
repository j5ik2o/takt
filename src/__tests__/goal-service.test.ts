vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: vi.fn(), readManagerEvents: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoal, hasGoalRegistrationArtifacts, registerReservedGoal } from '../infra/goals/service.js';
import { readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import type { prepareGoalBranch } from '../infra/goals/git.js';
import { goalInput, goalRecord } from './helpers/goal-fixtures.js';
import { extractFormalSpecBlocks, type FormalSpecVerificationResult } from '../features/interactive/formalSpecVerifier.js';
import { GoalSchema, type Goal } from '../infra/goals/schema.js';
import { appendGoalWorkLog } from '../infra/goals/workLog.js';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import { TaskRunner } from '../infra/task/runner.js';

const doubles = vi.hoisted(() => ({
  assertAbsent: vi.fn(), create: vi.fn(), find: vi.fn(), refs: vi.fn(),
  prepare: vi.fn(), createBranch: vi.fn(), removeBranch: vi.fn(), project: vi.fn(),
  manager: vi.fn(), formal: vi.fn(), verify: vi.fn(), update: vi.fn(), cleanup: vi.fn(),
}));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.manager }));
vi.mock('../infra/config/formalSpecConfig.js', () => ({ resolveFormalSpecConfigurationWithoutPrompt: doubles.formal }));
vi.mock('../infra/formal-spec/formalSpecVerifier.js', async (original) => ({
  ...await original<typeof import('../infra/formal-spec/formalSpecVerifier.js')>(),
  runFormalSpecVerification: doubles.verify,
  cleanupFormalSpecVerificationArtifacts: doubles.cleanup,
}));
vi.mock('../infra/config/global/projectRegistry.js', () => ({ registerProject: doubles.project }));
vi.mock('../infra/goals/store.js', () => ({
  GoalStore: class {
    assertAbsent = doubles.assertAbsent;
    create = doubles.create;
    find = doubles.find;
    update = doubles.update;
  },
}));
vi.mock('../infra/goals/git-command.js', () => ({ runGoalGit: doubles.refs }));
vi.mock('../infra/goals/git.js', () => ({
  prepareGoalBranch: doubles.prepare,
  createGoalBranch: doubles.createBranch,
  removeGoalBranch: doubles.removeBranch,
}));

describe('Goal registration service', () => {
  const cwd = '/project';
  const request = () => ({
    cwd, ...goalInput(), id: goalRecord().id,
  });
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.manager.mockReturnValue({ verifyOnRegister: false });
    doubles.formal.mockReturnValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 17 });
    doubles.prepare.mockResolvedValue({
      branch: goalRecord().branch, startBranch: 'main', integrationBranch: 'main', commit: 'a'.repeat(40),
    });
    doubles.create.mockImplementation(async (goal: unknown) => goal);
    doubles.refs.mockResolvedValue({ output: Buffer.alloc(0), truncated: false, code: 0 });
  });

  it('saves the approved record after creating its branch', async () => {
    expect(await createGoal(request())).toStrictEqual({ ...goalRecord(), createdAt: expect.any(String) });
    expect(doubles.assertAbsent).toHaveBeenCalledWith(goalRecord().id);
    expect(doubles.createBranch).toHaveBeenCalledWith(cwd, goalRecord().branch, 'a'.repeat(40));
    expect(doubles.createBranch.mock.invocationCallOrder[0]).toBeLessThan(doubles.create.mock.invocationCallOrder[0]!);
    expect(registerProject).toHaveBeenCalledExactlyOnceWith({
      globalConfigDirectory: process.env.TAKT_CONFIG_DIR,
      projectDirectory: cwd, command: 'manager', managerUsed: true,
    });
  });

  it('waits for branch preparation before creating or saving the goal', async () => {
    let finishPreparation!: (prepared: Awaited<ReturnType<typeof prepareGoalBranch>>) => void;
    doubles.prepare.mockReturnValue(new Promise<Awaited<ReturnType<typeof prepareGoalBranch>>>((resolve) => {
      finishPreparation = resolve;
    }));
    const creating = createGoal(request()).then((goal) => ({ goal }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => expect(doubles.prepare).toHaveBeenCalledExactlyOnceWith(cwd, goalRecord().id, undefined, undefined, undefined));
      expect(doubles.createBranch).not.toHaveBeenCalled();
      expect(doubles.create).not.toHaveBeenCalled();
    } finally {
      finishPreparation({ branch: goalRecord().branch, startBranch: 'main', integrationBranch: 'main', commit: 'b'.repeat(40) });
    }
    expect(await creating).toEqual({ goal: { ...goalRecord(), createdAt: expect.any(String) } });
    expect(doubles.createBranch).toHaveBeenCalledExactlyOnceWith(cwd, goalRecord().branch, 'b'.repeat(40));
    expect(doubles.createBranch.mock.invocationCallOrder[0]).toBeLessThan(doubles.create.mock.invocationCallOrder[0]!);
  });

  it('propagates preparation failure without creating or saving a branch', async () => {
    const error = new Error('commit verification failed');
    const preparation = Promise.reject(error);
    // await が未実装でも、未処理の rejection をほかのテストへ漏らさない。
    void preparation.catch(() => {});
    doubles.prepare.mockReturnValue(preparation);
    await expect(createGoal(request())).rejects.toThrow(error);
    expect(doubles.createBranch).not.toHaveBeenCalled();
    expect(doubles.create).not.toHaveBeenCalled();
    expect(doubles.removeBranch).not.toHaveBeenCalled();
  });

  it('rejects invalid input before saving or Git operations', async () => {
    await expect(createGoal({ ...request(), acceptanceCriteria: [] })).rejects.toThrow();
    expect(doubles.prepare).not.toHaveBeenCalled();
    expect(doubles.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate ID before Git operations', async () => {
    doubles.assertAbsent.mockImplementation(() => { throw new Error('duplicate'); });
    await expect(createGoal(request())).rejects.toThrow();
    expect(doubles.prepare).not.toHaveBeenCalled();
    expect(doubles.createBranch).not.toHaveBeenCalled();
  });

  it('does not publish or compensate when branch creation fails', async () => {
    const error = new Error('Git failed');
    doubles.createBranch.mockImplementation(() => { throw error; });
    await expect(createGoal(request())).rejects.toThrow(error);
    expect(doubles.create).not.toHaveBeenCalled();
    expect(doubles.removeBranch).not.toHaveBeenCalled();
  });

  it('compensates publication failure and permits a subsequent retry', async () => {
    doubles.create.mockRejectedValueOnce(new Error('publication failed'));
    await expect(createGoal(request())).rejects.toThrow();
    expect(doubles.removeBranch).toHaveBeenCalledWith(cwd, goalRecord().branch, 'a'.repeat(40));
    expect(await createGoal(request())).toEqual({ ...goalRecord(), createdAt: expect.any(String) });
  });

  it('reports a saved goal or matching branch as a registration artifact', async () => {
    doubles.find.mockReturnValue(goalRecord());
    expect(await hasGoalRegistrationArtifacts(cwd, goalRecord().id)).toBe(true);
    expect(doubles.refs).not.toHaveBeenCalled();

    doubles.find.mockReturnValue(undefined);
    doubles.refs.mockResolvedValueOnce({ output: Buffer.from(`refs/heads/takt/20261112T0000-goal-${goalRecord().id.slice(0, 8)}\n`), truncated: false, code: 0 });
    expect(await hasGoalRegistrationArtifacts(cwd, goalRecord().id)).toBe(true);
  });

  it('reports no registration artifacts only after confirming there is no goal or matching branch', async () => {
    doubles.find.mockReturnValue(undefined);
    doubles.refs.mockResolvedValueOnce({ output: Buffer.alloc(0), truncated: false, code: 0 });

    expect(await hasGoalRegistrationArtifacts(cwd, goalRecord().id)).toBe(false);
    expect(doubles.refs).toHaveBeenCalledWith(cwd,
      ['for-each-ref', '--format=%(refname)', `refs/heads/takt/*-goal-${goalRecord().id.slice(0, 8)}`], 1024, undefined);
  });

  it('keeps a reservation when its branch list is truncated and artifacts cannot be ruled out', async () => {
    doubles.find.mockReturnValue(undefined);
    doubles.refs.mockResolvedValueOnce({ output: Buffer.alloc(1024), truncated: true, code: 0 });

    expect(await hasGoalRegistrationArtifacts(cwd, goalRecord().id)).toBe(true);
  });

  it.each(['references', 'project', 'branch'] as const)('stops registration aborted during %s preparation before any branch, goal or event', async (boundary) => {
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const boundaryCall = boundary === 'references' ? doubles.refs : boundary === 'project' ? doubles.project : doubles.prepare;
    if (boundary === 'references') doubles.refs.mockImplementationOnce(async () => { await gate; return { output: Buffer.alloc(0), truncated: false, code: 0 }; });
    else if (boundary === 'project') doubles.project.mockImplementationOnce(async () => { await gate; });
    else doubles.prepare.mockImplementationOnce(async () => { await gate; return { branch: goalRecord().branch, startBranch: 'main', integrationBranch: 'main', commit: 'a'.repeat(40) }; });
    const abort = new Error('cancel registration');
    const registering = registerReservedGoal(request(), controller.signal);
    const rejected = expect(registering).rejects.toBe(abort);
    try {
      await vi.waitFor(() => expect(boundaryCall).toHaveBeenCalledOnce());
      controller.abort(abort);
    } finally { release(); }
    await rejected;
    expect(doubles.createBranch).not.toHaveBeenCalled();
    expect(doubles.create).not.toHaveBeenCalled();
    expect(saveManagerEvent).not.toHaveBeenCalled();
    expect(doubles.removeBranch).not.toHaveBeenCalled();
    if (boundary === 'references') expect(registerProject).not.toHaveBeenCalled();
    if (boundary === 'project') expect(doubles.prepare).not.toHaveBeenCalled();
  });

  it('keeps a committed registration successful when cancellation arrives after goal publication', async () => {
    const controller = new AbortController();
    doubles.create.mockImplementationOnce(async () => { controller.abort(); });
    expect(await createGoal(request(), controller.signal)).toEqual({ ...goalRecord(), createdAt: expect.any(String) });
    expect(saveManagerEvent).toHaveBeenCalledExactlyOnceWith(cwd, { kind: 'registered', goalId: goalRecord().id });
    expect(doubles.removeBranch).not.toHaveBeenCalled();
  });
});

describe('formal verification after goal registration', () => {
  let saved: Goal | undefined;
  const input = () => ({ cwd: '/project', ...goalInput(), id: goalRecord().id,
    specifications: { quint: 'module csv {}', alloy: 'sig CSV {}' } });
  const result = (verdict: FormalSpecVerificationResult['verdict']): FormalSpecVerificationResult => ({
    verdict, verificationStarted: true,
    quint: { status: verdict, message: 'Quint registration result' },
    alloy: { status: verdict, message: 'Alloy registration result' },
  });
  beforeEach(() => {
    vi.resetAllMocks(); saved = undefined;
    doubles.manager.mockReturnValue({ verifyOnRegister: true });
    doubles.formal.mockReturnValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 17 });
    doubles.prepare.mockResolvedValue({ branch: goalRecord().branch, startBranch: 'main', integrationBranch: 'main', commit: 'a'.repeat(40) });
    doubles.refs.mockResolvedValue({ output: Buffer.alloc(0), truncated: false, code: 0 });
    doubles.create.mockImplementation(async (goal: Goal) => { saved = goal; return goal; });
    doubles.find.mockImplementation(() => saved);
    doubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => {
      if (saved === undefined) throw new Error('Goal not published');
      saved = GoalSchema.parse(transform(saved)); return saved;
    });
    doubles.verify.mockResolvedValue(result('passed'));
    vi.mocked(readManagerEvents).mockReturnValue([{ filePath: '/event.json', event: {
      kind: 'registered', goalId: input().id, createdAt: new Date().toISOString(),
    } }]);
  });

  it.each([
    { quint: 'module csv {}', alloy: 'sig CSV {}' },
    { quint: 'module csv {}' },
    { alloy: 'sig CSV {}' },
  ])('verifies registered language fields once after publication: %j', async (specifications) => {
    const controller = new AbortController();
    doubles.verify.mockImplementation(async () => {
      expect(saved).toMatchObject({ id: input().id, specifications });
      expect(saveManagerEvent).toHaveBeenCalledExactlyOnceWith('/project', { kind: 'registered', goalId: input().id });
      return result('passed');
    });
    const goal = await createGoal({ ...input(), specifications }, controller.signal);
    expect(doubles.verify).toHaveBeenCalledOnce();
    const [source, cwd, options] = doubles.verify.mock.calls[0]!;
    expect(extractFormalSpecBlocks(source)).toEqual({
      quint: specifications.quint === undefined ? [] : [specifications.quint],
      alloy: specifications.alloy === undefined ? [] : [specifications.alloy],
    });
    expect(cwd).toBe('/project');
    expect(options).toMatchObject({ abortSignal: controller.signal, modelCheckTimeoutSeconds: 17 });
    expect(goal).toEqual(saved);
    expect(goal.workLog).toHaveLength(1);
    expect(goal.workLog[0]!.summary).toMatch(/passed/iu);
  });

  it('preserves embedded fences as Quint source without creating an Alloy input', async () => {
    const quint = 'module csv {}\n```\n~~~alloy\nsig Decoy {}\n~~~\n```alloy';
    await createGoal({ ...input(), specifications: { quint } });
    expect(doubles.verify).toHaveBeenCalledOnce();
    expect(extractFormalSpecBlocks(doubles.verify.mock.calls[0]![0])).toEqual({ quint: [quint], alloy: [] });
  });

  it.each([
    { verifyOnRegister: undefined, mode: true },
    { verifyOnRegister: false, mode: true },
    { verifyOnRegister: true, mode: false },
  ])('registers without verification when disabled: %j', async ({ verifyOnRegister, mode }) => {
    doubles.manager.mockReturnValue({ verifyOnRegister });
    doubles.formal.mockReturnValue({ mode, comments: true, modelCheckTimeoutSeconds: 17 });
    const goal = await createGoal(input());
    expect(goal.status).toBe('created'); expect(goal.workLog).toEqual([]);
    expect(doubles.create.mock.calls[0]![0].registrationVerification).toEqual({ status: 'not_required' });
    expect(doubles.update).not.toHaveBeenCalled();
    saved = GoalSchema.parse(JSON.parse(JSON.stringify(saved)));
    expect(await registerReservedGoal(input())).toEqual(goal);
    expect(doubles.verify).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { gherkin: 'Feature: CSV' }, { gherkin: 'Feature: CSV\n```alloy\nsig CSV {}\n```' }])(
    'registers without verification when no formal language field exists: %j', async (specifications) => {
      const goal = await createGoal({ ...input(), specifications });
      expect(goal.status).toBe('created'); expect(goal.workLog).toEqual([]);
      expect(saveManagerEvent).toHaveBeenCalledExactlyOnceWith('/project', { kind: 'registered', goalId: goal.id });
      expect(await registerReservedGoal({ ...input(), specifications })).toEqual(goal);
      expect(doubles.verify).not.toHaveBeenCalled();
    },
  );

  it.each(['failed', 'error'] as const)('keeps registration and records a %s verification result', async (verdict) => {
    doubles.verify.mockResolvedValue(result(verdict));
    const goal = await createGoal(input());
    expect(goal.status).toBe('created'); expect(goal).toEqual(saved);
    expect(goal.workLog).toHaveLength(1);
    expect(goal.workLog[0]!.summary).toContain(verdict);
    expect(goal.workLog[0]!.summary).toMatch(/quint/iu);
    expect(goal.workLog[0]!.summary).toMatch(/alloy/iu);
    expect(doubles.removeBranch).not.toHaveBeenCalled();
  });

  it('does not verify when initial goal publication fails', async () => {
    doubles.create.mockRejectedValueOnce(new Error('publication failed'));
    await expect(createGoal(input())).rejects.toThrow('publication failed');
    expect(doubles.removeBranch).toHaveBeenCalledOnce();
    expect(doubles.verify).not.toHaveBeenCalled();
  });

  it('rejects a configuration resolution failure before publishing the goal', async () => {
    const failure = new Error('configuration unavailable');
    doubles.manager.mockImplementation(() => { throw failure; });
    await expect(createGoal(input())).rejects.toBe(failure);
    expect(saved).toBeUndefined();
    expect(saveManagerEvent).not.toHaveBeenCalled();
    expect(doubles.createBranch).not.toHaveBeenCalled();
    expect(doubles.removeBranch).not.toHaveBeenCalled();
    expect(doubles.verify).not.toHaveBeenCalled();
  });

  it('reports a work log save failure without undoing the published registration', async () => {
    doubles.update.mockRejectedValueOnce(new Error('work log save failed'));
    await expect(createGoal(input())).rejects.toThrow('work log save failed');
    expect(saved).toMatchObject({ id: input().id, status: 'created' });
    expect(doubles.verify).toHaveBeenCalledOnce();
    expect(doubles.removeBranch).not.toHaveBeenCalled();
    expect(doubles.cleanup).toHaveBeenCalledOnce();
    saved = GoalSchema.parse(saved);
    expect((await registerReservedGoal(input())).registrationVerification?.status).toBe('completed');
    expect(doubles.verify).toHaveBeenCalledTimes(2);
    expect(saved.workLog).toHaveLength(1);
  });

  it('appends verification to the latest goal without overwriting another work log entry', async () => {
    doubles.verify.mockImplementation(async () => {
      saved = appendGoalWorkLog(saved!, { summary: 'Work recorded during verification' });
      return result('passed');
    });
    const goal = await createGoal(input());
    expect(goal.workLog).toHaveLength(2);
    expect(goal.workLog[0]!.summary).toBe('Work recorded during verification');
    expect(goal.workLog[1]!.summary).toContain('passed');
  });

  it('propagates verification cancellation while keeping the published goal and event', async () => {
    const controller = new AbortController();
    const cancellation = new Error('verification cancelled');
    doubles.verify.mockImplementation(async (_source: string, _cwd: string, options: { abortSignal: AbortSignal }) => {
      controller.abort(cancellation);
      options.abortSignal.throwIfAborted();
    });
    await expect(createGoal(input(), controller.signal)).rejects.toBe(cancellation);
    expect(saved).toMatchObject({ status: 'created', workLog: [] });
    expect(saveManagerEvent).toHaveBeenCalledExactlyOnceWith('/project', { kind: 'registered', goalId: input().id });
    expect(doubles.removeBranch).not.toHaveBeenCalled();
    saved = GoalSchema.parse(saved);
    doubles.verify.mockResolvedValue(result('passed'));
    doubles.verify.mockClear();
    const recovered = await registerReservedGoal(input(), new AbortController().signal);
    expect(recovered.registrationVerification?.status).toBe('completed');
    expect(doubles.verify).toHaveBeenCalledOnce();
    expect(saved.workLog).toHaveLength(1);
    expect(await registerReservedGoal(input())).toEqual(recovered);
    expect(doubles.verify).toHaveBeenCalledOnce();
  });

  it('records bounded failure diagnostics and uses the existing artifact cleanup', async () => {
    const verification = { ...result('error'), message: 'environment unavailable',
      quint: { status: 'error' as const, message: 'large diagnostic '.repeat(20_000) } };
    doubles.verify.mockResolvedValue(verification);
    const goal = await createGoal(input());
    expect(goal.workLog[0]!.summary).toContain('environment unavailable');
    expect(goal.workLog[0]!.summary).toContain('large diagnostic');
    expect(goal.workLog[0]!.summary.length).toBeLessThan(128 * 1024);
    expect(doubles.cleanup).toHaveBeenCalledExactlyOnceWith(verification);
  });

  it('records distinct language results under the overall failed verdict', async () => {
    doubles.verify.mockResolvedValue({ verdict: 'failed', verificationStarted: true,
      quint: { status: 'passed' }, alloy: { status: 'failed', message: 'Counterexample found' } });
    const goal = await createGoal(input());
    expect(goal.workLog[0]!.summary.split('\n')[0]).toContain('failed');
    expect(goal.workLog[0]!.summary).toContain('Quint: passed');
    expect(goal.workLog[0]!.summary).toContain('Alloy: failed');
    expect(goal.workLog[0]!.summary).toContain('Counterexample found');
  });

  it('returns an existing reserved goal without verifying it again', async () => {
    const goal = await registerReservedGoal(input());
    expect(await registerReservedGoal(input())).toEqual(goal);
    expect(doubles.verify).toHaveBeenCalledOnce();
    expect(saved!.workLog).toHaveLength(1);
  });

  it.each([false, true])('rereads and validates the goal after registration event lookup, conflict=%s', async (conflict) => {
    saved = GoalSchema.parse({ ...goalRecord(), specifications: input().specifications,
      registrationVerification: { status: 'pending' } });
    vi.mocked(readManagerEvents).mockReturnValue([]);
    const tasks = vi.spyOn(TaskRunner.prototype, 'listTaskStateItems').mockReturnValue([]);
    const delivered = vi.spyOn(FileEventStore.prototype, 'hasGoalRegistration').mockImplementation(async () => {
      saved = appendGoalWorkLog(saved!, { summary: 'Formal specification verification: passed' });
      saved = GoalSchema.parse({ ...saved, objective: conflict ? 'different reservation' : saved.objective,
        registrationVerification: { status: 'completed', workLogId: saved.workLog[0]!.id } });
      return true;
    });
    try {
      if (conflict) await expect(registerReservedGoal(input())).rejects.toThrow('conflicts');
      else expect(await registerReservedGoal(input())).toEqual(saved);
      expect(delivered).toHaveBeenCalledOnce();
      expect(doubles.verify).not.toHaveBeenCalled();
      expect(saved!.workLog).toHaveLength(1);
    } finally { tasks.mockRestore(); delivered.mockRestore(); }
  });

  it.each([{ quint: 'module csv {}' }, { alloy: 'sig CSV {}' }])('recovers an older saved registration without verification state: %j', async (specifications) => {
    saved = GoalSchema.parse({ ...goalRecord(), specifications });
    const original = structuredClone(saved);
    expect(await registerReservedGoal({ ...input(), specifications })).toEqual(original);
    expect(saved).toEqual(original);
    expect(doubles.create).not.toHaveBeenCalled();
    expect(saveManagerEvent).not.toHaveBeenCalled();
    expect(doubles.update).not.toHaveBeenCalled();
    expect(doubles.verify).not.toHaveBeenCalled();
    expect(saved.workLog).toHaveLength(0);

    saved = GoalSchema.parse({ ...original, registrationVerification: { status: 'pending' } });
    expect((await registerReservedGoal({ ...input(), specifications })).registrationVerification?.status).toBe('completed');
    expect(doubles.create).not.toHaveBeenCalled();
    expect(saveManagerEvent).not.toHaveBeenCalled();
    expect(doubles.verify).toHaveBeenCalledOnce();
    expect(saved.workLog).toHaveLength(1);
  });
});


it('saves the approved specifications and rejects recovery against different specifications', async () => {
  vi.resetAllMocks();
  doubles.manager.mockReturnValue({ verifyOnRegister: false });
  doubles.formal.mockReturnValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 17 });
  const specifications = { gherkin: 'Feature: Export', quint: 'module export {}', alloy: 'sig Export {}' };
  doubles.prepare.mockResolvedValue({ branch: goalRecord().branch, startBranch: 'main', integrationBranch: 'main', commit: 'a'.repeat(40) });
  doubles.create.mockImplementation(async (goal: unknown) => goal);
  const input = { cwd: '/project', ...goalInput(), id: goalRecord().id, specifications };
  doubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => transform({ ...goalRecord(), specifications }));
  expect(await createGoal(input)).toMatchObject({ specifications });
  doubles.find.mockReturnValue({ ...goalRecord(), specifications });
  await expect(registerReservedGoal({ ...input, specifications: { gherkin: 'Feature: Different' } })).rejects.toThrow('conflicts');
});

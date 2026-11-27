import { describe, expect, it } from 'vitest';
import type {
  AgentResponse,
  LoopMonitorConfig,
  WorkflowConfig,
  WorkflowMaxSteps,
  WorkflowStep,
} from '../core/models/index.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { StepLoopGuard } from '../core/workflow/engine/step-visit-guard.js';
import {
  runSingleWorkflowIteration,
  runWorkflowToCompletion,
} from '../core/workflow/engine/WorkflowRunLoop.js';
import type { WorkflowAbortResult, WorkflowEngineOptions } from '../core/workflow/types.js';
import { makeResponse, makeStep } from './engine-test-helpers.js';
import { createWorkflowRunLoopTestContract, makeRule } from './test-helpers.js';

type LoopDeps = Parameters<typeof runWorkflowToCompletion>[0];
type Mode = 'full' | 'single';

const modes = [
  ['full', 'runWorkflowToCompletion'],
  ['single', 'runSingleWorkflowIteration'],
] as const satisfies readonly (readonly [Mode, string])[];

interface Counters {
  iterationLimitEmits: number;
  onIterationLimitCalls: number;
  exceededInfo: boolean;
  applyRuntimeEnvironment: number;
  loopDetectorChecks: number;
  runStepCalls: number;
  cycleDetectorChecks: number;
  judgeCalls: number;
  events: string[];
}

interface HarnessOptions {
  steps: WorkflowStep[];
  initialStep?: string;
  maxSteps: WorkflowMaxSteps;
  iteration?: number;
  options?: Partial<WorkflowEngineOptions>;
  guard?: StepLoopGuard;
  loopDetection?: { isLoop: boolean; shouldWarn: boolean; shouldAbort: boolean };
  runStep: LoopDeps['runStep'];
  resolveDoneTransition?: LoopDeps['resolveDoneTransition'];
  cycleMonitor?: LoopMonitorConfig;
  /** Decides whether the nth cycle-detector call (1-based) reports a cycle. Defaults to every call when a monitor is set. */
  cycleTriggered?: (call: number) => boolean;
  abortRequested?: () => boolean;
}

function emptyCounters(): Counters {
  return {
    iterationLimitEmits: 0,
    onIterationLimitCalls: 0,
    exceededInfo: false,
    applyRuntimeEnvironment: 0,
    loopDetectorChecks: 0,
    runStepCalls: 0,
    cycleDetectorChecks: 0,
    judgeCalls: 0,
    events: [],
  };
}

function makeHarness(params: HarnessOptions): { deps: LoopDeps; counters: Counters; state: ReturnType<typeof createInitialState> } {
  const initialStep = params.initialStep ?? params.steps[0]!.name;
  const config: WorkflowConfig = {
    name: 'entry-order',
    maxSteps: params.maxSteps,
    initialStep,
    steps: params.steps,
  };
  const state = createInitialState(config, {
    projectCwd: '/worktree',
    initialIteration: params.iteration ?? 0,
  });
  const counters = emptyCounters();
  const guard = params.guard ?? new StepLoopGuard();
  let maxSteps = params.maxSteps;
  const loopDetection = params.loopDetection ?? { isLoop: false, shouldWarn: false, shouldAbort: false };

  const deps: LoopDeps = {
    state,
    options: { projectCwd: '/worktree', ...params.options } as WorkflowEngineOptions,
    getWorkflowName: () => config.name,
    getWorkflowSteps: () => config.steps,
    getCwd: () => '/worktree',
    getMaxSteps: () => maxSteps,
    getReportDir: () => '/worktree/.takt/runs/test/reports',
    abortRequested: params.abortRequested ?? (() => false),
    getStep: (name) => {
      const step = config.steps.find(candidate => candidate.name === name);
      if (step === undefined) throw new Error(`Unknown step: ${name}`);
      return step;
    },
    applyRuntimeEnvironment: () => {
      counters.applyRuntimeEnvironment++;
    },
    loopDetectorCheck: () => {
      counters.loopDetectorChecks++;
      return { count: 1, ...loopDetection };
    },
    cycleDetectorRecordAndCheck: () => {
      counters.cycleDetectorChecks++;
      const triggered = params.cycleMonitor !== undefined
        && (params.cycleTriggered?.(counters.cycleDetectorChecks) ?? true);
      return triggered
        ? { triggered: true, monitor: params.cycleMonitor!, cycleCount: 1 }
        : { triggered: false, cycleCount: 0 };
    },
    stepVisitCheckEntry: step => guard.checkEntry(step),
    stepVisitRecordCompletion: (step, matchedRuleIndex) => guard.recordCompletion(step, matchedRuleIndex),
    resolveDoneTransition: params.resolveDoneTransition
      ?? (() => ({ nextStep: 'COMPLETE', commandGates: 'skip' as const })),
    runLoopMonitorJudge: async () => {
      counters.judgeCalls++;
      return 'ABORT';
    },
    runStep: async (...args) => {
      counters.runStepCalls++;
      return params.runStep(...args);
    },
    runQualityGates: async () => ({ ok: true as const }),
    persistPreviousResponseSnapshot: () => {},
    prepareInstruction: () => ({ text: 'instruction', injectedReports: [], reviewScope: { kind: 'not_a_git_repository' as const } }),
    buildPhase1Instruction: (_step, instruction) => instruction,
    prepareNormalStepExecution: async () => undefined,
    resolveStepProviderModel: () => ({ provider: undefined, model: undefined }),
    resolveStepProviderModelBeforeAutoRouting: () => ({ provider: undefined, model: undefined }),
    resolveRuntimeForStep: () => undefined,
    addUserInput: () => {},
    emit: ((...args: unknown[]) => {
      const [event] = args;
      if (typeof event !== 'string') return;
      counters.events.push(event);
      if (event === 'iteration:limit') counters.iterationLimitEmits++;
    }) as LoopDeps['emit'],
    updateMaxSteps: (next) => {
      maxSteps = next;
    },
    ...createWorkflowRunLoopTestContract(config, state, 'test task'),
  };

  return { deps, counters, state };
}

function doneResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return makeResponse({ persona: 'worker', status: 'done', content: 'done', matchedRuleIndex: 0, ...overrides });
}

function visitLimitReason(name: string, completed: number, maxVisits: number): string {
  return `Visit limit reached: step "${name}" already completed ${completed} times (max_visits: ${maxVisits}); stopping instead of another lap.`;
}

async function runMode(mode: Mode, deps: LoopDeps): Promise<{ abort: WorkflowAbortResult | undefined; iteration: number }> {
  if (mode === 'full') {
    const result = await runWorkflowToCompletion(deps);
    return { abort: result.abort, iteration: result.state.iteration };
  }
  const result = await runSingleWorkflowIteration(deps);
  return { abort: result.abort, iteration: deps.state.iteration };
}

/** Pre-completes `count` visits of `step` so the guard reports it as already at max_visits. */
function precomplete(guard: StepLoopGuard, step: WorkflowStep, count: number): void {
  for (let visit = 0; visit < count; visit++) {
    guard.recordCompletion(step, 0);
  }
}

describe('WorkflowRunLoop iteration-entry order', () => {
  it.each(modes)('%s: an interrupt wins over max_visits, max_steps, user input and loop detection', async (mode) => {
    const guard = new StepLoopGuard();
    const step = makeStep('guarded', {
      maxVisits: 1,
      requiresUserInput: true,
      rules: [makeRule('done', 'COMPLETE')],
    });
    precomplete(guard, step, 1);
    const { deps, counters } = makeHarness({
      steps: [step],
      maxSteps: 1,
      iteration: 1,
      guard,
      loopDetection: { isLoop: true, shouldWarn: true, shouldAbort: true },
      abortRequested: () => true,
      runStep: async () => ({ response: doneResponse(), instruction: '' }),
    });

    const { abort } = await runMode(mode, deps);

    expect(abort?.kind).toBe('interrupt');
    expect(abort?.reason).toBe('Workflow interrupted by user (SIGINT)');
    expect(counters.iterationLimitEmits).toBe(0);
    expect(counters.onIterationLimitCalls).toBe(0);
    expect(counters.exceededInfo).toBe(false);
    expect(counters.applyRuntimeEnvironment).toBe(0);
    expect(counters.loopDetectorChecks).toBe(0);
    expect(counters.runStepCalls).toBe(0);
  });

  it.each(modes)('%s: max_visits wins over max_steps, user input and loop detection without side effects', async (mode) => {
    const guard = new StepLoopGuard();
    const step = makeStep('guarded', {
      maxVisits: 1,
      requiresUserInput: true,
      rules: [makeRule('done', 'COMPLETE')],
    });
    precomplete(guard, step, 1);
    const { deps, counters } = makeHarness({
      steps: [step],
      maxSteps: 2,
      iteration: 2,
      guard,
      loopDetection: { isLoop: true, shouldWarn: true, shouldAbort: true },
      options: {
        onIterationLimit: async () => {
          counters.onIterationLimitCalls++;
          counters.exceededInfo = true;
          return null;
        },
      },
      runStep: async () => ({ response: doneResponse(), instruction: '' }),
    });

    const { abort } = await runMode(mode, deps);

    expect(abort?.kind).toBe('loop_detected');
    expect(abort?.reason).toBe(visitLimitReason('guarded', 1, 1));
    expect(counters.iterationLimitEmits).toBe(0);
    expect(counters.onIterationLimitCalls).toBe(0);
    expect(counters.exceededInfo).toBe(false);
    expect(counters.applyRuntimeEnvironment).toBe(0);
    expect(counters.loopDetectorChecks).toBe(0);
    expect(counters.runStepCalls).toBe(0);
  });

  it('full: max_steps wins over user input and loop detection when max_visits is not reached', async () => {
    const step = makeStep('guarded', {
      requiresUserInput: true,
      rules: [makeRule('done', 'COMPLETE')],
    });
    const { deps, counters } = makeHarness({
      steps: [step],
      maxSteps: 2,
      iteration: 2,
      loopDetection: { isLoop: true, shouldWarn: true, shouldAbort: true },
      options: {
        onIterationLimit: async () => {
          counters.onIterationLimitCalls++;
          counters.exceededInfo = true;
          return null;
        },
      },
      runStep: async () => ({ response: doneResponse(), instruction: '' }),
    });

    const { abort } = await runMode('full', deps);

    expect(abort?.kind).toBe('iteration_limit');
    expect(abort?.reason).toBe('Max steps reached');
    expect(counters.iterationLimitEmits).toBe(1);
    expect(counters.onIterationLimitCalls).toBe(1);
    expect(counters.exceededInfo).toBe(true);
    expect(counters.applyRuntimeEnvironment).toBe(0);
    expect(counters.loopDetectorChecks).toBe(0);
    expect(counters.runStepCalls).toBe(0);
  });

  it('single: does not evaluate max_steps, so user input wins over loop detection', async () => {
    const step = makeStep('guarded', {
      requiresUserInput: true,
      rules: [makeRule('done', 'COMPLETE')],
    });
    const { deps, counters } = makeHarness({
      steps: [step],
      maxSteps: 2,
      iteration: 2,
      loopDetection: { isLoop: true, shouldWarn: true, shouldAbort: true },
      options: {
        onIterationLimit: async () => {
          counters.onIterationLimitCalls++;
          return null;
        },
      },
      runStep: async () => ({ response: doneResponse(), instruction: '' }),
    });

    const { abort } = await runMode('single', deps);

    expect(abort?.kind).toBe('user_input_required');
    expect(counters.iterationLimitEmits).toBe(0);
    expect(counters.onIterationLimitCalls).toBe(0);
    expect(counters.loopDetectorChecks).toBe(0);
    expect(counters.runStepCalls).toBe(0);
  });

  it.each(modes)('%s: user input is checked before loop detection', async (mode) => {
    const step = makeStep('guarded', {
      requiresUserInput: true,
      rules: [makeRule('done', 'COMPLETE')],
    });
    const { deps, counters } = makeHarness({
      steps: [step],
      maxSteps: 10,
      loopDetection: { isLoop: true, shouldWarn: true, shouldAbort: true },
      runStep: async () => ({ response: doneResponse(), instruction: '' }),
    });

    const { abort } = await runMode(mode, deps);

    expect(abort?.kind).toBe('user_input_required');
    expect(counters.loopDetectorChecks).toBe(0);
    expect(counters.runStepCalls).toBe(0);
  });

  it.each(modes)('%s: loop detection stops the run when nothing earlier applies', async (mode) => {
    const step = makeStep('guarded', { rules: [makeRule('done', 'COMPLETE')] });
    const { deps, counters } = makeHarness({
      steps: [step],
      maxSteps: 10,
      loopDetection: { isLoop: true, shouldWarn: true, shouldAbort: true },
      runStep: async () => ({ response: doneResponse(), instruction: '' }),
    });

    const { abort } = await runMode(mode, deps);

    expect(abort?.kind).toBe('loop_detected');
    expect(abort?.reason).toBe('Loop detected: step "guarded" ran 1 times consecutively without progress.');
    expect(counters.applyRuntimeEnvironment).toBe(1);
    expect(counters.loopDetectorChecks).toBe(1);
    expect(counters.runStepCalls).toBe(0);
  });
});

describe('WorkflowRunLoop nextStep already at max_visits', () => {
  const monitor: LoopMonitorConfig = {
    cycle: ['review', 'replan'],
    threshold: 1,
    judge: { rules: [{ condition: makeRule('stalled', 'ABORT').condition, next: 'ABORT' }] },
  };

  it('skips the loop monitor judge and stops with Visit limit reached without consuming an iteration', async () => {
    const guard = new StepLoopGuard();
    const review = makeStep('review', { maxVisits: 1, rules: [makeRule('done', 'replan')] });
    const replan = makeStep('replan', { rules: [makeRule('done', 'review')] });
    const { deps, counters } = makeHarness({
      steps: [review, replan],
      initialStep: 'review',
      maxSteps: 2,
      guard,
      cycleMonitor: monitor,
      // Only the transition that would re-enter the already exhausted review step is a cycle.
      cycleTriggered: call => call >= 2,
      options: {
        onIterationLimit: async () => {
          counters.onIterationLimitCalls++;
          counters.exceededInfo = true;
          return null;
        },
      },
      resolveDoneTransition: (step) => ({
        nextStep: step.name === 'review' ? 'replan' : 'review',
        commandGates: 'skip',
      }),
      runStep: async () => ({ response: doneResponse(), instruction: '' }),
    });

    const { abort, iteration } = await runMode('full', deps);

    expect(abort?.kind).toBe('loop_detected');
    expect(abort?.reason).toBe(visitLimitReason('review', 1, 1));
    expect(iteration).toBe(2);
    expect(counters.runStepCalls).toBe(2);
    expect(counters.cycleDetectorChecks).toBe(0);
    expect(counters.judgeCalls).toBe(0);
    expect(counters.events).not.toContain('step:cycle_detected');
    expect(counters.iterationLimitEmits).toBe(0);
    expect(counters.onIterationLimitCalls).toBe(0);
    expect(counters.exceededInfo).toBe(false);
  });
});

describe('WorkflowRunLoop wait.on_timeout visit completion', () => {
  it('clears the previous verdict on wait.on_timeout and still counts it toward max_visits', async () => {
    const guard = new StepLoopGuard();
    const poll = makeStep('poll', {
      kind: 'system',
      maxVisits: 3,
      stopOnRepeatedVerdict: true,
      rules: [makeRule('ready', 'poll')],
    });
    let call = 0;
    const { deps } = makeHarness({
      steps: [poll],
      maxSteps: 'infinite',
      guard,
      resolveDoneTransition: step => ({ nextStep: step.name, commandGates: 'skip' }),
      runStep: async () => {
        call++;
        if (call === 2) {
          return {
            response: doneResponse({ matchedRuleIndex: undefined, systemWaitTimeout: true }),
            instruction: '',
          };
        }
        return { response: doneResponse(), instruction: '' };
      },
    });

    const { abort } = await runMode('full', deps);

    expect(call).toBe(3);
    expect(abort?.kind).toBe('loop_detected');
    expect(abort?.reason).toBe(visitLimitReason('poll', 3, 3));
    expect(abort?.reason).not.toMatch(/same verdict/);
  });
});

describe('WorkflowRunLoop max_visits does not change existing contracts', () => {
  it('does not count a retried visit that never completed', async () => {
    const guard = new StepLoopGuard();
    const step = makeStep('retry', { maxVisits: 1, rules: [makeRule('done', 'COMPLETE')] });
    let call = 0;
    const { deps } = makeHarness({
      steps: [step],
      maxSteps: 10,
      guard,
      runStep: async () => {
        call++;
        if (call === 1) {
          return {
            response: makeResponse({ persona: 'retry', status: 'done', content: 'gate failed' }),
            instruction: '',
            qualityGateFailure: {
              response: makeResponse({ persona: 'retry', status: 'done', content: 'gate failed' }),
              stepIteration: 1,
            },
          };
        }
        return { response: doneResponse(), instruction: '' };
      },
    });

    const { abort, iteration } = await runMode('full', deps);

    expect(abort).toBeUndefined();
    expect(call).toBe(2);
    expect(iteration).toBe(2);
    expect(deps.state.status).toBe('completed');
  });

  it('still fires max_steps immediately when initialIteration is already at the limit and max_visits is unset', async () => {
    const step = makeStep('guarded', { rules: [makeRule('done', 'COMPLETE')] });
    const { deps, counters } = makeHarness({
      steps: [step],
      maxSteps: 2,
      iteration: 2,
      runStep: async () => ({ response: doneResponse(), instruction: '' }),
    });

    const { abort } = await runMode('full', deps);

    expect(abort?.kind).toBe('iteration_limit');
    expect(abort?.reason).toBe('Max steps reached');
    expect(counters.iterationLimitEmits).toBe(1);
    expect(counters.runStepCalls).toBe(0);
  });

  it('ignores max_steps when ignoreIterationLimit is true and lets max_visits stop the run', async () => {
    const guard = new StepLoopGuard();
    const step = makeStep('guarded', { maxVisits: 1, rules: [makeRule('done', 'COMPLETE')] });
    precomplete(guard, step, 1);
    const { deps } = makeHarness({
      steps: [step],
      maxSteps: 2,
      iteration: 5,
      guard,
      options: { ignoreIterationLimit: true },
      runStep: async () => ({ response: doneResponse(), instruction: '' }),
    });

    const { abort } = await runMode('full', deps);

    expect(abort?.kind).toBe('loop_detected');
    expect(abort?.reason).toBe(visitLimitReason('guarded', 1, 1));
  });

  it('ignores max_steps when it is infinite and completes when max_visits is unset', async () => {
    const step = makeStep('guarded', { rules: [makeRule('done', 'COMPLETE')] });
    const { deps } = makeHarness({
      steps: [step],
      maxSteps: 'infinite',
      iteration: 9,
      runStep: async () => ({ response: doneResponse(), instruction: '' }),
    });

    const { abort } = await runMode('full', deps);

    expect(abort).toBeUndefined();
    expect(deps.state.status).toBe('completed');
  });

  it('lets max_steps win over non-interactive requiresUserInput', async () => {
    const step = makeStep('guarded', {
      requiresUserInput: true,
      rules: [makeRule('done', 'COMPLETE')],
    });
    const { deps, counters } = makeHarness({
      steps: [step],
      maxSteps: 1,
      iteration: 1,
      runStep: async () => ({ response: doneResponse(), instruction: '' }),
    });

    const { abort } = await runMode('full', deps);

    expect(abort?.kind).toBe('iteration_limit');
    expect(abort?.reason).toBe('Max steps reached');
    expect(counters.loopDetectorChecks).toBe(0);
  });

  it('keeps interrupts ahead of a simultaneous max_visits and max_steps stop', async () => {
    const guard = new StepLoopGuard();
    const step = makeStep('guarded', { maxVisits: 1, rules: [makeRule('done', 'COMPLETE')] });
    precomplete(guard, step, 1);
    const { deps, counters } = makeHarness({
      steps: [step],
      maxSteps: 1,
      iteration: 1,
      guard,
      abortRequested: () => true,
      runStep: async () => ({ response: doneResponse(), instruction: '' }),
    });

    const { abort } = await runMode('full', deps);

    expect(abort?.kind).toBe('interrupt');
    expect(counters.iterationLimitEmits).toBe(0);
    expect(counters.onIterationLimitCalls).toBe(0);
  });
});

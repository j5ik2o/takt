import { describe, expect, it } from 'vitest';
import type {
  AgentResponse,
  WorkflowConfig,
  WorkflowMaxSteps,
  WorkflowStep,
} from '../core/models/index.js';
import { scaledMs } from '../../scripts/test-time-factor.mjs';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { StepLoopGuard } from '../core/workflow/engine/step-visit-guard.js';
import {
  runSingleWorkflowIteration,
  runWorkflowToCompletion,
} from '../core/workflow/engine/WorkflowRunLoop.js';
import type { WorkflowAbortKind, WorkflowAbortResult, WorkflowEngineOptions } from '../core/workflow/types.js';
import { makeStep } from './engine-test-helpers.js';
import { createWorkflowRunLoopTestContract, makeRule } from './test-helpers.js';

/**
 * Property-based test for the iteration-entry check order (j5ik2o/takt#176).
 *
 * The input space and the four properties are the ones in
 * docs/design/step-loop-guard.md ("PBT の性質と除外（#176 追加分）"). There are no
 * exclusions: every tuple is compared against a model oracle.
 *
 *   interrupt -> stepVisitCheckEntry (max_visits) -> max_steps -> user input -> loop detection
 *
 * The full loop runs max_steps; the single-iteration loop does not (the caller owns the count).
 */

type LoopDeps = Parameters<typeof runWorkflowToCompletion>[0];
type Mode = 'full' | 'single';

interface LoopDetectionInput {
  isLoop: boolean;
  shouldWarn: boolean;
  shouldAbort: boolean;
}

interface EntryOrderInput {
  interruptRequested: boolean;
  stepKind: 'normal' | 'workflow_call';
  maxVisits: number | undefined;
  completedVisits: number;
  maxSteps: WorkflowMaxSteps;
  iteration: number;
  ignoreIterationLimit: boolean;
  onIterationLimitBehavior: 'none' | 'null_exceeded' | 'extend_1';
  requiresUserInputInvalid: boolean;
  loopDetection: LoopDetectionInput;
}

const STEP_NAME = 'guarded';
const RESPONSE: AgentResponse = {
  persona: 'worker',
  status: 'done',
  content: 'done',
  timestamp: new Date(0),
  matchedRuleIndex: 0,
};

interface Outcome {
  abort: WorkflowAbortResult | undefined;
  iterationLimitEmits: number;
  onIterationLimitCalls: number;
  exceededInfo: boolean;
  applyRuntimeEnvironment: number;
  loopDetectorChecks: number;
  runStepCalls: number;
}

function visitLimitReason(completedVisits: number, maxVisits: number): string {
  return `Visit limit reached: step "${STEP_NAME}" already completed ${completedVisits} times (max_visits: ${maxVisits}); stopping instead of another lap.`;
}

/** Every tuple of the declared input space, in a stable order. */
function* entryOrderInputs(): Generator<EntryOrderInput> {
  const visitPairs: { maxVisits: number | undefined; completedVisits: number }[] = [
    { maxVisits: undefined, completedVisits: 0 },
  ];
  for (let maxVisits = 1; maxVisits <= 4; maxVisits++) {
    for (let completedVisits = 0; completedVisits <= maxVisits; completedVisits++) {
      visitPairs.push({ maxVisits, completedVisits });
    }
  }
  const maxStepValues: WorkflowMaxSteps[] = ['infinite', 0, 1, 2, 3, 4, 5];
  const behaviors: EntryOrderInput['onIterationLimitBehavior'][] = ['none', 'null_exceeded', 'extend_1'];
  for (const interruptRequested of [false, true]) {
    for (const stepKind of ['normal', 'workflow_call'] as const) {
      for (const { maxVisits, completedVisits } of visitPairs) {
        for (const maxSteps of maxStepValues) {
          for (let iteration = 0; iteration <= 6; iteration++) {
            for (const ignoreIterationLimit of [false, true]) {
              for (const onIterationLimitBehavior of behaviors) {
                for (const requiresUserInputInvalid of [false, true]) {
                  for (const isLoop of [false, true]) {
                    for (const shouldWarn of [false, true]) {
                      for (const shouldAbort of [false, true]) {
                        yield {
                          interruptRequested,
                          stepKind,
                          maxVisits,
                          completedVisits,
                          maxSteps,
                          iteration,
                          ignoreIterationLimit,
                          onIterationLimitBehavior,
                          requiresUserInputInvalid,
                          loopDetection: { isLoop, shouldWarn, shouldAbort },
                        };
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

async function runCase(mode: Mode, input: EntryOrderInput): Promise<Outcome> {
  const step = {
    ...makeStep(STEP_NAME, { rules: [makeRule('done', 'COMPLETE')] }),
    ...(input.stepKind === 'workflow_call' ? { kind: 'workflow_call' as const, call: 'child' } : {}),
    ...(input.maxVisits === undefined ? {} : { maxVisits: input.maxVisits }),
    ...(input.requiresUserInputInvalid ? { requiresUserInput: true } : {}),
  } as WorkflowStep;
  const config: WorkflowConfig = {
    name: 'entry-order-pbt',
    maxSteps: input.maxSteps,
    initialStep: STEP_NAME,
    steps: [step],
  };
  const state = createInitialState(config, {
    projectCwd: '/worktree',
    initialIteration: input.iteration,
  });
  const guard = new StepLoopGuard();
  for (let visit = 0; visit < input.completedVisits; visit++) {
    guard.recordCompletion(step, 0);
  }
  let maxSteps = input.maxSteps;
  const counters = {
    iterationLimitEmits: 0,
    onIterationLimitCalls: 0,
    exceededInfo: false,
    applyRuntimeEnvironment: 0,
    loopDetectorChecks: 0,
    runStepCalls: 0,
  };
  const onIterationLimit = input.onIterationLimitBehavior === 'none'
    ? undefined
    : async (): Promise<number | null> => {
      counters.onIterationLimitCalls++;
      if (input.onIterationLimitBehavior === 'null_exceeded') {
        counters.exceededInfo = true;
        return null;
      }
      return 1;
    };
  const options: WorkflowEngineOptions = {
    projectCwd: '/worktree',
    ...(input.ignoreIterationLimit ? { ignoreIterationLimit: true } : {}),
    ...(onIterationLimit === undefined ? {} : { onIterationLimit }),
  };
  const deps: LoopDeps = {
    state,
    options,
    getWorkflowName: () => config.name,
    getWorkflowSteps: () => config.steps,
    getCwd: () => '/worktree',
    getMaxSteps: () => maxSteps,
    getReportDir: () => '/worktree/.takt/runs/test/reports',
    abortRequested: () => input.interruptRequested,
    getStep: (name) => {
      if (name !== STEP_NAME) throw new Error(`Unknown step: ${name}`);
      return step;
    },
    applyRuntimeEnvironment: () => {
      counters.applyRuntimeEnvironment++;
    },
    loopDetectorCheck: () => {
      counters.loopDetectorChecks++;
      return { count: 1, ...input.loopDetection };
    },
    cycleDetectorRecordAndCheck: () => ({ triggered: false, cycleCount: 0 }),
    stepVisitCheckEntry: target => guard.checkEntry(target),
    stepVisitRecordCompletion: (target, matchedRuleIndex) => guard.recordCompletion(target, matchedRuleIndex),
    resolveDoneTransition: () => ({ nextStep: 'COMPLETE', commandGates: 'skip' }),
    runLoopMonitorJudge: async () => 'ABORT',
    runStep: async () => {
      counters.runStepCalls++;
      return { response: RESPONSE, instruction: '' };
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
      if (args[0] === 'iteration:limit') counters.iterationLimitEmits++;
    }) as LoopDeps['emit'],
    updateMaxSteps: (next) => {
      maxSteps = next;
    },
    ...createWorkflowRunLoopTestContract(config, state, 'test task'),
  };

  if (mode === 'full') {
    const result = await runWorkflowToCompletion(deps);
    return {
      abort: result.abort,
      iterationLimitEmits: counters.iterationLimitEmits,
      onIterationLimitCalls: counters.onIterationLimitCalls,
      exceededInfo: counters.exceededInfo,
      applyRuntimeEnvironment: counters.applyRuntimeEnvironment,
      loopDetectorChecks: counters.loopDetectorChecks,
      runStepCalls: counters.runStepCalls,
    };
  }
  const result = await runSingleWorkflowIteration(deps);
  return {
    abort: result.abort,
    iterationLimitEmits: counters.iterationLimitEmits,
    onIterationLimitCalls: counters.onIterationLimitCalls,
    exceededInfo: counters.exceededInfo,
    applyRuntimeEnvironment: counters.applyRuntimeEnvironment,
    loopDetectorChecks: counters.loopDetectorChecks,
    runStepCalls: counters.runStepCalls,
  };
}

interface ExpectedOutcome {
  kind: WorkflowAbortKind | undefined;
  reason: string | undefined;
  iterationLimitEmits: number;
  onIterationLimitCalls: number;
  exceededInfo: boolean;
  applyRuntimeEnvironment: number;
  loopDetectorChecks: number;
  runStepCalls: number;
}

function atVisitLimit(input: EntryOrderInput): boolean {
  return input.maxVisits !== undefined && input.completedVisits >= input.maxVisits;
}

function maxStepsApplies(mode: Mode, input: EntryOrderInput): boolean {
  return mode === 'full'
    && input.stepKind !== 'workflow_call'
    && !input.ignoreIterationLimit
    && typeof input.maxSteps === 'number'
    && input.iteration >= input.maxSteps;
}

/** The fixed order evaluated against the declared inputs. */
function modelOracle(mode: Mode, input: EntryOrderInput): ExpectedOutcome {
  const none = {
    iterationLimitEmits: 0,
    onIterationLimitCalls: 0,
    exceededInfo: false,
    applyRuntimeEnvironment: 0,
    loopDetectorChecks: 0,
    runStepCalls: 0,
  };
  if (input.interruptRequested) {
    return {
      ...none,
      kind: 'interrupt',
      reason: 'Workflow interrupted by user (SIGINT)',
    };
  }
  if (atVisitLimit(input)) {
    return {
      ...none,
      kind: 'loop_detected',
      reason: visitLimitReason(input.completedVisits, input.maxVisits!),
    };
  }

  let iterationLimitEmits = 0;
  let onIterationLimitCalls = 0;
  let exceededInfo = false;
  if (maxStepsApplies(mode, input)) {
    if (input.onIterationLimitBehavior === 'none') {
      return {
        ...none,
        iterationLimitEmits: 1,
        kind: 'iteration_limit',
        reason: 'Max steps reached',
      };
    }
    if (input.onIterationLimitBehavior === 'null_exceeded') {
      return {
        ...none,
        iterationLimitEmits: 1,
        onIterationLimitCalls: 1,
        exceededInfo: true,
        kind: 'iteration_limit',
        reason: 'Max steps reached',
      };
    }
    // `+1` per continue: the loop re-enters until maxSteps > iteration.
    const extensions = input.iteration - (input.maxSteps as number) + 1;
    iterationLimitEmits = extensions;
    onIterationLimitCalls = extensions;
  }

  if (input.requiresUserInputInvalid) {
    return {
      ...none,
      iterationLimitEmits,
      onIterationLimitCalls,
      exceededInfo,
      kind: 'user_input_required',
      reason: `Step "${STEP_NAME}" requires interactive user input but workflow interactive mode is disabled`,
    };
  }
  if (input.loopDetection.shouldAbort) {
    return {
      ...none,
      iterationLimitEmits,
      onIterationLimitCalls,
      exceededInfo,
      applyRuntimeEnvironment: 1,
      loopDetectorChecks: 1,
      kind: 'loop_detected',
      reason: `Loop detected: step "${STEP_NAME}" ran 1 times consecutively without progress.`,
    };
  }
  return {
    iterationLimitEmits,
    onIterationLimitCalls,
    exceededInfo,
    applyRuntimeEnvironment: 1,
    loopDetectorChecks: 1,
    runStepCalls: 1,
    kind: undefined,
    reason: undefined,
  };
}

function assertCase(
  label: string,
  mode: Mode,
  input: EntryOrderInput,
  property: () => void,
): void {
  try {
    property();
  } catch (error) {
    throw new Error(`${label} failed for mode=${mode}: ${JSON.stringify(input)}\n${String(error)}`);
  }
}

describe('WorkflowRunLoop iteration-entry order properties (#176)', () => {
  it('matches the fixed order, side effects and full/single consistency for every input tuple', async () => {
    for (const input of entryOrderInputs()) {
      const full = await runCase('full', input);
      const single = await runCase('single', input);
      const fullExpected = modelOracle('full', input);
      const singleExpected = modelOracle('single', input);

      assertCase('property 1 (priority determinism)', 'full', input, () => {
        expect(full.abort?.kind).toBe(fullExpected.kind);
        expect(full.abort?.reason).toBe(fullExpected.reason);
        expect(full.runStepCalls).toBe(fullExpected.runStepCalls);
      });
      assertCase('property 1 (priority determinism)', 'single', input, () => {
        expect(single.abort?.kind).toBe(singleExpected.kind);
        expect(single.abort?.reason).toBe(singleExpected.reason);
        expect(single.runStepCalls).toBe(singleExpected.runStepCalls);
      });

      const sideEffectsMatch = (actual: Outcome, expected: ExpectedOutcome): void => {
        expect(actual.iterationLimitEmits).toBe(expected.iterationLimitEmits);
        expect(actual.onIterationLimitCalls).toBe(expected.onIterationLimitCalls);
        expect(actual.exceededInfo).toBe(expected.exceededInfo);
        expect(actual.applyRuntimeEnvironment).toBe(expected.applyRuntimeEnvironment);
        expect(actual.loopDetectorChecks).toBe(expected.loopDetectorChecks);
      };
      assertCase('property 1 (no unexpected side effects)', 'full', input, () => {
        sideEffectsMatch(full, fullExpected);
      });
      assertCase('property 1 (no unexpected side effects)', 'single', input, () => {
        sideEffectsMatch(single, singleExpected);
      });

      if (!input.interruptRequested && atVisitLimit(input)) {
        assertCase('property 2 (visit limit is side-effect free)', 'full', input, () => {
          expect(full.iterationLimitEmits).toBe(0);
          expect(full.onIterationLimitCalls).toBe(0);
          expect(full.exceededInfo).toBe(false);
          expect(full.applyRuntimeEnvironment).toBe(0);
          expect(full.loopDetectorChecks).toBe(0);
          expect(full.runStepCalls).toBe(0);
        });
        assertCase('property 2 (visit limit is side-effect free)', 'single', input, () => {
          expect(single.iterationLimitEmits).toBe(0);
          expect(single.onIterationLimitCalls).toBe(0);
          expect(single.exceededInfo).toBe(false);
          expect(single.applyRuntimeEnvironment).toBe(0);
          expect(single.loopDetectorChecks).toBe(0);
          expect(single.runStepCalls).toBe(0);
        });
      }

      if (
        !input.interruptRequested
        && !atVisitLimit(input)
        && maxStepsApplies('full', input)
        && input.onIterationLimitBehavior === 'extend_1'
      ) {
        assertCase('property 3 (extension does not double-count loop detection)', 'full', input, () => {
          expect(full.loopDetectorChecks).toBeLessThanOrEqual(1);
        });
      }

      if (!maxStepsApplies('full', input)) {
        assertCase('property 4 (full and single agree when max_steps is inactive)', 'full', input, () => {
          expect(full.abort?.kind).toBe(single.abort?.kind);
          expect(full.abort?.reason).toBe(single.abort?.reason);
          expect(full.loopDetectorChecks > 0).toBe(single.loopDetectorChecks > 0);
        });
      }
    }
  }, scaledMs(900_000));
});

/**
 * Integration tests: executeWorkflow() only marks a run as `exceeded` when the
 * workflow actually aborted with `iteration_limit` (j5ik2o/takt#176).
 *
 * The child workflow_call exhausts the shared max_steps budget and records
 * `exceededInfo`. Depending on the parent rule, the parent either hits a step
 * already at max_visits (Visit limit reached), completes, or propagates the
 * iteration limit. Only the propagated case keeps `exceeded`.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return {
    ...actual,
    RuleEvaluator: MockRuleEvaluator,
  };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: 'done', method: 'phase3_tag' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { runAgent } from '../agents/runner.js';
import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import {
  createTestTmpDir,
  makeResponse,
  makeRule,
  makeStep,
} from './engine-test-helpers.js';

const CHILD_WORKFLOW = `name: child
subworkflow:
  callable: true
initial_step: work
steps:
  - name: work
    persona: child-worker
    instruction: "Keep working until the shared max_steps budget runs out."
    rules:
      - condition: done
        next: work
`;

function writeChildWorkflow(projectCwd: string): void {
  const workflowDir = join(projectCwd, '.takt', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, 'child.yaml'), CHILD_WORKFLOW, 'utf8');
}

function workflowCallStep(rules: ReturnType<typeof makeRule>[]) {
  return makeStep('implement', {
    kind: 'workflow_call',
    call: 'child',
    rules,
  });
}

let projectCwd: string;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
    options?.onPromptResolved?.({
      systemPrompt: String(persona),
      userInstruction: instruction,
    });
    options?.onDispatch?.(options.permissionMode);
    if (String(persona).includes('explode')) {
      return makeResponse({ persona: 'explode', status: 'error', content: 'branch failed' });
    }
    return makeResponse({ persona: String(persona), status: 'done', content: 'done' });
  });
  vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });
  projectCwd = createTestTmpDir();
  writeChildWorkflow(projectCwd);
});

afterEach(() => {
  rmSync(projectCwd, { recursive: true, force: true });
});

async function run(config: WorkflowConfig, reportDirName: string) {
  return executeWorkflow(config, 'Finish the task', projectCwd, {
    projectCwd,
    provider: 'mock',
    reportDirName,
    outputMode: 'silent',
  });
}

describe('executeWorkflow exceeded guard', () => {
  it('does not persist exceeded when a child workflow_call exhausts max_steps and the parent stops at an exhausted step', async () => {
    const config: WorkflowConfig = {
      name: 'child-exceeded-to-visit-limit',
      maxSteps: 2,
      initialStep: 'replan',
      steps: [
        makeStep('replan', {
          persona: 'replan-worker',
          maxVisits: 1,
          rules: [makeRule('done', 'implement')],
        }),
        workflowCallStep([
          makeRule('COMPLETE', 'COMPLETE'),
          makeRule('ABORT', 'replan'),
        ]),
      ],
    };

    const result = await run(config, 'exceeded-guard-main');

    expect(result.success, result.reason).toBe(false);
    expect(result.abortKind, result.reason).toBe('loop_detected');
    expect(result.reason).toMatch(/Visit limit reached: step "replan"/);
    expect(result.exceeded).toBe(false);
    expect(result.exceededInfo).toBeUndefined();
  });

  it.each([
    ['ABORT -> ABORT rule', [makeRule('COMPLETE', 'COMPLETE'), makeRule('ABORT', 'ABORT')]],
    ['no ABORT rule', [makeRule('COMPLETE', 'COMPLETE')]],
  ])('keeps exceeded when the child iteration limit propagates through the parent (%s)', async (_label, rules) => {
    const config: WorkflowConfig = {
      name: 'child-exceeded-propagated',
      maxSteps: 2,
      initialStep: 'implement',
      steps: [workflowCallStep(rules)],
    };

    const result = await run(config, 'exceeded-guard-propagated');

    expect(result.success, result.reason).toBe(false);
    expect(result.abortKind, result.reason).toBe('iteration_limit');
    expect(result.exceeded).toBe(true);
    expect(result.exceededInfo).toMatchObject({
      currentStep: 'work',
      newMaxSteps: 4,
    });
  });

  it('does not persist exceeded when the parent maps the child abort to COMPLETE', async () => {
    const config: WorkflowConfig = {
      name: 'child-exceeded-to-complete',
      maxSteps: 2,
      initialStep: 'implement',
      steps: [
        workflowCallStep([
          makeRule('COMPLETE', 'COMPLETE'),
          makeRule('ABORT', 'COMPLETE'),
        ]),
      ],
    };

    const result = await run(config, 'exceeded-guard-complete');

    expect(result.success, result.reason).toBe(true);
    expect(result.abortKind, result.reason).toBeUndefined();
    expect(result.exceeded).toBe(false);
    expect(result.exceededInfo).toBeUndefined();
  });

  it('does not persist exceeded when a parallel step_error is selected before the child iteration limit', async () => {
    const config: WorkflowConfig = {
      name: 'child-exceeded-parallel-step-error',
      maxSteps: 2,
      initialStep: 'fan',
      steps: [
        makeStep('fan', {
          parallel: [
            makeStep('explode', {
              persona: 'explode-agent',
              rules: [makeRule('done', 'COMPLETE')],
            }),
            makeStep('delegate', {
              kind: 'workflow_call',
              call: 'child',
              rules: [
                makeRule('COMPLETE', 'COMPLETE'),
                makeRule('ABORT', 'ABORT'),
              ],
            }),
          ],
          rules: [makeRule('all("COMPLETE")', 'COMPLETE')],
        }),
      ],
    };

    const result = await run(config, 'exceeded-guard-parallel');

    expect(result.success, result.reason).toBe(false);
    expect(result.abortKind, result.reason).toBe('step_error');
    expect(result.exceeded).toBe(false);
    expect(result.exceededInfo).toBeUndefined();
  });
});

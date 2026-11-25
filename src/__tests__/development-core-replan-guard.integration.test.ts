import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowConfig } from '../core/models/index.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));
vi.mock('../infra/config/global/globalConfigCore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/config/global/globalConfigCore.js')>();
  return {
    ...actual,
    loadGlobalConfig: () => ({ ...actual.loadGlobalConfig(), enableBuiltinWorkflows: true }),
  };
});

import { WorkflowEngine } from '../core/workflow/index.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowLoader.js';
import { writePhaseReportFixture } from './helpers/phase-report-fixture.js';
import {
  cleanupWorkflowEngine, createTestTmpDir, makeResponse, makeStep, mockRunAgentSequence,
} from './engine-test-helpers.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const languages = ['ja', 'en'] as const;
let directory: string;
let engine: WorkflowEngine | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, onReportWritten) => {
    for (const report of step.outputContracts ?? []) {
      writePhaseReportFixture(context, report.name, 'Replan guard fixture report');
      onReportWritten?.(report.name);
    }
  });
  directory = createTestTmpDir();
});
afterEach(() => {
  if (engine) cleanupWorkflowEngine(engine);
  engine = undefined;
  rmSync(directory, { recursive: true, force: true });
});

function load(language: string, extraConfig = ''): WorkflowConfig {
  mkdirSync(resolve(directory, '.takt'), { recursive: true });
  writeFileSync(resolve(directory, '.takt/config.yaml'), `language: ${language}\n${extraConfig}`);
  return loadWorkflowFromFile(resolve(repoRoot, 'builtins', language, 'workflows', 'development-core.yaml'), directory);
}

function semanticLabel(config: WorkflowConfig, stepName: string, next: string): string {
  const rule = config.steps.find(step => step.name === stepName)?.rules?.find(item => item.next === next);
  if (rule?.condition.kind !== 'semantic') throw new Error(`Missing ${stepName} -> ${next} rule`);
  return rule.condition.label;
}

/** Shipped graph and loop guards; agent execution is replaced by the mock provider. */
function start(config: WorkflowConfig): WorkflowEngine {
  engine = new WorkflowEngine({
    ...config,
    maxSteps: 60,
    initialStep: 'replan',
    steps: config.steps.map(step => makeStep(step.name, {
      rules: step.rules,
      outputContracts: step.outputContracts,
      maxVisits: step.maxVisits,
      stopOnRepeatedVerdict: step.stopOnRepeatedVerdict,
    })),
  }, directory, 'Finish the task', {
    projectCwd: directory,
    provider: 'mock',
    model: 'mock-model',
    reportDirName: 'reports',
  });
  return engine;
}

/** Each step entered yields one response and one judged label, in route order. */
function script(labels: string[]): void {
  mockRunAgentSequence(labels.map(() => makeResponse({ content: 'Recorded the current state.' })));
  for (const label of labels) {
    vi.mocked(runStatusJudgmentPhase).mockResolvedValueOnce({ label, method: 'phase3_tag' });
  }
}

describe('development-core stops laps that make no progress', () => {
  it.each(languages)('%s: the independent review staying BLOCKED stops at the second identical verdict', async (language) => {
    const config = load(language);
    const toImplement = semanticLabel(config, 'replan', 'implement');
    const implemented = semanticLabel(config, 'implement', 'peer-review');
    const blocked = semanticLabel(config, 'peer-review', 'replan');
    const lap = [toImplement, implemented, blocked];
    // Enough laps that only a guard, not the script running out, ends the run.
    script([...lap, ...lap, ...lap, ...lap, ...lap, ...lap]);
    const stepStarts: string[] = [];
    const abortReasons: string[] = [];
    const run = start(config);
    run.on('step:start', (step) => stepStarts.push(step.name));
    run.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const result = await run.run();

    expect(result.status).toBe('aborted');
    expect(stepStarts).toEqual(['replan', 'implement', 'peer-review', 'replan', 'implement', 'peer-review']);
    expect(abortReasons).toEqual([expect.stringMatching(/peer-review.*same verdict.*twice/)]);
  });

  it.each(languages)('%s: replan stops at its visit limit, which config.yaml can change', async (language) => {
    const config = load(language, 'workflow_overrides:\n  steps:\n    replan:\n      max_visits: 2\n');
    const toImplement = semanticLabel(config, 'replan', 'implement');
    const needsReplan = semanticLabel(config, 'implement', 'replan');
    script([toImplement, needsReplan, toImplement, needsReplan, toImplement, needsReplan]);
    const stepStarts: string[] = [];
    const abortReasons: string[] = [];
    const run = start(config);
    run.on('step:start', (step) => stepStarts.push(step.name));
    run.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const result = await run.run();

    expect(result.status).toBe('aborted');
    expect(stepStarts).toEqual(['replan', 'implement', 'replan', 'implement']);
    expect(abortReasons).toEqual([expect.stringMatching(/replan.*max_visits: 2/)]);
  });
});

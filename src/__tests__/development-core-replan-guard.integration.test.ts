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
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfigCore.js';
import { writePhaseReportFixture } from './helpers/phase-report-fixture.js';
import {
  cleanupWorkflowEngine, createTestTmpDir, makeResponse, makeRule, makeStep, mockRunAgentSequence,
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

type Placement = 'root' | 'workflow_call child';
const placements: Placement[] = ['root', 'workflow_call child'];
const cases = languages.flatMap(language => placements.map(placement => ({ language, placement })));

/**
 * Shipped graph and loop guards; agent execution is replaced by the mock provider.
 * As a workflow_call child it runs the way taktdash-change runs it: in its own engine under a caller step.
 */
function start(config: WorkflowConfig, placement: Placement): WorkflowEngine {
  const replanReport = config.steps.find(step => step.name === 'replan')?.outputContracts?.[0];
  if (!replanReport) throw new Error('Missing replan report');
  const core: WorkflowConfig = {
    ...config,
    maxSteps: 60,
    initialStep: 'replan',
    steps: config.steps.map(step => makeStep(step.name, {
      rules: step.rules,
      // The real peer-review child writes review-resolution.md, which the loop-monitor judge reads.
      outputContracts: step.name === 'peer-review'
        ? [{ ...replanReport, name: 'review-resolution.md' }]
        : step.outputContracts,
      maxVisits: step.maxVisits,
    })),
  };
  const caller: WorkflowConfig = {
    name: 'caller',
    initialStep: 'develop',
    maxSteps: 60,
    steps: [makeStep('develop', {
      kind: 'workflow_call',
      call: 'development-core',
      rules: [makeRule('COMPLETE', 'COMPLETE'), makeRule('ABORT', 'ABORT')],
    })],
  };
  engine = new WorkflowEngine(placement === 'root' ? core : caller, directory, 'Finish the task', {
    projectCwd: directory,
    provider: 'mock',
    model: 'mock-model',
    reportDirName: 'reports',
    workflowCallResolver: () => core,
  });
  return engine;
}

/** A judged label for one step entered, or the loop-monitor judge's choice between two steps. */
type Turn = { label: string } | { judge: string };

/** Mocks the agent and status judgment for each turn, in route order. */
function script(turns: Turn[]): void {
  mockRunAgentSequence(turns.map(turn => 'judge' in turn
    ? makeResponse({ content: JSON.stringify({ content: 'Compared the last two review results.' }) })
    : makeResponse({ content: 'Recorded the current state.' })));
  for (const turn of turns) {
    const label = 'judge' in turn ? turn.judge : turn.label;
    vi.mocked(runStatusJudgmentPhase).mockResolvedValueOnce({ label, method: 'phase3_tag' });
  }
}

function judgeLabel(config: WorkflowConfig, next: string, index: number): string {
  const monitor = config.loopMonitors?.find(item => item.cycle.join(',') === 'replan,peer-review');
  const rule = monitor?.judge.rules.filter(item => item.next === next)[index];
  if (rule?.condition.kind !== 'semantic') throw new Error(`Missing replan/peer-review judge rule -> ${next}`);
  return rule.condition.label;
}

async function runAndRecord(config: WorkflowConfig, placement: Placement) {
  const stepStarts: string[] = [];
  const abortReasons: string[] = [];
  const run = start(config, placement);
  run.on('step:start', (step) => stepStarts.push(step.name));
  run.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
  const result = await run.run();
  const judges = stepStarts.filter(name => name.startsWith('_loop_judge_'));
  return {
    result,
    stepStarts: stepStarts.filter(name => name !== 'develop' && !judges.includes(name)),
    judges,
    abortReasons,
  };
}

describe('development-core stops laps that make no progress', () => {
  it.each(cases)('$language $placement: the review returning BLOCKED twice goes to the judge, which stops on the same findings', async ({ language, placement }) => {
    const config = load(language);
    const lap: Turn[] = [
      { label: semanticLabel(config, 'replan', 'implement') },
      { label: semanticLabel(config, 'implement', 'peer-review') },
      { label: semanticLabel(config, 'peer-review', 'replan') },
    ];
    // 同じ指摘が新しい差分なしに繰り返されている
    script([...lap, ...lap, { judge: judgeLabel(config, 'ABORT', 0) }, ...lap, ...lap]);

    const { result, stepStarts, judges } = await runAndRecord(config, placement);

    expect(result.status).toBe('aborted');
    expect(stepStarts).toEqual(['replan', 'implement', 'peer-review', 'replan', 'implement', 'peer-review']);
    expect(judges).toEqual(['_loop_judge_replan_peer-review']);
  });

  it.each(cases)('$language $placement: new findings keep the lap going until replan reaches max_visits 4', async ({ language, placement }) => {
    const config = load(language);
    const lap: Turn[] = [
      { label: semanticLabel(config, 'replan', 'implement') },
      { label: semanticLabel(config, 'implement', 'peer-review') },
      { label: semanticLabel(config, 'peer-review', 'replan') },
    ];
    // 新しい再計画でレビュー指摘を解消できる具体的な差分・検証結果がある
    const newFindings: Turn = { judge: judgeLabel(config, 'replan', 1) };
    script([...lap, ...lap, newFindings, ...lap, ...lap, newFindings, ...lap, ...lap]);

    const { result, stepStarts, judges, abortReasons } = await runAndRecord(config, placement);

    expect(result.status).toBe('aborted');
    expect(judges).toHaveLength(2);
    expect(stepStarts).toEqual([1, 2, 3, 4].flatMap(() => ['replan', 'implement', 'peer-review']));
    expect(abortReasons).toContainEqual(expect.stringMatching(/replan" already completed 4 times \(max_visits: 4\)/));
  });

  it.each(cases)('$language $placement: replan stops at its visit limit, which config.yaml can change', async ({ language, placement }) => {
    const config = load(language, 'workflow_overrides:\n  steps:\n    replan:\n      max_visits: 2\n');
    const toImplement = { label: semanticLabel(config, 'replan', 'implement') };
    const needsReplan = { label: semanticLabel(config, 'implement', 'replan') };
    script([toImplement, needsReplan, toImplement, needsReplan, toImplement, needsReplan]);

    const { result, stepStarts, abortReasons } = await runAndRecord(config, placement);

    expect(result.status).toBe('aborted');
    expect(stepStarts).toEqual(['replan', 'implement', 'replan', 'implement']);
    expect(abortReasons).toContainEqual(expect.stringMatching(/replan.*max_visits: 2/));
  });

  it.each(languages)('%s: the project config max_visits wins over the global one', async (language) => {
    writeFileSync(
      resolve(process.env.TAKT_CONFIG_DIR!, 'config.yaml'),
      'workflow_overrides:\n  steps:\n    replan:\n      max_visits: 1\n',
    );
    invalidateGlobalConfigCache();
    const config = load(language, 'workflow_overrides:\n  steps:\n    replan:\n      max_visits: 2\n');
    expect(config.steps.find(step => step.name === 'replan')?.maxVisits).toBe(2);
    const toImplement = { label: semanticLabel(config, 'replan', 'implement') };
    const needsReplan = { label: semanticLabel(config, 'implement', 'replan') };
    script([toImplement, needsReplan, toImplement, needsReplan, toImplement, needsReplan]);

    const { stepStarts } = await runAndRecord(config, 'root');

    expect(stepStarts).toEqual(['replan', 'implement', 'replan', 'implement']);
  });
});

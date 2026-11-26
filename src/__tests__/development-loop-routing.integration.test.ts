import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowConfig } from '../core/models/index.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));
// builtin の workflow_call 解決はグローバル設定の enable_builtin_workflows に従う。
// 実環境の設定に依存させず、配布定義のグラフを解決できる状態にする。
vi.mock('../infra/config/global/globalConfigCore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/config/global/globalConfigCore.js')>();
  return {
    ...actual,
    loadGlobalConfig: () => ({ ...actual.loadGlobalConfig(), enableBuiltinWorkflows: true }),
  };
});

import { WorkflowEngine } from '../core/workflow/index.js';
import { CycleDetector } from '../core/workflow/engine/cycle-detector.js';
import { determineRuleTransition } from '../core/workflow/engine/transitions.js';
import { formatWorkflowRuleCondition } from '../core/models/workflow-rule-condition.js';
import { validateWorkflowReportReferences } from '../core/workflow/instruction/report-reference-validation.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { writePhaseReportFixture } from './helpers/phase-report-fixture.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { createWorkflowCallResolver, createWorkflowExecutionContext } from '../features/tasks/execute/workflowExecutionContext.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowLoader.js';
import {
  cleanupWorkflowEngine, createTestTmpDir, makeResponse, makeStep, mockRunAgentSequence,
} from './engine-test-helpers.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const implementations = ['development-implement', 'development-implement-dynamic', 'development-implement-team'];
const remediations = ['development-remediation', 'development-remediation-dynamic', 'development-remediation-team', 'review-remediation'];
const variants = (names: string[]) => (['ja', 'en'] as const).flatMap(language => names.map(name => ({ language, name })));
let directory: string;
let engine: WorkflowEngine | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, onReportWritten) => {
    for (const report of step.outputContracts ?? []) {
      writePhaseReportFixture(context, report.name, 'Current routing fixture report');
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

function load(language: string, name: string): WorkflowConfig {
  const resourceRoot = resolve(repoRoot, 'builtins', language);
  mkdirSync(resolve(directory, '.takt'), { recursive: true });
  writeFileSync(resolve(directory, '.takt/config.yaml'), `language: ${language}\n`);
  return loadWorkflowFromFile(resolve(resourceRoot, 'workflows', `${name}.yaml`), directory);
}

function resolverFor(config: WorkflowConfig) {
  return createWorkflowCallResolver(createWorkflowExecutionContext(config, directory));
}

function replannerWarnings(config: WorkflowConfig, resolver = resolverFor(config)) {
  return validateWorkflowReportReferences(config, resolver, { projectCwd: directory, lookupCwd: directory })
    .filter(diagnostic => diagnostic.level === 'warning'
      && /step "fix-replan" references /.test(diagnostic.message))
    .map(diagnostic => diagnostic.message);
}

function start(config: WorkflowConfig, initialStep: string, options: Pick<WorkflowEngineOptions, 'interactive' | 'onUserInput'> = {}): void {
  // Keep the shipped graph and return contract; replace agent execution details only.
  engine = new WorkflowEngine({
    ...config,
    initialStep,
    steps: config.steps.map(step => makeStep(step.name, { rules: step.rules, outputContracts: step.outputContracts })),
  }, directory, 'Complete required work without losing the accepted contract', {
    projectCwd: directory,
    provider: 'mock',
    model: 'mock-model',
    reportDirName: 'reports',
    ...options,
  });
}

async function execute(config: WorkflowConfig, stepName: string, ruleIndex: number) {
  const rule = config.steps.find(step => step.name === stepName)?.rules?.[ruleIndex];
  if (rule?.condition.kind !== 'semantic' || !engine) throw new Error('Missing semantic rule or engine');
  mockRunAgentSequence([makeResponse({ content: 'Recorded current work and remaining evidence.' })]);
  vi.mocked(runStatusJudgmentPhase).mockResolvedValueOnce({ label: rule.condition.label, method: 'phase3_tag' });
  return engine.runSingleIteration();
}

describe('shipped development completion and remediation routes', () => {
  it.each(variants(['development-core', 'simple-core', 'simple']))('$language/$name returns blocked test creation to planning before it resumes', async ({ language, name }) => {
    const config = load(language, name);
    for (const [ruleIndex, nextStep] of [[0, 'implement'], [1, 'implement'], [2, 'plan']] as const) {
      start(config, 'write_tests');
      expect((await execute(config, 'write_tests', ruleIndex)).nextStep).toBe(nextStep);
    }
    expect((await execute(config, 'plan', 0)).nextStep).toBe('write_tests');
    const writeTests = config.steps.find(step => step.name === 'write_tests');
    if (!writeTests) throw new Error('Missing write_tests step');
    expect(determineRuleTransition(writeTests, 3)).toMatchObject({ nextStep: 'write_tests', requiresUserInput: true });
  });

  it.each(variants(implementations))('$language/$name sends executable incompleteness to reimplement once, then hands remaining gaps to planning', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'implement');
    const pending = await execute(config, 'implement', 2);
    expect(pending.nextStep).toBe('reimplement');
    expect(pending.isComplete).toBe(false);
    expect(pending.returnValue).toBeUndefined();
    const remaining = await execute(config, 'reimplement', 2);
    expect(remaining).toMatchObject({ isComplete: true, returnValue: 'need_replan' });
    expect(remaining.nextStep).toBe('COMPLETE');
    start(config, 'reimplement');
    expect((await execute(config, 'reimplement', 0)).nextStep).toBe('COMPLETE');
  });

  it.each(variants(implementations))('$language/$name returns only an invalid plan to its caller', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'implement');
    expect((await execute(config, 'implement', 3)).returnValue).toBe('need_replan');
    start(config, 'reimplement');
    expect((await execute(config, 'reimplement', 3)).returnValue).toBe('need_replan');
  });

  it.each(variants(implementations))('$language/$name passes an external blocker to planning at either implementation step', async ({ language, name }) => {
    const config = load(language, name);
    for (const stepName of ['implement', 'reimplement']) {
      start(config, stepName);
      const result = await execute(config, stepName, 4);
      expect(result).toMatchObject({ isComplete: true, returnValue: 'need_replan' });
      expect(result.nextStep).toBe('COMPLETE');
    }
  });

  it.each(variants(implementations))('$language/$name collects an available user answer and resumes the same implementation step', async ({ language, name }) => {
    const config = load(language, name);
    for (const stepName of ['implement', 'reimplement']) {
      const implementation = config.steps.find(step => step.name === stepName);
      if (!implementation) throw new Error(`Missing ${stepName} step`);
      expect(determineRuleTransition(implementation, 5)).toMatchObject({ nextStep: stepName, requiresUserInput: true });
      const onUserInput = vi.fn().mockResolvedValueOnce('Use the requested export target.');
      start(config, stepName, { interactive: true, onUserInput });
      const waiting = await execute(config, stepName, 5);
      expect(waiting).toMatchObject({ nextStep: stepName, isComplete: false });
      expect(waiting.returnValue).toBeUndefined();
      expect(onUserInput).toHaveBeenCalledOnce();
      expect((await execute(config, stepName, 0)).nextStep).toBe('COMPLETE');
    }
  });

  it.each(variants(implementations))('$language/$name passes a headless external blocker to planning without requesting input', async ({ language, name }) => {
    const config = load(language, name);
    for (const stepName of ['implement', 'reimplement']) {
      const onUserInput = vi.fn();
      start(config, stepName, { interactive: false, onUserInput });
      const result = await execute(config, stepName, 4);
      expect(result).toMatchObject({ isComplete: true, returnValue: 'need_replan' });
      expect(result.nextStep).toBe('COMPLETE');
      expect(onUserInput).not.toHaveBeenCalled();
    }
  });

  it.each(variants(['development-core']))('$language routes implementation workflow results through the planning handoffs', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'implement');
    expect((await execute(config, 'implement', 0)).nextStep).toBe('peer-review');
    start(config, 'implement');
    expect((await execute(config, 'implement', 1)).nextStep).toBe('replan');
    start(config, 'implement');
    expect((await execute(config, 'implement', 2)).nextStep).toBe('replan');
    start(config, 'replan');
    expect((await execute(config, 'replan', 0)).nextStep).toBe('implement');
    start(config, 'replan');
    expect((await execute(config, 'replan', 1)).nextStep).toBe('peer-review');
    start(config, 'replan');
    expect((await execute(config, 'replan', 2)).nextStep).toBe('ABORT');
  });

  it.each(['ja', 'en'] as const)('%s: passes the caller-supplied fix replan instruction into the resolved remediation workflow', (language) => {
    const resourceRoot = resolve(repoRoot, 'builtins', language);
    const workflowDirectory = resolve(directory, '.takt/workflows');
    const instructionDirectory = resolve(directory, '.takt/facets/instructions');
    mkdirSync(workflowDirectory, { recursive: true });
    mkdirSync(instructionDirectory, { recursive: true });
    writeFileSync(resolve(directory, '.takt/config.yaml'), `language: ${language}\n`);
    const instruction = 'Maintain the requirement scenario while revising the repair plan for this fixture.';
    writeFileSync(resolve(instructionDirectory, 'scenario-replan-fixture.md'), instruction);
    const parentPath = resolve(workflowDirectory, 'parent.yaml');
    writeFileSync(parentPath, `name: parent
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: development-remediation
    args:
      fix_replan_instruction: scenario-replan-fixture
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    const parent = loadWorkflowFromFile(parentPath, directory, { resourceRoot });
    const call = parent.steps.find(step => step.kind === 'workflow_call');
    if (call?.kind !== 'workflow_call') throw new Error('Missing fixture workflow call');
    expect(call.args?.fix_replan_instruction).toBe('scenario-replan-fixture');

    const child = resolverFor(parent)({ parentWorkflow: parent, step: call, projectCwd: directory, lookupCwd: directory });

    expect(child?.steps.map(step => step.instruction)).toEqual(
      expect.arrayContaining([expect.stringContaining(instruction)]),
    );
  });

  it.each(['ja', 'en'] as const)('%s: builtin remediation graphs resolve their report references', (language) => {
    const resourceRoot = resolve(repoRoot, 'builtins', language);
    const workflowDirectory = resolve(resourceRoot, 'workflows');
    const workflowFiles = readdirSync(workflowDirectory).filter(file => file.endsWith('.yaml'));
    const invalidReferences: string[] = [];
    for (const file of workflowFiles) {
      const config = load(language, file.slice(0, -'.yaml'.length));
      invalidReferences.push(...replannerWarnings(config).map(message => `${file}: ${message}`));
    }
    expect(invalidReferences).toEqual([]);
  });

  it.each(variants(remediations))(
    '$language/$name counts every connected repair branch back into fix as one monitored round', ({ language, name }) => {
      const config = load(language, name);
      const monitor = config.loopMonitors?.find(item => item.cycle.length === 1 && item.cycle[0] === 'fix');
      if (!monitor) throw new Error('Missing one-step fix monitor');
      const ignored = new Set(monitor.ignoreSteps ?? []);
      // 各回は、ある step の完了から次の step の完了へ実際の遷移でつなぐ。
      // 往復はすべて fix へ戻り、中間 step は ignore_steps 側にだけ現れる。
      const rounds: string[][] = [
        ['fix', 'fix-replan', 'fix'],
        ['fix', 'fix-verifier', 'verification-replan', 'fix'],
        ['fix', 'fix-verifier', 'fix-retry', 'verification-replan', 'fix'],
      ];
      for (const round of rounds) {
        const detector = new CycleDetector(config.loopMonitors);
        for (let count = 1; count <= monitor.threshold; count++) {
          for (const step of round.slice(1, -1)) expect(ignored.has(step)).toBe(true);
          let triggered = false;
          for (let index = 0; index + 1 < round.length; index++) {
            triggered = detector.recordAndCheck(round[index]!, round[index + 1]!).triggered || triggered;
          }
          expect(triggered).toBe(count === monitor.threshold);
        }
      }
    },
  );

  it.each(variants(remediations))(
    '$language/$name does not count leaving the repair loop as a new round', ({ language, name }) => {
      const config = load(language, name);
      const monitor = config.loopMonitors?.find(item => item.cycle.length === 1 && item.cycle[0] === 'fix');
      if (!monitor) throw new Error('Missing one-step fix monitor');
      const detector = new CycleDetector(config.loopMonitors);
      for (let round = 1; round <= monitor.threshold + 1; round++) {
        // 修正が完了して検証・完了へ抜ける遷移は、同じ論理サイクルへ戻る再入ではない。
        expect(detector.recordAndCheck('fix', 'fix-verifier').triggered).toBe(false);
        expect(detector.recordAndCheck('fix-verifier', 'COMPLETE').triggered).toBe(false);
      }
    },
  );

  it.each(['ja', 'en'] as const)(
    '%s: peer-review re-planning inside its own loop never hands a partial justification to a child-owned step', (language) => {
      const config = load(language, 'peer-review');
      const monitor = config.loopMonitors?.find(item => item.cycle[0] === 'reviewers' && item.cycle.at(-1) === 'remediation');
      if (!monitor) throw new Error('Missing reviewers → remediation monitor');
      const replanRule = monitor.judge.rules.find(rule => rule.next === 'remediation');
      expect(replanRule?.condition.kind).toBe('semantic');
      // remediation は remediation_workflow（既定 development-remediation-dynamic）の子engine が
      // 所有する。子engine の step は親の CycleDetector 履歴にも judge の入力にも入らないため、
      // 同じ原因・同じ証拠を再計画してもこのループからは見直せない。子へ渡す再計画より先に、
      // 子ループの無進展をループ停止として扱う ABORT 経路を置く。
      const abortRules = monitor.judge.rules.filter(rule => rule.next === 'ABORT');
      const childOwnedAbort = abortRules.filter(rule =>
        formatWorkflowRuleCondition(rule.condition).includes('remediation_workflow'));
      expect(abortRules.length).toBeGreaterThanOrEqual(2);
      expect(childOwnedAbort).toHaveLength(1);
      const abortIndex = monitor.judge.rules.indexOf(childOwnedAbort[0]!);
      const replanIndex = monitor.judge.rules.indexOf(replanRule!);
      // ABORT は再計画の規則より後ろ、かつ最後の打開手段なし ABORT より前にある。
      expect(abortIndex).toBeGreaterThan(replanIndex);
      expect(abortIndex).toBeLessThan(monitor.judge.rules.length - 1);
    },
  );

  it.each(variants(['merge-review-fix-simple']))(
    '$language/$name leaves the nested review remediation to the child monitor', ({ language, name }) => {
      const config = load(language, name);
      const review = config.steps.find(step => step.name === 'review');
      if (review?.kind !== 'workflow_call') throw new Error('Missing nested review call');
      // ここで解決できなければテストが空振りするため、明示的に失敗させる。
      const reviewFix = resolverFor(config)({ parentWorkflow: config, step: review, projectCwd: directory, lookupCwd: directory });
      if (!reviewFix) throw new Error('Missing review-fix-simple');
      expect(reviewFix.name).toBe('review-fix-simple');
      const peer = reviewFix.steps.find(step => step.name === 'reviewers');
      if (peer?.kind !== 'workflow_call') throw new Error('Missing peer-review call');
      const peerReview = resolverFor(reviewFix)({ parentWorkflow: reviewFix, step: peer, projectCwd: directory, lookupCwd: directory });
      expect(peerReview?.name).toBe('peer-review');
      const remediation = peerReview!.steps.find(step => step.name === 'remediation');
      if (remediation?.kind !== 'workflow_call') throw new Error('Missing remediation call');
      const child = resolverFor(peerReview!)({ parentWorkflow: peerReview!, step: remediation, projectCwd: directory, lookupCwd: directory });
      // 修正は review-remediation ではなく development-remediation-dynamic が担い、その内側の
      // fix 4 周 monitor が指摘の往復を監視する。review-remediation の 4 周 monitor は
      // review-fix-* 系（reviewer → final-gate → remediation）用で、この経路では走らない。
      expect(child?.name).toBe('development-remediation-dynamic');
      expect(child?.loopMonitors?.some(item => item.cycle[0] === 'fix')).toBe(true);
      expect(peerReview?.loopMonitors?.some(item => item.cycle[0] === 'reviewers')).toBe(true);
      // リポジトリ・同期・Caccia・CI は指定 PR に対する単一工程である。
      expect(config.loopMonitors ?? []).toHaveLength(0);
    },
  );
});

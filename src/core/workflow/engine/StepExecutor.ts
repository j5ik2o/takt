/**
 * Executes a single workflow step through the 3-phase model.
 *
 * Phase 1: Main agent execution (with tools)
 * Phase 2: Report output (Write-only, optional)
 * Phase 3: Status judgment (no tools, optional)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  WorkflowStep,
  WorkflowState,
  AgentResponse,
  Language,
} from '../../models/types.js';
import type { PhaseName } from '../types.js';
import { runAgent } from '../../../agents/runner.js';
import { InstructionBuilder, isReportObjectConfig } from '../instruction/InstructionBuilder.js';
import { needsStatusJudgmentPhase, runReportPhase, runStatusJudgmentPhase } from '../phase-runner.js';
import { detectMatchedRule } from '../evaluation/index.js';
import { incrementStepIteration, getPreviousOutput } from './state-manager.js';
import { createLogger } from '../../../shared/utils/index.js';
import type { OptionsBuilder } from './OptionsBuilder.js';

const log = createLogger('step-executor');

export interface StepExecutorDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly getCwd: () => string;
  readonly getProjectCwd: () => string;
  readonly getReportDir: () => string;
  readonly getLanguage: () => Language | undefined;
  readonly getInteractive: () => boolean;
  readonly getWorkflowSteps: () => ReadonlyArray<{ name: string; description?: string }>;
  readonly detectRuleIndex: (content: string, stepName: string) => number;
  readonly callAiJudge: (
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: { cwd: string }
  ) => Promise<number>;
  readonly onPhaseStart?: (step: WorkflowStep, phase: 1 | 2 | 3, phaseName: PhaseName, instruction: string) => void;
  readonly onPhaseComplete?: (step: WorkflowStep, phase: 1 | 2 | 3, phaseName: PhaseName, content: string, status: string, error?: string) => void;
}

export class StepExecutor {
  constructor(
    private readonly deps: StepExecutorDeps,
  ) {}

  /** Build Phase 1 instruction from template */
  buildInstruction(
    step: WorkflowStep,
    stepIteration: number,
    state: WorkflowState,
    task: string,
    maxIterations: number,
  ): string {
    const workflowSteps = this.deps.getWorkflowSteps();
    return new InstructionBuilder(step, {
      task,
      iteration: state.iteration,
      maxIterations,
      stepIteration,
      cwd: this.deps.getCwd(),
      projectCwd: this.deps.getProjectCwd(),
      userInputs: state.userInputs,
      previousOutput: getPreviousOutput(state),
      reportDir: join(this.deps.getProjectCwd(), this.deps.getReportDir()),
      language: this.deps.getLanguage(),
      interactive: this.deps.getInteractive(),
      workflowSteps,
      currentStepIndex: workflowSteps.findIndex(s => s.name === step.name),
    }).build();
  }

  /**
   * Execute a normal (non-parallel) step through all 3 phases.
   *
   * Returns the final response (with matchedRuleIndex if a rule matched)
   * and the instruction used for Phase 1.
   */
  async runNormalStep(
    step: WorkflowStep,
    state: WorkflowState,
    task: string,
    maxIterations: number,
    updateAgentSession: (agent: string, sessionId: string | undefined) => void,
    prebuiltInstruction?: string,
  ): Promise<{ response: AgentResponse; instruction: string }> {
    const stepIteration = prebuiltInstruction
      ? state.stepIterations.get(step.name) ?? 1
      : incrementStepIteration(state, step.name);
    const instruction = prebuiltInstruction ?? this.buildInstruction(step, stepIteration, state, task, maxIterations);
    const sessionKey = step.agent ?? step.name;
    log.debug('Running step', {
      step: step.name,
      agent: step.agent ?? '(none)',
      stepIteration,
      iteration: state.iteration,
      sessionId: state.agentSessions.get(sessionKey) ?? 'new',
    });

    // Phase 1: main execution (Write excluded if step has report)
    this.deps.onPhaseStart?.(step, 1, 'execute', instruction);
    const agentOptions = this.deps.optionsBuilder.buildAgentOptions(step);
    let response = await runAgent(step.agent, instruction, agentOptions);
    updateAgentSession(sessionKey, response.sessionId);
    this.deps.onPhaseComplete?.(step, 1, 'execute', response.content, response.status, response.error);

    const phaseCtx = this.deps.optionsBuilder.buildPhaseRunnerContext(state, updateAgentSession, this.deps.onPhaseStart, this.deps.onPhaseComplete);

    // Phase 2: report output (resume same session, Write only)
    if (step.report) {
      await runReportPhase(step, stepIteration, phaseCtx);
    }

    // Phase 3: status judgment (resume session, no tools, output status tag)
    let tagContent = '';
    if (needsStatusJudgmentPhase(step)) {
      tagContent = await runStatusJudgmentPhase(step, phaseCtx);
    }

    const match = await detectMatchedRule(step, response.content, tagContent, {
      state,
      cwd: this.deps.getCwd(),
      interactive: this.deps.getInteractive(),
      detectRuleIndex: this.deps.detectRuleIndex,
      callAiJudge: this.deps.callAiJudge,
    });
    if (match) {
      log.debug('Rule matched', { step: step.name, ruleIndex: match.index, method: match.method });
      response = { ...response, matchedRuleIndex: match.index, matchedRuleMethod: match.method };
    }

    state.stepOutputs.set(step.name, response);
    this.emitStepReports(step);
    return { response, instruction };
  }

  /** Emit step:report events for each report file that exists */
  emitStepReports(step: WorkflowStep): void {
    if (!step.report) return;
    const baseDir = join(this.deps.getProjectCwd(), this.deps.getReportDir());

    if (typeof step.report === 'string') {
      this.checkReportFile(step, baseDir, step.report);
    } else if (isReportObjectConfig(step.report)) {
      this.checkReportFile(step, baseDir, step.report.name);
    } else {
      // ReportConfig[] (array)
      for (const rc of step.report) {
        this.checkReportFile(step, baseDir, rc.path);
      }
    }
  }

  // Collects report file paths that exist (used by WorkflowEngine to emit events)
  private reportFiles: Array<{ step: WorkflowStep; filePath: string; fileName: string }> = [];

  /** Check if report file exists and collect for emission */
  private checkReportFile(step: WorkflowStep, baseDir: string, fileName: string): void {
    const filePath = join(baseDir, fileName);
    if (existsSync(filePath)) {
      this.reportFiles.push({ step, filePath, fileName });
    }
  }

  /** Drain collected report files (called by engine after step execution) */
  drainReportFiles(): Array<{ step: WorkflowStep; filePath: string; fileName: string }> {
    const files = this.reportFiles;
    this.reportFiles = [];
    return files;
  }

}

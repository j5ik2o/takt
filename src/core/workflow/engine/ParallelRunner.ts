/**
 * Executes parallel workflow steps concurrently and aggregates results.
 *
 * When onStream is provided, uses ParallelLogger to prefix each
 * sub-step's output with `[name]` for readable interleaved display.
 */

import type {
  WorkflowStep,
  WorkflowState,
  AgentResponse,
} from '../../models/types.js';
import { runAgent } from '../../../agents/runner.js';
import { ParallelLogger } from './parallel-logger.js';
import { needsStatusJudgmentPhase, runReportPhase, runStatusJudgmentPhase } from '../phase-runner.js';
import { detectMatchedRule } from '../evaluation/index.js';
import { incrementStepIteration } from './state-manager.js';
import { createLogger } from '../../../shared/utils/index.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';
import type { WorkflowEngineOptions, PhaseName } from '../types.js';

const log = createLogger('parallel-runner');

export interface ParallelRunnerDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly stepExecutor: StepExecutor;
  readonly engineOptions: WorkflowEngineOptions;
  readonly getCwd: () => string;
  readonly getReportDir: () => string;
  readonly getInteractive: () => boolean;
  readonly detectRuleIndex: (content: string, stepName: string) => number;
  readonly callAiJudge: (
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: { cwd: string }
  ) => Promise<number>;
  readonly onPhaseStart?: (step: WorkflowStep, phase: 1 | 2 | 3, phaseName: PhaseName, instruction: string) => void;
  readonly onPhaseComplete?: (step: WorkflowStep, phase: 1 | 2 | 3, phaseName: PhaseName, content: string, status: string, error?: string) => void;
}

export class ParallelRunner {
  constructor(
    private readonly deps: ParallelRunnerDeps,
  ) {}

  /**
   * Run a parallel step: execute all sub-steps concurrently, then aggregate results.
   * The aggregated output becomes the parent step's response for rules evaluation.
   */
  async runParallelStep(
    step: WorkflowStep,
    state: WorkflowState,
    task: string,
    maxIterations: number,
    updateAgentSession: (agent: string, sessionId: string | undefined) => void,
  ): Promise<{ response: AgentResponse; instruction: string }> {
    const subSteps = step.parallel!;
    const stepIteration = incrementStepIteration(state, step.name);
    log.debug('Running parallel step', {
      step: step.name,
      subSteps: subSteps.map(s => s.name),
      stepIteration,
    });

    // Create parallel logger for prefixed output (only when streaming is enabled)
    const parallelLogger = this.deps.engineOptions.onStream
      ? new ParallelLogger({
          subStepNames: subSteps.map((s) => s.name),
          parentOnStream: this.deps.engineOptions.onStream,
        })
      : undefined;

    const phaseCtx = this.deps.optionsBuilder.buildPhaseRunnerContext(state, updateAgentSession, this.deps.onPhaseStart, this.deps.onPhaseComplete);
    const ruleCtx = {
      state,
      cwd: this.deps.getCwd(),
      interactive: this.deps.getInteractive(),
      detectRuleIndex: this.deps.detectRuleIndex,
      callAiJudge: this.deps.callAiJudge,
    };

    // Run all sub-steps concurrently
    const subResults = await Promise.all(
      subSteps.map(async (subStep, index) => {
        const subIteration = incrementStepIteration(state, subStep.name);
        const subInstruction = this.deps.stepExecutor.buildInstruction(subStep, subIteration, state, task, maxIterations);

        // Phase 1: main execution (Write excluded if sub-step has report)
        const baseOptions = this.deps.optionsBuilder.buildAgentOptions(subStep);

        // Override onStream with parallel logger's prefixed handler (immutable)
        const agentOptions = parallelLogger
          ? { ...baseOptions, onStream: parallelLogger.createStreamHandler(subStep.name, index) }
          : baseOptions;

        const subSessionKey = subStep.agent ?? subStep.name;
        this.deps.onPhaseStart?.(subStep, 1, 'execute', subInstruction);
        const subResponse = await runAgent(subStep.agent, subInstruction, agentOptions);
        updateAgentSession(subSessionKey, subResponse.sessionId);
        this.deps.onPhaseComplete?.(subStep, 1, 'execute', subResponse.content, subResponse.status, subResponse.error);

        // Phase 2: report output for sub-step
        if (subStep.report) {
          await runReportPhase(subStep, subIteration, phaseCtx);
        }

        // Phase 3: status judgment for sub-step
        let subTagContent = '';
        if (needsStatusJudgmentPhase(subStep)) {
          subTagContent = await runStatusJudgmentPhase(subStep, phaseCtx);
        }

        const match = await detectMatchedRule(subStep, subResponse.content, subTagContent, ruleCtx);
        const finalResponse = match
          ? { ...subResponse, matchedRuleIndex: match.index, matchedRuleMethod: match.method }
          : subResponse;

        state.stepOutputs.set(subStep.name, finalResponse);
        this.deps.stepExecutor.emitStepReports(subStep);

        return { subStep, response: finalResponse, instruction: subInstruction };
      }),
    );

    // Print completion summary
    if (parallelLogger) {
      parallelLogger.printSummary(
        step.name,
        subResults.map((r) => ({
          name: r.subStep.name,
          condition: r.response.matchedRuleIndex != null && r.subStep.rules
            ? r.subStep.rules[r.response.matchedRuleIndex]?.condition
            : undefined,
        })),
      );
    }

    // Aggregate sub-step outputs into parent step's response
    const aggregatedContent = subResults
      .map((r) => `## ${r.subStep.name}\n${r.response.content}`)
      .join('\n\n---\n\n');

    const aggregatedInstruction = subResults
      .map((r) => r.instruction)
      .join('\n\n');

    // Parent step uses aggregate conditions, so tagContent is empty
    const match = await detectMatchedRule(step, aggregatedContent, '', ruleCtx);

    const aggregatedResponse: AgentResponse = {
      agent: step.name,
      status: 'done',
      content: aggregatedContent,
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
    };

    state.stepOutputs.set(step.name, aggregatedResponse);
    this.deps.stepExecutor.emitStepReports(step);
    return { response: aggregatedResponse, instruction: aggregatedInstruction };
  }

}

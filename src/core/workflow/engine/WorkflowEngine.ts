/**
 * Workflow execution engine.
 *
 * Orchestrates the main execution loop: step transitions, abort handling,
 * loop detection, and iteration limits. Delegates step execution to
 * StepExecutor (normal steps) and ParallelRunner (parallel steps).
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  WorkflowConfig,
  WorkflowState,
  WorkflowStep,
  AgentResponse,
} from '../../models/types.js';
import { COMPLETE_STEP, ABORT_STEP, ERROR_MESSAGES } from '../constants.js';
import type { WorkflowEngineOptions } from '../types.js';
import { determineNextStepByRules } from './transitions.js';
import { LoopDetector } from './loop-detector.js';
import { handleBlocked } from './blocked-handler.js';
import {
  createInitialState,
  addUserInput as addUserInputToState,
  incrementStepIteration,
} from './state-manager.js';
import { generateReportDir, getErrorMessage, createLogger } from '../../../shared/utils/index.js';
import { OptionsBuilder } from './OptionsBuilder.js';
import { StepExecutor } from './StepExecutor.js';
import { ParallelRunner } from './ParallelRunner.js';

const log = createLogger('engine');

// Re-export types for backward compatibility
export type {
  WorkflowEvents,
  UserInputRequest,
  IterationLimitRequest,
  SessionUpdateCallback,
  IterationLimitCallback,
  WorkflowEngineOptions,
} from '../types.js';
export { COMPLETE_STEP, ABORT_STEP } from '../constants.js';

/** Workflow engine for orchestrating agent execution */
export class WorkflowEngine extends EventEmitter {
  private state: WorkflowState;
  private config: WorkflowConfig;
  private projectCwd: string;
  private cwd: string;
  private task: string;
  private options: WorkflowEngineOptions;
  private loopDetector: LoopDetector;
  private reportDir: string;
  private abortRequested = false;

  private readonly optionsBuilder: OptionsBuilder;
  private readonly stepExecutor: StepExecutor;
  private readonly parallelRunner: ParallelRunner;
  private readonly detectRuleIndex: (content: string, stepName: string) => number;
  private readonly callAiJudge: (
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: { cwd: string }
  ) => Promise<number>;

  constructor(config: WorkflowConfig, cwd: string, task: string, options: WorkflowEngineOptions) {
    super();
    this.config = config;
    this.projectCwd = options.projectCwd;
    this.cwd = cwd;
    this.task = task;
    this.options = options;
    this.loopDetector = new LoopDetector(config.loopDetection);
    this.reportDir = `.takt/reports/${generateReportDir(task)}`;
    this.ensureReportDirExists();
    this.validateConfig();
    this.state = createInitialState(config, options);
    this.detectRuleIndex = options.detectRuleIndex ?? (() => {
      throw new Error('detectRuleIndex is required for rule evaluation');
    });
    this.callAiJudge = options.callAiJudge ?? (async () => {
      throw new Error('callAiJudge is required for rule evaluation');
    });

    // Initialize composed collaborators
    this.optionsBuilder = new OptionsBuilder(
      options,
      () => this.cwd,
      () => this.projectCwd,
      (agent) => this.state.agentSessions.get(agent),
      () => this.reportDir,
      () => this.options.language,
    );

    this.stepExecutor = new StepExecutor({
      optionsBuilder: this.optionsBuilder,
      getCwd: () => this.cwd,
      getProjectCwd: () => this.projectCwd,
      getReportDir: () => this.reportDir,
      getLanguage: () => this.options.language,
      getInteractive: () => this.options.interactive === true,
      getWorkflowSteps: () => this.config.steps.map(s => ({ name: s.name, description: s.description })),
      detectRuleIndex: this.detectRuleIndex,
      callAiJudge: this.callAiJudge,
      onPhaseStart: (step, phase, phaseName, instruction) => {
        this.emit('phase:start', step, phase, phaseName, instruction);
      },
      onPhaseComplete: (step, phase, phaseName, content, phaseStatus, error) => {
        this.emit('phase:complete', step, phase, phaseName, content, phaseStatus, error);
      },
    });

    this.parallelRunner = new ParallelRunner({
      optionsBuilder: this.optionsBuilder,
      stepExecutor: this.stepExecutor,
      engineOptions: this.options,
      getCwd: () => this.cwd,
      getReportDir: () => this.reportDir,
      getInteractive: () => this.options.interactive === true,
      detectRuleIndex: this.detectRuleIndex,
      callAiJudge: this.callAiJudge,
      onPhaseStart: (step, phase, phaseName, instruction) => {
        this.emit('phase:start', step, phase, phaseName, instruction);
      },
      onPhaseComplete: (step, phase, phaseName, content, phaseStatus, error) => {
        this.emit('phase:complete', step, phase, phaseName, content, phaseStatus, error);
      },
    });

    log.debug('WorkflowEngine initialized', {
      workflow: config.name,
      steps: config.steps.map(s => s.name),
      initialStep: config.initialStep,
      maxIterations: config.maxIterations,
    });
  }

  /** Ensure report directory exists (always in project root, not clone) */
  private ensureReportDirExists(): void {
    const reportDirPath = join(this.projectCwd, this.reportDir);
    if (!existsSync(reportDirPath)) {
      mkdirSync(reportDirPath, { recursive: true });
    }

    // Worktree mode: create symlink so agents can access reports via relative path
    if (this.cwd !== this.projectCwd) {
      const cwdReportsDir = join(this.cwd, '.takt', 'reports');
      if (!existsSync(cwdReportsDir)) {
        mkdirSync(join(this.cwd, '.takt'), { recursive: true });
        symlinkSync(
          join(this.projectCwd, '.takt', 'reports'),
          cwdReportsDir,
        );
      }
    }
  }

  /** Validate workflow configuration at construction time */
  private validateConfig(): void {
    const initialStep = this.config.steps.find((s) => s.name === this.config.initialStep);
    if (!initialStep) {
      throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(this.config.initialStep));
    }

    const stepNames = new Set(this.config.steps.map((s) => s.name));
    stepNames.add(COMPLETE_STEP);
    stepNames.add(ABORT_STEP);

    for (const step of this.config.steps) {
      if (step.rules) {
        for (const rule of step.rules) {
          if (rule.next && !stepNames.has(rule.next)) {
            throw new Error(
              `Invalid rule in step "${step.name}": target step "${rule.next}" does not exist`
            );
          }
        }
      }
    }
  }

  /** Get current workflow state */
  getState(): WorkflowState {
    return { ...this.state };
  }

  /** Add user input */
  addUserInput(input: string): void {
    addUserInputToState(this.state, input);
  }

  /** Update working directory */
  updateCwd(newCwd: string): void {
    this.cwd = newCwd;
  }

  /** Get current working directory */
  getCwd(): string {
    return this.cwd;
  }

  /** Get project root directory (where .takt/ lives) */
  getProjectCwd(): string {
    return this.projectCwd;
  }

  /** Request graceful abort: interrupt running queries and stop after current step */
  abort(): void {
    if (this.abortRequested) return;
    this.abortRequested = true;
    log.info('Abort requested');
  }

  /** Check if abort has been requested */
  isAbortRequested(): boolean {
    return this.abortRequested;
  }

  /** Get step by name */
  private getStep(name: string): WorkflowStep {
    const step = this.config.steps.find((s) => s.name === name);
    if (!step) {
      throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(name));
    }
    return step;
  }

  /** Update agent session and notify via callback if session changed */
  private updateAgentSession(agent: string, sessionId: string | undefined): void {
    if (!sessionId) return;

    const previousSessionId = this.state.agentSessions.get(agent);
    this.state.agentSessions.set(agent, sessionId);

    if (this.options.onSessionUpdate && sessionId !== previousSessionId) {
      this.options.onSessionUpdate(agent, sessionId);
    }
  }

  /** Emit step:report events collected by StepExecutor */
  private emitCollectedReports(): void {
    for (const { step, filePath, fileName } of this.stepExecutor.drainReportFiles()) {
      this.emit('step:report', step, filePath, fileName);
    }
  }

  /** Run a single step (delegates to ParallelRunner if step has parallel sub-steps) */
  private async runStep(step: WorkflowStep, prebuiltInstruction?: string): Promise<{ response: AgentResponse; instruction: string }> {
    const updateSession = this.updateAgentSession.bind(this);
    let result: { response: AgentResponse; instruction: string };

    if (step.parallel && step.parallel.length > 0) {
      result = await this.parallelRunner.runParallelStep(
        step, this.state, this.task, this.config.maxIterations, updateSession,
      );
    } else {
      result = await this.stepExecutor.runNormalStep(
        step, this.state, this.task, this.config.maxIterations, updateSession, prebuiltInstruction,
      );
    }

    this.emitCollectedReports();
    return result;
  }

  /**
   * Determine next step for a completed step using rules-based routing.
   */
  private resolveNextStep(step: WorkflowStep, response: AgentResponse): string {
    if (response.matchedRuleIndex != null && step.rules) {
      const nextByRules = determineNextStepByRules(step, response.matchedRuleIndex);
      if (nextByRules) {
        return nextByRules;
      }
    }

    throw new Error(`No matching rule found for step "${step.name}" (status: ${response.status})`);
  }

  /** Build instruction (public, used by workflowExecution.ts for logging) */
  buildInstruction(step: WorkflowStep, stepIteration: number): string {
    return this.stepExecutor.buildInstruction(
      step, stepIteration, this.state, this.task, this.config.maxIterations,
    );
  }

  /** Run the workflow to completion */
  async run(): Promise<WorkflowState> {
    while (this.state.status === 'running') {
      if (this.abortRequested) {
        this.state.status = 'aborted';
        this.emit('workflow:abort', this.state, 'Workflow interrupted by user (SIGINT)');
        break;
      }

      if (this.state.iteration >= this.config.maxIterations) {
        this.emit('iteration:limit', this.state.iteration, this.config.maxIterations);

        if (this.options.onIterationLimit) {
          const additionalIterations = await this.options.onIterationLimit({
            currentIteration: this.state.iteration,
            maxIterations: this.config.maxIterations,
            currentStep: this.state.currentStep,
          });

          if (additionalIterations !== null && additionalIterations > 0) {
            this.config = {
              ...this.config,
              maxIterations: this.config.maxIterations + additionalIterations,
            };
            continue;
          }
        }

        this.state.status = 'aborted';
        this.emit('workflow:abort', this.state, ERROR_MESSAGES.MAX_ITERATIONS_REACHED);
        break;
      }

      const step = this.getStep(this.state.currentStep);
      const loopCheck = this.loopDetector.check(step.name);

      if (loopCheck.shouldWarn) {
        this.emit('step:loop_detected', step, loopCheck.count);
      }

      if (loopCheck.shouldAbort) {
        this.state.status = 'aborted';
        this.emit('workflow:abort', this.state, ERROR_MESSAGES.LOOP_DETECTED(step.name, loopCheck.count));
        break;
      }

      this.state.iteration++;

      // Build instruction before emitting step:start so listeners can log it
      const isParallel = step.parallel && step.parallel.length > 0;
      let prebuiltInstruction: string | undefined;
      if (!isParallel) {
        const stepIteration = incrementStepIteration(this.state, step.name);
        prebuiltInstruction = this.stepExecutor.buildInstruction(
          step, stepIteration, this.state, this.task, this.config.maxIterations,
        );
      }
      this.emit('step:start', step, this.state.iteration, prebuiltInstruction ?? '');

      try {
        const { response, instruction } = await this.runStep(step, prebuiltInstruction);
        this.emit('step:complete', step, response, instruction);

        if (response.status === 'blocked') {
          this.emit('step:blocked', step, response);
          const result = await handleBlocked(step, response, this.options);

          if (result.shouldContinue && result.userInput) {
            this.addUserInput(result.userInput);
            this.emit('step:user_input', step, result.userInput);
            continue;
          }

          this.state.status = 'aborted';
          this.emit('workflow:abort', this.state, 'Workflow blocked and no user input provided');
          break;
        }

        const nextStep = this.resolveNextStep(step, response);
        log.debug('Step transition', {
          from: step.name,
          status: response.status,
          matchedRuleIndex: response.matchedRuleIndex,
          nextStep,
        });

        if (response.matchedRuleIndex != null && step.rules) {
          const matchedRule = step.rules[response.matchedRuleIndex];
          if (matchedRule?.requiresUserInput) {
            if (!this.options.onUserInput) {
              this.state.status = 'aborted';
              this.emit('workflow:abort', this.state, 'User input required but no handler is configured');
              break;
            }
            const userInput = await this.options.onUserInput({
              step,
              response,
              prompt: response.content,
            });
            if (userInput === null) {
              this.state.status = 'aborted';
              this.emit('workflow:abort', this.state, 'User input cancelled');
              break;
            }
            this.addUserInput(userInput);
            this.emit('step:user_input', step, userInput);
            this.state.currentStep = step.name;
            continue;
          }
        }

        if (nextStep === COMPLETE_STEP) {
          this.state.status = 'completed';
          this.emit('workflow:complete', this.state);
          break;
        }

        if (nextStep === ABORT_STEP) {
          this.state.status = 'aborted';
          this.emit('workflow:abort', this.state, 'Workflow aborted by step transition');
          break;
        }

        this.state.currentStep = nextStep;
      } catch (error) {
        this.state.status = 'aborted';
        if (this.abortRequested) {
          this.emit('workflow:abort', this.state, 'Workflow interrupted by user (SIGINT)');
        } else {
          const message = getErrorMessage(error);
          this.emit('workflow:abort', this.state, ERROR_MESSAGES.STEP_EXECUTION_FAILED(message));
        }
        break;
      }
    }

    return this.state;
  }

  /** Run a single iteration (for interactive mode) */
  async runSingleIteration(): Promise<{
    response: AgentResponse;
    nextStep: string;
    isComplete: boolean;
    loopDetected?: boolean;
  }> {
    const step = this.getStep(this.state.currentStep);
    const loopCheck = this.loopDetector.check(step.name);

    if (loopCheck.shouldAbort) {
      this.state.status = 'aborted';
      return {
        response: {
          agent: step.agent ?? step.name,
          status: 'blocked',
          content: ERROR_MESSAGES.LOOP_DETECTED(step.name, loopCheck.count),
          timestamp: new Date(),
        },
        nextStep: ABORT_STEP,
        isComplete: true,
        loopDetected: true,
      };
    }

    this.state.iteration++;
    const { response } = await this.runStep(step);
    const nextStep = this.resolveNextStep(step, response);
    const isComplete = nextStep === COMPLETE_STEP || nextStep === ABORT_STEP;

    if (response.matchedRuleIndex != null && step.rules) {
      const matchedRule = step.rules[response.matchedRuleIndex];
      if (matchedRule?.requiresUserInput) {
        if (!this.options.onUserInput) {
          this.state.status = 'aborted';
          return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop };
        }
        const userInput = await this.options.onUserInput({
          step,
          response,
          prompt: response.content,
        });
        if (userInput === null) {
          this.state.status = 'aborted';
          return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop };
        }
        this.addUserInput(userInput);
        this.emit('step:user_input', step, userInput);
        this.state.currentStep = step.name;
        return { response, nextStep: step.name, isComplete: false, loopDetected: loopCheck.isLoop };
      }
    }

    if (!isComplete) {
      this.state.currentStep = nextStep;
    } else {
      this.state.status = nextStep === COMPLETE_STEP ? 'completed' : 'aborted';
    }

    return { response, nextStep, isComplete, loopDetected: loopCheck.isLoop };
  }
}

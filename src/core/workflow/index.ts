/**
 * Workflow module public API
 *
 * This file exports all public types, functions, and classes
 * from the workflow module.
 */

// Main engine
export { WorkflowEngine } from './engine/index.js';

// Constants
export { COMPLETE_STEP, ABORT_STEP, ERROR_MESSAGES } from './constants.js';

// Types
export type {
  WorkflowEvents,
  PhaseName,
  UserInputRequest,
  IterationLimitRequest,
  SessionUpdateCallback,
  IterationLimitCallback,
  WorkflowEngineOptions,
  LoopCheckResult,
  StreamEvent,
  StreamCallback,
  PermissionHandler,
  PermissionResult,
  AskUserQuestionHandler,
  ProviderType,
} from './types.js';

// Transitions (engine/)
export { determineNextStepByRules, extractBlockedPrompt } from './engine/transitions.js';

// Loop detection (engine/)
export { LoopDetector } from './engine/loop-detector.js';

// State management (engine/)
export {
  createInitialState,
  addUserInput,
  getPreviousOutput,
} from './engine/state-manager.js';

// Blocked handling (engine/)
export { handleBlocked, type BlockedHandlerResult } from './engine/blocked-handler.js';

// Parallel logger (engine/)
export { ParallelLogger } from './engine/parallel-logger.js';

// Instruction building
export { InstructionBuilder, isReportObjectConfig } from './instruction/InstructionBuilder.js';
export { ReportInstructionBuilder, type ReportInstructionContext } from './instruction/ReportInstructionBuilder.js';
export { StatusJudgmentBuilder, type StatusJudgmentContext } from './instruction/StatusJudgmentBuilder.js';
export { buildExecutionMetadata, renderExecutionMetadata, type InstructionContext, type ExecutionMetadata } from './instruction/instruction-context.js';
export { generateStatusRulesFromRules } from './instruction/status-rules.js';

// Rule evaluation
export { RuleEvaluator, type RuleMatch, type RuleEvaluatorContext, detectMatchedRule, evaluateAggregateConditions } from './evaluation/index.js';
export { AggregateEvaluator } from './evaluation/AggregateEvaluator.js';

// Phase runner
export { needsStatusJudgmentPhase, runReportPhase, runStatusJudgmentPhase } from './phase-runner.js';

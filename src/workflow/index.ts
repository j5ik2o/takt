/**
 * Workflow module public API
 *
 * This file exports all public types, functions, and classes
 * from the workflow module.
 */

// Main engine
export { WorkflowEngine } from './engine.js';

// Constants
export { COMPLETE_STEP, ABORT_STEP, ERROR_MESSAGES } from './constants.js';

// Types
export type {
  WorkflowEvents,
  UserInputRequest,
  IterationLimitRequest,
  SessionUpdateCallback,
  IterationLimitCallback,
  WorkflowEngineOptions,
  LoopCheckResult,
} from './types.js';

// Transitions
export { determineNextStepByRules, extractBlockedPrompt } from './transitions.js';

// Loop detection
export { LoopDetector } from './loop-detector.js';

// State management
export {
  createInitialState,
  addUserInput,
  getPreviousOutput,
  storeStepOutput,
} from './state-manager.js';

// Instruction building
export {
  buildInstruction,
  buildExecutionMetadata,
  renderExecutionMetadata,
  type InstructionContext,
  type ExecutionMetadata,
} from './instruction-builder.js';

// Blocked handling
export { handleBlocked, type BlockedHandlerResult } from './blocked-handler.js';

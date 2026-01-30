/**
 * Claude module public API
 *
 * This file exports all public types, functions, and classes
 * from the Claude integration module.
 */

// Main process and execution
export { ClaudeProcess, executeClaudeCli, type ClaudeSpawnOptions } from './process.js';
export { executeClaudeQuery, type ExecuteOptions } from './executor.js';

// Query management (only from query-manager, process.ts re-exports these)
export {
  generateQueryId,
  hasActiveProcess,
  isQueryActive,
  getActiveQueryCount,
  registerQuery,
  unregisterQuery,
  interruptQuery,
  interruptAllQueries,
  interruptCurrentProcess,
} from './query-manager.js';

// Types (only from types.ts, avoiding duplicates from process.ts)
export type {
  StreamEvent,
  StreamCallback,
  PermissionRequest,
  PermissionHandler,
  AskUserQuestionInput,
  AskUserQuestionHandler,
  ClaudeResult,
  ClaudeResultWithQueryId,
  InitEventData,
  ToolUseEventData,
  ToolResultEventData,
  ToolOutputEventData,
  TextEventData,
  ThinkingEventData,
  ResultEventData,
  ErrorEventData,
} from './types.js';

// Stream conversion
export { sdkMessageToStreamEvent } from './stream-converter.js';

// Options building
export {
  createCanUseToolCallback,
  createAskUserQuestionHooks,
} from './options-builder.js';

// Client functions and types
export {
  callClaude,
  callClaudeCustom,
  callClaudeAgent,
  callClaudeSkill,
  detectRuleIndex,
  isRegexSafe,
  type ClaudeCallOptions,
} from './client.js';

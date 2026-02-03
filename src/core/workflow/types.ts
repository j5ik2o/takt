/**
 * Workflow engine type definitions
 *
 * Contains types for workflow events, requests, and callbacks
 * used by the workflow execution engine.
 */

import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { WorkflowStep, AgentResponse, WorkflowState, Language } from '../models/types.js';

export type ProviderType = 'claude' | 'codex' | 'mock';

export interface StreamInitEventData {
  model: string;
  sessionId: string;
}

export interface StreamToolUseEventData {
  tool: string;
  input: Record<string, unknown>;
  id: string;
}

export interface StreamToolResultEventData {
  content: string;
  isError: boolean;
}

export interface StreamToolOutputEventData {
  tool: string;
  output: string;
}

export interface StreamTextEventData {
  text: string;
}

export interface StreamThinkingEventData {
  thinking: string;
}

export interface StreamResultEventData {
  result: string;
  sessionId: string;
  success: boolean;
  error?: string;
}

export interface StreamErrorEventData {
  message: string;
  raw?: string;
}

export type StreamEvent =
  | { type: 'init'; data: StreamInitEventData }
  | { type: 'tool_use'; data: StreamToolUseEventData }
  | { type: 'tool_result'; data: StreamToolResultEventData }
  | { type: 'tool_output'; data: StreamToolOutputEventData }
  | { type: 'text'; data: StreamTextEventData }
  | { type: 'thinking'; data: StreamThinkingEventData }
  | { type: 'result'; data: StreamResultEventData }
  | { type: 'error'; data: StreamErrorEventData };

export type StreamCallback = (event: StreamEvent) => void;

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
}

export type { PermissionResult, PermissionUpdate };

export type PermissionHandler = (request: PermissionRequest) => Promise<PermissionResult>;

export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{
      label: string;
      description?: string;
    }>;
    multiSelect?: boolean;
  }>;
}

export type AskUserQuestionHandler = (
  input: AskUserQuestionInput
) => Promise<Record<string, string>>;

export type RuleIndexDetector = (content: string, stepName: string) => number;

export interface AiJudgeCondition {
  index: number;
  text: string;
}

export type AiJudgeCaller = (
  agentOutput: string,
  conditions: AiJudgeCondition[],
  options: { cwd: string }
) => Promise<number>;

export type PhaseName = 'execute' | 'report' | 'judge';

/** Events emitted by workflow engine */
export interface WorkflowEvents {
  'step:start': (step: WorkflowStep, iteration: number, instruction: string) => void;
  'step:complete': (step: WorkflowStep, response: AgentResponse, instruction: string) => void;
  'step:report': (step: WorkflowStep, filePath: string, fileName: string) => void;
  'step:blocked': (step: WorkflowStep, response: AgentResponse) => void;
  'step:user_input': (step: WorkflowStep, userInput: string) => void;
  'phase:start': (step: WorkflowStep, phase: 1 | 2 | 3, phaseName: PhaseName, instruction: string) => void;
  'phase:complete': (step: WorkflowStep, phase: 1 | 2 | 3, phaseName: PhaseName, content: string, status: string, error?: string) => void;
  'workflow:complete': (state: WorkflowState) => void;
  'workflow:abort': (state: WorkflowState, reason: string) => void;
  'iteration:limit': (iteration: number, maxIterations: number) => void;
  'step:loop_detected': (step: WorkflowStep, consecutiveCount: number) => void;
}

/** User input request for blocked state */
export interface UserInputRequest {
  /** The step that is blocked */
  step: WorkflowStep;
  /** The blocked response from the agent */
  response: AgentResponse;
  /** Prompt for the user (extracted from blocked message) */
  prompt: string;
}

/** Iteration limit request */
export interface IterationLimitRequest {
  /** Current iteration count */
  currentIteration: number;
  /** Current max iterations */
  maxIterations: number;
  /** Current step name */
  currentStep: string;
}

/** Callback for session updates (when agent session IDs change) */
export type SessionUpdateCallback = (agentName: string, sessionId: string) => void;

/**
 * Callback for iteration limit reached.
 * Returns the number of additional iterations to continue, or null to stop.
 */
export type IterationLimitCallback = (request: IterationLimitRequest) => Promise<number | null>;

/** Options for workflow engine */
export interface WorkflowEngineOptions {
  /** Callback for streaming real-time output */
  onStream?: StreamCallback;
  /** Callback for requesting user input when an agent is blocked */
  onUserInput?: (request: UserInputRequest) => Promise<string | null>;
  /** Initial agent sessions to restore (agent name -> session ID) */
  initialSessions?: Record<string, string>;
  /** Callback when agent session ID is updated */
  onSessionUpdate?: SessionUpdateCallback;
  /** Custom permission handler for interactive permission prompts */
  onPermissionRequest?: PermissionHandler;
  /** Initial user inputs to share with all agents */
  initialUserInputs?: string[];
  /** Custom handler for AskUserQuestion tool */
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Callback when iteration limit is reached - returns additional iterations or null to stop */
  onIterationLimit?: IterationLimitCallback;
  /** Bypass all permission checks (sacrifice-my-pc mode) */
  bypassPermissions?: boolean;
  /** Project root directory (where .takt/ lives). */
  projectCwd: string;
  /** Language for instruction metadata. Defaults to 'en'. */
  language?: Language;
  provider?: ProviderType;
  model?: string;
  /** Enable interactive-only rules and user-input transitions */
  interactive?: boolean;
  /** Rule tag index detector (required for rules evaluation) */
  detectRuleIndex?: RuleIndexDetector;
  /** AI judge caller (required for rules evaluation) */
  callAiJudge?: AiJudgeCaller;
}

/** Loop detection result */
export interface LoopCheckResult {
  isLoop: boolean;
  count: number;
  shouldAbort: boolean;
  shouldWarn?: boolean;
}

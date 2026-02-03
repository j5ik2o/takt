/**
 * Type definitions for utils module.
 *
 * Contains session log types and NDJSON record types
 * used by SessionManager and its consumers.
 */

/** Session log entry */
export interface SessionLog {
  task: string;
  projectDir: string;
  workflowName: string;
  iterations: number;
  startTime: string;
  endTime?: string;
  status: 'running' | 'completed' | 'aborted';
  history: Array<{
    step: string;
    agent: string;
    instruction: string;
    status: string;
    timestamp: string;
    content: string;
    error?: string;
    /** Matched rule index (0-based) when rules-based detection was used */
    matchedRuleIndex?: number;
    /** How the rule match was detected */
    matchedRuleMethod?: string;
  }>;
}

// --- NDJSON log types ---

export interface NdjsonWorkflowStart {
  type: 'workflow_start';
  task: string;
  workflowName: string;
  startTime: string;
}

export interface NdjsonStepStart {
  type: 'step_start';
  step: string;
  agent: string;
  iteration: number;
  timestamp: string;
  instruction?: string;
}

export interface NdjsonStepComplete {
  type: 'step_complete';
  step: string;
  agent: string;
  status: string;
  content: string;
  instruction: string;
  matchedRuleIndex?: number;
  matchedRuleMethod?: string;
  error?: string;
  timestamp: string;
}

export interface NdjsonWorkflowComplete {
  type: 'workflow_complete';
  iterations: number;
  endTime: string;
}

export interface NdjsonWorkflowAbort {
  type: 'workflow_abort';
  iterations: number;
  reason: string;
  endTime: string;
}

export interface NdjsonPhaseStart {
  type: 'phase_start';
  step: string;
  phase: 1 | 2 | 3;
  phaseName: 'execute' | 'report' | 'judge';
  timestamp: string;
  instruction?: string;
}

export interface NdjsonPhaseComplete {
  type: 'phase_complete';
  step: string;
  phase: 1 | 2 | 3;
  phaseName: 'execute' | 'report' | 'judge';
  status: string;
  content?: string;
  timestamp: string;
  error?: string;
}

export interface NdjsonInteractiveStart {
  type: 'interactive_start';
  timestamp: string;
}

export interface NdjsonInteractiveEnd {
  type: 'interactive_end';
  confirmed: boolean;
  task?: string;
  timestamp: string;
}

export type NdjsonRecord =
  | NdjsonWorkflowStart
  | NdjsonStepStart
  | NdjsonStepComplete
  | NdjsonWorkflowComplete
  | NdjsonWorkflowAbort
  | NdjsonPhaseStart
  | NdjsonPhaseComplete
  | NdjsonInteractiveStart
  | NdjsonInteractiveEnd;

// --- Conversation log types ---

/** Pointer metadata for latest/previous log files */
export interface LatestLogPointer {
  sessionId: string;
  logFile: string;
  task: string;
  workflowName: string;
  status: SessionLog['status'];
  startTime: string;
  updatedAt: string;
  iterations: number;
}

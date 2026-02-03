/**
 * Workflow configuration and runtime state types
 */

import type { PermissionMode } from './status.js';
import type { AgentResponse } from './response.js';

/** Rule-based transition configuration (unified format) */
export interface WorkflowRule {
  /** Human-readable condition text */
  condition: string;
  /** Next movement name (e.g., implement, COMPLETE, ABORT). Optional for parallel sub-movements. */
  next?: string;
  /** Template for additional AI output */
  appendix?: string;
  /** Require user input before continuing (interactive mode only) */
  requiresUserInput?: boolean;
  /** Rule applies only in interactive mode */
  interactiveOnly?: boolean;
  /** Whether this condition uses ai() expression (set by loader) */
  isAiCondition?: boolean;
  /** The condition text inside ai("...") for AI judge evaluation (set by loader) */
  aiConditionText?: string;
  /** Whether this condition uses all()/any() aggregate expression (set by loader) */
  isAggregateCondition?: boolean;
  /** Aggregate type: 'all' requires all sub-movements match, 'any' requires at least one (set by loader) */
  aggregateType?: 'all' | 'any';
  /** The condition text(s) inside all("...")/any("...") to match against sub-movement results (set by loader).
   * - string: all sub-movements must match this single condition (e.g., all("approved"))
   * - string[]: each sub-movement must match the corresponding condition by index (e.g., all("A", "B"))
   */
  aggregateConditionText?: string | string[];
}

/** Report file configuration for a workflow movement (label: path pair) */
export interface ReportConfig {
  /** Display label (e.g., "Scope", "Decisions") */
  label: string;
  /** File path relative to report directory (e.g., "01-coder-scope.md") */
  path: string;
}

/** Report object configuration with order/format instructions */
export interface ReportObjectConfig {
  /** Report file name (e.g., "00-plan.md") */
  name: string;
  /** Instruction prepended before instruction_template (e.g., output destination) */
  order?: string;
  /** Instruction appended after instruction_template (e.g., output format) */
  format?: string;
}

/** Single movement in a workflow */
export interface WorkflowMovement {
  name: string;
  /** Brief description of this movement's role in the workflow */
  description?: string;
  /** Agent name, path, or inline prompt as specified in workflow YAML. Undefined when movement runs without an agent. */
  agent?: string;
  /** Session handling for this movement */
  session?: 'continue' | 'refresh';
  /** Display name for the agent (shown in output). Falls back to agent basename if not specified */
  agentDisplayName: string;
  /** Allowed tools for this movement (optional, passed to agent execution) */
  allowedTools?: string[];
  /** Resolved absolute path to agent prompt file (set by loader) */
  agentPath?: string;
  /** Provider override for this movement */
  provider?: 'claude' | 'codex' | 'mock';
  /** Model override for this movement */
  model?: string;
  /** Permission mode for tool execution in this movement */
  permissionMode?: PermissionMode;
  /** Whether this movement is allowed to edit project files (true=allowed, false=prohibited, undefined=no prompt) */
  edit?: boolean;
  instructionTemplate: string;
  /** Rules for movement routing */
  rules?: WorkflowRule[];
  /** Report file configuration. Single string, array of label:path, or object with order/format. */
  report?: string | ReportConfig[] | ReportObjectConfig;
  passPreviousResponse: boolean;
  /** Sub-movements to execute in parallel. When set, this movement runs all sub-movements concurrently. */
  parallel?: WorkflowMovement[];
}

/** @deprecated Use WorkflowMovement instead */
export type WorkflowStep = WorkflowMovement;

/** Loop detection configuration */
export interface LoopDetectionConfig {
  /** Maximum consecutive runs of the same step before triggering (default: 10) */
  maxConsecutiveSameStep?: number;
  /** Action to take when loop is detected (default: 'warn') */
  action?: 'abort' | 'warn' | 'ignore';
}

/** Workflow configuration */
export interface WorkflowConfig {
  name: string;
  description?: string;
  movements: WorkflowMovement[];
  initialMovement: string;
  maxIterations: number;
  /** Loop detection settings */
  loopDetection?: LoopDetectionConfig;
  /**
   * Agent to use for answering AskUserQuestion prompts automatically.
   * When specified, questions from Claude Code are routed to this agent
   * instead of prompting the user interactively.
   */
  answerAgent?: string;
}

/** Runtime state of a workflow execution */
export interface WorkflowState {
  workflowName: string;
  currentMovement: string;
  iteration: number;
  movementOutputs: Map<string, AgentResponse>;
  userInputs: string[];
  agentSessions: Map<string, string>;
  /** Per-movement iteration counters (how many times each movement has been executed) */
  movementIterations: Map<string, number>;
  status: 'running' | 'completed' | 'aborted';
}

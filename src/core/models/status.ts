/**
 * Status and classification types
 */

/** Built-in agent types */
export type AgentType = 'coder' | 'architect' | 'supervisor' | 'custom';

/** Execution status for agents and pieces */
export type Status =
  | 'pending'
  | 'done'
  | 'blocked'
  | 'error'
  | 'approved'
  | 'rejected'
  | 'improve'
  | 'cancelled'
  | 'interrupted'
  | 'answer';

/** How a rule match was detected */
export type RuleMatchMethod =
  | 'aggregate'
  | 'phase3_tag'
  | 'phase1_tag'
  | 'ai_judge'
  | 'ai_judge_fallback';

/** Permission mode for tool execution (provider-agnostic) */
export type PermissionMode = 'readonly' | 'edit' | 'full';

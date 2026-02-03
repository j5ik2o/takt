/**
 * Core type definitions for TAKT orchestration system
 *
 * This file re-exports all types from categorized sub-modules.
 * Consumers import from './types.js' — no path changes needed.
 */

// Status and classification types
export type {
  AgentType,
  Status,
  RuleMatchMethod,
  PermissionMode,
} from './status.js';

// Agent response
export type {
  AgentResponse,
} from './response.js';

// Session state (authoritative definition with createSessionState)
export type {
  SessionState,
} from './session.js';

// Workflow configuration and runtime state
export type {
  WorkflowRule,
  ReportConfig,
  ReportObjectConfig,
  WorkflowMovement,
  WorkflowStep,
  LoopDetectionConfig,
  WorkflowConfig,
  WorkflowState,
} from './workflow-types.js';

// Configuration types (global and project)
export type {
  CustomAgentConfig,
  DebugConfig,
  Language,
  PipelineConfig,
  GlobalConfig,
  ProjectConfig,
} from './global-config.js';

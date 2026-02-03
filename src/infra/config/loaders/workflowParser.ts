/**
 * Workflow YAML parsing and normalization.
 *
 * Converts raw YAML structures into internal WorkflowConfig format,
 * resolving agent paths, content paths, and rule conditions.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { WorkflowConfigRawSchema, WorkflowMovementRawSchema } from '../../../core/models/index.js';
import type { WorkflowConfig, WorkflowMovement, WorkflowRule, ReportConfig, ReportObjectConfig } from '../../../core/models/index.js';

/** Parsed movement type from Zod schema (replaces `any`) */
type RawStep = z.output<typeof WorkflowMovementRawSchema>;

/**
 * Resolve agent path from workflow specification.
 * - Relative path (./agent.md): relative to workflow directory
 * - Absolute path (/path/to/agent.md or ~/...): use as-is
 */
function resolveAgentPathForWorkflow(agentSpec: string, workflowDir: string): string {
  if (agentSpec.startsWith('./')) {
    return join(workflowDir, agentSpec.slice(2));
  }
  if (agentSpec.startsWith('~')) {
    const homedir = process.env.HOME || process.env.USERPROFILE || '';
    return join(homedir, agentSpec.slice(1));
  }
  if (agentSpec.startsWith('/')) {
    return agentSpec;
  }
  return join(workflowDir, agentSpec);
}

/**
 * Extract display name from agent path.
 * e.g., "~/.takt/agents/default/coder.md" -> "coder"
 */
function extractAgentDisplayName(agentPath: string): string {
  return basename(agentPath, '.md');
}

/**
 * Resolve a string value that may be a file path.
 * If the value ends with .md and the file exists (resolved relative to workflowDir),
 * read and return the file contents. Otherwise return the value as-is.
 */
function resolveContentPath(value: string | undefined, workflowDir: string): string | undefined {
  if (value == null) return undefined;
  if (value.endsWith('.md')) {
    let resolvedPath = value;
    if (value.startsWith('./')) {
      resolvedPath = join(workflowDir, value.slice(2));
    } else if (value.startsWith('~')) {
      const homedir = process.env.HOME || process.env.USERPROFILE || '';
      resolvedPath = join(homedir, value.slice(1));
    } else if (!value.startsWith('/')) {
      resolvedPath = join(workflowDir, value);
    }
    if (existsSync(resolvedPath)) {
      return readFileSync(resolvedPath, 'utf-8');
    }
  }
  return value;
}

/** Check if a raw report value is the object form (has 'name' property). */
function isReportObject(raw: unknown): raw is { name: string; order?: string; format?: string } {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'name' in raw;
}

/**
 * Normalize the raw report field from YAML into internal format.
 */
function normalizeReport(
  raw: string | Record<string, string>[] | { name: string; order?: string; format?: string } | undefined,
  workflowDir: string,
): string | ReportConfig[] | ReportObjectConfig | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw;
  if (isReportObject(raw)) {
    return {
      name: raw.name,
      order: resolveContentPath(raw.order, workflowDir),
      format: resolveContentPath(raw.format, workflowDir),
    };
  }
  return (raw as Record<string, string>[]).flatMap((entry) =>
    Object.entries(entry).map(([label, path]) => ({ label, path })),
  );
}

/** Regex to detect ai("...") condition expressions */
const AI_CONDITION_REGEX = /^ai\("(.+)"\)$/;

/** Regex to detect all("...")/any("...") aggregate condition expressions */
const AGGREGATE_CONDITION_REGEX = /^(all|any)\((.+)\)$/;

/**
 * Parse aggregate condition arguments from all("A", "B") or any("A", "B").
 * Returns an array of condition strings.
 * Throws if the format is invalid.
 */
function parseAggregateConditions(argsText: string): string[] {
  const conditions: string[] = [];
  const regex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(argsText)) !== null) {
    if (match[1]) conditions.push(match[1]);
  }

  if (conditions.length === 0) {
    throw new Error(`Invalid aggregate condition format: ${argsText}`);
  }

  return conditions;
}

/**
 * Parse a rule's condition for ai() and all()/any() expressions.
 */
function normalizeRule(r: {
  condition: string;
  next?: string;
  appendix?: string;
  requires_user_input?: boolean;
  interactive_only?: boolean;
}): WorkflowRule {
  const next = r.next ?? '';
  const aiMatch = r.condition.match(AI_CONDITION_REGEX);
  if (aiMatch?.[1]) {
    return {
      condition: r.condition,
      next,
      appendix: r.appendix,
      requiresUserInput: r.requires_user_input,
      interactiveOnly: r.interactive_only,
      isAiCondition: true,
      aiConditionText: aiMatch[1],
    };
  }

  const aggMatch = r.condition.match(AGGREGATE_CONDITION_REGEX);
  if (aggMatch?.[1] && aggMatch[2]) {
    const conditions = parseAggregateConditions(aggMatch[2]);
    // parseAggregateConditions guarantees conditions.length >= 1
    const aggregateConditionText: string | string[] =
      conditions.length === 1 ? (conditions[0] as string) : conditions;
    return {
      condition: r.condition,
      next,
      appendix: r.appendix,
      requiresUserInput: r.requires_user_input,
      interactiveOnly: r.interactive_only,
      isAggregateCondition: true,
      aggregateType: aggMatch[1] as 'all' | 'any',
      aggregateConditionText,
    };
  }

  return {
    condition: r.condition,
    next,
    appendix: r.appendix,
    requiresUserInput: r.requires_user_input,
    interactiveOnly: r.interactive_only,
  };
}

/** Normalize a raw step into internal WorkflowMovement format. */
function normalizeStepFromRaw(step: RawStep, workflowDir: string): WorkflowMovement {
  const rules: WorkflowRule[] | undefined = step.rules?.map(normalizeRule);
  const agentSpec: string | undefined = step.agent || undefined;

  // Resolve agent path: if the resolved path exists on disk, use it; otherwise leave agentPath undefined
  // so that the runner treats agentSpec as an inline system prompt string.
  let agentPath: string | undefined;
  if (agentSpec) {
    const resolved = resolveAgentPathForWorkflow(agentSpec, workflowDir);
    if (existsSync(resolved)) {
      agentPath = resolved;
    }
  }

  const result: WorkflowMovement = {
    name: step.name,
    description: step.description,
    agent: agentSpec,
    session: step.session,
    agentDisplayName: step.agent_name || (agentSpec ? extractAgentDisplayName(agentSpec) : step.name),
    agentPath,
    allowedTools: step.allowed_tools,
    provider: step.provider,
    model: step.model,
    permissionMode: step.permission_mode,
    edit: step.edit,
    instructionTemplate: resolveContentPath(step.instruction_template, workflowDir) || step.instruction || '{task}',
    rules,
    report: normalizeReport(step.report, workflowDir),
    passPreviousResponse: step.pass_previous_response ?? true,
  };

  if (step.parallel && step.parallel.length > 0) {
    result.parallel = step.parallel.map((sub: RawStep) => normalizeStepFromRaw(sub, workflowDir));
  }

  return result;
}

/**
 * Convert raw YAML workflow config to internal format.
 * Agent paths are resolved relative to the workflow directory.
 */
export function normalizeWorkflowConfig(raw: unknown, workflowDir: string): WorkflowConfig {
  const parsed = WorkflowConfigRawSchema.parse(raw);

  const movements: WorkflowMovement[] = parsed.movements.map((step) =>
    normalizeStepFromRaw(step, workflowDir),
  );

  const initialMovement = parsed.initial_movement ?? movements[0]?.name ?? '';

  return {
    name: parsed.name,
    description: parsed.description,
    movements,
    initialMovement,
    maxIterations: parsed.max_iterations,
    answerAgent: parsed.answer_agent,
  };
}

/**
 * Load a workflow from a YAML file.
 * @param filePath Path to the workflow YAML file
 */
export function loadWorkflowFromFile(filePath: string): WorkflowConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Workflow file not found: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf-8');
  const raw = parseYaml(content);
  const workflowDir = dirname(filePath);
  return normalizeWorkflowConfig(raw, workflowDir);
}

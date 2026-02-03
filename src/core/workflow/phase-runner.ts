/**
 * Phase execution logic extracted from engine.ts.
 *
 * Handles Phase 2 (report output) and Phase 3 (status judgment)
 * as session-resume operations.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { WorkflowStep, Language } from '../models/types.js';
import type { PhaseName } from './types.js';
import { runAgent, type RunAgentOptions } from '../../agents/runner.js';
import { ReportInstructionBuilder } from './instruction/ReportInstructionBuilder.js';
import { StatusJudgmentBuilder } from './instruction/StatusJudgmentBuilder.js';
import { hasTagBasedRules } from './evaluation/rule-utils.js';
import { isReportObjectConfig } from './instruction/InstructionBuilder.js';
import { createLogger } from '../../shared/utils/index.js';

const log = createLogger('phase-runner');

export interface PhaseRunnerContext {
  /** Working directory (agent work dir, may be a clone) */
  cwd: string;
  /** Report directory path */
  reportDir: string;
  /** Language for instructions */
  language?: Language;
  /** Whether interactive-only rules are enabled */
  interactive?: boolean;
  /** Get agent session ID */
  getSessionId: (agent: string) => string | undefined;
  /** Build resume options for a step */
  buildResumeOptions: (step: WorkflowStep, sessionId: string, overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>) => RunAgentOptions;
  /** Update agent session after a phase run */
  updateAgentSession: (agent: string, sessionId: string | undefined) => void;
  /** Callback for phase lifecycle logging */
  onPhaseStart?: (step: WorkflowStep, phase: 1 | 2 | 3, phaseName: PhaseName, instruction: string) => void;
  /** Callback for phase completion logging */
  onPhaseComplete?: (step: WorkflowStep, phase: 1 | 2 | 3, phaseName: PhaseName, content: string, status: string, error?: string) => void;
}

/**
 * Check if a step needs Phase 3 (status judgment).
 * Returns true when at least one rule requires tag-based detection.
 */
export function needsStatusJudgmentPhase(step: WorkflowStep): boolean {
  return hasTagBasedRules(step);
}

function extractJsonPayload(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1]!.trim() : null;
}

function parseReportJson(content: string): Record<string, string> | null {
  const payload = extractJsonPayload(content);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      for (const value of Object.values(obj)) {
        if (typeof value !== 'string') return null;
      }
      return obj as Record<string, string>;
    }
    return null;
  } catch {
    return null;
  }
}

function getReportFiles(report: WorkflowStep['report']): string[] {
  if (!report) return [];
  if (typeof report === 'string') return [report];
  if (isReportObjectConfig(report)) return [report.name];
  return report.map((rc) => rc.path);
}

function resolveReportOutputs(
  report: WorkflowStep['report'],
  reportDir: string,
  content: string,
): Map<string, string> {
  if (!report) return new Map();

  const files = getReportFiles(report);
  const json = parseReportJson(content);
  if (!json) {
    const raw = content;
    if (!raw || raw.trim().length === 0) {
      throw new Error('Report output is empty.');
    }
    return new Map(files.map((file) => [file, raw]));
  }

  const outputs = new Map<string, string>();
  for (const file of files) {
    const absolutePath = resolve(reportDir, file);
    const value = json[file] ?? json[absolutePath];
    if (typeof value !== 'string') {
      throw new Error(`Report output missing content for file: ${file}`);
    }
    outputs.set(file, value);
  }
  return outputs;
}

function writeReportFile(reportDir: string, fileName: string, content: string): void {
  const baseDir = resolve(reportDir);
  const targetPath = resolve(reportDir, fileName);
  const basePrefix = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (!targetPath.startsWith(basePrefix)) {
    throw new Error(`Report file path escapes report directory: ${fileName}`);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  if (existsSync(targetPath)) {
    appendFileSync(targetPath, `\n\n${content}`);
  } else {
    writeFileSync(targetPath, content);
  }
}

/**
 * Phase 2: Report output.
 * Resumes the agent session with no tools to request report content.
 * The engine writes the report files to the Report Directory.
 */
export async function runReportPhase(
  step: WorkflowStep,
  stepIteration: number,
  ctx: PhaseRunnerContext,
): Promise<void> {
  const sessionKey = step.agent ?? step.name;
  const sessionId = ctx.getSessionId(sessionKey);
  if (!sessionId) {
    throw new Error(`Report phase requires a session to resume, but no sessionId found for agent "${sessionKey}" in step "${step.name}"`);
  }

  log.debug('Running report phase', { step: step.name, sessionId });

  const reportInstruction = new ReportInstructionBuilder(step, {
    cwd: ctx.cwd,
    reportDir: ctx.reportDir,
    stepIteration,
    language: ctx.language,
  }).build();

  ctx.onPhaseStart?.(step, 2, 'report', reportInstruction);

  const reportOptions = ctx.buildResumeOptions(step, sessionId, {
    allowedTools: [],
    maxTurns: 3,
  });

  let reportResponse;
  try {
    reportResponse = await runAgent(step.agent, reportInstruction, reportOptions);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    ctx.onPhaseComplete?.(step, 2, 'report', '', 'error', errorMsg);
    throw error;
  }

  // Check for errors in report phase
  if (reportResponse.status !== 'done') {
    const errorMsg = reportResponse.error || reportResponse.content || 'Unknown error';
    ctx.onPhaseComplete?.(step, 2, 'report', reportResponse.content, reportResponse.status, errorMsg);
    throw new Error(`Report phase failed: ${errorMsg}`);
  }

  const outputs = resolveReportOutputs(step.report, ctx.reportDir, reportResponse.content);
  for (const [fileName, content] of outputs.entries()) {
    writeReportFile(ctx.reportDir, fileName, content);
  }

  // Update session (phase 2 may update it)
  ctx.updateAgentSession(sessionKey, reportResponse.sessionId);

  ctx.onPhaseComplete?.(step, 2, 'report', reportResponse.content, reportResponse.status);
  log.debug('Report phase complete', { step: step.name, status: reportResponse.status });
}

/**
 * Phase 3: Status judgment.
 * Resumes the agent session with no tools to ask the agent to output a status tag.
 * Returns the Phase 3 response content (containing the status tag).
 */
export async function runStatusJudgmentPhase(
  step: WorkflowStep,
  ctx: PhaseRunnerContext,
): Promise<string> {
  const sessionKey = step.agent ?? step.name;
  const sessionId = ctx.getSessionId(sessionKey);
  if (!sessionId) {
    throw new Error(`Status judgment phase requires a session to resume, but no sessionId found for agent "${sessionKey}" in step "${step.name}"`);
  }

  log.debug('Running status judgment phase', { step: step.name, sessionId });

  const judgmentInstruction = new StatusJudgmentBuilder(step, {
    language: ctx.language,
    interactive: ctx.interactive,
  }).build();

  ctx.onPhaseStart?.(step, 3, 'judge', judgmentInstruction);

  const judgmentOptions = ctx.buildResumeOptions(step, sessionId, {
    allowedTools: [],
    maxTurns: 3,
  });

  let judgmentResponse;
  try {
    judgmentResponse = await runAgent(step.agent, judgmentInstruction, judgmentOptions);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    ctx.onPhaseComplete?.(step, 3, 'judge', '', 'error', errorMsg);
    throw error;
  }

  // Check for errors in status judgment phase
  if (judgmentResponse.status !== 'done') {
    const errorMsg = judgmentResponse.error || judgmentResponse.content || 'Unknown error';
    ctx.onPhaseComplete?.(step, 3, 'judge', judgmentResponse.content, judgmentResponse.status, errorMsg);
    throw new Error(`Status judgment phase failed: ${errorMsg}`);
  }

  // Update session (phase 3 may update it)
  ctx.updateAgentSession(sessionKey, judgmentResponse.sessionId);

  ctx.onPhaseComplete?.(step, 3, 'judge', judgmentResponse.content, judgmentResponse.status);
  log.debug('Status judgment phase complete', { step: step.name, status: judgmentResponse.status });
  return judgmentResponse.content;
}

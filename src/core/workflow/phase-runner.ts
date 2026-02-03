/**
 * Phase execution logic extracted from engine.ts.
 *
 * Handles Phase 2 (report output) and Phase 3 (status judgment)
 * as session-resume operations.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { WorkflowMovement, Language } from '../models/types.js';
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
  /** Build resume options for a movement */
  buildResumeOptions: (step: WorkflowMovement, sessionId: string, overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>) => RunAgentOptions;
  /** Update agent session after a phase run */
  updateAgentSession: (agent: string, sessionId: string | undefined) => void;
  /** Callback for phase lifecycle logging */
  onPhaseStart?: (step: WorkflowMovement, phase: 1 | 2 | 3, phaseName: PhaseName, instruction: string) => void;
  /** Callback for phase completion logging */
  onPhaseComplete?: (step: WorkflowMovement, phase: 1 | 2 | 3, phaseName: PhaseName, content: string, status: string, error?: string) => void;
}

/**
 * Check if a movement needs Phase 3 (status judgment).
 * Returns true when at least one rule requires tag-based detection.
 */
export function needsStatusJudgmentPhase(step: WorkflowMovement): boolean {
  return hasTagBasedRules(step);
}

function getReportFiles(report: WorkflowMovement['report']): string[] {
  if (!report) return [];
  if (typeof report === 'string') return [report];
  if (isReportObjectConfig(report)) return [report.name];
  return report.map((rc) => rc.path);
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
 * Each report file is generated individually in a loop.
 * Plain text responses are written directly to files (no JSON parsing).
 */
export async function runReportPhase(
  step: WorkflowMovement,
  movementIteration: number,
  ctx: PhaseRunnerContext,
): Promise<void> {
  const sessionKey = step.agent ?? step.name;
  let currentSessionId = ctx.getSessionId(sessionKey);
  if (!currentSessionId) {
    throw new Error(`Report phase requires a session to resume, but no sessionId found for agent "${sessionKey}" in movement "${step.name}"`);
  }

  log.debug('Running report phase', { movement: step.name, sessionId: currentSessionId });

  const reportFiles = getReportFiles(step.report);
  if (reportFiles.length === 0) {
    log.debug('No report files configured, skipping report phase');
    return;
  }

  for (const fileName of reportFiles) {
    if (!fileName) {
      throw new Error(`Invalid report file name: ${fileName}`);
    }

    log.debug('Generating report file', { movement: step.name, fileName });

    const reportInstruction = new ReportInstructionBuilder(step, {
      cwd: ctx.cwd,
      reportDir: ctx.reportDir,
      movementIteration: movementIteration,
      language: ctx.language,
      targetFile: fileName,
    }).build();

    ctx.onPhaseStart?.(step, 2, 'report', reportInstruction);

    const reportOptions = ctx.buildResumeOptions(step, currentSessionId, {
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

    if (reportResponse.status !== 'done') {
      const errorMsg = reportResponse.error || reportResponse.content || 'Unknown error';
      ctx.onPhaseComplete?.(step, 2, 'report', reportResponse.content, reportResponse.status, errorMsg);
      throw new Error(`Report phase failed for ${fileName}: ${errorMsg}`);
    }

    const content = reportResponse.content.trim();
    if (content.length === 0) {
      throw new Error(`Report output is empty for file: ${fileName}`);
    }

    writeReportFile(ctx.reportDir, fileName, content);

    if (reportResponse.sessionId) {
      currentSessionId = reportResponse.sessionId;
      ctx.updateAgentSession(sessionKey, currentSessionId);
    }

    ctx.onPhaseComplete?.(step, 2, 'report', reportResponse.content, reportResponse.status);
    log.debug('Report file generated', { movement: step.name, fileName });
  }

  log.debug('Report phase complete', { movement: step.name, filesGenerated: reportFiles.length });
}

/**
 * Phase 3: Status judgment.
 * Resumes the agent session with no tools to ask the agent to output a status tag.
 * Returns the Phase 3 response content (containing the status tag).
 */
export async function runStatusJudgmentPhase(
  step: WorkflowMovement,
  ctx: PhaseRunnerContext,
): Promise<string> {
  const sessionKey = step.agent ?? step.name;
  const sessionId = ctx.getSessionId(sessionKey);
  if (!sessionId) {
    throw new Error(`Status judgment phase requires a session to resume, but no sessionId found for agent "${sessionKey}" in movement "${step.name}"`);
  }

  log.debug('Running status judgment phase', { movement: step.name, sessionId });

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
  log.debug('Status judgment phase complete', { movement: step.name, status: judgmentResponse.status });
  return judgmentResponse.content;
}

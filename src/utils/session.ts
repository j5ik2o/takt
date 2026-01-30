/**
 * Session management utilities
 */

import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentResponse, WorkflowState } from '../models/types.js';
import { getProjectLogsDir, getGlobalLogsDir, ensureDir, writeFileAtomic } from '../config/paths.js';

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
  }>;
}

/** Generate a session ID */
export function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * Generate report directory name from task and timestamp.
 * Format: YYYYMMDD-HHMMSS-task-summary
 */
export function generateReportDir(task: string): string {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)
    .replace(/(\d{8})(\d{6})/, '$1-$2');

  // Extract first 30 chars of task, sanitize for directory name
  const summary = task
    .slice(0, 30)
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'task';

  return `${timestamp}-${summary}`;
}

/** Create a new session log */
export function createSessionLog(
  task: string,
  projectDir: string,
  workflowName: string
): SessionLog {
  return {
    task,
    projectDir,
    workflowName,
    iterations: 0,
    startTime: new Date().toISOString(),
    status: 'running',
    history: [],
  };
}

/** Add agent response to session log */
export function addToSessionLog(
  log: SessionLog,
  stepName: string,
  response: AgentResponse,
  instruction: string
): void {
  log.history.push({
    step: stepName,
    agent: response.agent,
    instruction,
    status: response.status,
    timestamp: response.timestamp.toISOString(),
    content: response.content,
    ...(response.error ? { error: response.error } : {}),
  });
  log.iterations++;
}

/** Finalize session log */
export function finalizeSessionLog(
  log: SessionLog,
  status: 'completed' | 'aborted'
): void {
  log.status = status;
  log.endTime = new Date().toISOString();
}

/** Save session log to file */
export function saveSessionLog(
  log: SessionLog,
  sessionId: string,
  projectDir?: string
): string {
  const logsDir = projectDir
    ? getProjectLogsDir(projectDir)
    : getGlobalLogsDir();
  ensureDir(logsDir);

  const filename = `${sessionId}.json`;
  const filepath = join(logsDir, filename);

  writeFileAtomic(filepath, JSON.stringify(log, null, 2));
  return filepath;
}

/** Load session log from file */
export function loadSessionLog(filepath: string): SessionLog | null {
  if (!existsSync(filepath)) {
    return null;
  }
  const content = readFileSync(filepath, 'utf-8');
  return JSON.parse(content) as SessionLog;
}

/** Load project context (CLAUDE.md files) */
export function loadProjectContext(projectDir: string): string {
  const contextParts: string[] = [];

  // Check project root CLAUDE.md
  const rootClaudeMd = join(projectDir, 'CLAUDE.md');
  if (existsSync(rootClaudeMd)) {
    contextParts.push(readFileSync(rootClaudeMd, 'utf-8'));
  }

  // Check .claude/CLAUDE.md
  const dotClaudeMd = join(projectDir, '.claude', 'CLAUDE.md');
  if (existsSync(dotClaudeMd)) {
    contextParts.push(readFileSync(dotClaudeMd, 'utf-8'));
  }

  return contextParts.join('\n\n---\n\n');
}

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

/**
 * Update latest.json pointer file.
 * On first call (workflow start), copies existing latest.json to previous.json.
 * On subsequent calls (step complete / workflow end), only overwrites latest.json.
 */
export function updateLatestPointer(
  log: SessionLog,
  sessionId: string,
  projectDir?: string,
  options?: { copyToPrevious?: boolean }
): void {
  const logsDir = projectDir
    ? getProjectLogsDir(projectDir)
    : getGlobalLogsDir();
  ensureDir(logsDir);

  const latestPath = join(logsDir, 'latest.json');
  const previousPath = join(logsDir, 'previous.json');

  // Copy latest → previous only when explicitly requested (workflow start)
  if (options?.copyToPrevious && existsSync(latestPath)) {
    copyFileSync(latestPath, previousPath);
  }

  const pointer: LatestLogPointer = {
    sessionId,
    logFile: `${sessionId}.json`,
    task: log.task,
    workflowName: log.workflowName,
    status: log.status,
    startTime: log.startTime,
    updatedAt: new Date().toISOString(),
    iterations: log.iterations,
  };

  writeFileAtomic(latestPath, JSON.stringify(pointer, null, 2));
}

/** Convert workflow state to session log */
export function workflowStateToSessionLog(
  state: WorkflowState,
  task: string,
  projectDir: string
): SessionLog {
  const log: SessionLog = {
    task,
    projectDir,
    workflowName: state.workflowName,
    iterations: state.iteration,
    startTime: new Date().toISOString(),
    status: state.status === 'running' ? 'running' : state.status === 'completed' ? 'completed' : 'aborted',
    history: [],
  };

  for (const [stepName, response] of state.stepOutputs) {
    log.history.push({
      step: stepName,
      agent: response.agent,
      instruction: '',
      status: response.status,
      timestamp: response.timestamp.toISOString(),
      content: response.content,
    });
  }

  return log;
}

/**
 * Session management utilities
 */

import { existsSync, readFileSync, copyFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectLogsDir, getGlobalLogsDir, ensureDir, writeFileAtomic } from '../config/index.js';
import { generateReportDir as buildReportDir } from '../../shared/utils/index.js';
import type {
  SessionLog,
  NdjsonRecord,
  NdjsonWorkflowStart,
  LatestLogPointer,
} from '../../shared/utils/index.js';

// Re-export types for backward compatibility
export type {
  SessionLog,
  NdjsonWorkflowStart,
  NdjsonStepStart,
  NdjsonStepComplete,
  NdjsonWorkflowComplete,
  NdjsonWorkflowAbort,
  NdjsonPhaseStart,
  NdjsonPhaseComplete,
  NdjsonInteractiveStart,
  NdjsonInteractiveEnd,
  NdjsonRecord,
  LatestLogPointer,
} from '../../shared/utils/index.js';

/**
 * Manages session lifecycle: ID generation, NDJSON logging,
 * session log creation/loading, and latest pointer maintenance.
 */
export class SessionManager {
  /** Append a single NDJSON line to a log file */
  appendNdjsonLine(filepath: string, record: NdjsonRecord): void {
    appendFileSync(filepath, JSON.stringify(record) + '\n', 'utf-8');
  }


  /** Initialize an NDJSON log file with the workflow_start record */
  initNdjsonLog(
    sessionId: string,
    task: string,
    workflowName: string,
    projectDir?: string,
  ): string {
    const logsDir = projectDir
      ? getProjectLogsDir(projectDir)
      : getGlobalLogsDir();
    ensureDir(logsDir);

    const filepath = join(logsDir, `${sessionId}.jsonl`);
    const record: NdjsonWorkflowStart = {
      type: 'workflow_start',
      task,
      workflowName,
      startTime: new Date().toISOString(),
    };
    this.appendNdjsonLine(filepath, record);
    return filepath;
  }


  /** Load an NDJSON log file and convert it to a SessionLog */
  loadNdjsonLog(filepath: string): SessionLog | null {
    if (!existsSync(filepath)) {
      return null;
    }

    const content = readFileSync(filepath, 'utf-8');
    const lines = content.trim().split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) return null;

    let sessionLog: SessionLog | null = null;

    for (const line of lines) {
      const record = JSON.parse(line) as NdjsonRecord;

      switch (record.type) {
        case 'workflow_start':
          sessionLog = {
            task: record.task,
            projectDir: '',
            workflowName: record.workflowName,
            iterations: 0,
            startTime: record.startTime,
            status: 'running',
            history: [],
          };
          break;

        case 'step_complete':
          if (sessionLog) {
            sessionLog.history.push({
              step: record.step,
              agent: record.agent,
              instruction: record.instruction,
              status: record.status,
              timestamp: record.timestamp,
              content: record.content,
              ...(record.error ? { error: record.error } : {}),
              ...(record.matchedRuleIndex != null ? { matchedRuleIndex: record.matchedRuleIndex } : {}),
              ...(record.matchedRuleMethod ? { matchedRuleMethod: record.matchedRuleMethod } : {}),
            });
            sessionLog.iterations++;
          }
          break;

        case 'workflow_complete':
          if (sessionLog) {
            sessionLog.status = 'completed';
            sessionLog.endTime = record.endTime;
          }
          break;

        case 'workflow_abort':
          if (sessionLog) {
            sessionLog.status = 'aborted';
            sessionLog.endTime = record.endTime;
          }
          break;

        default:
          break;
      }
    }

    return sessionLog;
  }

  /** Generate a session ID */
  generateSessionId(): string {
    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(
      now.getHours(),
    ).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const random = Math.random().toString(36).slice(2, 8);
    return `${timestamp}-${random}`;
  }

  /** Generate report directory name from task and timestamp */
  generateReportDir(task: string): string {
    return buildReportDir(task);
  }

  /** Create a new session log */
  createSessionLog(
    task: string,
    projectDir: string,
    workflowName: string,
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

  /** Create a finalized copy of a session log (immutable) */
  finalizeSessionLog(
    log: SessionLog,
    status: 'completed' | 'aborted',
  ): SessionLog {
    return {
      ...log,
      status,
      endTime: new Date().toISOString(),
    };
  }

  /** Load session log from file (supports both .json and .jsonl formats) */
  loadSessionLog(filepath: string): SessionLog | null {
    if (filepath.endsWith('.jsonl')) {
      return this.loadNdjsonLog(filepath);
    }

    if (!existsSync(filepath)) {
      return null;
    }
    const content = readFileSync(filepath, 'utf-8');
    return JSON.parse(content) as SessionLog;
  }

  /** Load project context (CLAUDE.md files) */
  loadProjectContext(projectDir: string): string {
    const contextParts: string[] = [];

    const rootClaudeMd = join(projectDir, 'CLAUDE.md');
    if (existsSync(rootClaudeMd)) {
      contextParts.push(readFileSync(rootClaudeMd, 'utf-8'));
    }

    const dotClaudeMd = join(projectDir, '.claude', 'CLAUDE.md');
    if (existsSync(dotClaudeMd)) {
      contextParts.push(readFileSync(dotClaudeMd, 'utf-8'));
    }

    return contextParts.join('\n\n---\n\n');
  }

  /** Update latest.json pointer file */
  updateLatestPointer(
    log: SessionLog,
    sessionId: string,
    projectDir?: string,
    options?: { copyToPrevious?: boolean },
  ): void {
    const logsDir = projectDir
      ? getProjectLogsDir(projectDir)
      : getGlobalLogsDir();
    ensureDir(logsDir);

    const latestPath = join(logsDir, 'latest.json');
    const previousPath = join(logsDir, 'previous.json');

    if (options?.copyToPrevious && existsSync(latestPath)) {
      copyFileSync(latestPath, previousPath);
    }

    const pointer: LatestLogPointer = {
      sessionId,
      logFile: `${sessionId}.jsonl`,
      task: log.task,
      workflowName: log.workflowName,
      status: log.status,
      startTime: log.startTime,
      updatedAt: new Date().toISOString(),
      iterations: log.iterations,
    };

    writeFileAtomic(latestPath, JSON.stringify(pointer, null, 2));
  }
}

// ---- Backward-compatible module-level functions ----

const defaultManager = new SessionManager();

export function appendNdjsonLine(filepath: string, record: NdjsonRecord): void {
  defaultManager.appendNdjsonLine(filepath, record);
}

export function initNdjsonLog(
  sessionId: string,
  task: string,
  workflowName: string,
  projectDir?: string,
): string {
  return defaultManager.initNdjsonLog(sessionId, task, workflowName, projectDir);
}


export function loadNdjsonLog(filepath: string): SessionLog | null {
  return defaultManager.loadNdjsonLog(filepath);
}


export function generateSessionId(): string {
  return defaultManager.generateSessionId();
}

export function generateReportDir(task: string): string {
  return defaultManager.generateReportDir(task);
}

export function createSessionLog(
  task: string,
  projectDir: string,
  workflowName: string,
): SessionLog {
  return defaultManager.createSessionLog(task, projectDir, workflowName);
}

export function finalizeSessionLog(
  log: SessionLog,
  status: 'completed' | 'aborted',
): SessionLog {
  return defaultManager.finalizeSessionLog(log, status);
}

export function loadSessionLog(filepath: string): SessionLog | null {
  return defaultManager.loadSessionLog(filepath);
}

export function loadProjectContext(projectDir: string): string {
  return defaultManager.loadProjectContext(projectDir);
}

export function updateLatestPointer(
  log: SessionLog,
  sessionId: string,
  projectDir?: string,
  options?: { copyToPrevious?: boolean },
): void {
  defaultManager.updateLatestPointer(log, sessionId, projectDir, options);
}

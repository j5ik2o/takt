/**
 * Workflow execution logic
 */

import { WorkflowEngine } from '../workflow/engine.js';
import type { WorkflowConfig } from '../models/types.js';
import type { IterationLimitRequest } from '../workflow/types.js';
import { loadAgentSessions, updateAgentSession } from '../config/paths.js';
import {
  header,
  info,
  warn,
  error,
  success,
  status,
  StreamDisplay,
} from '../utils/ui.js';
import {
  generateSessionId,
  createSessionLog,
  addToSessionLog,
  finalizeSessionLog,
  saveSessionLog,
} from '../utils/session.js';
import { createLogger } from '../utils/debug.js';
import { notifySuccess, notifyError } from '../utils/notification.js';
import { selectOption, promptInput } from '../prompt/index.js';

const log = createLogger('workflow');

/**
 * Format elapsed time in human-readable format
 */
function formatElapsedTime(startTime: string, endTime: string): string {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const elapsedMs = end - start;
  const elapsedSec = elapsedMs / 1000;

  if (elapsedSec < 60) {
    return `${elapsedSec.toFixed(1)}s`;
  }

  const minutes = Math.floor(elapsedSec / 60);
  const seconds = Math.floor(elapsedSec % 60);
  return `${minutes}m ${seconds}s`;
}

/** Result of workflow execution */
export interface WorkflowExecutionResult {
  success: boolean;
  reason?: string;
}

/** Options for workflow execution */
export interface WorkflowExecutionOptions {
  /** Header prefix for display */
  headerPrefix?: string;
  /** Project root directory (where .takt/ lives). Defaults to cwd. */
  projectCwd?: string;
}

/**
 * Execute a workflow and handle all events
 */
export async function executeWorkflow(
  workflowConfig: WorkflowConfig,
  task: string,
  cwd: string,
  options: WorkflowExecutionOptions = {}
): Promise<WorkflowExecutionResult> {
  const {
    headerPrefix = 'Running Workflow:',
  } = options;

  // projectCwd is where .takt/ lives (project root, not worktree)
  const projectCwd = options.projectCwd ?? cwd;

  // Always continue from previous sessions (use /clear to reset)
  log.debug('Continuing session (use /clear to reset)');

  header(`${headerPrefix} ${workflowConfig.name}`);

  const workflowSessionId = generateSessionId();
  const sessionLog = createSessionLog(task, projectCwd, workflowConfig.name);

  // Track current display for streaming
  const displayRef: { current: StreamDisplay | null } = { current: null };

  // Create stream handler that delegates to current display
  const streamHandler = (
    event: Parameters<ReturnType<StreamDisplay['createHandler']>>[0]
  ): void => {
    if (!displayRef.current) return;
    if (event.type === 'result') return;
    displayRef.current.createHandler()(event);
  };

  // Load saved agent sessions for continuity (from project root)
  // When running in a worktree (cwd !== projectCwd), skip session resume because
  // Claude Code sessions are stored per-cwd in ~/.claude/projects/{encoded-path}/
  // and sessions from the main project dir can't be resumed in a worktree dir.
  const isWorktree = cwd !== projectCwd;
  const savedSessions = isWorktree ? {} : loadAgentSessions(projectCwd);

  // Session update handler - persist session IDs when they change (to project root)
  // Skip persisting worktree sessions since they can't be reused across different worktrees.
  const sessionUpdateHandler = isWorktree
    ? undefined
    : (agentName: string, agentSessionId: string): void => {
        updateAgentSession(projectCwd, agentName, agentSessionId);
      };

  const iterationLimitHandler = async (
    request: IterationLimitRequest
  ): Promise<number | null> => {
    if (displayRef.current) {
      displayRef.current.flush();
      displayRef.current = null;
    }

    console.log();
    warn(
      `最大イテレーションに到達しました (${request.currentIteration}/${request.maxIterations})`
    );
    info(`現在のステップ: ${request.currentStep}`);

    const action = await selectOption('続行しますか？', [
      {
        label: '続行する（追加イテレーション数を入力）',
        value: 'continue',
        description: '入力した回数だけ上限を増やします',
      },
      { label: '終了する', value: 'stop' },
    ]);

    if (action !== 'continue') {
      return null;
    }

    while (true) {
      const input = await promptInput('追加するイテレーション数を入力してください（1以上）');
      if (!input) {
        return null;
      }

      const additionalIterations = Number.parseInt(input, 10);
      if (Number.isInteger(additionalIterations) && additionalIterations > 0) {
        workflowConfig.maxIterations += additionalIterations;
        return additionalIterations;
      }

      warn('1以上の整数を入力してください。');
    }
  };

  const engine = new WorkflowEngine(workflowConfig, cwd, task, {
    onStream: streamHandler,
    initialSessions: savedSessions,
    onSessionUpdate: sessionUpdateHandler,
    onIterationLimit: iterationLimitHandler,
    projectCwd,
  });

  let abortReason: string | undefined;

  engine.on('step:start', (step, iteration) => {
    log.debug('Step starting', { step: step.name, agent: step.agentDisplayName, iteration });
    info(`[${iteration}/${workflowConfig.maxIterations}] ${step.name} (${step.agentDisplayName})`);
    displayRef.current = new StreamDisplay(step.agentDisplayName);
  });

  engine.on('step:complete', (step, response) => {
    log.debug('Step completed', {
      step: step.name,
      status: response.status,
      contentLength: response.content.length,
      sessionId: response.sessionId,
      error: response.error,
    });
    if (displayRef.current) {
      displayRef.current.flush();
      displayRef.current = null;
    }
    console.log();
    status('Status', response.status);
    if (response.error) {
      error(`Error: ${response.error}`);
    }
    if (response.sessionId) {
      status('Session', response.sessionId);
    }
    addToSessionLog(sessionLog, step.name, response);
  });

  engine.on('workflow:complete', (state) => {
    log.info('Workflow completed successfully', { iterations: state.iteration });
    finalizeSessionLog(sessionLog, 'completed');
    // Save log to project root so user can find it easily
    const logPath = saveSessionLog(sessionLog, workflowSessionId, projectCwd);

    const elapsed = sessionLog.endTime
      ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime)
      : '';
    const elapsedDisplay = elapsed ? `, ${elapsed}` : '';

    success(`Workflow completed (${state.iteration} iterations${elapsedDisplay})`);
    info(`Session log: ${logPath}`);
    notifySuccess('TAKT', `ワークフロー完了 (${state.iteration} iterations)`);
  });

  engine.on('workflow:abort', (state, reason) => {
    log.error('Workflow aborted', { reason, iterations: state.iteration });
    if (displayRef.current) {
      displayRef.current.flush();
      displayRef.current = null;
    }
    abortReason = reason;
    finalizeSessionLog(sessionLog, 'aborted');
    // Save log to project root so user can find it easily
    const logPath = saveSessionLog(sessionLog, workflowSessionId, projectCwd);

    const elapsed = sessionLog.endTime
      ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime)
      : '';
    const elapsedDisplay = elapsed ? ` (${elapsed})` : '';

    error(`Workflow aborted after ${state.iteration} iterations${elapsedDisplay}: ${reason}`);
    info(`Session log: ${logPath}`);
    notifyError('TAKT', `中断: ${reason}`);
  });

  const finalState = await engine.run();

  return {
    success: finalState.status === 'completed',
    reason: abortReason,
  };
}

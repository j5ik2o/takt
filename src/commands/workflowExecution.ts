/**
 * Workflow execution logic
 */

import { WorkflowEngine } from '../workflow/engine.js';
import type { WorkflowConfig } from '../models/types.js';
import { loadAgentSessions, updateAgentSession, clearAgentSessions } from '../config/paths.js';
import {
  header,
  info,
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
import { createWorktree, type WorktreeInfo, type WorktreeConfig } from '../utils/worktree.js';

const log = createLogger('workflow');

/** Result of workflow execution */
export interface WorkflowExecutionResult {
  success: boolean;
  reason?: string;
  /** Worktree information if worktree mode was used */
  worktree?: WorktreeInfo;
}

/** Options for workflow execution */
export interface WorkflowExecutionOptions {
  /** Resume previous session instead of starting fresh */
  resumeSession?: boolean;
  /** Header prefix for display */
  headerPrefix?: string;
}

/**
 * Execute a workflow and handle all events
 *
 * Worktree creation is determined by Planner:
 * - If Planner outputs [PLANNER:DONE] with worktree config, a worktree is created
 * - If Planner outputs [PLANNER:BLOCKED], no worktree is created
 */
export async function executeWorkflow(
  workflowConfig: WorkflowConfig,
  task: string,
  cwd: string,
  options: WorkflowExecutionOptions = {}
): Promise<WorkflowExecutionResult> {
  const {
    resumeSession = false,
    headerPrefix = 'Running Workflow:',
  } = options;

  // Worktree info will be set when Planner emits worktree config
  let worktreeInfo: WorktreeInfo | undefined;

  // Clear previous sessions if not resuming
  if (!resumeSession) {
    log.debug('Starting fresh session (clearing previous agent sessions)');
    clearAgentSessions(cwd);
  } else {
    log.debug('Resuming previous session');
  }

  header(`${headerPrefix} ${workflowConfig.name}${resumeSession ? ' (resuming)' : ''}`);

  const workflowSessionId = generateSessionId();
  const sessionLog = createSessionLog(task, cwd, workflowConfig.name);

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

  // Load saved agent sessions for continuity
  const savedSessions = loadAgentSessions(cwd);

  // Session update handler - persist session IDs when they change
  // Always use original cwd for .takt data (案C: worktreeはコード作業専用)
  const sessionUpdateHandler = (agentName: string, agentSessionId: string): void => {
    updateAgentSession(cwd, agentName, agentSessionId);
  };

  const engine = new WorkflowEngine(workflowConfig, cwd, task, {
    onStream: streamHandler,
    initialSessions: savedSessions,
    onSessionUpdate: sessionUpdateHandler,
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
    });
    if (displayRef.current) {
      displayRef.current.flush();
      displayRef.current = null;
    }
    console.log();
    status('Status', response.status);
    addToSessionLog(sessionLog, step.name, response);
  });

  // Handle worktree config from Planner
  engine.on('planner:worktree_config', (config: WorktreeConfig) => {
    log.info('Planner provided worktree config', config);
    try {
      info(`Creating worktree for branch: ${config.branchName}`);
      worktreeInfo = createWorktree(cwd, config.branchName, config.baseBranch);
      success(`Worktree created: ${worktreeInfo.path}`);
      info(`Base branch: ${worktreeInfo.baseBranch}`);
      info(`Working in worktree: ${worktreeInfo.path}`);

      // Update engine's cwd to worktree path for remaining steps
      engine.updateCwd(worktreeInfo.path);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      error(`Failed to create worktree: ${errorMessage}`);
      // Continue without worktree - don't abort the workflow
    }
  });

  engine.on('workflow:complete', (state) => {
    log.info('Workflow completed successfully', { iterations: state.iteration });
    finalizeSessionLog(sessionLog, 'completed');
    // Save log to original cwd so user can find it easily
    const logPath = saveSessionLog(sessionLog, workflowSessionId, cwd);
    success(`Workflow completed (${state.iteration} iterations)`);
    info(`Session log: ${logPath}`);
    if (worktreeInfo) {
      info(`Worktree preserved at: ${worktreeInfo.path}`);
      info(`Branch: ${worktreeInfo.branch}`);
    }
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
    // Save log to original cwd so user can find it easily
    const logPath = saveSessionLog(sessionLog, workflowSessionId, cwd);
    error(`Workflow aborted after ${state.iteration} iterations: ${reason}`);
    info(`Session log: ${logPath}`);
    if (worktreeInfo) {
      info(`Worktree preserved at: ${worktreeInfo.path}`);
      info(`Branch: ${worktreeInfo.branch}`);
    }
    notifyError('TAKT', `中断: ${reason}`);
  });

  const finalState = await engine.run();

  return {
    success: finalState.status === 'completed',
    reason: abortReason,
    worktree: worktreeInfo,
  };
}

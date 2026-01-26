/**
 * Workflow execution logic
 */

import { WorkflowEngine } from '../workflow/engine.js';
import type { WorkflowConfig } from '../models/types.js';
import type { IterationLimitRequest } from '../workflow/types.js';
import { loadAgentSessions, updateAgentSession, clearAgentSessions } from '../config/paths.js';
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

/** Result of workflow execution */
export interface WorkflowExecutionResult {
  success: boolean;
  reason?: string;
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
  const sessionUpdateHandler = (agentName: string, agentSessionId: string): void => {
    updateAgentSession(cwd, agentName, agentSessionId);
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

  engine.on('workflow:complete', (state) => {
    log.info('Workflow completed successfully', { iterations: state.iteration });
    finalizeSessionLog(sessionLog, 'completed');
    // Save log to original cwd so user can find it easily
    const logPath = saveSessionLog(sessionLog, workflowSessionId, cwd);
    success(`Workflow completed (${state.iteration} iterations)`);
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
    // Save log to original cwd so user can find it easily
    const logPath = saveSessionLog(sessionLog, workflowSessionId, cwd);
    error(`Workflow aborted after ${state.iteration} iterations: ${reason}`);
    info(`Session log: ${logPath}`);
    notifyError('TAKT', `中断: ${reason}`);
  });

  const finalState = await engine.run();

  return {
    success: finalState.status === 'completed',
    reason: abortReason,
  };
}

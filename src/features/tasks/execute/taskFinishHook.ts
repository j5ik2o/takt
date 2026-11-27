/**
 * Task finish hook: one external command per saved terminal task state.
 *
 * The command runs after the terminal state is on disk and only observes it. Nothing the command
 * does (exit code, timeout, spawn failure) changes the saved state, the resume point, or the value
 * the execution returns to its caller.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskRunner, TaskState } from '../../../infra/task/index.js';
import type { TaskFinishHookConfig } from '../../../core/models/task-finish-hook.js';
import { loadProjectConfig } from '../../../infra/config/project/projectConfig.js';
import { isFileLockTimeoutError } from '../../../infra/fs/file-lock.js';
import { buildCommandEnv, runBoundedCommand } from '../../../shared/utils/bounded-command-runner.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitive-text.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { warn } from '../../../shared/ui/index.js';

const log = createLogger('task-finish-hook');

const TERMINAL_STATUSES = ['completed', 'failed', 'exceeded', 'pr_failed'] as const;
type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** Keeps one oversized failure message from making the child's environment unspawnable. */
const MAX_FAILURE_REASON_CHARS = 4096;

const TASK_FINISH_HOOK_READ_MAX_ATTEMPTS = 2;
const TASK_FINISH_HOOK_READ_RETRY_INTERVAL_MS = 250;
const MAX_NOTICE_TASK_NAMES = 10;

export interface TaskFinishHookOptions {
  emitStatusLog?: boolean;
}

type LostHookPhase = 'config-read' | 'named-read' | 'execution-read' | 'hook-call';

function isTerminal(state: TaskState | undefined): state is TaskState & { status: TerminalStatus } {
  return state !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(state.status);
}

function readTaskState(taskRunner: TaskRunner, taskName: string): TaskState | undefined {
  return taskRunner.listTaskStateItems().find((item) => item.name === taskName);
}

function formatTaskNames(taskNames: readonly string[]): string {
  const unique = [...new Set(taskNames.map((name) => sanitizeTerminalText(name)))];
  const shown = unique.slice(0, MAX_NOTICE_TASK_NAMES).map((name) => `"${name}"`);
  const suffix = unique.length > MAX_NOTICE_TASK_NAMES ? ` and ${unique.length - MAX_NOTICE_TASK_NAMES} more` : '';
  return shown.join(', ') + suffix;
}

function emitNotice(message: string, taskNames: readonly string[], reason: unknown): void {
  const sanitized = sanitizeSensitiveText(message);
  try {
    warn(sanitized);
  } catch (warnError) {
    try {
      log.error('Task finish hook notice could not be shown', {
        taskNames, error: getErrorMessage(reason), warnError: getErrorMessage(warnError),
      });
    } catch {
      // A failed notice must never reach the caller.
    }
    return;
  }
  log.error('Task finish hook could not run', { taskNames, error: getErrorMessage(reason) });
}

function reportLostHook(
  taskNames: readonly string[],
  reason: unknown,
  phase: LostHookPhase,
): void {
  const names = formatTaskNames(taskNames);
  const reasonText = sanitizeSensitiveText(getErrorMessage(reason));
  let detail: string;
  if (phase === 'config-read') {
    detail = `reading .takt/config.yaml failed: ${reasonText}`;
  } else if (phase === 'named-read' || phase === 'execution-read') {
    detail = isFileLockTimeoutError(reason)
      ? `reading .takt/tasks.yaml timed out after ${TASK_FINISH_HOOK_READ_MAX_ATTEMPTS} attempts: ${reasonText}`
      : `reading .takt/tasks.yaml failed: ${reasonText}`;
  } else {
    detail = `the hook command could not be started: ${reasonText}`;
  }
  const message = `Task finish hook was not run for ${names}: ${detail}. The saved task state is unchanged; the hook is not retried later.`;
  emitNotice(message, taskNames, reason);
}

function reportUnconfirmedPreRead(taskName: string, reason: unknown): void {
  const names = formatTaskNames([taskName]);
  const reasonText = sanitizeSensitiveText(getErrorMessage(reason));
  const message = `Task finish hook for ${names} ran without a confirmed previous state: the state before execution could not be read (${reasonText}), so the hook may run for a state that this execution did not save.`;
  emitNotice(message, [taskName], reason);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readTaskStateItemsWithRetry(taskRunner: TaskRunner): Promise<TaskState[]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return taskRunner.listTaskStateItems();
    } catch (error) {
      if (!isFileLockTimeoutError(error) || attempt >= TASK_FINISH_HOOK_READ_MAX_ATTEMPTS) {
        throw error;
      }
      await delay(TASK_FINISH_HOOK_READ_RETRY_INTERVAL_MS);
    }
  }
}

/** Identifies one saved terminal state, so a state that was already saved before is not reported again. */
function terminalStamp(state: TaskState | undefined): string | undefined {
  return isTerminal(state) ? `${state.status}\n${state.completedAt ?? ''}` : undefined;
}

function resolveRunDir(projectCwd: string, state: TaskState): string | undefined {
  if (state.runSlug === undefined) return undefined;
  const roots = state.worktreePath === undefined ? [projectCwd] : [state.worktreePath, projectCwd];
  return roots
    .map((root) => join(root, '.takt', 'runs', state.runSlug!))
    .find((dir) => existsSync(dir));
}

function buildHookEnv(projectCwd: string, state: TaskState & { status: TerminalStatus }): NodeJS.ProcessEnv {
  const runDir = resolveRunDir(projectCwd, state);
  const failureReason = state.failure?.error ?? state.completion?.failureReason;
  const optional: Record<string, string | undefined> = {
    TAKT_FINISH_COMPLETED_AT: state.completedAt,
    TAKT_FINISH_RUN_SLUG: state.runSlug,
    TAKT_FINISH_RUN_DIR: runDir,
    TAKT_FINISH_BRANCH: state.branch,
    TAKT_FINISH_WORKTREE_PATH: state.worktreePath,
    TAKT_FINISH_PR_URL: state.prUrl,
    TAKT_FINISH_GOAL_ID: state.goalId,
    TAKT_FINISH_FAILURE_REASON: failureReason?.slice(0, MAX_FAILURE_REASON_CHARS),
  };
  // The same allowlist as the other bounded commands: credentials in TAKT's environment are not passed on.
  const env = buildCommandEnv(process.env);
  env.TAKT_FINISH_TASK_NAME = state.name;
  env.TAKT_FINISH_STATUS = state.status;
  env.TAKT_FINISH_PROJECT_DIR = projectCwd;
  env.TAKT_FINISH_INTERRUPTED = state.completion?.interrupted === true ? 'true' : 'false';
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function callHook(
  projectCwd: string,
  hook: TaskFinishHookConfig,
  state: TaskState & { status: TerminalStatus },
  options: TaskFinishHookOptions | undefined,
): Promise<void> {
  const taskName = state.name;
  const [file, ...args] = hook.command;
  const result = await runBoundedCommand({
    command: file,
    args,
    cwd: projectCwd,
    timeoutMs: hook.timeoutMs,
    env: buildHookEnv(projectCwd, state),
  });
  if (result.exitCode === 0 && !result.timedOut && result.error === undefined) {
    log.debug('Task finish hook completed', { taskName, status: state.status });
    return;
  }
  const reason = result.timedOut ? `timed out after ${hook.timeoutMs} ms`
    : result.error !== undefined ? result.error.message
      : `exited with code ${String(result.exitCode)}`;
  log.error('Task finish hook failed; the saved task state is unchanged', {
    taskName, status: state.status, reason, stderr: result.stderr,
  });
  if (options?.emitStatusLog !== false) {
    warn(`Task finish hook for "${sanitizeTerminalText(taskName)}" ${sanitizeTerminalText(reason)}; the task state is unchanged`);
  }
}

async function runHook(
  projectCwd: string,
  taskRunner: TaskRunner,
  taskName: string,
  stampBefore: string | undefined,
  options: TaskFinishHookOptions | undefined,
  beforeReadFailed = false,
  beforeReadError?: unknown,
): Promise<void> {
  let items: TaskState[];
  try {
    items = await readTaskStateItemsWithRetry(taskRunner);
  } catch (error) {
    reportLostHook([taskName], error, 'execution-read');
    return;
  }
  const state = items.find((item) => item.name === taskName);
  if (!isTerminal(state) || terminalStamp(state) === stampBefore) return;
  let hook: TaskFinishHookConfig | undefined;
  try {
    hook = loadProjectConfig(projectCwd).taskFinishHook;
  } catch (error) {
    reportLostHook([taskName], error, 'config-read');
    return;
  }
  if (hook === undefined) return;
  try {
    await callHook(projectCwd, hook, state, options);
  } catch (error) {
    reportLostHook([taskName], error, 'hook-call');
    return;
  }
  if (beforeReadFailed) {
    reportUnconfirmedPreRead(taskName, beforeReadError);
  }
}

/**
 * Call the hook for tasks whose terminal state was just saved without an execution: a published
 * `pr_failed` task, a goal task that failed while it was claimed, a pending task of an aborted goal.
 * The caller names only tasks it has just saved. Never throws.
 */
export async function runTaskFinishHooks(
  projectCwd: string,
  taskRunner: TaskRunner,
  taskNames: readonly string[],
  options?: TaskFinishHookOptions,
): Promise<void> {
  if (taskNames.length === 0) return;
  let hook: TaskFinishHookConfig | undefined;
  try {
    hook = loadProjectConfig(projectCwd).taskFinishHook;
  } catch (error) {
    reportLostHook(taskNames, error, 'config-read');
    return;
  }
  if (hook === undefined) return;
  let states: (TaskState & { status: TerminalStatus })[];
  try {
    const items = await readTaskStateItemsWithRetry(taskRunner);
    const names = new Set(taskNames);
    states = items.filter((item) => names.has(item.name)).filter(isTerminal);
  } catch (error) {
    reportLostHook(taskNames, error, 'named-read');
    return;
  }
  // Side by side: aborting a goal with many pending tasks waits for one timeout, not one per task.
  const results = await Promise.allSettled(states.map((state) => callHook(projectCwd, hook, state, options)));
  const rejectedNames: string[] = [];
  let firstReason: unknown;
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      rejectedNames.push(states[index]!.name);
      if (firstReason === undefined) firstReason = result.reason;
    }
  });
  if (rejectedNames.length > 0) {
    reportLostHook(rejectedNames, firstReason, 'hook-call');
  }
}

/** Call the hook for saved terminal states handed over directly, without re-reading tasks.yaml. Never throws. */
export async function runTaskFinishHooksForStates(
  projectCwd: string,
  states: readonly TaskState[],
  options?: TaskFinishHookOptions,
): Promise<void> {
  if (states.length === 0) return;
  const terminal = states.filter(isTerminal);
  if (terminal.length === 0) return;
  let hook: TaskFinishHookConfig | undefined;
  try {
    hook = loadProjectConfig(projectCwd).taskFinishHook;
  } catch (error) {
    reportLostHook(terminal.map((state) => state.name), error, 'config-read');
    return;
  }
  if (hook === undefined) return;
  const results = await Promise.allSettled(terminal.map((state) => callHook(projectCwd, hook, state, options)));
  const rejectedNames: string[] = [];
  let firstReason: unknown;
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      rejectedNames.push(terminal[index]!.name);
      if (firstReason === undefined) firstReason = result.reason;
    }
  });
  if (rejectedNames.length > 0) {
    reportLostHook(rejectedNames, firstReason, 'hook-call');
  }
}

/** Fail the pending tasks of an aborted goal, then call the hook for each task this saved as failed. */
export async function invalidatePendingGoalTasksWithFinishHook(
  projectCwd: string,
  taskRunner: TaskRunner,
  goalId: string,
): Promise<void> {
  const invalidated: TaskState[] = [];
  try {
    taskRunner.invalidatePendingGoalTasks(goalId, (state) => { invalidated.push(state); });
  } finally {
    await runTaskFinishHooksForStates(projectCwd, invalidated);
  }
}

/**
 * Run `execute`, then call the project's `task_finish_hook` once if `execute` left a newly saved
 * terminal state for the task. The result or error of `execute` is passed through untouched.
 *
 * The hook is awaited, so the caller's execution slot stays occupied until the command exits or its
 * timeout (at most 60 s, plus about a second to kill the process group) expires.
 */
export async function withTaskFinishHook<T>(
  projectCwd: string,
  taskRunner: TaskRunner,
  taskName: string,
  execute: () => Promise<T>,
  options?: TaskFinishHookOptions,
): Promise<T> {
  let stampBefore: string | undefined;
  let beforeReadFailed = false;
  let beforeReadError: unknown;
  try {
    stampBefore = terminalStamp(readTaskState(taskRunner, taskName));
  } catch (error) {
    // An execution starts from a running task, so an unreadable state is taken as "nothing saved yet".
    beforeReadFailed = true;
    beforeReadError = error;
    log.error('Task state was unreadable before execution', { taskName, error: getErrorMessage(error) });
  }
  try {
    return await execute();
  } finally {
    try {
      await runHook(projectCwd, taskRunner, taskName, stampBefore, options, beforeReadFailed, beforeReadError);
    } catch (error) {
      reportLostHook([taskName], error, 'hook-call');
    }
  }
}

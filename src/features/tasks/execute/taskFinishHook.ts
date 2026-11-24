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
import { buildCommandEnv, runBoundedCommand } from '../../../shared/utils/bounded-command-runner.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { warn } from '../../../shared/ui/index.js';

const log = createLogger('task-finish-hook');

const TERMINAL_STATUSES = ['completed', 'failed', 'exceeded', 'pr_failed'] as const;
type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** Keeps one oversized failure message from making the child's environment unspawnable. */
const MAX_FAILURE_REASON_CHARS = 4096;

export interface TaskFinishHookOptions {
  emitStatusLog?: boolean;
}

function isTerminal(state: TaskState | undefined): state is TaskState & { status: TerminalStatus } {
  return state !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(state.status);
}

function readTaskState(taskRunner: TaskRunner, taskName: string): TaskState | undefined {
  return taskRunner.listTaskStateItems().find((item) => item.name === taskName);
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
): Promise<void> {
  const state = readTaskState(taskRunner, taskName);
  if (!isTerminal(state) || terminalStamp(state) === stampBefore) return;
  const hook = loadProjectConfig(projectCwd).taskFinishHook;
  if (hook === undefined) return;
  await callHook(projectCwd, hook, state, options);
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
  try {
    const hook = loadProjectConfig(projectCwd).taskFinishHook;
    if (hook === undefined) return;
    const names = new Set(taskNames);
    const states = taskRunner.listTaskStateItems().filter((item) => names.has(item.name)).filter(isTerminal);
    // Side by side: aborting a goal with many pending tasks waits for one timeout, not one per task.
    await Promise.all(states.map((state) => callHook(projectCwd, hook, state, options)));
  } catch (error) {
    log.error('Task finish hook could not run', { taskNames, error: getErrorMessage(error) });
  }
}

/** Fail the pending tasks of an aborted goal, then call the hook for each task this saved as failed. */
export async function invalidatePendingGoalTasksWithFinishHook(
  projectCwd: string,
  taskRunner: TaskRunner,
  goalId: string,
): Promise<void> {
  let pendingNames: string[] = [];
  try {
    pendingNames = taskRunner.listTaskStateItems()
      .filter((item) => item.status === 'pending' && item.goalId === goalId)
      .map((item) => item.name);
  } catch (error) {
    log.error('Task state was unreadable before goal task invalidation', { goalId, error: getErrorMessage(error) });
  }
  taskRunner.invalidatePendingGoalTasks(goalId);
  await runTaskFinishHooks(projectCwd, taskRunner, pendingNames);
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
  try {
    stampBefore = terminalStamp(readTaskState(taskRunner, taskName));
  } catch (error) {
    // An execution starts from a running task, so an unreadable state is taken as "nothing saved yet".
    log.error('Task state was unreadable before execution', { taskName, error: getErrorMessage(error) });
  }
  try {
    return await execute();
  } finally {
    try {
      await runHook(projectCwd, taskRunner, taskName, stampBefore, options);
    } catch (error) {
      log.error('Task finish hook could not run', { taskName, error: getErrorMessage(error) });
    }
  }
}

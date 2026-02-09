/**
 * Resolve execution directory and piece from task data.
 */

import { loadGlobalConfig } from '../../../infra/config/index.js';
import { type TaskInfo, createSharedClone, summarizeTaskName, getCurrentBranch } from '../../../infra/task/index.js';
import { info } from '../../../shared/ui/index.js';

export interface ResolvedTaskExecution {
  execCwd: string;
  execPiece: string;
  isWorktree: boolean;
  branch?: string;
  baseBranch?: string;
  startMovement?: string;
  retryNote?: string;
  autoPr?: boolean;
  issueNumber?: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Task execution aborted');
  }
}

/**
 * Resolve execution directory and piece from task data.
 * If the task has worktree settings, create a shared clone and use it as cwd.
 * Task name is summarized to English by AI for use in branch/clone names.
 */
export async function resolveTaskExecution(
  task: TaskInfo,
  defaultCwd: string,
  defaultPiece: string,
  abortSignal?: AbortSignal,
): Promise<ResolvedTaskExecution> {
  throwIfAborted(abortSignal);

  const data = task.data;
  if (!data) {
    return { execCwd: defaultCwd, execPiece: defaultPiece, isWorktree: false };
  }

  let execCwd = defaultCwd;
  let isWorktree = false;
  let branch: string | undefined;
  let baseBranch: string | undefined;

  if (data.worktree) {
    throwIfAborted(abortSignal);
    baseBranch = getCurrentBranch(defaultCwd);
    info('Generating branch name...');
    const taskSlug = await summarizeTaskName(task.content, { cwd: defaultCwd });

    throwIfAborted(abortSignal);
    info('Creating clone...');
    const result = createSharedClone(defaultCwd, {
      worktree: data.worktree,
      branch: data.branch,
      taskSlug,
      issueNumber: data.issue,
    });
    throwIfAborted(abortSignal);
    execCwd = result.path;
    branch = result.branch;
    isWorktree = true;
    info(`Clone created: ${result.path} (branch: ${result.branch})`);
  }

  const execPiece = data.piece || defaultPiece;
  const startMovement = data.start_movement;
  const retryNote = data.retry_note;

  let autoPr: boolean | undefined;
  if (data.auto_pr !== undefined) {
    autoPr = data.auto_pr;
  } else {
    const globalConfig = loadGlobalConfig();
    autoPr = globalConfig.autoPr;
  }

  return { execCwd, execPiece, isWorktree, branch, baseBranch, startMovement, retryNote, autoPr, issueNumber: data.issue };
}

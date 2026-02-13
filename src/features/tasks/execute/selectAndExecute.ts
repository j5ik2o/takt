/**
 * Task execution orchestration.
 *
 * Coordinates piece selection, worktree creation, task execution,
 * auto-commit, and PR creation. Extracted from cli.ts to avoid
 * mixing CLI parsing with business logic.
 */

import {
  listPieces,
  isPiecePath,
} from '../../../infra/config/index.js';
import { confirm } from '../../../shared/prompt/index.js';
import { createSharedClone, summarizeTaskName, getCurrentBranch } from '../../../infra/task/index.js';
import { DEFAULT_PIECE_NAME } from '../../../shared/constants.js';
import { info, error, withProgress } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { executeTask } from './taskExecution.js';
import { resolveAutoPr, postExecutionFlow } from './postExecution.js';
import type { TaskExecutionOptions, WorktreeConfirmationResult, SelectAndExecuteOptions } from './types.js';
import { selectPiece } from '../../pieceSelection/index.js';

export type { WorktreeConfirmationResult, SelectAndExecuteOptions };

const log = createLogger('selectAndExecute');

export async function determinePiece(cwd: string, override?: string): Promise<string | null> {
  if (override) {
    if (isPiecePath(override)) {
      return override;
    }
    const availablePieces = listPieces(cwd);
    const knownPieces = availablePieces.length === 0 ? [DEFAULT_PIECE_NAME] : availablePieces;
    if (!knownPieces.includes(override)) {
      error(`Piece not found: ${override}`);
      return null;
    }
    return override;
  }
  return selectPiece(cwd);
}

export async function confirmAndCreateWorktree(
  cwd: string,
  task: string,
  createWorktreeOverride?: boolean | undefined,
): Promise<WorktreeConfirmationResult> {
  const useWorktree =
    typeof createWorktreeOverride === 'boolean'
      ? createWorktreeOverride
      : await confirm('Create worktree?', true);

  if (!useWorktree) {
    return { execCwd: cwd, isWorktree: false };
  }

  const baseBranch = getCurrentBranch(cwd);

  const taskSlug = await withProgress(
    'Generating branch name...',
    (slug) => `Branch name generated: ${slug}`,
    () => summarizeTaskName(task, { cwd }),
  );

  const result = await withProgress(
    'Creating clone...',
    (cloneResult) => `Clone created: ${cloneResult.path} (branch: ${cloneResult.branch})`,
    async () => createSharedClone(cwd, {
      worktree: true,
      taskSlug,
    }),
  );

  return { execCwd: result.path, isWorktree: true, branch: result.branch, baseBranch };
}

/**
 * Execute a task with piece selection, optional worktree, and auto-commit.
 * Shared by direct task execution and interactive mode.
 */
export async function selectAndExecuteTask(
  cwd: string,
  task: string,
  options?: SelectAndExecuteOptions,
  agentOverrides?: TaskExecutionOptions,
): Promise<void> {
  const pieceIdentifier = await determinePiece(cwd, options?.piece);

  if (pieceIdentifier === null) {
    info('Cancelled');
    return;
  }

  const { execCwd, isWorktree, branch, baseBranch } = await confirmAndCreateWorktree(
    cwd,
    task,
    options?.createWorktree,
  );

  // Ask for PR creation BEFORE execution (only if worktree is enabled)
  let shouldCreatePr = false;
  if (isWorktree) {
    shouldCreatePr = await resolveAutoPr(options?.autoPr);
  }

  log.info('Starting task execution', { piece: pieceIdentifier, worktree: isWorktree, autoPr: shouldCreatePr });
  const taskSuccess = await executeTask({
    task,
    cwd: execCwd,
    pieceIdentifier,
    projectCwd: cwd,
    agentOverrides,
    interactiveUserInput: options?.interactiveUserInput === true,
    interactiveMetadata: options?.interactiveMetadata,
  });

  if (taskSuccess && isWorktree) {
    await postExecutionFlow({
      execCwd,
      projectCwd: cwd,
      task,
      branch,
      baseBranch,
      shouldCreatePr,
      pieceIdentifier,
      issues: options?.issues,
      repo: options?.repo,
    });
  }

  if (!taskSuccess) {
    process.exit(1);
  }
}

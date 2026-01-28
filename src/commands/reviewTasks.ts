/**
 * Review tasks command
 *
 * Interactive UI for reviewing worktree-based task results:
 * try merge, merge & cleanup, or delete actions.
 */

import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import {
  removeWorktree,
  detectDefaultBranch,
  listTaktWorktrees,
  buildReviewItems,
  type WorktreeReviewItem,
} from '../task/worktree.js';
import { selectOption, confirm } from '../prompt/index.js';
import { info, success, error as logError, warn } from '../utils/ui.js';
import { createLogger } from '../utils/debug.js';

const log = createLogger('review-tasks');

/** Actions available for a reviewed worktree */
export type ReviewAction = 'try' | 'merge' | 'delete';

/**
 * Check if a branch has already been merged into HEAD.
 */
export function isBranchMerged(projectDir: string, branch: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Show diff stat for a branch and prompt for an action.
 */
async function showDiffAndPromptAction(
  cwd: string,
  defaultBranch: string,
  item: WorktreeReviewItem,
): Promise<ReviewAction | null> {
  console.log();
  console.log(chalk.bold.cyan(`=== ${item.info.branch} ===`));
  console.log();

  // Show diff stat
  try {
    const stat = execFileSync(
      'git', ['diff', '--stat', `${defaultBranch}...${item.info.branch}`],
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    );
    console.log(stat);
  } catch {
    warn('Could not generate diff stat');
  }

  // Prompt action
  const action = await selectOption<ReviewAction>(
    `Action for ${item.info.branch}:`,
    [
      { label: 'Try merge', value: 'try', description: 'Merge without cleanup (keep worktree & branch)' },
      { label: 'Merge & cleanup', value: 'merge', description: 'Merge (if needed) and remove worktree & branch' },
      { label: 'Delete', value: 'delete', description: 'Discard changes, remove worktree and branch' },
    ],
  );

  return action;
}

/**
 * Try-merge: merge the branch without cleanup.
 * Keeps the worktree and branch intact for further review.
 */
export function tryMergeWorktreeBranch(projectDir: string, item: WorktreeReviewItem): boolean {
  const { branch } = item.info;

  try {
    execFileSync('git', ['merge', branch], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    success(`Merged ${branch} (worktree kept)`);
    log.info('Try-merge completed', { branch });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Merge failed: ${msg}`);
    logError('You may need to resolve conflicts manually.');
    log.error('Try-merge failed', { branch, error: msg });
    return false;
  }
}

/**
 * Merge & cleanup: if already merged, skip merge and just cleanup.
 * Otherwise merge first, then cleanup (remove worktree + delete branch).
 */
export function mergeWorktreeBranch(projectDir: string, item: WorktreeReviewItem): boolean {
  const { branch } = item.info;
  const alreadyMerged = isBranchMerged(projectDir, branch);

  try {
    // 1. Remove worktree (must happen before merge to unlock branch)
    removeWorktree(projectDir, item.info.path);

    // 2. Merge only if not already merged
    if (alreadyMerged) {
      info(`${branch} is already merged, skipping merge.`);
      log.info('Branch already merged, cleanup only', { branch });
    } else {
      execFileSync('git', ['merge', branch], {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    }

    // 3. Delete the branch
    try {
      execFileSync('git', ['branch', '-d', branch], {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch {
      warn(`Could not delete branch ${branch}. You may delete it manually.`);
    }

    success(`Merged & cleaned up ${branch}`);
    log.info('Worktree merged & cleaned up', { branch, alreadyMerged });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Merge failed: ${msg}`);
    logError('You may need to resolve conflicts manually.');
    log.error('Merge & cleanup failed', { branch, error: msg });
    return false;
  }
}

/**
 * Delete a worktree and its branch (discard changes).
 */
export function deleteWorktreeBranch(projectDir: string, item: WorktreeReviewItem): boolean {
  const { branch } = item.info;

  try {
    // 1. Remove worktree
    removeWorktree(projectDir, item.info.path);

    // 2. Force-delete the branch
    execFileSync('git', ['branch', '-D', branch], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    success(`Deleted ${branch}`);
    log.info('Worktree deleted', { branch });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Delete failed: ${msg}`);
    log.error('Delete failed', { branch, error: msg });
    return false;
  }
}

/**
 * Main entry point: review worktree tasks interactively.
 */
export async function reviewTasks(cwd: string): Promise<void> {
  log.info('Starting review-tasks');

  const defaultBranch = detectDefaultBranch(cwd);
  let worktrees = listTaktWorktrees(cwd);

  if (worktrees.length === 0) {
    info('No tasks to review.');
    return;
  }

  // Interactive loop
  while (worktrees.length > 0) {
    const items = buildReviewItems(cwd, worktrees, defaultBranch);

    // Build selection options
    const options = items.map((item, idx) => ({
      label: item.info.branch,
      value: String(idx),
      description: `${item.filesChanged} file${item.filesChanged !== 1 ? 's' : ''} changed`,
    }));

    const selected = await selectOption<string>(
      'Review Tasks (Worktrees)',
      options,
    );

    if (selected === null) {
      return;
    }

    const selectedIdx = parseInt(selected, 10);
    const item = items[selectedIdx];
    if (!item) continue;

    const action = await showDiffAndPromptAction(cwd, defaultBranch, item);

    if (action === null) continue;

    switch (action) {
      case 'try':
        tryMergeWorktreeBranch(cwd, item);
        break;
      case 'merge':
        mergeWorktreeBranch(cwd, item);
        break;
      case 'delete': {
        const confirmed = await confirm(
          `Delete ${item.info.branch}? This will discard all changes.`,
          false,
        );
        if (confirmed) {
          deleteWorktreeBranch(cwd, item);
        }
        break;
      }
    }

    // Refresh worktree list after action
    worktrees = listTaktWorktrees(cwd);
  }

  info('All tasks reviewed.');
}

/**
 * Git worktree management
 *
 * Creates and removes git worktrees for task isolation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLogger } from '../utils/debug.js';
import { slugify } from '../utils/slug.js';
import { loadGlobalConfig } from '../config/globalConfig.js';

const log = createLogger('worktree');

export interface WorktreeOptions {
  /** worktree setting: true = auto path, string = custom path */
  worktree: boolean | string;
  /** Branch name (optional, auto-generated if omitted) */
  branch?: string;
  /** Task slug for auto-generated paths/branches */
  taskSlug: string;
}

export interface WorktreeResult {
  /** Absolute path to the worktree */
  path: string;
  /** Branch name used */
  branch: string;
}

/**
 * Generate a timestamp string for paths/branches
 */
function generateTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
}

/**
 * Resolve the worktree path based on options and global config.
 *
 * Priority:
 * 1. Custom path in options.worktree (string)
 * 2. worktree_dir from config.yaml (if set)
 * 3. Default: ../{tree-name} (outside project to avoid Claude Code project detection issues)
 */
function resolveWorktreePath(projectDir: string, options: WorktreeOptions): string {
  const timestamp = generateTimestamp();
  const slug = slugify(options.taskSlug);
  const dirName = slug ? `${timestamp}-${slug}` : timestamp;

  // Custom path specified in task options
  if (typeof options.worktree === 'string') {
    const resolved = path.isAbsolute(options.worktree)
      ? options.worktree
      : path.resolve(projectDir, options.worktree);
    return resolved;
  }

  // Load config to check for worktree_dir setting
  let worktreeBaseDir: string | undefined;
  try {
    const globalConfig = loadGlobalConfig();
    worktreeBaseDir = globalConfig.worktreeDir;
  } catch {
    // Config not found, use default
  }

  if (worktreeBaseDir) {
    // Use configured worktree directory
    const resolved = path.isAbsolute(worktreeBaseDir)
      ? worktreeBaseDir
      : path.resolve(projectDir, worktreeBaseDir);
    return path.join(resolved, dirName);
  }

  // Default: ../{tree-name} (sibling to project directory)
  return path.join(projectDir, '..', dirName);
}

/**
 * Resolve the branch name based on options
 */
function resolveBranchName(options: WorktreeOptions): string {
  if (options.branch) {
    return options.branch;
  }

  // Auto-generate: takt/{timestamp}-{task-slug}
  const timestamp = generateTimestamp();
  const slug = slugify(options.taskSlug);
  return slug ? `takt/${timestamp}-${slug}` : `takt/${timestamp}`;
}

/**
 * Check if a git branch exists
 */
function branchExists(projectDir: string, branch: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', branch], {
      cwd: projectDir,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a git worktree for a task
 *
 * @returns WorktreeResult with path and branch
 * @throws Error if git worktree creation fails
 */
export function createWorktree(projectDir: string, options: WorktreeOptions): WorktreeResult {
  const worktreePath = resolveWorktreePath(projectDir, options);
  const branch = resolveBranchName(options);

  log.info('Creating worktree', { path: worktreePath, branch });

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  // Create worktree (use execFileSync to avoid shell injection)
  if (branchExists(projectDir, branch)) {
    execFileSync('git', ['worktree', 'add', worktreePath, branch], {
      cwd: projectDir,
      stdio: 'pipe',
    });
  } else {
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath], {
      cwd: projectDir,
      stdio: 'pipe',
    });
  }

  log.info('Worktree created', { path: worktreePath, branch });

  return { path: worktreePath, branch };
}

/**
 * Remove a git worktree
 */
export function removeWorktree(projectDir: string, worktreePath: string): void {
  log.info('Removing worktree', { path: worktreePath });

  try {
    execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: projectDir,
      stdio: 'pipe',
    });
    log.info('Worktree removed', { path: worktreePath });
  } catch (err) {
    log.error('Failed to remove worktree', { path: worktreePath, error: String(err) });
  }
}

// --- Review-related types and helpers ---

const TAKT_BRANCH_PREFIX = 'takt/';

/** Parsed worktree entry from git worktree list */
export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
}

/** Worktree with review metadata */
export interface WorktreeReviewItem {
  info: WorktreeInfo;
  filesChanged: number;
  taskSlug: string;
}

/**
 * Detect the default branch name (main or master).
 * Falls back to 'main'.
 */
export function detectDefaultBranch(cwd: string): string {
  try {
    const ref = execFileSync(
      'git', ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    // ref is like "refs/remotes/origin/main"
    const parts = ref.split('/');
    return parts[parts.length - 1] || 'main';
  } catch {
    // Fallback: check if 'main' or 'master' exists
    try {
      execFileSync('git', ['rev-parse', '--verify', 'main'], {
        cwd, encoding: 'utf-8', stdio: 'pipe',
      });
      return 'main';
    } catch {
      try {
        execFileSync('git', ['rev-parse', '--verify', 'master'], {
          cwd, encoding: 'utf-8', stdio: 'pipe',
        });
        return 'master';
      } catch {
        return 'main';
      }
    }
  }
}

/**
 * Parse `git worktree list --porcelain` output into WorktreeInfo entries.
 * Only includes worktrees on branches with the takt/ prefix.
 */
export function parseTaktWorktrees(porcelainOutput: string): WorktreeInfo[] {
  const entries: WorktreeInfo[] = [];
  const blocks = porcelainOutput.trim().split('\n\n');

  for (const block of blocks) {
    const lines = block.split('\n');
    let wtPath = '';
    let commit = '';
    let branch = '';

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        commit = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length);
        branch = ref.replace('refs/heads/', '');
      }
    }

    if (wtPath && branch.startsWith(TAKT_BRANCH_PREFIX)) {
      entries.push({ path: wtPath, branch, commit });
    }
  }

  return entries;
}

/**
 * List all takt-managed worktrees.
 */
export function listTaktWorktrees(projectDir: string): WorktreeInfo[] {
  try {
    const output = execFileSync(
      'git', ['worktree', 'list', '--porcelain'],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
    );
    return parseTaktWorktrees(output);
  } catch (err) {
    log.error('Failed to list worktrees', { error: String(err) });
    return [];
  }
}

/**
 * Get the number of files changed between the default branch and a given branch.
 */
export function getFilesChanged(cwd: string, defaultBranch: string, branch: string): number {
  try {
    const output = execFileSync(
      'git', ['diff', '--numstat', `${defaultBranch}...${branch}`],
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    );
    return output.trim().split('\n').filter(l => l.length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Extract a human-readable task slug from a takt branch name.
 * e.g. "takt/20260128T032800-fix-auth" → "fix-auth"
 */
export function extractTaskSlug(branch: string): string {
  const name = branch.replace(TAKT_BRANCH_PREFIX, '');
  // Remove timestamp prefix (format: YYYYMMDDTHHmmss- or similar)
  const withoutTimestamp = name.replace(/^\d{8,}T?\d{0,6}-?/, '');
  return withoutTimestamp || name;
}

/**
 * Build review items from worktree list, enriching with diff stats.
 */
export function buildReviewItems(
  projectDir: string,
  worktrees: WorktreeInfo[],
  defaultBranch: string,
): WorktreeReviewItem[] {
  return worktrees.map(wt => ({
    info: wt,
    filesChanged: getFilesChanged(projectDir, defaultBranch, wt.branch),
    taskSlug: extractTaskSlug(wt.branch),
  }));
}

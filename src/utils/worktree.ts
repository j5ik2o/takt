/**
 * Git worktree management utilities for takt
 */

import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { createLogger } from './debug.js';

const log = createLogger('worktree');

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseBranch: string;
}

/** Worktree configuration from Planner output */
export interface WorktreeConfig {
  baseBranch: string;
  branchName: string;
}

/**
 * Parse worktree configuration from Planner output
 */
export function parseWorktreeConfig(content: string): WorktreeConfig | null {
  // Match worktree: block with baseBranch and branchName
  const worktreeMatch = content.match(/worktree:\s*\n\s*baseBranch:\s*(\S+)\s*\n\s*branchName:\s*(\S+)/);
  if (worktreeMatch && worktreeMatch[1] && worktreeMatch[2]) {
    return {
      baseBranch: worktreeMatch[1],
      branchName: worktreeMatch[2],
    };
  }
  return null;
}

/**
 * Generate a timestamp string for worktree directory
 */
export function generateTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

/**
 * Sanitize branch name for use in directory name
 */
export function sanitizeBranchName(branchName: string): string {
  return branchName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/**
 * Get the worktrees directory path
 */
export function getWorktreesDir(cwd: string): string {
  return join(resolve(cwd), '.takt', 'worktrees');
}

/**
 * Generate worktree path
 */
export function getWorktreePath(cwd: string, timestamp: string, branchName: string): string {
  const sanitizedBranch = sanitizeBranchName(branchName);
  return join(getWorktreesDir(cwd), `${timestamp}-${sanitizedBranch}`);
}

/**
 * Create a new git worktree with a new branch
 * @param cwd - Current working directory
 * @param branchName - Name of the new branch to create
 * @param baseBranch - Base branch to create the worktree from (required, determined by Planner)
 */
export function createWorktree(
  cwd: string,
  branchName: string,
  baseBranch: string
): WorktreeInfo {
  const timestamp = generateTimestamp();
  const worktreePath = getWorktreePath(cwd, timestamp, branchName);

  // Ensure worktrees directory exists
  const worktreesDir = getWorktreesDir(cwd);
  if (!existsSync(worktreesDir)) {
    mkdirSync(worktreesDir, { recursive: true });
  }

  log.info('Creating worktree', { path: worktreePath, branch: branchName, baseBranch });

  // Fetch latest from origin
  try {
    execFileSync('git', ['fetch', 'origin'], { cwd, stdio: 'pipe' });
  } catch {
    log.debug('Failed to fetch from origin, continuing with local state');
  }

  // Create worktree with new branch (using execFileSync to prevent command injection)
  try {
    const baseRef = `origin/${baseBranch}`;
    execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, baseRef], {
      cwd,
      stdio: 'pipe',
    });
  } catch (e) {
    // If origin/base doesn't exist, try local base
    log.debug('Failed to create from origin, trying local branch', { error: e });
    execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, baseBranch], {
      cwd,
      stdio: 'pipe',
    });
  }

  log.info('Worktree created successfully', { path: worktreePath });

  return {
    path: worktreePath,
    branch: branchName,
    baseBranch,
  };
}

/**
 * Remove a worktree
 */
export function removeWorktree(cwd: string, worktreePath: string): void {
  log.info('Removing worktree', { path: worktreePath });
  execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd, stdio: 'pipe' });
}

/**
 * List all worktrees
 */
export function listWorktrees(cwd: string): string[] {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf-8' });
  const paths: string[] = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      paths.push(line.slice('worktree '.length));
    }
  }
  return paths;
}

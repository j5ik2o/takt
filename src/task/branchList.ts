/**
 * Branch list helpers
 *
 * Functions for listing, parsing, and enriching takt-managed branches
 * with metadata (diff stats, original instruction, task slug).
 * Used by the /list command.
 */

import { execFileSync } from 'node:child_process';
import { createLogger } from '../utils/debug.js';

const log = createLogger('branchList');

/** Branch info from `git branch --list` */
export interface BranchInfo {
  branch: string;
  commit: string;
}

/** Branch with list metadata */
export interface BranchListItem {
  info: BranchInfo;
  filesChanged: number;
  taskSlug: string;
  /** Original task instruction extracted from first commit message */
  originalInstruction: string;
}

const TAKT_BRANCH_PREFIX = 'takt/';

/**
 * Detect the default branch name (main or master).
 * Checks local branch refs directly. Falls back to 'main'.
 */
export function detectDefaultBranch(cwd: string): string {
  try {
    const ref = execFileSync(
      'git', ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    const parts = ref.split('/');
    return parts[parts.length - 1] || 'main';
  } catch {
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
 * List all takt-managed branches.
 */
export function listTaktBranches(projectDir: string): BranchInfo[] {
  try {
    const output = execFileSync(
      'git', ['branch', '--list', 'takt/*', '--format=%(refname:short) %(objectname:short)'],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
    );
    return parseTaktBranches(output);
  } catch (err) {
    log.error('Failed to list takt branches', { error: String(err) });
    return [];
  }
}

/**
 * Parse `git branch --list` formatted output into BranchInfo entries.
 */
export function parseTaktBranches(output: string): BranchInfo[] {
  const entries: BranchInfo[] = [];
  const lines = output.trim().split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const spaceIdx = trimmed.lastIndexOf(' ');
    if (spaceIdx === -1) continue;

    const branch = trimmed.slice(0, spaceIdx);
    const commit = trimmed.slice(spaceIdx + 1);

    if (branch.startsWith(TAKT_BRANCH_PREFIX)) {
      entries.push({ branch, commit });
    }
  }

  return entries;
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
 * e.g. "takt/20260128T032800-fix-auth" -> "fix-auth"
 */
export function extractTaskSlug(branch: string): string {
  const name = branch.replace(TAKT_BRANCH_PREFIX, '');
  const withoutTimestamp = name.replace(/^\d{8,}T?\d{0,6}-?/, '');
  return withoutTimestamp || name;
}

/**
 * Extract the original task instruction from the first commit message on a branch.
 *
 * The first commit on a takt branch has the format: "takt: {original instruction}".
 * Strips the "takt: " prefix and returns the instruction text.
 * Returns empty string if extraction fails.
 */
export function getOriginalInstruction(
  cwd: string,
  defaultBranch: string,
  branch: string,
): string {
  try {
    const output = execFileSync(
      'git',
      ['log', '--format=%s', '--reverse', `${defaultBranch}..${branch}`],
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();

    if (!output) return '';

    const firstLine = output.split('\n')[0] || '';
    const TAKT_COMMIT_PREFIX = 'takt:';
    if (firstLine.startsWith(TAKT_COMMIT_PREFIX)) {
      return firstLine.slice(TAKT_COMMIT_PREFIX.length).trim();
    }

    return firstLine;
  } catch {
    return '';
  }
}

/**
 * Build list items from branch list, enriching with diff stats.
 */
export function buildListItems(
  projectDir: string,
  branches: BranchInfo[],
  defaultBranch: string,
): BranchListItem[] {
  return branches.map(br => ({
    info: br,
    filesChanged: getFilesChanged(projectDir, defaultBranch, br.branch),
    taskSlug: extractTaskSlug(br.branch),
    originalInstruction: getOriginalInstruction(projectDir, defaultBranch, br.branch),
  }));
}

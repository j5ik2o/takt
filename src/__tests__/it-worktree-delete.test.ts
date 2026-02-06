/**
 * Integration test for branch deletion
 *
 * Tests that takt branches can be properly deleted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { listTaktBranches } from '../infra/task/branchList.js';
import { deleteBranch } from '../features/tasks/list/taskActions.js';

describe('branch deletion', () => {
  let testDir: string;

  beforeEach(() => {
    // Create temporary git repository
    testDir = join(tmpdir(), `takt-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Initialize git repo
    execFileSync('git', ['init'], { cwd: testDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });

    // Create initial commit
    writeFileSync(join(testDir, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });
  });

  afterEach(() => {
    // Cleanup
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should delete regular branches normally', () => {
    const defaultBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: testDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    // Create a regular local branch
    const branchName = 'takt/20260203T1002-regular-branch';
    execFileSync('git', ['checkout', '-b', branchName], { cwd: testDir });

    // Make a change
    writeFileSync(join(testDir, 'test.txt'), 'test content');
    execFileSync('git', ['add', 'test.txt'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'Test change'], { cwd: testDir });

    // Switch back to main
    execFileSync('git', ['checkout', defaultBranch || 'main'], { cwd: testDir });

    // Verify branch exists
    const branchesBefore = listTaktBranches(testDir);
    const foundBefore = branchesBefore.find(b => b.branch === branchName);
    expect(foundBefore).toBeDefined();
    expect(foundBefore?.worktreePath).toBeUndefined();

    // Delete branch
    const result = deleteBranch(testDir, {
      info: foundBefore!,
      filesChanged: 1,
      taskSlug: '20260203T1002-regular-branch',
      originalInstruction: 'Test instruction',
    });

    // Verify deletion succeeded
    expect(result).toBe(true);

    // Verify branch is no longer listed
    const branchesAfter = listTaktBranches(testDir);
    const foundAfter = branchesAfter.find(b => b.branch === branchName);
    expect(foundAfter).toBeUndefined();
  });
});

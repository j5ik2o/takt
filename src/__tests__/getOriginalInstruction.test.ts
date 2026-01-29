/**
 * Tests for getOriginalInstruction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process.execFileSync
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);

import { getOriginalInstruction } from '../task/branchList.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOriginalInstruction', () => {
  it('should extract instruction from takt-prefixed commit message', () => {
    mockExecFileSync.mockReturnValue('takt: 認証機能を追加する\ntakt: fix-auth\n');

    const result = getOriginalInstruction('/project', 'main', 'takt/20260128-fix-auth');

    expect(result).toBe('認証機能を追加する');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['log', '--format=%s', '--reverse', 'main..takt/20260128-fix-auth'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
  });

  it('should return first commit message without takt prefix if not present', () => {
    mockExecFileSync.mockReturnValue('Initial implementation\n');

    const result = getOriginalInstruction('/project', 'main', 'takt/20260128-fix-auth');

    expect(result).toBe('Initial implementation');
  });

  it('should return empty string when no commits on branch', () => {
    mockExecFileSync.mockReturnValue('');

    const result = getOriginalInstruction('/project', 'main', 'takt/20260128-fix-auth');

    expect(result).toBe('');
  });

  it('should return empty string when git command fails', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repository');
    });

    const result = getOriginalInstruction('/non-existent', 'main', 'takt/20260128-fix-auth');

    expect(result).toBe('');
  });

  it('should handle multi-line commit messages (use only first line)', () => {
    mockExecFileSync.mockReturnValue('takt: Fix the login bug\ntakt: follow-up fix\n');

    const result = getOriginalInstruction('/project', 'main', 'takt/20260128-fix-login');

    expect(result).toBe('Fix the login bug');
  });

  it('should return empty string when takt prefix has no content', () => {
    // "takt: \n" trimmed → "takt:", starts with "takt:" → slice + trim → ""
    mockExecFileSync.mockReturnValue('takt: \n');

    const result = getOriginalInstruction('/project', 'main', 'takt/20260128-task');

    expect(result).toBe('');
  });

  it('should return instruction text when takt prefix has content', () => {
    mockExecFileSync.mockReturnValue('takt: add search feature\n');

    const result = getOriginalInstruction('/project', 'main', 'takt/20260128-task');

    expect(result).toBe('add search feature');
  });

  it('should use correct git range with custom default branch', () => {
    mockExecFileSync.mockReturnValue('takt: Add search feature\n');

    getOriginalInstruction('/project', 'master', 'takt/20260128-add-search');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['log', '--format=%s', '--reverse', 'master..takt/20260128-add-search'],
      expect.objectContaining({ cwd: '/project' }),
    );
  });
});

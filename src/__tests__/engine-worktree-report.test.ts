/**
 * Tests for worktree environment: reportDir should use cwd (clone dir), not projectCwd.
 *
 * Issue #67: In worktree mode, the agent's sandbox blocks writes to projectCwd paths.
 * reportDir must be resolved relative to cwd so the agent writes via the symlink.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// --- Mock setup (must be before imports that use these modules) ---

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../workflow/rule-evaluator.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(''),
}));

vi.mock('../utils/session.js', () => ({
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

// --- Imports (after mocks) ---

import { WorkflowEngine } from '../workflow/engine.js';
import { runReportPhase } from '../workflow/phase-runner.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  applyDefaultMocks,
} from './engine-test-helpers.js';
import type { WorkflowConfig } from '../models/types.js';

function createWorktreeDirs(): { projectCwd: string; cloneCwd: string } {
  const base = join(tmpdir(), `takt-worktree-test-${randomUUID()}`);
  const projectCwd = join(base, 'project');
  const cloneCwd = join(base, 'clone');

  // Project side: real .takt/reports directory
  mkdirSync(join(projectCwd, '.takt', 'reports', 'test-report-dir'), { recursive: true });

  // Clone side: .takt directory with symlink to project's reports
  mkdirSync(join(cloneCwd, '.takt'), { recursive: true });
  symlinkSync(
    join(projectCwd, '.takt', 'reports'),
    join(cloneCwd, '.takt', 'reports'),
  );

  return { projectCwd, cloneCwd };
}

function buildSimpleConfig(): WorkflowConfig {
  return {
    name: 'worktree-test',
    description: 'Test workflow for worktree',
    maxIterations: 10,
    initialStep: 'review',
    steps: [
      makeStep('review', {
        report: '00-review.md',
        rules: [
          makeRule('approved', 'COMPLETE'),
        ],
      }),
    ],
  };
}

describe('WorkflowEngine: worktree reportDir resolution', () => {
  let projectCwd: string;
  let cloneCwd: string;
  let baseDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    const dirs = createWorktreeDirs();
    projectCwd = dirs.projectCwd;
    cloneCwd = dirs.cloneCwd;
    baseDir = join(cloneCwd, '..');
  });

  afterEach(() => {
    if (existsSync(baseDir)) {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('should pass cwd-based reportDir to phase runner context in worktree mode', async () => {
    // Given: worktree environment where cwd !== projectCwd
    const config = buildSimpleConfig();
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
    });

    mockRunAgentSequence([
      makeResponse({ agent: 'review', content: 'Review done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'tag' as const },
    ]);

    // When: run the workflow
    await engine.run();

    // Then: runReportPhase was called with context containing cwd-based reportDir
    const reportPhaseMock = vi.mocked(runReportPhase);
    expect(reportPhaseMock).toHaveBeenCalled();
    const phaseCtx = reportPhaseMock.mock.calls[0][2] as { reportDir: string };

    // reportDir should be resolved from cloneCwd (cwd), not projectCwd
    const expectedPath = join(cloneCwd, '.takt/reports/test-report-dir');
    const unexpectedPath = join(projectCwd, '.takt/reports/test-report-dir');

    expect(phaseCtx.reportDir).toBe(expectedPath);
    expect(phaseCtx.reportDir).not.toBe(unexpectedPath);
  });

  it('should pass cwd-based reportDir to buildInstruction (used by {report_dir} placeholder)', async () => {
    // Given: worktree environment with a step that uses {report_dir} in template
    const config: WorkflowConfig = {
      name: 'worktree-test',
      description: 'Test',
      maxIterations: 10,
      initialStep: 'review',
      steps: [
        makeStep('review', {
          instructionTemplate: 'Write report to {report_dir}',
          report: '00-review.md',
          rules: [
            makeRule('approved', 'COMPLETE'),
          ],
        }),
      ],
    };
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
    });

    const { runAgent } = await import('../agents/runner.js');
    mockRunAgentSequence([
      makeResponse({ agent: 'review', content: 'Review done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'tag' as const },
    ]);

    // When: run the workflow
    await engine.run();

    // Then: the instruction should contain cwd-based reportDir
    const runAgentMock = vi.mocked(runAgent);
    expect(runAgentMock).toHaveBeenCalled();
    const instruction = runAgentMock.mock.calls[0][1] as string;

    const expectedPath = join(cloneCwd, '.takt/reports/test-report-dir');
    expect(instruction).toContain(expectedPath);
    // In worktree mode, projectCwd path should NOT appear
    expect(instruction).not.toContain(join(projectCwd, '.takt/reports/test-report-dir'));
  });

  it('should use same path in non-worktree mode (cwd === projectCwd)', async () => {
    // Given: normal environment where cwd === projectCwd
    const normalDir = projectCwd;
    const config = buildSimpleConfig();
    const engine = new WorkflowEngine(config, normalDir, 'test task', {
      projectCwd: normalDir,
    });

    mockRunAgentSequence([
      makeResponse({ agent: 'review', content: 'Review done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'tag' as const },
    ]);

    // When: run the workflow
    await engine.run();

    // Then: reportDir should be the same (cwd === projectCwd)
    const reportPhaseMock = vi.mocked(runReportPhase);
    expect(reportPhaseMock).toHaveBeenCalled();
    const phaseCtx = reportPhaseMock.mock.calls[0][2] as { reportDir: string };

    const expectedPath = join(normalDir, '.takt/reports/test-report-dir');
    expect(phaseCtx.reportDir).toBe(expectedPath);
  });
});

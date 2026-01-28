/**
 * Tests for instruction-builder module
 */

import { describe, it, expect } from 'vitest';
import { buildInstruction, type InstructionContext } from '../workflow/instruction-builder.js';
import type { WorkflowStep } from '../models/types.js';

function createMinimalStep(template: string): WorkflowStep {
  return {
    name: 'test-step',
    agent: 'test-agent',
    agentDisplayName: 'Test Agent',
    instructionTemplate: template,
    transitions: [],
    passPreviousResponse: false,
  };
}

function createMinimalContext(overrides: Partial<InstructionContext> = {}): InstructionContext {
  return {
    task: 'Test task',
    iteration: 1,
    maxIterations: 10,
    stepIteration: 1,
    cwd: '/project',
    userInputs: [],
    ...overrides,
  };
}

describe('instruction-builder', () => {
  describe('report_dir replacement', () => {
    it('should replace .takt/reports/{report_dir} with full absolute path', () => {
      const step = createMinimalStep(
        '- Report Directory: .takt/reports/{report_dir}/'
      );
      const context = createMinimalContext({
        cwd: '/project',
        reportDir: '20260128-test-report',
      });

      const result = buildInstruction(step, context);

      expect(result).toBe(
        '- Report Directory: /project/.takt/reports/20260128-test-report/'
      );
    });

    it('should use projectCwd for report path when cwd is a worktree', () => {
      const step = createMinimalStep(
        '- Report: .takt/reports/{report_dir}/00-plan.md'
      );
      const context = createMinimalContext({
        cwd: '/project/.takt/worktrees/my-task',
        projectCwd: '/project',
        reportDir: '20260128-worktree-report',
      });

      const result = buildInstruction(step, context);

      expect(result).toBe(
        '- Report: /project/.takt/reports/20260128-worktree-report/00-plan.md'
      );
      // Should NOT contain the worktree path
      expect(result).not.toContain('/project/.takt/worktrees/');
    });

    it('should replace multiple .takt/reports/{report_dir} occurrences', () => {
      const step = createMinimalStep(
        '- Scope: .takt/reports/{report_dir}/01-scope.md\n- Decisions: .takt/reports/{report_dir}/02-decisions.md'
      );
      const context = createMinimalContext({
        projectCwd: '/project',
        cwd: '/worktree',
        reportDir: '20260128-multi',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('/project/.takt/reports/20260128-multi/01-scope.md');
      expect(result).toContain('/project/.takt/reports/20260128-multi/02-decisions.md');
    });

    it('should replace standalone {report_dir} with directory name only', () => {
      const step = createMinimalStep(
        'Report dir name: {report_dir}'
      );
      const context = createMinimalContext({
        reportDir: '20260128-standalone',
      });

      const result = buildInstruction(step, context);

      expect(result).toBe('Report dir name: 20260128-standalone');
    });

    it('should fall back to cwd when projectCwd is not provided', () => {
      const step = createMinimalStep(
        '- Dir: .takt/reports/{report_dir}/'
      );
      const context = createMinimalContext({
        cwd: '/fallback-project',
        reportDir: '20260128-fallback',
      });
      // projectCwd intentionally omitted

      const result = buildInstruction(step, context);

      expect(result).toBe(
        '- Dir: /fallback-project/.takt/reports/20260128-fallback/'
      );
    });
  });

  describe('basic placeholder replacement', () => {
    it('should replace {task} placeholder', () => {
      const step = createMinimalStep('Execute: {task}');
      const context = createMinimalContext({ task: 'Build the app' });

      const result = buildInstruction(step, context);

      expect(result).toContain('Build the app');
    });

    it('should replace {iteration} and {max_iterations}', () => {
      const step = createMinimalStep('Step {iteration}/{max_iterations}');
      const context = createMinimalContext({ iteration: 3, maxIterations: 20 });

      const result = buildInstruction(step, context);

      expect(result).toBe('Step 3/20');
    });

    it('should replace {step_iteration}', () => {
      const step = createMinimalStep('Run #{step_iteration}');
      const context = createMinimalContext({ stepIteration: 2 });

      const result = buildInstruction(step, context);

      expect(result).toBe('Run #2');
    });
  });
});

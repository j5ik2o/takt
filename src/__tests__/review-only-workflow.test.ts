/**
 * Tests for review-only workflow
 *
 * Covers:
 * - Workflow YAML files (EN/JA) load and pass schema validation
 * - Workflow structure: plan -> reviewers (parallel) -> supervise -> pr-comment
 * - All movements have edit: false
 * - pr-commenter agent has Bash in allowed_tools
 * - Routing rules for local vs PR comment flows
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WorkflowConfigRawSchema } from '../core/models/index.js';

const RESOURCES_DIR = join(import.meta.dirname, '../../resources/global');

function loadReviewOnlyYaml(lang: 'en' | 'ja') {
  const filePath = join(RESOURCES_DIR, lang, 'pieces', 'review-only.yaml');
  const content = readFileSync(filePath, 'utf-8');
  return parseYaml(content);
}

describe('review-only workflow (EN)', () => {
  const raw = loadReviewOnlyYaml('en');

  it('should pass schema validation', () => {
    const result = WorkflowConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should have correct name and initial_movement', () => {
    expect(raw.name).toBe('review-only');
    expect(raw.initial_movement).toBe('plan');
  });

  it('should have max_iterations of 10', () => {
    expect(raw.max_iterations).toBe(10);
  });

  it('should have 4 movements: plan, reviewers, supervise, pr-comment', () => {
    const movementNames = raw.movements.map((s: { name: string }) => s.name);
    expect(movementNames).toEqual(['plan', 'reviewers', 'supervise', 'pr-comment']);
  });

  it('should have all movements with edit: false', () => {
    for (const movement of raw.movements) {
      if (movement.edit !== undefined) {
        expect(movement.edit).toBe(false);
      }
      if (movement.parallel) {
        for (const sub of movement.parallel) {
          if (sub.edit !== undefined) {
            expect(sub.edit).toBe(false);
          }
        }
      }
    }
  });

  it('should have reviewers movement with 3 parallel sub-movements', () => {
    const reviewers = raw.movements.find((s: { name: string }) => s.name === 'reviewers');
    expect(reviewers).toBeDefined();
    expect(reviewers.parallel).toHaveLength(3);

    const subNames = reviewers.parallel.map((s: { name: string }) => s.name);
    expect(subNames).toEqual(['arch-review', 'security-review', 'ai-review']);
  });

  it('should have reviewers movement with aggregate rules', () => {
    const reviewers = raw.movements.find((s: { name: string }) => s.name === 'reviewers');
    expect(reviewers.rules).toHaveLength(2);
    expect(reviewers.rules[0].condition).toBe('all("approved")');
    expect(reviewers.rules[0].next).toBe('supervise');
    expect(reviewers.rules[1].condition).toBe('any("needs_fix")');
    expect(reviewers.rules[1].next).toBe('supervise');
  });

  it('should have supervise movement with routing rules for local and PR flows', () => {
    const supervise = raw.movements.find((s: { name: string }) => s.name === 'supervise');
    expect(supervise.rules).toHaveLength(3);

    const conditions = supervise.rules.map((r: { condition: string }) => r.condition);
    expect(conditions).toContain('approved, PR comment requested');
    expect(conditions).toContain('approved');
    expect(conditions).toContain('rejected');

    const prRule = supervise.rules.find((r: { condition: string }) => r.condition === 'approved, PR comment requested');
    expect(prRule.next).toBe('pr-comment');

    const localRule = supervise.rules.find((r: { condition: string }) => r.condition === 'approved');
    expect(localRule.next).toBe('COMPLETE');

    const rejectRule = supervise.rules.find((r: { condition: string }) => r.condition === 'rejected');
    expect(rejectRule.next).toBe('ABORT');
  });

  it('should have pr-comment movement with Bash in allowed_tools', () => {
    const prComment = raw.movements.find((s: { name: string }) => s.name === 'pr-comment');
    expect(prComment).toBeDefined();
    expect(prComment.allowed_tools).toContain('Bash');
  });

  it('should have pr-comment movement using pr-commenter agent', () => {
    const prComment = raw.movements.find((s: { name: string }) => s.name === 'pr-comment');
    expect(prComment.agent).toContain('review/pr-commenter.md');
  });

  it('should have plan movement reusing default planner agent', () => {
    const plan = raw.movements.find((s: { name: string }) => s.name === 'plan');
    expect(plan.agent).toContain('default/planner.md');
  });

  it('should have supervise movement reusing default supervisor agent', () => {
    const supervise = raw.movements.find((s: { name: string }) => s.name === 'supervise');
    expect(supervise.agent).toContain('default/supervisor.md');
  });

  it('should not have any movement with edit: true', () => {
    for (const movement of raw.movements) {
      expect(movement.edit).not.toBe(true);
      if (movement.parallel) {
        for (const sub of movement.parallel) {
          expect(sub.edit).not.toBe(true);
        }
      }
    }
  });

  it('reviewer sub-movements should not have Bash in allowed_tools', () => {
    const reviewers = raw.movements.find((s: { name: string }) => s.name === 'reviewers');
    for (const sub of reviewers.parallel) {
      expect(sub.allowed_tools).not.toContain('Bash');
    }
  });
});

describe('review-only workflow (JA)', () => {
  const raw = loadReviewOnlyYaml('ja');

  it('should pass schema validation', () => {
    const result = WorkflowConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should have correct name and initial_movement', () => {
    expect(raw.name).toBe('review-only');
    expect(raw.initial_movement).toBe('plan');
  });

  it('should have same movement structure as EN version', () => {
    const movementNames = raw.movements.map((s: { name: string }) => s.name);
    expect(movementNames).toEqual(['plan', 'reviewers', 'supervise', 'pr-comment']);
  });

  it('should have reviewers movement with 3 parallel sub-movements', () => {
    const reviewers = raw.movements.find((s: { name: string }) => s.name === 'reviewers');
    expect(reviewers.parallel).toHaveLength(3);

    const subNames = reviewers.parallel.map((s: { name: string }) => s.name);
    expect(subNames).toEqual(['arch-review', 'security-review', 'ai-review']);
  });

  it('should have all movements with edit: false or undefined', () => {
    for (const movement of raw.movements) {
      expect(movement.edit).not.toBe(true);
      if (movement.parallel) {
        for (const sub of movement.parallel) {
          expect(sub.edit).not.toBe(true);
        }
      }
    }
  });

  it('should have pr-comment movement with Bash in allowed_tools', () => {
    const prComment = raw.movements.find((s: { name: string }) => s.name === 'pr-comment');
    expect(prComment.allowed_tools).toContain('Bash');
  });

  it('should have same aggregate rules on reviewers', () => {
    const reviewers = raw.movements.find((s: { name: string }) => s.name === 'reviewers');
    expect(reviewers.rules[0].condition).toBe('all("approved")');
    expect(reviewers.rules[1].condition).toBe('any("needs_fix")');
  });
});

describe('pr-commenter agent files', () => {
  it('should exist for EN with domain knowledge', () => {
    const filePath = join(RESOURCES_DIR, 'en', 'agents', 'review', 'pr-commenter.md');
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('PR Commenter');
    expect(content).toContain('gh api');
    expect(content).toContain('gh pr comment');
  });

  it('should exist for JA with domain knowledge', () => {
    const filePath = join(RESOURCES_DIR, 'ja', 'agents', 'review', 'pr-commenter.md');
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('PR Commenter');
    expect(content).toContain('gh api');
    expect(content).toContain('gh pr comment');
  });

  it('should NOT contain workflow-specific report names (EN)', () => {
    const filePath = join(RESOURCES_DIR, 'en', 'agents', 'review', 'pr-commenter.md');
    const content = readFileSync(filePath, 'utf-8');
    // Agent should not reference specific review-only workflow report files
    expect(content).not.toContain('01-architect-review.md');
    expect(content).not.toContain('02-security-review.md');
    expect(content).not.toContain('03-ai-review.md');
    expect(content).not.toContain('04-review-summary.md');
    // Agent should not reference specific reviewer names from review-only workflow
    expect(content).not.toContain('Architecture review report');
    expect(content).not.toContain('Security review report');
    expect(content).not.toContain('AI antipattern review report');
  });

  it('should NOT contain workflow-specific report names (JA)', () => {
    const filePath = join(RESOURCES_DIR, 'ja', 'agents', 'review', 'pr-commenter.md');
    const content = readFileSync(filePath, 'utf-8');
    expect(content).not.toContain('01-architect-review.md');
    expect(content).not.toContain('02-security-review.md');
    expect(content).not.toContain('03-ai-review.md');
    expect(content).not.toContain('04-review-summary.md');
  });
});

describe('pr-comment instruction_template contains workflow-specific procedures', () => {
  it('EN: should reference specific report files', () => {
    const raw = loadReviewOnlyYaml('en');
    const prComment = raw.movements.find((s: { name: string }) => s.name === 'pr-comment');
    const template = prComment.instruction_template;
    expect(template).toContain('01-architect-review.md');
    expect(template).toContain('02-security-review.md');
    expect(template).toContain('03-ai-review.md');
    expect(template).toContain('04-review-summary.md');
  });

  it('JA: should reference specific report files', () => {
    const raw = loadReviewOnlyYaml('ja');
    const prComment = raw.movements.find((s: { name: string }) => s.name === 'pr-comment');
    const template = prComment.instruction_template;
    expect(template).toContain('01-architect-review.md');
    expect(template).toContain('02-security-review.md');
    expect(template).toContain('03-ai-review.md');
    expect(template).toContain('04-review-summary.md');
  });
});

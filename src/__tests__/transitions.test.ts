/**
 * Tests for workflow transitions module (movement-based)
 */

import { describe, it, expect } from 'vitest';
import { determineNextMovementByRules } from '../core/workflow/index.js';
import type { WorkflowMovement } from '../core/models/index.js';

function createMovementWithRules(rules: { condition: string; next: string }[]): WorkflowMovement {
  return {
    name: 'test-step',
    agent: 'test-agent',
    agentDisplayName: 'Test Agent',
    instructionTemplate: '{task}',
    passPreviousResponse: false,
    rules: rules.map((r) => ({
      condition: r.condition,
      next: r.next,
    })),
  };
}

describe('determineNextMovementByRules', () => {
  it('should return next movement for valid rule index', () => {
    const step = createMovementWithRules([
      { condition: 'Clear', next: 'implement' },
      { condition: 'Blocked', next: 'ABORT' },
    ]);

    expect(determineNextMovementByRules(step, 0)).toBe('implement');
    expect(determineNextMovementByRules(step, 1)).toBe('ABORT');
  });

  it('should return null for out-of-bounds index', () => {
    const step = createMovementWithRules([
      { condition: 'Clear', next: 'implement' },
    ]);

    expect(determineNextMovementByRules(step, 1)).toBeNull();
    expect(determineNextMovementByRules(step, -1)).toBeNull();
    expect(determineNextMovementByRules(step, 100)).toBeNull();
  });

  it('should return null when movement has no rules', () => {
    const step: WorkflowMovement = {
      name: 'test-step',
      agent: 'test-agent',
      agentDisplayName: 'Test Agent',
      instructionTemplate: '{task}',
      passPreviousResponse: false,
    };

    expect(determineNextMovementByRules(step, 0)).toBeNull();
  });

  it('should handle COMPLETE as next movement', () => {
    const step = createMovementWithRules([
      { condition: 'All passed', next: 'COMPLETE' },
    ]);

    expect(determineNextMovementByRules(step, 0)).toBe('COMPLETE');
  });

  it('should return null when rule exists but next is undefined', () => {
    // Parallel sub-movement rules may omit `next` (optional field)
    const step: WorkflowMovement = {
      name: 'sub-step',
      agent: 'test-agent',
      agentDisplayName: 'Test Agent',
      instructionTemplate: '{task}',
      passPreviousResponse: false,
      rules: [
        { condition: 'approved' },
        { condition: 'needs_fix' },
      ],
    };

    expect(determineNextMovementByRules(step, 0)).toBeNull();
    expect(determineNextMovementByRules(step, 1)).toBeNull();
  });
});

/**
 * Tests for takt models
 */

import { describe, it, expect } from 'vitest';
import {
  AgentTypeSchema,
  StatusSchema,
  TransitionConditionSchema,
  WorkflowConfigRawSchema,
  CustomAgentConfigSchema,
  GlobalConfigSchema,
  GENERIC_STATUS_PATTERNS,
} from '../models/schemas.js';

describe('AgentTypeSchema', () => {
  it('should accept valid agent types', () => {
    expect(AgentTypeSchema.parse('coder')).toBe('coder');
    expect(AgentTypeSchema.parse('architect')).toBe('architect');
    expect(AgentTypeSchema.parse('supervisor')).toBe('supervisor');
    expect(AgentTypeSchema.parse('custom')).toBe('custom');
  });

  it('should reject invalid agent types', () => {
    expect(() => AgentTypeSchema.parse('invalid')).toThrow();
  });
});

describe('StatusSchema', () => {
  it('should accept valid statuses', () => {
    expect(StatusSchema.parse('pending')).toBe('pending');
    expect(StatusSchema.parse('done')).toBe('done');
    expect(StatusSchema.parse('approved')).toBe('approved');
    expect(StatusSchema.parse('rejected')).toBe('rejected');
    expect(StatusSchema.parse('blocked')).toBe('blocked');
  });

  it('should reject invalid statuses', () => {
    expect(() => StatusSchema.parse('unknown')).toThrow();
    expect(() => StatusSchema.parse('conditional')).toThrow();
  });
});

describe('TransitionConditionSchema', () => {
  it('should accept valid conditions', () => {
    expect(TransitionConditionSchema.parse('done')).toBe('done');
    expect(TransitionConditionSchema.parse('approved')).toBe('approved');
    expect(TransitionConditionSchema.parse('rejected')).toBe('rejected');
    expect(TransitionConditionSchema.parse('always')).toBe('always');
  });

  it('should reject invalid conditions', () => {
    expect(() => TransitionConditionSchema.parse('conditional')).toThrow();
    expect(() => TransitionConditionSchema.parse('fixed')).toThrow();
  });
});

describe('WorkflowConfigRawSchema', () => {
  it('should parse valid workflow config', () => {
    const config = {
      name: 'test-workflow',
      description: 'A test workflow',
      steps: [
        {
          name: 'step1',
          agent: 'coder',
          allowed_tools: ['Read', 'Grep'],
          instruction: '{task}',
          transitions: [
            { condition: 'done', next_step: 'COMPLETE' },
          ],
        },
      ],
    };

    const result = WorkflowConfigRawSchema.parse(config);
    expect(result.name).toBe('test-workflow');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.allowed_tools).toEqual(['Read', 'Grep']);
    expect(result.max_iterations).toBe(10);
  });

  it('should require at least one step', () => {
    const config = {
      name: 'empty-workflow',
      steps: [],
    };

    expect(() => WorkflowConfigRawSchema.parse(config)).toThrow();
  });
});

describe('CustomAgentConfigSchema', () => {
  it('should accept agent with prompt', () => {
    const config = {
      name: 'my-agent',
      prompt: 'You are a helpful assistant.',
    };

    const result = CustomAgentConfigSchema.parse(config);
    expect(result.name).toBe('my-agent');
  });

  it('should accept agent with prompt_file', () => {
    const config = {
      name: 'my-agent',
      prompt_file: '/path/to/prompt.md',
    };

    const result = CustomAgentConfigSchema.parse(config);
    expect(result.prompt_file).toBe('/path/to/prompt.md');
  });

  it('should accept agent with claude_agent', () => {
    const config = {
      name: 'my-agent',
      claude_agent: 'architect',
    };

    const result = CustomAgentConfigSchema.parse(config);
    expect(result.claude_agent).toBe('architect');
  });

  it('should accept agent with provider override', () => {
    const config = {
      name: 'my-agent',
      prompt: 'You are a helpful assistant.',
      provider: 'codex',
    };

    const result = CustomAgentConfigSchema.parse(config);
    expect(result.provider).toBe('codex');
  });

  it('should reject agent without any prompt source', () => {
    const config = {
      name: 'my-agent',
    };

    expect(() => CustomAgentConfigSchema.parse(config)).toThrow();
  });
});

describe('GlobalConfigSchema', () => {
  it('should provide defaults', () => {
    const config = {};
    const result = GlobalConfigSchema.parse(config);

    expect(result.trusted_directories).toEqual([]);
    expect(result.default_workflow).toBe('default');
    expect(result.log_level).toBe('info');
    expect(result.provider).toBe('claude');
  });

  it('should accept valid config', () => {
    const config = {
      trusted_directories: ['/home/user/projects'],
      default_workflow: 'custom',
      log_level: 'debug' as const,
    };

    const result = GlobalConfigSchema.parse(config);
    expect(result.trusted_directories).toHaveLength(1);
    expect(result.log_level).toBe('debug');
  });
});

describe('GENERIC_STATUS_PATTERNS', () => {
  it('should have all standard status patterns', () => {
    expect(GENERIC_STATUS_PATTERNS.approved).toBeDefined();
    expect(GENERIC_STATUS_PATTERNS.rejected).toBeDefined();
    expect(GENERIC_STATUS_PATTERNS.done).toBeDefined();
    expect(GENERIC_STATUS_PATTERNS.blocked).toBeDefined();
    expect(GENERIC_STATUS_PATTERNS.improve).toBeDefined();
  });

  it('should have valid regex patterns', () => {
    for (const pattern of Object.values(GENERIC_STATUS_PATTERNS)) {
      expect(() => new RegExp(pattern)).not.toThrow();
    }
  });

  it('should match any [ROLE:COMMAND] format', () => {
    // Generic patterns match any role
    expect(new RegExp(GENERIC_STATUS_PATTERNS.approved).test('[CODER:APPROVE]')).toBe(true);
    expect(new RegExp(GENERIC_STATUS_PATTERNS.approved).test('[MY_AGENT:APPROVE]')).toBe(true);
    expect(new RegExp(GENERIC_STATUS_PATTERNS.done).test('[CUSTOM:DONE]')).toBe(true);
    expect(new RegExp(GENERIC_STATUS_PATTERNS.done).test('[CODER:FIXED]')).toBe(true);
    expect(new RegExp(GENERIC_STATUS_PATTERNS.improve).test('[MAGI:IMPROVE]')).toBe(true);
  });
});

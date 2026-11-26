import { describe, expect, it } from 'vitest';
import {
  createSelectorContract,
  describeSelectorError,
  validateSelectorResponse,
} from '../core/workflow/selector-contract.js';
import {
  StructuredAgentContractError,
  StructuredAgentResponseError,
  StructuredOutputRejectedError,
} from '../agents/structured-caller/transport.js';
import { createAgentFailureError } from '../shared/types/agent-failure.js';
import type { AgentResponse } from '../core/models/types.js';
import { assertStrictStructuredOutputSchema } from '../core/workflow/engine/structured-output-schema-validator.js';

const identity = (text: string) => text;
const candidates = (names: readonly string[]) => names.map((name) => ({
  name,
  description: `${name} description`,
}));

describe('CandidateSelector strict ID selection primitive (C-SHARED-SELECTOR, C-SELECTOR-OUTPUT, C-SELECTOR-FAILFAST)', () => {
  describe('createSelectorContract', () => {
    it('should produce a provider-compatible schema and preserve semantic validation constraints (C-SELECTOR-OUTPUT)', () => {
      const contract = createSelectorContract(candidates(['backend', 'transaction', 'backward-compatibility']));

      expect(() => assertStrictStructuredOutputSchema(contract.providerSchema)).not.toThrow();
      expect(contract.providerSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: {
          selected_ids: {
            type: 'array',
            items: { type: 'string', enum: ['backend', 'transaction', 'backward-compatibility'] },
          },
          rationale: { type: 'string' },
        },
        required: ['selected_ids', 'rationale'],
      });
      expect(contract.providerSchema).not.toHaveProperty('properties.selected_ids.uniqueItems');
      expect(contract.providerSchema).not.toHaveProperty('properties.selected_ids.maxItems');
      expect(contract.validationSchema).toHaveProperty('properties.selected_ids.uniqueItems', true);
    });

    it('should produce one shared contract shape for all selector consumers (C-SHARED-SELECTOR)', () => {
      const contract = createSelectorContract(candidates(['a', 'b']));
      expect(contract.validationSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: {
          selected_ids: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['a', 'b'] } },
          rationale: { type: 'string' },
        },
        required: ['selected_ids', 'rationale'],
      });
    });

    it('should include maxItems in both schemas when maxSelected is specified (C-SELECTOR-OUTPUT: max_selected)', () => {
      const contract = createSelectorContract(candidates(['a', 'b', 'c']), 2);
      expect(contract.providerSchema).toHaveProperty('properties.selected_ids.maxItems', 2);
      expect(contract.validationSchema).toHaveProperty('properties.selected_ids.maxItems', 2);
      expect(contract.validationSchema).toHaveProperty('properties.selected_ids.uniqueItems', true);
    });
  });

  describe('validateSelectorResponse', () => {
    const poolIds = ['backend', 'transaction', 'backward-compatibility'];
    const poolContract = createSelectorContract(candidates(poolIds));

    it('should accept a valid selection with unique IDs within the pool enum (C-SELECTOR-OUTPUT)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: {
          selected_ids: ['backend', 'transaction'],
          rationale: 'task needs backend and transaction expertise',
        },
      } as unknown as AgentResponse;

      const result = validateSelectorResponse(response, poolContract, 'fix', identity, { label: 'Dynamic facet' });
      expect(result.selectedIds).toEqual(['backend', 'transaction']);
      expect(result.rationale).toBe('task needs backend and transaction expertise');
    });

    it('should accept an empty selection (C-SELECTOR-OUTPUT: 空選択は正常)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: [], rationale: 'no extra facets needed' },
      } as unknown as AgentResponse;

      const result = validateSelectorResponse(response, poolContract, 'fix', identity, { label: 'Dynamic facet' });
      expect(result.selectedIds).toEqual([]);
    });

    it('should accept a selection exactly at maxSelected (C-SELECTOR-OUTPUT: 境界値)', () => {
      const contract = createSelectorContract(candidates(poolIds), 2);
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: {
          selected_ids: ['backend', 'transaction'],
          rationale: 'two relevant candidates',
        },
      } as unknown as AgentResponse;

      const result = validateSelectorResponse(
        response,
        contract,
        'fix',
        identity,
        { label: 'Dynamic facet' },
      );
      expect(result.selectedIds).toEqual(['backend', 'transaction']);
    });

    it('should redact a valid selector rationale', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: ['backend'], rationale: 'sensitive-value' },
      } as unknown as AgentResponse;

      const result = validateSelectorResponse(
        response,
        poolContract,
        'fix',
        (text) => text.replace('sensitive-value', '[REDACTED]'),
        { label: 'Dynamic facet' },
      );
      expect(result.rationale).toBe('[REDACTED]');
    });

    it('should reject a pool-external ID (C-SELECTOR-FAILFAST: 未知 ID)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: ['unknown-id'], rationale: 'x' },
      } as unknown as AgentResponse;

      const reject = () => validateSelectorResponse(response, poolContract, 'fix', identity, { label: 'Dynamic facet' });

      expect(reject).toThrow('Dynamic facet selector for "fix"');
      expect(reject).toThrow('returned selected_ids: ["unknown-id"]');
      expect(reject).toThrow('allowed candidate ids: ["backend","transaction","backward-compatibility"]');
    });

    it('should reject duplicate IDs (C-SELECTOR-FAILFAST: 重複)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: ['backend', 'backend'], rationale: 'x' },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, poolContract, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject a non-array selected_ids (C-SELECTOR-FAILFAST: 非配列)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: 'backend', rationale: 'x' },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, poolContract, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject a non-string element in selected_ids (C-SELECTOR-FAILFAST: 非文字列)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: ['backend', 123], rationale: 'x' },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, poolContract, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject a missing rationale (C-SELECTOR-OUTPUT: rationale 必須)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: ['backend'] },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, poolContract, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject when structured output is absent (C-SELECTOR-FAILFAST: structured output 不成立)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: undefined,
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, poolContract, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject a failed selector response status (C-SELECTOR-FAIL)', () => {
      const response: AgentResponse = {
        status: 'error',
        content: 'fallback detail',
        error: 'sensitive-provider-detail',
        failureCategory: 'provider_error',
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(
        response,
        poolContract,
        'fix',
        (text) => text.replace('sensitive-provider-detail', '[REDACTED]'),
        { label: 'Dynamic facet' },
      )).toThrow('status "error": category "provider_error": [REDACTED]');
    });

    it('should reject additional properties in the structured output (strict schema)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: {
          selected_ids: ['backend'],
          rationale: 'x',
          extra: 'should not be allowed',
        },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, poolContract, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject duplicate IDs even when the count exceeds max_selected (C-SELECTOR-FAILFAST: 重複かつ超過)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: ['backend', 'transaction', 'backward-compatibility', 'backend'], rationale: 'x' },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, poolContract, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject a selection above maxSelected in the shared validator (C-SELECTOR-FAILFAST: max_selected)', () => {
      const contract = createSelectorContract(candidates(poolIds), 2);
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: {
          selected_ids: ['backend', 'transaction', 'backward-compatibility'],
          rationale: 'all',
        },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(
        response,
        contract,
        'fix',
        identity,
        { label: 'Dynamic facet' },
      )).toThrow();
    });
  });

  describe('describeSelectorError', () => {
    const contract = createSelectorContract(candidates(['backend', 'transaction']));
    const label = { label: 'Dynamic facet' };
    const rejected = (response: Partial<AgentResponse>) => new StructuredAgentContractError(
      '$.selected_ids[0] must be equal to one of the allowed values',
      { persona: 'selector', status: 'done', content: '', timestamp: new Date(), ...response },
    );

    it('should omit the returned ids when the rejected response is not a JSON object', () => {
      const message = describeSelectorError(rejected({ content: 'I pick backend.' }), contract, 'fix', identity, label);

      expect(message).not.toContain('returned selected_ids');
      expect(message).toContain('allowed candidate ids: ["backend","transaction"]');
    });

    it('should bound the returned ids so one oversized selection cannot flood the failure reason', () => {
      const message = describeSelectorError(
        rejected({ structuredOutput: { selected_ids: ['x'.repeat(2000)], rationale: 'x' } }),
        contract,
        'fix',
        identity,
        label,
      );

      expect(message).not.toContain('x'.repeat(513));
      expect(message).toContain('(truncated)');
      expect(message).toContain('allowed candidate ids: ["backend","transaction"]');
    });

    it('should redact a returned id that needs JSON escaping before it is encoded', () => {
      const message = describeSelectorError(
        rejected({ structuredOutput: { selected_ids: ['pa"ss\\word'], rationale: 'x' } }),
        contract,
        'fix',
        (text) => text.replaceAll('pa"ss\\word', '[REDACTED]'),
        label,
      );

      expect(message).toContain('returned selected_ids: ["[REDACTED]"]');
    });

    const terminalRejected = (output: Record<string, unknown>) => new StructuredOutputRejectedError(
      {
        status: 'error',
        content: '',
        error: 'Claude terminal structured output validation failed: $.selected_ids[0] must be equal to one of the allowed values',
      },
      output,
    );

    it('should name the returned and allowed ids when the provider rejected the output itself', () => {
      const message = describeSelectorError(
        terminalRejected({ selected_ids: ['coding'], rationale: 'x' }),
        contract,
        'fix',
        identity,
        label,
      );

      expect(message).toContain('Dynamic facet selector for "fix" returned invalid structured output');
      expect(message).toContain('returned selected_ids: ["coding"]');
      expect(message).toContain('allowed candidate ids: ["backend","transaction"]');
    });

    it('should omit the returned ids line when the rejected output has no selected_ids', () => {
      const message = describeSelectorError(terminalRejected({ rationale: 'x' }), contract, 'fix', identity, label);

      expect(message).not.toContain('returned selected_ids');
      expect(message).toContain('allowed candidate ids: ["backend","transaction"]');
    });

    it('should redact secrets in object keys at every depth before the returned ids are shortened', () => {
      const secret = 'k'.repeat(600);
      const nested = 'n'.repeat(600);
      const message = describeSelectorError(
        terminalRejected({ selected_ids: { [secret]: { [nested]: [secret] } }, rationale: 'x' }),
        contract,
        'fix',
        (text) => text.replaceAll(secret, '[REDACTED]').replaceAll(nested, '[REDACTED]'),
        label,
      );

      expect(message).toContain('returned selected_ids: {"[REDACTED]":{"[REDACTED]":["[REDACTED]"]}}');
      expect(message).not.toContain('kkkk');
      expect(message).not.toContain('nnnn');
    });

    it.each([
      ['an array', { password: ['hunter2-array'] }],
      ['an object', { api_key: { value: 'hunter2-object' } }],
    ])('should redact %s held under a secret key even when the secret is not a known value', (_name, selectedIds) => {
      const message = describeSelectorError(
        terminalRejected({ selected_ids: selectedIds, rationale: 'x' }),
        contract,
        'fix',
        identity,
        label,
      );

      expect(message).toContain('returned selected_ids:');
      expect(message).not.toContain('hunter2');
    });

    it.each([
      ['a provider failure', createAgentFailureError('provider_error', 'connection reset: {"selected_ids":["coding"]}')],
      ['a rate limit', new StructuredAgentResponseError('rate limited', {
        persona: 'selector',
        status: 'rate_limited',
        content: '{"selected_ids":["coding"]}',
        timestamp: new Date(),
      })],
    ])('should not treat %s as a contract violation', (_name, error) => {
      const message = describeSelectorError(error, contract, 'fix', identity, label);

      expect(message).not.toContain('returned selected_ids');
      expect(message).not.toContain('allowed candidate ids');
    });

    it('should redact a failure that is not a contract violation without adding candidates', () => {
      expect(describeSelectorError(
        new Error('provider unavailable: sensitive-detail'),
        contract,
        'fix',
        (text) => text.replace('sensitive-detail', '[REDACTED]'),
        label,
      )).toBe('provider unavailable: [REDACTED]');
    });
  });
});

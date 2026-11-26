import { inspect } from 'node:util';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeStructuredAgent,
  executeStructuredTextAgent,
  requireStructuredAgentProvider,
  StructuredAgentResponseError,
  StructuredOutputRejectedError,
} from '../agents/structured-caller/transport.js';
import { executeAgent } from '../agents/agent-usecases.js';
import type { AgentResponse } from '../core/models/types.js';
import type { StepProviderOptions } from '../core/models/workflow-types.js';
import { normalizeClaudeTerminalResponse } from '../infra/claude-terminal/response-normalizer.js';
import {
  AGENT_FAILURE_CATEGORIES,
  AgentFailureError,
  ProviderStreamParseError,
  createAgentResponseFailureError,
  type AgentFailureCategory,
} from '../shared/types/agent-failure.js';

vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: vi.fn() }));

const schema = {
  type: 'object',
  properties: { complete: { type: 'boolean' } },
  required: ['complete'],
  additionalProperties: false,
};

describe('executeStructuredAgent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses a fresh session without injecting permissions or capabilities when omitted', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'judge',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { complete: true },
    });

    await expect(executeStructuredAgent<{ complete: boolean }>('review', schema, {
      name: 'judge',
      cwd: '/repo',
      systemPrompt: 'judge system',
      resolution: { provider: 'mock' },
    })).resolves.toMatchObject({ structuredOutput: { complete: true } });

    expect(vi.mocked(executeAgent).mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      cwd: '/repo',
      sessionId: undefined,
      resolvedExecution: {
        provider: 'mock',
        model: undefined,
        providerOptions: undefined,
        permissionMode: undefined,
      },
      outputSchema: schema,
    }));
    const options = vi.mocked(executeAgent).mock.calls[0]?.[2];
    expect(options).not.toHaveProperty('permissionMode');
    expect(options).not.toHaveProperty('allowedTools');
    expect(options).not.toHaveProperty('mcpServers');
    expect(options).not.toHaveProperty('bypassPermissions');
  });

  it('passes explicitly resolved provider options and permission mode unchanged', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'judge',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { complete: true },
    });
    const providerOptions: StepProviderOptions = {
      claude: {
        allowedTools: ['Read', 'Grep'],
        skills: { enabled: false },
      },
    };

    await executeStructuredAgent('review', schema, {
      name: 'judge',
      cwd: '/repo',
      resolution: {
        provider: 'claude',
        model: 'claude-review',
        providerOptions,
        permissionMode: 'readonly',
      },
    });

    expect(vi.mocked(executeAgent).mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      resolvedExecution: {
        provider: 'claude',
        model: 'claude-review',
        providerOptions,
        permissionMode: 'readonly',
      },
      allowedTools: ['Read', 'Grep'],
    }));
  });

  it('omits synthetic permission and selector-tool controls for DeepSeek Harness', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { complete: true },
    });

    await executeStructuredAgent('select', schema, {
      name: 'selector',
      cwd: '/repo',
      resolution: {
        provider: 'deepseek-harness',
        permissionMode: 'readonly',
        permissionModeSource: 'synthetic',
        providerOptions: { claude: { allowedTools: ['Read'] } },
      },
      allowedTools: ['Grep'],
      allowedToolsSource: 'synthetic',
    });

    const options = vi.mocked(executeAgent).mock.calls[0]?.[2];
    expect(options?.resolvedExecution?.permissionMode).toBeUndefined();
    expect(options).not.toHaveProperty('allowedTools');
  });

  it('preserves explicit unsupported permission constraints for provider rejection', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'selector',
      status: 'error',
      content: 'unsupported permission controls',
      error: 'unsupported permission controls',
      failureCategory: 'provider_error',
      timestamp: new Date(),
    });

    await expect(executeStructuredAgent('select', schema, {
      name: 'selector',
      cwd: '/repo',
      resolution: {
        provider: 'deepseek-harness',
        permissionMode: 'readonly',
      },
    })).rejects.toMatchObject({
      failureCategory: 'provider_error',
    });

    const options = vi.mocked(executeAgent).mock.calls[0]?.[2];
    expect(options?.resolvedExecution?.permissionMode).toBe('readonly');
  });

  it('preserves explicit unsupported tool constraints for provider rejection', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'selector',
      status: 'error',
      content: 'unsupported allowed tools',
      error: 'unsupported allowed tools',
      failureCategory: 'provider_error',
      timestamp: new Date(),
    });

    await expect(executeStructuredAgent('select', schema, {
      name: 'selector',
      cwd: '/repo',
      resolution: { provider: 'deepseek-harness' },
      allowedTools: ['Read'],
    })).rejects.toMatchObject({ failureCategory: 'provider_error' });

    const options = vi.mocked(executeAgent).mock.calls[0]?.[2];
    expect(options?.allowedTools).toEqual(['Read']);
  });

  it('preserves omitted provider options as explicit undefined in resolved execution', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { complete: true },
    });

    await executeStructuredAgent('select', schema, {
      name: 'selector',
      cwd: '/repo',
      resolution: { provider: 'mock', providerOptions: undefined },
    });

    expect(vi.mocked(executeAgent).mock.calls[0]?.[2]?.resolvedExecution?.providerOptions)
      .toBeUndefined();
  });

  it('fails fast when the caller has not resolved a provider', () => {
    expect(() => requireStructuredAgentProvider(undefined, 'judge'))
      .toThrow('requires a resolved provider');
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('uses the prompt JSON fallback and validates providers without native structured output', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'judge',
      status: 'done',
      content: '```json\n{"complete":true}\n```',
      timestamp: new Date(),
    });

    const response = await executeStructuredAgent<{ complete: boolean }>('review evidence', schema, {
      name: 'judge',
      cwd: '/repo',
      language: 'en',
      resolution: { provider: 'cursor' },
    });

    expect(response.structuredOutput).toEqual({ complete: true });
    const [, instruction, options] = vi.mocked(executeAgent).mock.calls[0]!;
    expect(instruction).toContain('review evidence');
    expect(instruction).toContain('"complete"');
    expect(options).not.toHaveProperty('outputSchema');
  });

  it('rejects fallback output that violates the requested schema', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'judge',
      status: 'done',
      content: '{"complete":"yes"}',
      timestamp: new Date(),
    });

    await expect(executeStructuredAgent('review', schema, {
      name: 'judge',
      cwd: '/repo',
      resolution: { provider: 'cursor' },
    })).rejects.toThrow(/complete.*boolean/i);
  });
});

const PBT_NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return process.env.CI ? 100 : 500;
})();

const SECRET_LIKE_OUTPUT = { complete: 'leaked-rationale-6f1c' };

function terminalRejection(options: { outputSchema?: Record<string, unknown> }): AgentResponse {
  return normalizeClaudeTerminalResponse({
    agentName: 'judge',
    sessionId: 'terminal-session',
    assistantText: `Checking.\n${JSON.stringify(SECRET_LIKE_OUTPUT)}`,
    lastAssistantText: JSON.stringify(SECRET_LIKE_OUTPUT),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
  });
}

async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    (value) => ({ resolvedWith: value }),
    (error: unknown) => error,
  );
}

describe('executeStructuredAgent with output the provider rejected against the schema', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(executeAgent).mockImplementation(async (_persona, _instruction, options) => terminalRejection(options));
  });

  it.each([
    ['executeStructuredAgent', () => executeStructuredAgent('review', schema, {
      name: 'judge',
      cwd: '/repo',
      resolution: { provider: 'claude-terminal' },
    })],
    ['executeStructuredTextAgent', () => executeStructuredTextAgent('review', {
      name: 'judge',
      cwd: '/repo',
      resolution: { provider: 'claude-terminal' },
    })],
  ] as const)('%s throws the provider_error failure it threw before and keeps the rejected output', async (_name, call) => {
    const failure = await rejectionOf(call());

    expect(failure).toBeInstanceOf(StructuredOutputRejectedError);
    expect(failure).toBeInstanceOf(AgentFailureError);
    expect(failure).not.toBeInstanceOf(StructuredAgentResponseError);
    const rejected = failure as StructuredOutputRejectedError;
    expect(rejected.failureCategory).toBe(AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR);
    expect(rejected.name).toBe('AgentFailureError');
    expect(rejected.message).toContain('Claude terminal structured output validation failed');
    expect(rejected.rejectedStructuredOutput).toEqual(SECRET_LIKE_OUTPUT);
  });

  it('does not show the rejected output when the error is listed, serialized or inspected', async () => {
    const failure = await rejectionOf(executeStructuredAgent('review', schema, {
      name: 'judge',
      cwd: '/repo',
      resolution: { provider: 'claude-terminal' },
    }));

    expect(failure).toBeInstanceOf(StructuredOutputRejectedError);
    expect(Object.keys(failure as object)).not.toContain('rejectedStructuredOutput');
    expect(JSON.stringify(failure)).not.toContain('leaked-rationale-6f1c');
    expect(inspect(failure)).not.toContain('leaked-rationale-6f1c');
  });

  it('keeps a rate_limited response on its own path even when it carries a rejected output', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'judge',
      status: 'rate_limited',
      content: '',
      error: 'rate limited',
      timestamp: new Date(),
      rejectedStructuredOutput: SECRET_LIKE_OUTPUT,
    });

    const failure = await rejectionOf(executeStructuredAgent('review', schema, {
      name: 'judge',
      cwd: '/repo',
      resolution: { provider: 'claude-terminal' },
    }));

    expect(failure).toBeInstanceOf(StructuredAgentResponseError);
    expect(failure).not.toBeInstanceOf(StructuredOutputRejectedError);
    expect((failure as StructuredAgentResponseError).response.status).toBe('rate_limited');
  });

  it('keeps a stream parse failure as ProviderStreamParseError even when it carries a rejected output', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'judge',
      status: 'error',
      content: '',
      error: 'bad frame',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
      timestamp: new Date(),
      rejectedStructuredOutput: SECRET_LIKE_OUTPUT,
    });

    const failure = await rejectionOf(executeStructuredAgent('review', schema, {
      name: 'judge',
      cwd: '/repo',
      resolution: { provider: 'claude-terminal' },
    }));

    expect(failure).toBeInstanceOf(ProviderStreamParseError);
    expect(failure).not.toBeInstanceOf(StructuredOutputRejectedError);
  });
});

/** The non-done branches of the transport before #162, written out. */
function baselineFailure(response: AgentResponse): { readonly type: 'failure' | 'response'; readonly error: Error } {
  if (response.failureCategory !== undefined) {
    return { type: 'failure', error: createAgentResponseFailureError(response, 'Structured agent "judge" did not complete') };
  }
  return {
    type: 'response',
    error: new StructuredAgentResponseError(
      response.error || response.content || 'Structured agent "judge" did not complete',
      response,
    ),
  };
}

const failureCategoryArb = fc.option(
  fc.constantFrom(...Object.values(AGENT_FAILURE_CATEGORIES) as AgentFailureCategory[]),
  { nil: undefined },
);
const textArb = fc.oneof(fc.constant(''), fc.constant('   '), fc.string({ maxLength: 40 }));
const rejectedOutputArb = fc.option(
  fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 2 }), { maxKeys: 3 }),
  { nil: undefined },
);

describe('executeStructuredAgent property: a non-done response', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('always throws, and only a rejected provider_error (or uncategorized) failure changes class', async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<AgentResponse['status']>('error', 'blocked', 'rate_limited'),
      failureCategoryArb,
      rejectedOutputArb,
      textArb,
      textArb,
      async (status, failureCategory, rejectedStructuredOutput, error, content) => {
        const response: AgentResponse = {
          persona: 'judge',
          status,
          content,
          error,
          timestamp: new Date(),
          ...(failureCategory === undefined ? {} : { failureCategory }),
          ...(rejectedStructuredOutput === undefined ? {} : { rejectedStructuredOutput }),
        };
        vi.mocked(executeAgent).mockResolvedValueOnce(response);

        const failure = await rejectionOf(executeStructuredAgent('review', schema, {
          name: 'judge',
          cwd: '/repo',
          resolution: { provider: 'claude-terminal' },
        }));

        expect(failure).toBeInstanceOf(Error);
        const baseline = baselineFailure(response);
        const becomesRejected = status !== 'rate_limited'
          && rejectedStructuredOutput !== undefined
          && (failureCategory === undefined || failureCategory === AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR);
        if (becomesRejected) {
          expect(failure).toBeInstanceOf(StructuredOutputRejectedError);
          const rejected = failure as StructuredOutputRejectedError;
          expect(rejected.failureCategory).toBe(AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR);
          expect(rejected.message).toBe(createAgentResponseFailureError(
            { ...response, failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR },
            '',
          ).message);
          expect(rejected.rejectedStructuredOutput).toBe(rejectedStructuredOutput);
          expect(Object.keys(rejected)).not.toContain('rejectedStructuredOutput');
          return;
        }
        expect(failure).not.toBeInstanceOf(StructuredOutputRejectedError);
        expect((failure as Error).constructor).toBe(baseline.error.constructor);
        expect((failure as Error).message).toBe(baseline.error.message);
        if (baseline.type === 'failure') {
          expect((failure as AgentFailureError).failureCategory).toBe(failureCategory);
        } else {
          expect((failure as StructuredAgentResponseError).response.status).toBe(status);
        }
      },
    ), { numRuns: PBT_NUM_RUNS });
  });
});


import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTaktMcpServer, TAKT_MCP_MANAGER_TOOL_NAMES } from '../features/mcp/server.js';
import { MCP_RESPONSE_MAX_BYTES } from '../features/mcp/response.js';
import { runFormalSpecVerification } from '../features/interactive/formalSpecVerification.js';
import { goalSpecificationVerificationInputSchema } from '../features/mcp/schemas.js';
import { GoalStore } from '../infra/goals/store.js';
import { GoalSchema, type Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

const { mockSpawnManagedProcess } = vi.hoisted(() => ({ mockSpawnManagedProcess: vi.fn() }));
vi.mock('../shared/utils/spawn.js', () => ({ spawnManagedProcess: mockSpawnManagedProcess }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));

const toolName = 'takt_verify_goal_specification';

class MockStream extends EventEmitter {
  setEncoding(_encoding: string): void {
    // The verifier only consumes the stream event contract.
  }
}

function installAlloyProcessFixture(): void {
  let alloyCommands: Array<{ type: string; label: string }> = [];
  mockSpawnManagedProcess.mockImplementation((command: string, args: readonly string[]) => {
    const stdout = new MockStream();
    const stderr = new MockStream();
    const wait = async () => {
      if (command.includes('java') && !args.includes('exec') && !args.includes('commands')) {
        stderr.emit('data', 'openjdk version "17.0.1"');
      } else if (args.includes('commands')) {
        stdout.emit('data', '0 . run GoalScenario for 3');
        alloyCommands = [{ type: 'run', label: 'GoalScenario' }];
      } else if (args.includes('exec')) {
        const outputDirectory = args[args.indexOf('--output') + 1]!;
        const command2 = alloyCommands[Number(args[args.indexOf('--command') + 1])];
        if (command2 !== undefined) {
          writeFileSync(join(outputDirectory, 'receipt.json'), JSON.stringify({ commands: { [command2.label]: {
            name: command2.label, type: command2.type, source: `${command2.type} ${command2.label}`,
            solution: [{ instances: [{ values: {} }] }],
          } } }));
          writeFileSync(join(outputDirectory, `${command2.label}-solution-0.txt`), '---Trace--- instance');
        }
      }
      return { code: 0, signal: null };
    };
    return { child: { stdout, stderr }, wait, waitForExit: wait };
  });
}

function installQuintInvariantsFixture(invariantCount: number): void {
  const declarations = Array.from({ length: invariantCount }, (_, index) => ({
    kind: 'def', qualifier: 'val', name: `inv${String(index).padStart(4, '0')}x`,
  }));
  const parseJson = JSON.stringify({ modules: [{ name: 'goalSpec', declarations: [
    { kind: 'def', qualifier: 'action', name: 'init' },
    { kind: 'def', qualifier: 'action', name: 'step' },
    ...declarations,
  ] }] });
  let alloyCommands: Array<{ type: string; label: string }> = [];
  mockSpawnManagedProcess.mockImplementation((command: string, args: readonly string[]) => {
    const stdout = new MockStream();
    const stderr = new MockStream();
    const wait = async () => {
      if (command.includes('java') && !args.includes('exec') && !args.includes('commands')) {
        stderr.emit('data', 'openjdk version "17.0.1"');
      } else if (args.includes('parse')) {
        writeFileSync(join(args[args.indexOf('--out') + 1]!), parseJson);
        stdout.emit('data', parseJson);
      } else if (args.includes('commands')) {
        stdout.emit('data', '0 . run GoalScenario for 3');
        alloyCommands = [{ type: 'run', label: 'GoalScenario' }];
      } else if (args.includes('exec')) {
        const outputDirectory = args[args.indexOf('--output') + 1]!;
        const command2 = alloyCommands[Number(args[args.indexOf('--command') + 1])];
        if (command2 !== undefined) {
          writeFileSync(join(outputDirectory, 'receipt.json'), JSON.stringify({ commands: { [command2.label]: {
            name: command2.label, type: command2.type, source: `${command2.type} ${command2.label}`,
            solution: [{ instances: [{ values: {} }] }],
          } } }));
          writeFileSync(join(outputDirectory, `${command2.label}-solution-0.txt`), '---Trace--- instance');
        }
      }
      return { code: 0, signal: null };
    };
    return { child: { stdout, stderr }, wait, waitForExit: wait };
  });
}

function installAlloyCommandsFixture(commandCount: number): void {
  const commands = Array.from({ length: commandCount }, (_, index) => `${index} . run Scenario${index} for 3`).join('\n');
  mockSpawnManagedProcess.mockImplementation((command: string, args: readonly string[]) => {
    const stdout = new MockStream();
    const stderr = new MockStream();
    const wait = async () => {
      if (command.includes('java') && !args.includes('exec') && !args.includes('commands')) {
        stderr.emit('data', 'openjdk version "17.0.1"');
      } else if (args.includes('commands')) {
        stdout.emit('data', commands);
      } else if (args.includes('exec')) {
        const outputDirectory = args[args.indexOf('--output') + 1]!;
        const number = Number(args[args.indexOf('--command') + 1]);
        writeFileSync(join(outputDirectory, 'receipt.json'), JSON.stringify({ commands: { [`Scenario${number}`]: {
          name: `Scenario${number}`, type: 'run', source: `run Scenario${number}`,
          solution: [{ instances: [{ values: {} }] }],
        } } }));
        writeFileSync(join(outputDirectory, `Scenario${number}-solution-0.txt`), '---Trace--- instance');
      }
      return { code: 0, signal: null };
    };
    return { child: { stdout, stderr }, wait, waitForExit: wait };
  });
}

function installAlloyChecksFixture(checkCount: number, timeoutCommands: number[] = []): void {
  const commands = Array.from({ length: checkCount }, (_, index) => `${index} . check a`).join('\n');
  mockSpawnManagedProcess.mockImplementation((command: string, args: readonly string[], _options: unknown, signal: AbortSignal) => {
    const stdout = new MockStream();
    const stderr = new MockStream();
    const wait = async () => {
      if (command.includes('java') && !args.includes('exec') && !args.includes('commands')) {
        stderr.emit('data', 'openjdk version "17.0.1"');
      } else if (args.includes('commands')) {
        stdout.emit('data', commands);
      } else if (args.includes('exec')) {
        const number = Number(args[args.indexOf('--command') + 1]);
        if (timeoutCommands.includes(number)) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          return { code: null, signal: 'SIGTERM' };
        }
        const outputDirectory = args[args.indexOf('--output') + 1]!;
        writeFileSync(join(outputDirectory, 'receipt.json'), JSON.stringify({ commands: { a: {
          name: 'a', type: 'check', source: 'check a',
        } } }));
        writeFileSync(join(outputDirectory, 'a.txt'), '---Trace--- instance');
      }
      return { code: 0, signal: null };
    };
    return { child: { stdout, stderr }, wait, waitForExit: wait };
  });
}

let cwd: string;
const specifications = { gherkin: 'Feature: 検証', quint: 'module goalSpec {}', alloy: 'sig Goal {}\npred GoalScenario { some Goal }\nrun GoalScenario for 3' };
const savedGoal = (overrides: Partial<Goal> = {}): Goal => GoalSchema.parse({
  ...goalRecord(), specifications, ...overrides,
});

function seedGoal(target: string, goal: Goal): Promise<Goal> {
  return new GoalStore(target).create(goal);
}

beforeEach(() => {
  vi.clearAllMocks();
  cwd = mkdtempSync(join(tmpdir(), 'takt-goal-spec-verify-it-'));
  execFileSync('git', ['init', '-q'], { cwd });
  writeFileSync(join(cwd, 'alloy.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  vi.stubEnv('TAKT_ALLOY_JAR', join(cwd, 'alloy.jar'));
  installAlloyProcessFixture();
});

afterEach(() => {
  vi.unstubAllEnvs();
  // Large verifications leave many per-command files; retry transient ENOTEMPTY under load.
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 30000);

async function withManagerServer<T>(action: (client: Client) => Promise<T>): Promise<T> {
  const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
  const client = new Client({ name: 'goal-spec-verification-it', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

it('advertises the verification tool only in the manager tool set and lists it in the manager tool names', async () => {
  expect(TAKT_MCP_MANAGER_TOOL_NAMES).toContain(toolName);
  await withManagerServer(async (client) => {
    const tools = (await client.listTools()).tools;
    const tool = tools.find(({ name }) => name === toolName);
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        cwd: { type: 'string' }, goalId: { type: 'string', format: 'uuid' },
        specifications: { type: 'array', items: { type: 'string', enum: ['quint', 'alloy'] } },
      },
    });
  });
});

it('advertises specifications as an optional input so omitting it verifies every saved formal specification', async () => {
  await withManagerServer(async (client) => {
    const tool = (await client.listTools()).tools.find(({ name }) => name === toolName);
    const inputSchema = tool!.inputSchema as { required?: string[]; properties?: Record<string, unknown> };

    expect(inputSchema.required).toEqual(['cwd', 'goalId']);
    expect(inputSchema.properties).toHaveProperty('specifications');
  });
});

it.each(['all', 'read-only'] as const)('does not expose the verification tool in the %s tool set', async (toolSet) => {
  const server = createTaktMcpServer({}, { toolSet });
  const client = new Client({ name: 'goal-spec-verification-toolset', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map(({ name }) => name)).not.toContain(toolName);
  } finally {
    await client.close();
    await server.close();
  }
});

it('runs the existing verifier for the saved specifications when specifications is omitted', async () => {
  await seedGoal(cwd, savedGoal({ specifications: { alloy: specifications.alloy } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id },
  }));

  expect(result.isError).not.toBe(true);
  const body = JSON.parse(firstTextContent(result.content));
  expect(body).toMatchObject({ goalId: goalRecord().id, verifiedSpecifications: ['alloy'] });
  expect(body.verification).toMatchObject({ verdict: 'passed', alloy: { status: 'passed' } });
  expect(body.verification.artifacts.runDirectory).toContain(join('.takt', 'runs', 'verify-'));
});

it('returns an MCP error when the goal has no saved formal specification', async () => {
  await seedGoal(cwd, savedGoal({ specifications: { gherkin: 'Feature: UI only' } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id },
  }));

  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toMatch(/no saved (quint|alloy|formal) specification/iu);
});

it('returns an MCP error for an unknown goal', async () => {
  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id },
  }));

  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toMatch(/Goal not found/iu);
});

it('rejects a caller-supplied cwd that is not a repository of the manager assignment', async () => {
  await seedGoal(cwd, savedGoal({ specifications: { alloy: specifications.alloy } }));
  const outside = mkdtempSync(join(tmpdir(), 'takt-goal-spec-verify-outside-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: outside });

    const result = await withManagerServer((client) => client.callTool({
      name: toolName, arguments: { cwd: outside, goalId: goalRecord().id, specifications: ['alloy'] },
    }));

    expect(result.isError).toBe(true);
    expect(firstTextContent(result.content)).not.toContain('verifiedSpecifications');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

it('verifies only the selected notation when specifications names it', async () => {
  await seedGoal(cwd, savedGoal({ specifications: { quint: specifications.quint, alloy: specifications.alloy } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id, specifications: ['alloy'] },
  }));

  expect(result.isError).not.toBe(true);
  const body = JSON.parse(firstTextContent(result.content));
  expect(body.verifiedSpecifications).toEqual(['alloy']);
  expect(body.verification.quint.status).toBe('skipped');
});

it.each([
  { specifications: [] },
  { specifications: ['gherkin'] },
  { specifications: ['quint', 'quint'] },
])('rejects an invalid specifications selector through the advertised input schema: %j', ({ specifications: selector }) => {
  expect(() => goalSpecificationVerificationInputSchema.parse({
    cwd, goalId: goalRecord().id, specifications: selector,
  })).toThrow(/specifications/iu);
});

it('keeps every artifact path and the verdict when the response exceeds 64 KiB', async () => {
  const commandCount = 110;
  installAlloyCommandsFixture(commandCount);
  await seedGoal(cwd, savedGoal({ specifications: { alloy: 'sig Goal {}\nrun Scenario for 3' } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id, specifications: ['alloy'] },
  }));

  expect(result.isError).not.toBe(true);
  const body = JSON.parse(firstTextContent(result.content));
  const artifacts = body.verification.artifacts as { runDirectory: string; specifications: { alloy: string }; alloyOutputs: string[] };
  expect(body.verification.verdict).toBe('passed');
  expect(body.verification.alloy.status).toBe('passed');
  expect(typeof artifacts.runDirectory).toBe('string');
  expect(artifacts.alloyOutputs).toHaveLength(commandCount * 2);
  for (const path of artifacts.alloyOutputs) {
    expect(path.startsWith(artifacts.runDirectory)).toBe(true);
    expect(path.endsWith('.txt') || path.endsWith('.json')).toBe(true);
  }
  expect(body.truncated).toBeUndefined();
  expect(body.omissions).toBeUndefined();
  // The complete verification exceeded 64 KiB before trimming (the tool had to bound it), yet the
  // response still carries every path, which the generic shortener would have sliced at 50.
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
});

it('summarizes the artifact path list with counts and a run-directory location when even the paths exceed 64 KiB', async () => {
  const commandCount = 1200;
  installAlloyCommandsFixture(commandCount);
  await seedGoal(cwd, savedGoal({ specifications: { alloy: 'sig Goal {}\nrun Scenario for 3' } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id, specifications: ['alloy'] },
  }));

  expect(result.isError).not.toBe(true);
  const text = firstTextContent(result.content);
  const body = JSON.parse(text);
  const artifacts = body.verification.artifacts as { runDirectory: string; alloyOutputs: string[] };
  const summary = body.verification.alloyOutputsSummary as { returnedCount: number; omittedCount: number; complete: boolean; retrieval: string };
  expect(body.verification.verdict).toBe('passed');
  expect(body.verification.alloy.status).toBe('passed');
  expect(typeof artifacts.runDirectory).toBe('string');
  // The response must not fall back to the generic shortener (no truncated/omissions, no unusable takt_get_goal guidance).
  expect(body.truncated).toBeUndefined();
  expect(body.omissions).toBeUndefined();
  expect(text).not.toContain('takt_get_goal');
  // The list is summarized: bounded window, explicit counts, and a run-directory-relative location.
  expect(artifacts.alloyOutputs.length).toBe(summary.returnedCount);
  expect(artifacts.alloyOutputs.length).toBeLessThan(commandCount * 2);
  expect(summary.returnedCount + summary.omittedCount).toBe(commandCount * 2);
  expect(summary.complete).toBe(false);
  expect(summary.retrieval).toContain('verification.artifacts.runDirectory');
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
});

it('keeps the verdict and artifact location when a large quint invariants list would exceed 64 KiB', async () => {
  installQuintInvariantsFixture(3500);
  await seedGoal(cwd, savedGoal({ specifications: { quint: 'module goalSpec {}', alloy: 'sig Goal {}\nrun Scenario for 3' } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id, specifications: ['quint', 'alloy'] },
  }));

  expect(result.isError).not.toBe(true);
  const text = firstTextContent(result.content);
  const body = JSON.parse(text);
  expect(body.verification.verdict).toBe('passed');
  expect(typeof body.verification.quint.status).toBe('string');
  expect(typeof body.verification.alloy.status).toBe('string');
  expect(typeof body.verification.artifacts.runDirectory).toBe('string');
  expect(body.truncated).toBeUndefined();
  expect(body.omissions).toBeUndefined();
  expect(text).not.toContain('takt_get_goal');
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
});

it('summarizes quint invariants with counts and a parse-artifact location when they exceed 64 KiB', async () => {
  const invariantCount = 5900;
  installQuintInvariantsFixture(invariantCount);
  await seedGoal(cwd, savedGoal({ specifications: { quint: 'module goalSpec {}' } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id, specifications: ['quint'] },
  }));

  expect(result.isError).not.toBe(true);
  const text = firstTextContent(result.content);
  const body = JSON.parse(text);
  const invariants = body.verification.quint.invariants as string[];
  const summary = body.verification.quintNameListSummaries.quintInvariants as {
    returnedCount: number; omittedCount: number; complete: boolean; retrieval: string;
  };
  expect(body.verification.verdict).toBe('passed');
  expect(body.truncated).toBeUndefined();
  expect(body.omissions).toBeUndefined();
  expect(text).not.toContain('takt_get_goal');
  expect(invariants.length).toBe(summary.returnedCount);
  expect(invariants.length).toBeLessThan(invariantCount);
  expect(summary.returnedCount + summary.omittedCount).toBe(invariantCount);
  expect(summary.complete).toBe(false);
  expect(summary.retrieval).toContain('verification.artifacts.parseJson');
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
});

it('keeps the verdict and artifact location when a large alloy checks list would exceed 64 KiB', async () => {
  installAlloyChecksFixture(3000);
  await seedGoal(cwd, savedGoal({ specifications: { quint: 'module goalSpec {}', alloy: 'sig Goal {}\ncheck a' } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id, specifications: ['quint', 'alloy'] },
  }));

  expect(result.isError).not.toBe(true);
  const text = firstTextContent(result.content);
  const body = JSON.parse(text);
  expect(['passed', 'failed', 'error']).toContain(body.verification.verdict);
  expect(typeof body.verification.alloy.status).toBe('string');
  expect(typeof body.verification.artifacts.runDirectory).toBe('string');
  expect(body.truncated).toBeUndefined();
  expect(body.omissions).toBeUndefined();
  expect(text).not.toContain('takt_get_goal');
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
});

it('summarizes alloy checks with counts and an artifact location when they exceed 64 KiB', async () => {
  const checkCount = 16000;
  installAlloyChecksFixture(checkCount);
  await seedGoal(cwd, savedGoal({ specifications: { alloy: 'sig Goal {}\ncheck a' } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id, specifications: ['alloy'] },
  }));

  expect(result.isError).not.toBe(true);
  const text = firstTextContent(result.content);
  const body = JSON.parse(text);
  const checks = body.verification.alloy.checks as number[];
  const summary = body.verification.alloyChecksSummary as {
    returnedCount: number; omittedCount: number; complete: boolean; retrieval: string;
  };
  expect(body.verification.verdict).toBe('passed');
  expect(body.truncated).toBeUndefined();
  expect(body.omissions).toBeUndefined();
  expect(text).not.toContain('takt_get_goal');
  expect(checks.length).toBe(summary.returnedCount);
  expect(checks.length).toBeLessThan(checkCount);
  expect(summary.returnedCount + summary.omittedCount).toBe(checkCount);
  expect(summary.complete).toBe(false);
  expect(summary.retrieval).toContain('verification.artifacts.runDirectory');
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
});

it('does not add notes or a checks summary when the alloy run response fits within 64 KiB', async () => {
  installAlloyCommandsFixture(40);
  await seedGoal(cwd, savedGoal({ specifications: { alloy: 'sig Goal {}\nrun Scenario for 3' } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id, specifications: ['alloy'] },
  }));

  expect(result.isError).not.toBe(true);
  const body = JSON.parse(firstTextContent(result.content));
  expect(body.notes).toBeUndefined();
  expect(body.verification.alloyChecksSummary).toBeUndefined();
  expect(body.truncated).toBeUndefined();
  expect(body.verification.artifacts.alloyOutputs).toHaveLength(80);
});

it('keeps the statuses without truncation when two stage messages are near the 8,000-byte cap', async () => {
  const big = 'E'.repeat(7900);
  mockSpawnManagedProcess.mockImplementation((command: string, args: readonly string[]) => {
    const stdout = new MockStream();
    const stderr = new MockStream();
    const wait = async () => {
      if (command.includes('java') && !args.includes('exec') && !args.includes('commands')) {
        stderr.emit('data', 'openjdk version "17.0.1"');
      } else if (args.includes('parse')) {
        writeFileSync(join(args[args.indexOf('--out') + 1]!), '{}');
        stdout.emit('data', '{}');
      } else if (args.includes('typecheck')) {
        stderr.emit('data', big);
        return { code: 1, signal: null };
      } else if (args.includes('run')) {
        stdout.emit('data', big);
        return { code: 1, signal: null };
      } else if (args.includes('commands')) {
        stdout.emit('data', Array.from({ length: 3000 }, (_, index) => `${index} . check a`).join('\n'));
      } else if (args.includes('exec')) {
        const outputDirectory = args[args.indexOf('--output') + 1]!;
        stderr.emit('data', big);
        writeFileSync(join(outputDirectory, 'receipt.json'), JSON.stringify({ commands: { a: { name: 'a', type: 'check', source: 'check a' } } }));
        return { code: 1, signal: null };
      }
      return { code: 0, signal: null };
    };
    return { child: { stdout, stderr }, wait, waitForExit: wait };
  });
  await seedGoal(cwd, savedGoal({ specifications: { quint: 'module goalSpec {}', alloy: 'sig Goal {}\ncheck a' } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id, specifications: ['quint', 'alloy'] },
  }));

  expect(result.isError).not.toBe(true);
  const text = firstTextContent(result.content);
  const body = JSON.parse(text);
  expect(['failed', 'error']).toContain(body.verification.quint.status);
  expect(['failed', 'error']).toContain(body.verification.alloy.status);
  expect(body.truncated).toBeUndefined();
  expect(body.omissions).toBeUndefined();
  expect(text).not.toContain('takt_get_goal');
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
});

it('summarizes log stage keys with names and counts when the key set exceeds the budget', async () => {
  installAlloyCommandsFixture(600);
  await seedGoal(cwd, savedGoal({ specifications: { alloy: 'sig Goal {}\nrun Scenario for 3' } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id, specifications: ['alloy'] },
  }));

  expect(result.isError).not.toBe(true);
  const text = firstTextContent(result.content);
  const body = JSON.parse(text);
  const logs = body.verification.artifacts.logs as Record<string, unknown>;
  const summary = body.verification.logsSummary as {
    returnedCount: number; omittedCount: number; complete: boolean;
    firstOmittedStage: string; lastOmittedStage: string; retrieval: string;
  };
  expect(body.truncated).toBeUndefined();
  expect(body.omissions).toBeUndefined();
  expect(text).not.toContain('takt_get_goal');
  expect(Object.keys(logs)).toHaveLength(summary.returnedCount);
  expect(summary.returnedCount + summary.omittedCount).toBe(602);
  expect(summary.complete).toBe(false);
  expect(summary.firstOmittedStage).toMatch(/^alloy-run-/u);
  expect(summary.lastOmittedStage).toBe('alloy-run-599');
  expect(summary.retrieval).toContain('verification.artifacts.runDirectory');
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
});

it('does not claim log truncation when only short log paths are present but the response exceeds 64 KiB', async () => {
  // Many alloy outputs push the payload over 64 KiB while log entries are short file paths; no log
  // string is actually truncated, so the truncation note must not appear.
  installAlloyCommandsFixture(3);
  const base = 0x50;
  // Re-wrap the fixture to also drop many output files per command.
  mockSpawnManagedProcess.mockImplementation((command: string, args: readonly string[]) => {
    const stdout = new MockStream();
    const stderr = new MockStream();
    const wait = async () => {
      if (command.includes('java') && !args.includes('exec') && !args.includes('commands')) {
        stderr.emit('data', 'openjdk version "17.0.1"');
      } else if (args.includes('commands')) {
        stdout.emit('data', Array.from({ length: 3 }, (_, i) => `${i} . run Scenario${i} for 3`).join('\n'));
      } else if (args.includes('exec')) {
        const outputDirectory = args[args.indexOf('--output') + 1]!;
        const number = Number(args[args.indexOf('--command') + 1]);
        writeFileSync(join(outputDirectory, 'receipt.json'), JSON.stringify({ commands: { [`Scenario${number}`]: {
          name: `Scenario${number}`, type: 'run', source: `run Scenario${number}`, solution: [{ instances: [{}] }],
        } } }));
        for (let index = 0; index < 400; index += 1) {
          writeFileSync(join(outputDirectory, `extra-${index}.txt`), String.fromCharCode(base + (index % 26)).repeat(50));
        }
      }
      return { code: 0, signal: null };
    };
    return { child: { stdout, stderr }, wait, waitForExit: wait };
  });
  await seedGoal(cwd, savedGoal({ specifications: { alloy: 'sig Goal {}\nrun Scenario for 3' } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id, specifications: ['alloy'] },
  }));

  expect(result.isError).not.toBe(true);
  const text = firstTextContent(result.content);
  const body = JSON.parse(text);
  const logs = body.verification.artifacts.logs as Record<string, { stdout: string; stderr: string }>;
  const notes: string[] = Array.isArray(body.notes) ? body.notes : [];
  // The response is summarized (alloyOutputs), proving it exceeded 64 KiB.
  expect(body.verification.alloyOutputsSummary).toBeDefined();
  expect(body.truncated).toBeUndefined();
  expect(body.omissions).toBeUndefined();
  // No log entry was actually shortened, so the truncation claim must be absent.
  const truncatedAny = Object.values(logs).some((entry) => !entry.stdout.endsWith('.stdout.log') || !entry.stderr.endsWith('.stderr.log'));
  expect(truncatedAny).toBe(false);
  expect(notes.some((note) => note.includes('Log stream contents were truncated'))).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
});

it('keeps the whole response within 64 KiB when many commands and outputs combine', async () => {
  installAlloyCommandsFixture(120);
  await seedGoal(cwd, savedGoal({ specifications: { alloy: 'sig Goal {}\nrun Scenario for 3' } }));

  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id, specifications: ['alloy'] },
  }));

  expect(result.isError).not.toBe(true);
  const text = firstTextContent(result.content);
  const body = JSON.parse(text);
  expect(body.verification.verdict).toBe('passed');
  expect(typeof body.verification.artifacts.runDirectory).toBe('string');
  expect(body.truncated).toBeUndefined();
  expect(body.omissions).toBeUndefined();
  expect(text).not.toContain('takt_get_goal');
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
});

type RawVerification = Awaited<ReturnType<typeof runFormalSpecVerification>>;

async function verifyAlloyThroughMcp() {
  const result = await withManagerServer((client) => client.callTool({
    name: toolName, arguments: { cwd, goalId: goalRecord().id, specifications: ['alloy'] },
  }));
  expect(result.isError).not.toBe(true);
  return {
    body: JSON.parse(firstTextContent(result.content)) as {
      notes?: string[];
      verificationResultPath?: string;
      verification: RawVerification;
    },
    bytes: Buffer.byteLength(JSON.stringify(result)),
  };
}

async function rawAlloyVerification(alloy: string) {
  await seedGoal(cwd, savedGoal({ specifications: { alloy } }));
  const verification = await runFormalSpecVerification(
    `\`\`\`alloy\n${alloy}\n\`\`\``, cwd, { modelCheckTimeoutSeconds: 1 },
  );
  const body = { goalId: goalRecord().id, verifiedSpecifications: ['alloy'], verification };
  const bytes = Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(body) }] }));
  return { body, bytes };
}

it('returns the full verifier result when the MCP envelope fits within 64 KiB', async () => {
  installAlloyChecksFixture(40);
  const { body: raw, bytes: rawBytes } = await rawAlloyVerification('sig Goal {}\ncheck a');

  const { body, bytes } = await verifyAlloyThroughMcp();

  expect(rawBytes).toBeLessThan(MCP_RESPONSE_MAX_BYTES);
  expect(bytes).toBe(rawBytes);
  expect(body).toEqual(JSON.parse(JSON.stringify(raw).replaceAll(
    raw.verification.artifacts!.runDirectory, body.verification.artifacts!.runDirectory,
  )));
});

it('bounds an oversized envelope while preserving usable log paths and all Alloy timeout results', async () => {
  installAlloyChecksFixture(220, [3, 210]);
  mkdirSync(join(cwd, '.takt'), { recursive: true });
  writeFileSync(join(cwd, '.takt', 'config.yaml'), 'assistant:\n  formal_spec:\n    model_check_timeout_seconds: 1\n');
  const { bytes: rawBytes } = await rawAlloyVerification('sig Goal {}\ncheck a');

  const { body, bytes } = await verifyAlloyThroughMcp();

  expect(rawBytes).toBeGreaterThan(MCP_RESPONSE_MAX_BYTES);
  expect(bytes).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
  expect(body.verification.alloy.commandResults).toBeUndefined();
  const artifacts = body.verification.artifacts!;
  expect(Object.keys(artifacts.logs).length).toBeGreaterThan(0);
  for (const [stage, paths] of Object.entries(artifacts.logs)) {
    expect(paths.stdout).toBe(join(artifacts.runDirectory, 'logs', `${stage}.stdout.log`));
    expect(paths.stderr).toBe(join(artifacts.runDirectory, 'logs', `${stage}.stderr.log`));
    expect(() => readFileSync(paths.stdout)).not.toThrow();
    expect(() => readFileSync(paths.stderr)).not.toThrow();
  }
  expect(body.verificationResultPath).toBe(join(artifacts.runDirectory, 'verification-result.json'));
  const complete: RawVerification = JSON.parse(readFileSync(body.verificationResultPath!, 'utf8'));
  expect(complete.verdict).toBe(body.verification.verdict);
  expect(complete.alloy.commandResults?.filter((command) => command.timedOut)
    .map((command) => command.number)).toEqual([3, 210]);
  expect(readFileSync(complete.artifacts!.logs['alloy-check-210']!.stdout, 'utf8')).toBe('');
});

it('keeps successful verification logs readable until the stale-run cleanup', async () => {
  await seedGoal(cwd, savedGoal({ specifications: { alloy: specifications.alloy } }));

  const { body } = await verifyAlloyThroughMcp();

  const runDirectory = body.verification.artifacts!.runDirectory;
  expect(existsSync(join(runDirectory, '.active'))).toBe(false);
  expect(readFileSync(join(runDirectory, 'logs', 'alloy-run-0.stdout.log'), 'utf8')).toBeTypeOf('string');

  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(runDirectory, stale, stale);
  await verifyAlloyThroughMcp();
  expect(existsSync(runDirectory)).toBe(false);
});

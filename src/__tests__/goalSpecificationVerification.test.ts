import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GoalSchema, type Goal, type GoalSpecifications } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

const { mockSpawnManagedProcess } = vi.hoisted(() => ({ mockSpawnManagedProcess: vi.fn() }));
vi.mock('../shared/utils/spawn.js', () => ({ spawnManagedProcess: mockSpawnManagedProcess }));

const doubles = vi.hoisted(() => ({ get: vi.fn(), resolveTimeout: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; } }));
vi.mock('../features/interactive/taskInstructionFormat.js', async (original) => ({
  ...await original<typeof import('../features/interactive/taskInstructionFormat.js')>(),
  resolveFormalSpecConfigurationWithoutPrompt: doubles.resolveTimeout,
}));

const specs: GoalSpecifications = {
  gherkin: 'Feature: 検証\n  Scenario: 保存済みの仕様を検証する',
  quint: 'module goalSpec {}',
  alloy: 'sig Goal {}',
};
const savedGoal = (specifications?: GoalSpecifications): Goal => GoalSchema.parse({
  ...goalRecord(),
  ...(specifications === undefined ? {} : { specifications }),
});

class MockStream extends EventEmitter {
  setEncoding(_encoding: string): void {
    // The verifier only consumes the stream event contract.
  }
}

function respondAlloy(): ReturnType<typeof setTimeout> {
  let alloyCommands: Array<{ type: string; label: string }> = [];
  mockSpawnManagedProcess.mockImplementation((command: string, args: readonly string[]) => {
    const stdout = new MockStream();
    const stderr = new MockStream();
    const wait = async () => {
      if (args.includes('commands')) {
        stdout.emit('data', '0 . run Scenario for 3');
        alloyCommands = [{ type: 'run', label: 'Scenario' }];
      } else if (args.includes('exec')) {
        const outputDirectory = args[args.indexOf('--output') + 1]!;
        const command = alloyCommands[Number(args[args.indexOf('--command') + 1])];
        if (command !== undefined) {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(join(outputDirectory, 'receipt.json'), JSON.stringify({ commands: { [command.label]: {
            name: command.label, type: command.type, source: `${command.type} ${command.label}`,
            solution: [{ instances: [{ values: {} }] }],
          } } }));
          writeFileSync(join(outputDirectory, `${command.label}-solution-0.txt`), '---Trace--- instance');
        }
      } else if (command.includes('java')) {
        stderr.emit('data', 'openjdk version "17.0.1"');
      }
      return { code: 0, signal: null };
    };
    return { child: { stdout, stderr }, wait, waitForExit: wait };
  });
  return setTimeout(() => undefined, 0);
}

async function verifyGoalSpecification(overrides: Record<string, unknown> = {}) {
  const module = await import('../features/mcp/goalSpecificationVerificationOperations.js');
  const signal = new AbortController().signal;
  return module.verifyTaktGoalSpecification(
    { cwd: directory, goalId: goalRecord().id, ...overrides } as never,
    { allowedProjectRoot: directory } as never,
    signal,
  );
}

function parsed(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse(firstTextContent(result.content));
}

let directory: string;

beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), 'takt-goal-spec-verify-unit-'));
  doubles.get.mockResolvedValue(savedGoal(specs));
  doubles.resolveTimeout.mockReturnValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 15 });
  respondAlloy();
  writeFileSync(join(directory, 'alloy.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  vi.stubEnv('TAKT_ALLOY_JAR', join(directory, 'alloy.jar'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it('verifies saved Quint and Alloy specifications through the existing formal specification verifier', async () => {
  doubles.get.mockResolvedValue(savedGoal(specs));

  const result = await verifyGoalSpecification();

  expect(result.isError).not.toBe(true);
  const body = parsed(result);
  expect(body).toMatchObject({ goalId: goalRecord().id, verifiedSpecifications: ['quint', 'alloy'] });
  expect(body.verification).toMatchObject({
    quint: { status: expect.any(String) },
    alloy: { status: 'passed' },
  });
});

it('reuses the configured model-check timeout from the existing formal specification configuration', async () => {
  doubles.resolveTimeout.mockReturnValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 42 });

  await verifyGoalSpecification();

  expect(doubles.resolveTimeout).toHaveBeenCalledWith(directory);
});

it('verifies only the requested documented notation and skips the other one', async () => {
  doubles.get.mockResolvedValue(savedGoal(specs));

  const result = await verifyGoalSpecification({ specifications: ['alloy'] });

  expect(result.isError).not.toBe(true);
  const body = parsed(result);
  expect(body.verifiedSpecifications).toEqual(['alloy']);
  expect((body.verification as { quint: { status: string } }).quint.status).toBe('skipped');
});

it('includes per-stage success, artifact locations and logs in the existing MCP result format', async () => {
  doubles.get.mockResolvedValue(savedGoal({ alloy: 'sig Goal {}' }));

  const result = await verifyGoalSpecification({ specifications: ['alloy'] });

  const body = parsed(result);
  const verification = body.verification as {
    verdict: string;
    alloy: { status: string; commandResults: Array<{ label: string; status: string }> };
    artifacts: { runDirectory: string; alloyOutputs: string[]; logs: Record<string, { stdout: string }> };
  };
  expect(verification.verdict).toBe('passed');
  expect(verification.alloy.commandResults).toEqual([
    expect.objectContaining({ label: 'Scenario', status: 'passed' }),
  ]);
  expect(verification.artifacts.runDirectory).toContain('.takt/runs/verify-');
  expect(verification.artifacts.alloyOutputs.some((path) => path.endsWith('receipt.json'))).toBe(true);
  expect(verification.artifacts.logs['alloy-run-0']!.stdout).toMatch(/alloy-run-0\.stdout\.log$/u);
});

it('rejects an unknown goal with an MCP error and does not start verification', async () => {
  doubles.get.mockRejectedValue(new Error(`Goal not found: ${goalRecord().id}`));

  const result = await verifyGoalSpecification();

  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toContain('Goal not found');
  expect(mockSpawnManagedProcess).not.toHaveBeenCalled();
});

it('rejects a goal without saved formal specifications instead of returning an empty success', async () => {
  doubles.get.mockResolvedValue(savedGoal({ gherkin: 'Feature: UI only' }));

  const result = await verifyGoalSpecification();

  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toMatch(/no saved (quint|alloy|formal) specification/iu);
  expect(mockSpawnManagedProcess).not.toHaveBeenCalled();
});

it('rejects a requested notation that the goal did not save', async () => {
  doubles.get.mockResolvedValue(savedGoal({ quint: 'module goalSpec {}' }));

  const result = await verifyGoalSpecification({ specifications: ['alloy'] });

  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toMatch(/alloy/iu);
});

it.each([
  { specifications: [] },
  { specifications: ['gherkin'] },
  { specifications: ['quint', 'quint'] },
  { specifications: 'quint' },
])('rejects an invalid specifications selector before reading the goal: %j', async (overrides) => {
  const result = await verifyGoalSpecification(overrides);

  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toContain('Input validation error');
  expect(doubles.get).not.toHaveBeenCalled();
});

it('preserves a saved specification that itself contains code fences so the verifier reads the whole body', async () => {  const body = '```quint\nmodule inner {}\n```';
  doubles.get.mockResolvedValue(savedGoal({ alloy: `sig Goal {}\n${body}` }));

  mockSpawnManagedProcess.mockImplementation((command: string, args: readonly string[]) => {
    const stdout = new MockStream();
    const stderr = new MockStream();
    const wait = async () => {
      if (args.includes('commands')) {
        stdout.emit('data', '0 . run Scenario for 3');
      } else if (args.includes('exec')) {
        const outputDirectory = args[args.indexOf('--output') + 1]!;
        const { writeFileSync } = await import('node:fs');
        writeFileSync(join(outputDirectory, 'receipt.json'), JSON.stringify({ commands: { Scenario: {
          name: 'Scenario', type: 'run', source: 'run Scenario', solution: [{ instances: [{ values: {} }] }],
        } } }));
        writeFileSync(join(outputDirectory, 'Scenario-solution-0.txt'), '---Trace--- instance');
      } else if (command.includes('java')) {
        stderr.emit('data', 'openjdk version "17.0.1"');
      }
      return { code: 0, signal: null };
    };
    return { child: { stdout, stderr }, wait, waitForExit: wait };
  });

  const result = await verifyGoalSpecification({ specifications: ['alloy'] });

  expect(result.isError).not.toBe(true);
  const verification = parsed(result).verification as { alloy: { status: string } };
  expect(verification.alloy.status).toBe('passed');
});

type QuintStage = { status: string };

it('returns the verifier verdict, artifact location and retention message when a Quint simulation fails', async () => {
  doubles.get.mockResolvedValue(savedGoal({ quint: 'module goalSpec {}' }));
  const parseJson = JSON.stringify({ modules: [{ name: 'goalSpec', declarations: [
    { kind: 'def', qualifier: 'action', name: 'init' },
    { kind: 'def', qualifier: 'action', name: 'step' },
  ] }] });

  mockSpawnManagedProcess.mockImplementation((_command: string, args: readonly string[]) => {
    const stdout = new MockStream();
    const stderr = new MockStream();
    const wait = async () => {
      if (args.includes('parse')) {
        writeFileSync(join(args[args.indexOf('--out') + 1]!), parseJson);
        stdout.emit('data', parseJson);
        return { code: 0, signal: null };
      }
      if (args.includes('typecheck')) return { code: 0, signal: null };
      if (args.includes('run')) {
        stdout.emit('data', 'invariant violated');
        return { code: 1, signal: null };
      }
      return { code: 0, signal: null };
    };
    return { child: { stdout, stderr }, wait, waitForExit: wait };
  });

  const result = await verifyGoalSpecification({ specifications: ['quint'] });

  expect(result.isError).not.toBe(true);
  const verification = parsed(result).verification as {
    verdict: string; message?: string;
    quint: { run?: QuintStage };
    artifacts?: { runDirectory: string };
  };
  expect(verification.verdict).toBe('failed');
  expect(verification.quint.run?.status).toBe('failed');
  expect(typeof verification.artifacts?.runDirectory).toBe('string');
  expect(verification.message).toContain('Verification artifacts retained at');
  expect(verification.message).toContain(verification.artifacts!.runDirectory);
});

it('keeps the artifact location and retention message in the response when Alloy execution settings are invalid', async () => {
  doubles.get.mockResolvedValue(savedGoal({ alloy: 'sig Goal {}' }));
  vi.stubEnv('TAKT_ALLOY_CONCURRENCY', '0');

  const result = await verifyGoalSpecification({ specifications: ['alloy'] });

  expect(result.isError).not.toBe(true);
  const verification = parsed(result).verification as {
    verdict: string; message?: string;
    alloy: { status: string };
    artifacts?: { runDirectory: string };
  };
  expect(verification.verdict).toBe('error');
  expect(verification.alloy.status).toBe('error');
  expect(typeof verification.artifacts?.runDirectory).toBe('string');
  expect(verification.message).toContain('Verification artifacts retained at');
  expect(verification.message).toContain(verification.artifacts!.runDirectory);
});

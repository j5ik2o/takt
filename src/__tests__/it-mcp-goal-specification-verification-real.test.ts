import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { verifyTaktGoalSpecification } from '../features/mcp/goalSpecificationVerificationOperations.js';
import { GoalStore } from '../infra/goals/store.js';
import { GoalSchema, type Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

const quintSpecification = [
  'module goalSpec {',
  '  var n: int',
  '  action init = { n\' = 0 }',
  '  action step = { n\' = n + 1 }',
  '  val invNonNegative = n >= 0',
  '}',
].join('\n');
const alloySpecification = 'sig Goal {}\npred GoalScenario { some Goal }\nrun GoalScenario for 3';

function installJavaFixture(directory: string): void {
  const binDirectory = join(directory, 'bin');
  mkdirSync(binDirectory, { recursive: true });
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('-version')) { console.error('openjdk version "17.0.1"'); process.exit(0); }
const specification = fs.readFileSync(args.at(-1), 'utf8');
const commands = specification.split('\\n').filter(line => /^(run|check) /.test(line));
if (args.includes('commands')) {
  commands.forEach((line, number) => console.log(number + ' . ' + line));
  process.exit(0);
}
const number = Number(args[args.indexOf('--command') + 1]);
const output = args[args.indexOf('--output') + 1];
const [type, label] = commands[number].split(' ');
const sat = type === 'run';
fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify({ commands: { [label]: {
  name: label, type, source: commands[number], ...(sat ? { solution: [{ instances: [{}] }] } : {}),
} } }));
if (sat) fs.writeFileSync(path.join(output, label + '-solution-0.txt'), 'instance-0');
process.exit(0);
`;
  writeFileSync(join(binDirectory, 'java'), script, { mode: 0o700 });
  chmodSync(join(binDirectory, 'java'), 0o700);
  const jarPath = join(directory, 'alloy-fixture.jar');
  writeFileSync(jarPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  process.env.PATH = `${binDirectory}:${process.env.PATH ?? ''}`;
  process.env.TAKT_ALLOY_JAR = jarPath;
}

let cwd: string;
let originalPath: string | undefined;
let originalJar: string | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'takt-goal-spec-verify-real-'));
  originalPath = process.env.PATH;
  originalJar = process.env.TAKT_ALLOY_JAR;
  installJavaFixture(cwd);
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  if (originalJar === undefined) delete process.env.TAKT_ALLOY_JAR; else process.env.TAKT_ALLOY_JAR = originalJar;
  rmSync(cwd, { recursive: true, force: true });
});

const savedGoal = (overrides: Partial<Goal> = {}): Goal => GoalSchema.parse({ ...goalRecord(), ...overrides });

it('runs the real Quint and Alloy verifiers over saved goal specifications and returns stage results and artifacts', async () => {
  await new GoalStore(cwd).create(savedGoal({ specifications: { quint: quintSpecification, alloy: alloySpecification } }));

  const result = await verifyTaktGoalSpecification(
    { cwd, goalId: goalRecord().id } as never,
    { allowedProjectRoot: cwd } as never,
    new AbortController().signal,
  );

  expect(result.isError).not.toBe(true);
  const body = JSON.parse(firstTextContent(result.content));
  expect(body.verifiedSpecifications).toEqual(['quint', 'alloy']);
  const verification = body.verification;
  expect(verification.quint.parse.status).toBe('passed');
  expect(verification.quint.typecheck.status).toBe('passed');
  expect(verification.alloy.status).toBe('passed');
  expect(verification.alloy.commandResults).toEqual([
    expect.objectContaining({ label: 'GoalScenario', type: 'run', status: 'passed' }),
  ]);
  const artifacts = verification.artifacts;
  expect(readFileSync(artifacts.specifications.quint, 'utf8')).toContain('module goalSpec');
  expect(readFileSync(artifacts.specifications.alloy, 'utf8')).toContain('run GoalScenario');
  expect(readFileSync(artifacts.parseJson, 'utf8')).toContain('goalSpec');
  expect(artifacts.alloyOutputs.some((path: string) => path.endsWith('receipt.json'))).toBe(true);
  expect(artifacts.logs['quint-parse'].stdout).toBeTypeOf('string');
});

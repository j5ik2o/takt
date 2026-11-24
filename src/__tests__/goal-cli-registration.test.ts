import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { goalId } from './helpers/goal-fixtures.js';

const cliEntry = join(process.cwd(), 'dist', 'app', 'cli', 'index.js');
const runningChildren = new Set<ChildProcess>();

function track(child: ChildProcess): void {
  runningChildren.add(child);
  child.once('close', () => { runningChildren.delete(child); });
}

// タイムアウトしたテストの子プロセスを止め、終了を待ってから fixture を消す。
async function stopRunningChildren(): Promise<void> {
  await Promise.all([...runningChildren].map((child) => new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.kill('SIGKILL');
  })));
}

interface CliInvocation {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function invokeTakt(args: string[], cwd: string, stdin?: string): Promise<CliInvocation> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd,
      env: { ...process.env, TAKT_NO_TTY: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    track(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

function registrationInput(overrides: Record<string, unknown> = {}) {
  return {
    id: goalId,
    objective: '非対話 CLI からゴールを登録する',
    outOfScope: ['GitHub 連携'],
    acceptanceCriteria: ['登録後に goal.json が生成される'],
    constraints: [],
    ...overrides,
  };
}

function omitKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

function savedGoalPath(repository: string, id: string) {
  return join(repository, '.takt', 'goals', id, 'goal.json');
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function branchTip(repository: string): string {
  return execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'],
    { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
}

describe('goal registration through the public CLI', () => {
  let root: string;
  let repository: string;

  beforeEach(() => {
    const temporaryRoot = join(process.cwd(), '.tmp');
    mkdirSync(temporaryRoot, { recursive: true });
    root = realpathSync(mkdtempSync(join(temporaryRoot, 'goal-cli-')));
    repository = join(root, 'repository');
    mkdirSync(repository);
    initializeGitFixture(repository, []);
  });

  afterEach(async () => {
    await stopRunningChildren();
    rmSync(root, { recursive: true, force: true });
  });

  it('registers a goal from JSON supplied on a piped (non-TTY) stdin and persists it through createGoal', async () => {
    const result = await invokeTakt(['goal', 'register', '--input', '-'], repository, JSON.stringify(registrationInput()));

    expect(result.exitCode, result.stderr).toBe(0);
    const saved = JSON.parse(readFileSync(savedGoalPath(repository, goalId), 'utf8'));
    expect(saved).toMatchObject({
      id: goalId,
      objective: '非対話 CLI からゴールを登録する',
      outOfScope: ['GitHub 連携'],
      acceptanceCriteria: ['登録後に goal.json が生成される'],
      constraints: [],
      status: 'created',
    });
    expect(typeof saved.branch).toBe('string');
  }, 120_000);

  it('prints the registered goal id on stdout', async () => {
    const result = await invokeTakt(['goal', 'register', '--input', '-'], repository, JSON.stringify(registrationInput()));

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(goalId);
  }, 120_000);

  it('fails with a non-zero exit and saves nothing when stdin reaches an empty EOF', async () => {
    const result = await invokeTakt(['goal', 'register', '--input', '-'], repository, '');

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(savedGoalPath(repository, goalId))).toBe(false);
  }, 120_000);

  it.each([
    ['truncated JSON', '{"id":"550e8400'],
    ['missing acceptanceCriteria', JSON.stringify(omitKey(registrationInput(), 'acceptanceCriteria'))],
    ['non-UUID id', JSON.stringify(registrationInput({ id: 'not-a-uuid' }))],
    ['non-array outOfScope', JSON.stringify(registrationInput({ outOfScope: 'GitHub 連携' }))],
    ['JSON-RPC envelope', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })],
  ])('fails with a non-zero exit and saves nothing for %s', async (_label, stdin) => {
    const result = await invokeTakt(['goal', 'register', '--input', '-'], repository, stdin);

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(savedGoalPath(repository, goalId))).toBe(false);
  }, 120_000);

  it('preserves optional specifications exactly as supplied', async () => {
    const specifications = { gherkin: 'Feature: registration\n  Scenario: piped input' };
    const result = await invokeTakt(['goal', 'register', '--input', '-'], repository,
      JSON.stringify(registrationInput({ specifications })));

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(savedGoalPath(repository, goalId), 'utf8'))).toMatchObject({ specifications });
  }, 120_000);

  it('rejects a duplicate id without overwriting the existing goal or moving its branch', async () => {
    const first = await invokeTakt(['goal', 'register', '--input', '-'], repository, JSON.stringify(registrationInput()));
    expect(first.exitCode, first.stderr).toBe(0);
    const path = savedGoalPath(repository, goalId);
    const bytes = sha256(path);
    const branches = branchTip(repository);

    const duplicate = await invokeTakt(['goal', 'register', '--input', '-'], repository,
      JSON.stringify(registrationInput({ objective: '別の目的' })));

    expect(duplicate.exitCode).not.toBe(0);
    expect(sha256(path)).toBe(bytes);
    expect(branchTip(repository)).toBe(branches);
  }, 180_000);

  it('reports a missing --input option as an error instead of reading stdin', async () => {
    const result = await invokeTakt(['goal', 'register'], repository, JSON.stringify(registrationInput()));

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(savedGoalPath(repository, goalId))).toBe(false);
  }, 120_000);

  it('completes the registration and exits zero when a hangup arrives while stdin is still open', async () => {
    const result = await invokeTaktHoldingStdinUnderHangup(
      ['goal', 'register', '--input', '-'], repository, JSON.stringify(registrationInput()));

    expect(result.signal, JSON.stringify(result)).toBeNull();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(savedGoalPath(repository, goalId))).toBe(true);
  }, 180_000);

  it('completes the registration and exits zero when a hangup arrives and stdin is never closed', async () => {
    const result = await invokeTaktHoldingStdinUnderHangup(
      ['goal', 'register', '--input', '-'], repository, JSON.stringify(registrationInput()),
      { hangupDelayMs: 1000, closeDelayMs: null });

    expect(result.signal, JSON.stringify(result)).not.toBe('SIGHUP');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(existsSync(savedGoalPath(repository, goalId))).toBe(true);
  }, 180_000);

  it.each([
    ['empty stdin', ''],
    ['truncated JSON', '{"id":"550e8400'],
  ])('exits non-zero with the underlying reason when a hangup arrives before the input is complete (%s)', async (_label, incomplete) => {
    const result = await invokeTaktHoldingStdinUnderHangup(
      ['goal', 'register', '--input', '-'], repository, incomplete,
      { hangupDelayMs: 1000, closeDelayMs: null });

    expect(result.signal, JSON.stringify(result)).not.toBe('SIGHUP');
    expect(result.exitCode, JSON.stringify(result)).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/hangup/i);
    expect(`${result.stdout}${result.stderr}`).toMatch(/JSON/i);
    expect(existsSync(savedGoalPath(repository, goalId))).toBe(false);
  }, 180_000);

  it('reports the underlying goal registration failure alongside the hangup notice', async () => {
    const first = await invokeTakt(['goal', 'register', '--input', '-'], repository, JSON.stringify(registrationInput()));
    expect(first.exitCode, first.stderr).toBe(0);

    const duplicate = await invokeTaktHoldingStdinUnderHangup(
      ['goal', 'register', '--input', '-'], repository, JSON.stringify(registrationInput()),
      { hangupDelayMs: 1200, closeDelayMs: 1800 });

    expect(duplicate.signal, JSON.stringify(duplicate)).not.toBe('SIGHUP');
    expect(duplicate.exitCode, JSON.stringify(duplicate)).not.toBe(0);
    expect(`${duplicate.stdout}${duplicate.stderr}`).toMatch(/Goal already exists/);
  }, 180_000);
});

interface CliInvocationUnderHangup extends CliInvocation {
  signal: NodeJS.Signals | null;
}

function invokeTaktHoldingStdinUnderHangup(
  args: string[], cwd: string, stdin: string,
  options: { hangupDelayMs?: number; closeDelayMs?: number | null } = {},
): Promise<CliInvocationUnderHangup> {
  const { hangupDelayMs = 1000, closeDelayMs = 1500 } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd,
      env: { ...process.env, TAKT_NO_TTY: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    track(child);
    const timers: NodeJS.Timeout[] = [];
    const clearTimers = () => { for (const timer of timers) clearTimeout(timer); };
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => { clearTimers(); reject(error); });
    child.on('close', (code, signal) => {
      clearTimers();
      resolve({ exitCode: code ?? -1, signal, stdout, stderr });
    });
    child.stdin.write(stdin);
    timers.push(setTimeout(() => { child.kill('SIGHUP'); }, hangupDelayMs));
    if (closeDelayMs !== null) timers.push(setTimeout(() => { child.stdin.end(); }, closeDelayMs));
  });
}

/**
 * The task finish hook runs for the tasks a write saved as failed even when a lock release fails
 * after that write, including a tasks.yaml.lock that can never be removed (#169, 設計レビュー 高-1).
 * The hook gets the saved states and does not read tasks.yaml again, so a lock this process could
 * not release does not keep the hook from running. Real tasks.yaml, real locks with the release
 * failure injected into `node:fs`, and a real hook command (a Node child process).
 * Design: docs/design/claim-lock-release-failure.md (2節, 試験の3・5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { scaledMs } from '../../scripts/test-time-factor.mjs';
import type { LockReleaseFaultState } from './helpers/lock-release-faults.js';

const faults = vi.hoisted(() => ({ armed: [], times: 1, active: new Map(), failingReads: new Set() }) as LockReleaseFaultState);
vi.mock('node:fs', async (original) => (await import('./helpers/lock-release-faults.js'))
  .withLockReleaseFaults(await original<typeof import('node:fs')>(), faults));
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: vi.fn() }));
const { executeRunTaskAndComplete } = vi.hoisted(() => ({ executeRunTaskAndComplete: vi.fn() }));
vi.mock('../features/tasks/execute/providerPreflight.js', () => ({
  checkPendingTaskProviders: vi.fn(async () => undefined),
  checkTaskNameProvider: vi.fn(async () => undefined),
  checkQueuedTaskProviders: vi.fn(async () => undefined),
  terminalProviderConfirmation: vi.fn(() => undefined),
}));
vi.mock('../features/tasks/execute/runTaskExecution.js', () => ({
  executeRunTaskAndComplete,
  executeRunTaskAndCompleteWithDetails: vi.fn(),
}));
vi.mock('../features/tasks/execute/inputWait.js', () => ({ isInputWaiting: vi.fn(() => false) }));

import { invalidatePendingGoalTasksWithFinishHook } from '../features/tasks/execute/taskFinishHook.js';
import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';
import { TaskRunner } from '../infra/task/runner.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import { armAfterWrite, healLockReleaseFaults, LOCK_RELEASE_FAULTS } from './helpers/lock-release-faults.js';

// Devin (PR #182): limits this test owns follow TEST_TIME_FACTOR, as CONTRIBUTING.md asks.
const HOOK_TEST_TIMEOUT_MS = scaledMs(30_000);

const HOOK_SCRIPT = `
const fs = require('node:fs');
const [out] = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('TAKT_FINISH_')));
fs.appendFileSync(out, JSON.stringify(env) + '\\n');
`;

const dirs: string[] = [];

interface Project {
  dir: string;
  out: string;
  runner: TaskRunner;
  warnings: string[];
}

function createProject(): Project {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-lock-release-hook-')));
  dirs.push(dir);
  const script = path.join(dir, 'hook.cjs');
  const out = path.join(dir, 'hook-calls.jsonl');
  fs.writeFileSync(script, HOOK_SCRIPT, 'utf-8');
  fs.mkdirSync(path.join(dir, '.takt', 'goals', goalId), { recursive: true });
  fs.writeFileSync(path.join(dir, '.takt', 'goals', goalId, 'goal.json'), JSON.stringify(goalRecord()));
  fs.writeFileSync(path.join(dir, '.takt', 'config.yaml'), stringifyYaml({
    language: 'en', provider: 'mock', task_finish_hook: { command: [process.execPath, script, out] },
  }), 'utf-8');
  invalidateAllResolvedConfigCache();
  const warnings: string[] = [];
  return { dir, out, runner: new TaskRunner(dir, { onWarning: (warning) => warnings.push(warning) }), warnings };
}

function hookCalls(project: Project): Record<string, string>[] {
  if (!fs.existsSync(project.out)) return [];
  return fs.readFileSync(project.out, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, string>);
}

function statuses(project: Project): Record<string, string> {
  healLockReleaseFaults(faults);
  return Object.fromEntries(new TaskRunner(project.dir).listTaskStateItems().map((task) => [task.name, task.status]));
}

beforeEach(() => {
  healLockReleaseFaults(faults);
  executeRunTaskAndComplete.mockReset().mockResolvedValue(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  healLockReleaseFaults(faults);
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  invalidateAllResolvedConfigCache();
});

describe('aborting a goal when a lock release fails after the write (試験の5)', () => {
  const cases = [
    ...LOCK_RELEASE_FAULTS.map((fault) => ({ fault, times: 1 })),
    { fault: 'tasks-unlink-EACCES' as const, times: Number.POSITIVE_INFINITY },
  ];

  it.each(cases)('calls the hook for every task it saved as failed, then throws: $fault x $times', async ({ fault, times }) => {
    const project = createProject();
    const first = project.runner.addTask('Goal work 1', { workflow: 'default', goal_id: goalId });
    const second = project.runner.addTask('Goal work 2', { workflow: 'default', goal_id: goalId });
    const unrelated = project.runner.addTask('Other work', { workflow: 'default' });
    armAfterWrite(faults, [fault], times);

    await expect(invalidatePendingGoalTasksWithFinishHook(project.dir, project.runner, goalId)).rejects.toThrow();

    const calls = hookCalls(project);
    expect(calls.map((call) => call.TAKT_FINISH_TASK_NAME).sort()).toEqual([first.name, second.name].sort());
    expect(calls.every((call) => call.TAKT_FINISH_STATUS === 'failed' && call.TAKT_FINISH_GOAL_ID === goalId)).toBe(true);
    expect(statuses(project)).toMatchObject({ [first.name]: 'failed', [second.name]: 'failed', [unrelated.name]: 'pending' });
  }, HOOK_TEST_TIMEOUT_MS);

  it('does not call the hook when the abort fails before the write', async () => {
    const project = createProject();
    const pending = project.runner.addTask('Goal work', { workflow: 'default', goal_id: goalId });
    faults.failAcquisition = true;

    await expect(invalidatePendingGoalTasksWithFinishHook(project.dir, project.runner, goalId)).rejects.toThrow();

    expect(hookCalls(project)).toEqual([]);
    expect(statuses(project)).toMatchObject({ [pending.name]: 'pending' });
  }, HOOK_TEST_TIMEOUT_MS);
});

describe('claiming through the worker pool when a lock release fails after the write (試験の3)', () => {
  it('calls the hook for a setup failure even when tasks.yaml.lock can never be removed', async () => {
    const project = createProject();
    // The runtime assignment is not in runtime.yaml: the claim saves this goal task as failed.
    const broken = project.runner.addTask('Broken goal work', { workflow: 'default', goal_id: goalId, runtime_assignment: 'gone' });
    armAfterWrite(faults, ['tasks-unlink-EACCES'], Number.POSITIVE_INFINITY);

    // The next claim cannot remove the lock left behind and ends the run; only the hook matters here.
    await runWithWorkerPool(project.runner, [], 1, project.dir, undefined, undefined, 50, 'run').catch(() => undefined);

    expect(hookCalls(project).map((call) => [call.TAKT_FINISH_TASK_NAME, call.TAKT_FINISH_STATUS])).toEqual([[broken.name, 'failed']]);
    expect(project.warnings.filter((warning) => warning.includes('releasing a lock afterwards failed'))).toHaveLength(1);
    expect(executeRunTaskAndComplete).not.toHaveBeenCalled();
    expect(statuses(project)).toMatchObject({ [broken.name]: 'failed' });
  }, HOOK_TEST_TIMEOUT_MS);
});

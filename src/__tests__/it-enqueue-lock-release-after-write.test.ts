/**
 * Adding a task keeps its instruction files when a lock release fails after tasks.yaml is written
 * (#169, PR #182 Devin on file-lock.ts:106). The task is already in tasks.yaml then, so removing its
 * task_dir would leave a queued task that cannot run. A failure before the write still removes them.
 * Real tasks.yaml and real locks, with the release failure injected into `node:fs`.
 * Design: docs/design/claim-lock-release-failure.md (4節).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { LockReleaseFaultState } from './helpers/lock-release-faults.js';

const faults = vi.hoisted(() => ({ armed: [], times: 1, active: new Map(), failingReads: new Set() }) as LockReleaseFaultState);
vi.mock('node:fs', async (original) => (await import('./helpers/lock-release-faults.js'))
  .withLockReleaseFaults(await original<typeof import('node:fs')>(), faults));
// The task name and the provider check would call a provider; neither matters here.
vi.mock('../infra/task/summarize.js', () => ({ summarizeTaskName: vi.fn(async () => 'lock-release-task') }));
vi.mock('../infra/config/runtime-provider/execution-preparation.js', async (original) => ({
  ...await original<typeof import('../infra/config/runtime-provider/execution-preparation.js')>(),
  checkWorkflowProviders: vi.fn(async () => undefined),
}));

import { saveEnqueuedTaskFile } from '../infra/task/enqueuedTaskFile.js';
import { armAfterWrite, healLockReleaseFaults, TASKS_LOCK_RELEASE_FAULTS } from './helpers/lock-release-faults.js';

const dirs: string[] = [];
const TASK_CONTENT = 'Write the release notes';

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'takt-enqueue-lock-release-')));
  dirs.push(dir);
  mkdirSync(join(dir, '.takt'), { recursive: true });
  return dir;
}

/** tasks.yaml as saved, read without taking its lock. */
function savedTasks(dir: string): { name: string; status: string; task_dir?: string }[] {
  const file = join(dir, '.takt', 'tasks.yaml');
  if (!existsSync(file)) return [];
  return (parseYaml(readFileSync(file, 'utf-8')) as { tasks: { name: string; status: string; task_dir?: string }[] }).tasks;
}

function taskSpecDirectories(dir: string): string[] {
  const root = join(dir, '.takt', 'tasks');
  return existsSync(root) ? readdirSync(root) : [];
}

beforeEach(() => {
  healLockReleaseFaults(faults);
});

afterEach(() => {
  healLockReleaseFaults(faults);
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('adding a task when a lock release fails after the write', () => {
  it.each(TASKS_LOCK_RELEASE_FAULTS)('throws but keeps the saved task and its instruction files: %s', async (fault) => {
    const dir = project();
    armAfterWrite(faults, [fault]);

    await expect(saveEnqueuedTaskFile(dir, TASK_CONTENT)).rejects.toThrow();

    const tasks = savedTasks(dir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'pending' });
    expect(tasks[0]!.task_dir).toBeDefined();
    expect(readFileSync(join(dir, tasks[0]!.task_dir!, 'order.md'), 'utf-8')).toBe(TASK_CONTENT);
  });

  it('removes the instruction files when taking tasks.yaml.lock fails before the write', async () => {
    const dir = project();
    faults.failAcquisition = true;

    await expect(saveEnqueuedTaskFile(dir, TASK_CONTENT)).rejects.toThrow();

    expect(savedTasks(dir)).toEqual([]);
    expect(taskSpecDirectories(dir)).toEqual([]);
  });
});

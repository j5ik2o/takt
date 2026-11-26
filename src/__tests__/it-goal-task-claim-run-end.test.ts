/**
 * `takt run` with a real tasks.yaml: a claimed task is executed even when tasks.yaml cannot be read
 * right after the claim. In d2bd16a30 that read failed the claim after the task was saved as
 * running; the retry tick then claimed nothing and the run ended normally with success 0 / fail 0.
 * Waits for one claim retry interval (5 s), so it lives in the heavy IT layer.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';
import { TaskRunner } from '../infra/task/index.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';

const dirs: string[] = [];

beforeEach(() => {
  executeRunTaskAndComplete.mockReset().mockResolvedValue(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('executes the claimed task when tasks.yaml cannot be read right after the claim', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'takt-claim-run-end-')));
  dirs.push(dir);
  mkdirSync(join(dir, '.takt'), { recursive: true });
  writeFileSync(join(dir, '.takt', 'config.yaml'), 'language: en\nprovider: mock\n', 'utf-8');
  invalidateAllResolvedConfigCache();
  const runner = new TaskRunner(dir);
  const pending = runner.addTask('Do the work', { workflow: 'default' });

  // Fail once, and only a read made in the same synchronous turn as a claim: the read after the
  // claim that d2bd16a30 made. A read on a later poll tick is not touched.
  let justClaimed = false;
  let failed = false;
  const claim = runner.claimNextTasks.bind(runner);
  vi.spyOn(runner, 'claimNextTasks').mockImplementation((...args) => {
    justClaimed = true;
    queueMicrotask(() => { justClaimed = false; });
    return claim(...args);
  });
  const read = runner.listTaskStateItems.bind(runner);
  vi.spyOn(runner, 'listTaskStateItems').mockImplementation(() => {
    if (justClaimed && !failed) {
      justClaimed = false;
      failed = true;
      throw new Error(`File lock: timed out waiting for lock: ${join(dir, '.takt', 'tasks.yaml.lock')}`);
    }
    return read();
  });

  const result = await runWithWorkerPool(runner, [], 1, dir, undefined, undefined, 50, 'run');

  expect(result).toEqual({ success: 1, fail: 0, executedTaskNames: [pending.name] });
  expect(executeRunTaskAndComplete).toHaveBeenCalledOnce();
  expect(executeRunTaskAndComplete.mock.calls[0]?.[0]).toMatchObject({ name: pending.name });
}, 30_000);

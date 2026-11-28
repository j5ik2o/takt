/**
 * The builtin worker runs goal tasks without the CLI initialization that reads `vcs_provider`, so its
 * runtime must select the git provider from the project configuration before it executes a task (#208).
 * Otherwise a project configured for a self-hosted GitLab falls back to GitHub when it creates a PR.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { BuiltinProjectRuntime } from '../features/workerPool/builtinProjectRuntime.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';
import { getGitProvider, type GitProvider } from '../infra/git/index.js';
import { GitLabProvider } from '../infra/gitlab/index.js';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { TaskInfo } from '../infra/task/types.js';

const doubles = vi.hoisted(() => ({ execute: vi.fn(), preflight: vi.fn(), terminate: vi.fn(), cleanup: vi.fn() }));
vi.mock('../features/tasks/execute/runTaskExecution.js', () => ({ executeRunTaskAndCompleteWithDetails: doubles.execute }));
vi.mock('../features/tasks/execute/providerPreflight.js', () => ({ checkQueuedTaskProviders: doubles.preflight }));
vi.mock('../shared/utils/spawn.js', async (original) => ({
  ...await original<typeof import('../shared/utils/spawn.js')>(), terminateManagedProcesses: doubles.terminate,
}));
vi.mock('../infra/opencode/server-pool.js', async (original) => ({
  ...await original<typeof import('../infra/opencode/server-pool.js')>(), prepareSharedServerPoolForForcedShutdown: doubles.cleanup,
}));

let cwd: string;
let runtime: BuiltinProjectRuntime | undefined;
const finished = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  doubles.preflight.mockResolvedValue(undefined);
  doubles.terminate.mockResolvedValue(undefined);
  doubles.cleanup.mockResolvedValue(undefined);
  cwd = mkdtempSync(join(getGlobalConfigDir(), 'builtin-git-provider-'));
  mkdirSync(join(cwd, '.takt'));
  await new GoalStore(cwd).create(goalRecord());
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  rmSync(cwd, { recursive: true, force: true });
  invalidateAllResolvedConfigCache();
});

it.each([
  { setting: 'gitlab', origin: 'https://git.example.test/group/repo.git', expected: GitLabProvider },
  { setting: undefined, origin: 'https://github.com/example/repo.git', expected: GitHubProvider },
])('selects the $setting git provider of the project before the builtin worker executes a task (origin $origin)', async ({ setting, origin, expected }) => {
  for (const args of [['init', '-b', 'main'], ['remote', 'add', 'origin', origin]]) {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }
  writeFileSync(join(cwd, '.takt', 'config.yaml'), stringifyYaml({ provider: 'mock', concurrency: 1,
    ...(setting === undefined ? {} : { vcs_provider: setting }) }));
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
  const task = new TaskRunner(cwd, { goalTasksOnly: true }).addTask('git provider', { goal_id: goalRecord().id });
  let selected: GitProvider | undefined;
  doubles.execute.mockImplementation(async (info: TaskInfo, executingRunner: TaskRunner) => {
    selected = getGitProvider();
    const completion = { success: true, interrupted: false, workflowResult: 'completed' as const };
    executingRunner.completeTask({ task: info, success: true, completion, response: 'done', executionLog: [],
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    return { completion, runSlug: `run-${info.name}` };
  });
  runtime = new BuiltinProjectRuntime(cwd, finished, vi.fn());
  expect(await runtime.start(task.name, 'builtin')).toEqual({ kind: 'started' });
  await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(task.name));
  expect(selected).toBeInstanceOf(expected);
});

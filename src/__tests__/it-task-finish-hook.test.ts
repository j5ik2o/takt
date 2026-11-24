/**
 * Task finish hook: a real task store, a real hook command (a Node child process), and a stubbed
 * workflow executor that drives each exit of the task completion path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { ExecuteTaskOptions, WorkflowExecutionResult } from '../features/tasks/execute/types.js';
import type { TaskInfo } from '../infra/task/index.js';

const doubles = vi.hoisted(() => ({
  resolveTaskExecution: vi.fn(),
  postExecutionFlow: vi.fn(),
  gitProvider: vi.fn(),
  persistedMerge: vi.fn(),
}));

vi.mock('../features/tasks/execute/resolveTask.js', () => ({
  resolveTaskExecution: doubles.resolveTaskExecution,
  resolveTaskIssue: () => undefined,
}));
vi.mock('../features/tasks/execute/postExecution.js', () => ({
  postExecutionFlow: doubles.postExecutionFlow,
}));
vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitProvider: doubles.gitProvider,
}));

import { executeTaskAndCompleteWithDetails } from '../features/tasks/execute/taskExecution.js';
import { executePrWorkflow, resolveMergeSettings } from '../features/merge/index.js';
import { TaskRunner } from '../infra/task/runner.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';

interface HookCall {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

const HOOK_SCRIPT = `
const fs = require('node:fs');
const [out, mode] = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('TAKT_FINISH_')));
fs.appendFileSync(out, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env }) + '\\n');
if (mode === 'fail') process.exit(3);
if (mode === 'hang') setInterval(() => {}, 1000);
`;

const tempDirs = new Set<string>();
const savedFinishEnv = new Map<string, string | undefined>();

interface Project {
  dir: string;
  out: string;
  runner: TaskRunner;
}

function createProject(hook?: { mode?: string; timeoutMs?: number; extraArgs?: string[] } | 'none'): Project {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-finish-hook-')));
  tempDirs.add(dir);
  const script = path.join(dir, 'hook.cjs');
  const out = path.join(dir, 'hook-calls.jsonl');
  fs.writeFileSync(script, HOOK_SCRIPT, 'utf-8');
  fs.mkdirSync(path.join(dir, '.takt'), { recursive: true });
  const config: Record<string, unknown> = { language: 'en', provider: 'mock' };
  if (hook !== 'none') {
    config.task_finish_hook = {
      command: [process.execPath, script, out, hook?.mode ?? 'ok', ...(hook?.extraArgs ?? [])],
      ...(hook?.timeoutMs === undefined ? {} : { timeout_ms: hook.timeoutMs }),
    };
  }
  fs.writeFileSync(path.join(dir, '.takt', 'config.yaml'), stringifyYaml(config), 'utf-8');
  invalidateAllResolvedConfigCache();
  return { dir, out, runner: new TaskRunner(dir) };
}

function claimTask(project: Project): TaskInfo {
  project.runner.addTask('Do the work', { workflow: 'default' });
  return project.runner.claimNextTasks(1)[0]!;
}

function hookCalls(project: Project): HookCall[] {
  if (!fs.existsSync(project.out)) return [];
  return fs.readFileSync(project.out, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as HookCall);
}

function savedRecord(project: Project): string {
  return fs.readFileSync(project.runner.getTasksFilePath(), 'utf-8');
}

function stubResolution(project: Project, overrides: Record<string, unknown> = {}): void {
  doubles.resolveTaskExecution.mockResolvedValue({
    execCwd: project.dir,
    workflowIdentifier: 'default',
    isWorktree: false,
    reportDirName: 'run-1',
    autoPr: false,
    draftPr: false,
    shouldPublishBranchToOrigin: false,
    ...overrides,
  });
}

type Executor = (options: ExecuteTaskOptions) => Promise<WorkflowExecutionResult>;

function run(project: Project, task: TaskInfo, executor: Executor, abortSignal?: AbortSignal) {
  return executeTaskAndCompleteWithDetails(task, project.runner, project.dir, executor, undefined,
    { outputMode: 'silent', ...(abortSignal === undefined ? {} : { abortSignal }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(process.env).filter((name) => name.startsWith('TAKT_FINISH_'))) {
    savedFinishEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env).filter((name) => name.startsWith('TAKT_FINISH_'))) delete process.env[key];
  for (const [key, value] of savedFinishEnv) if (value !== undefined) process.env[key] = value;
  savedFinishEnv.clear();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  invalidateAllResolvedConfigCache();
});

describe('task finish hook', () => {
  it('calls the command once after a completed task is saved, with the saved state in the environment', async () => {
    const project = createProject({ extraArgs: ['$(touch injected); two words'] });
    const task = claimTask(project);
    stubResolution(project);
    process.env.TAKT_FINISH_PR_URL = 'https://example.invalid/stale';
    const statusSeenByExecutor: string[] = [];

    const result = await run(project, task, async () => {
      fs.mkdirSync(path.join(project.dir, '.takt', 'runs', 'run-1'), { recursive: true });
      statusSeenByExecutor.push(...hookCalls(project).map((call) => call.env.TAKT_FINISH_STATUS!));
      return { success: true };
    });

    expect(result.success).toBe(true);
    expect(statusSeenByExecutor).toEqual([]);
    const calls = hookCalls(project);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe(project.dir);
    // No shell: the argument arrives as written and nothing in it is executed.
    expect(calls[0]!.argv.slice(2)).toEqual(['$(touch injected); two words']);
    expect(fs.existsSync(path.join(project.dir, 'injected'))).toBe(false);
    const saved = project.runner.listTaskStateItems().find((item) => item.name === task.name)!;
    expect(saved.status).toBe('completed');
    expect(calls[0]!.env).toEqual({
      TAKT_FINISH_TASK_NAME: task.name,
      TAKT_FINISH_STATUS: 'completed',
      TAKT_FINISH_PROJECT_DIR: project.dir,
      TAKT_FINISH_INTERRUPTED: 'false',
      TAKT_FINISH_COMPLETED_AT: saved.completedAt,
      TAKT_FINISH_RUN_SLUG: 'run-1',
      TAKT_FINISH_RUN_DIR: path.join(project.dir, '.takt', 'runs', 'run-1'),
    });
  });

  it('reports a failed workflow with its reason', async () => {
    const project = createProject();
    const task = claimTask(project);
    stubResolution(project);

    const result = await run(project, task, async () => ({ success: false, reason: 'review rejected', lastStep: 'review' }));

    expect(result.success).toBe(false);
    const calls = hookCalls(project);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toMatchObject({ TAKT_FINISH_STATUS: 'failed', TAKT_FINISH_FAILURE_REASON: 'review rejected' });
    // The run directory was never created, so no path is offered.
    expect(calls[0]!.env.TAKT_FINISH_RUN_DIR).toBeUndefined();
  });

  it('reports an execution error saved by the catch path', async () => {
    const project = createProject();
    const task = claimTask(project);
    stubResolution(project);

    const result = await run(project, task, async () => { throw new Error('provider crashed'); });

    expect(result).toMatchObject({ success: false, failureReason: 'provider crashed' });
    const calls = hookCalls(project);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toMatchObject({ TAKT_FINISH_STATUS: 'failed', TAKT_FINISH_FAILURE_REASON: 'provider crashed' });
  });

  it('reports a setup error raised before the workflow starts', async () => {
    const project = createProject();
    const task = claimTask(project);
    doubles.resolveTaskExecution.mockRejectedValue(new Error('clone failed'));

    const result = await run(project, task, async () => ({ success: true }));

    expect(result.success).toBe(false);
    expect(hookCalls(project).map((call) => call.env.TAKT_FINISH_STATUS)).toEqual(['failed']);
  });

  it('still runs for an interrupted task whose abort signal has fired', async () => {
    const project = createProject();
    const task = claimTask(project);
    stubResolution(project);
    const controller = new AbortController();

    const result = await run(project, task, async () => {
      controller.abort(new Error('SIGINT'));
      return { success: false, interrupted: true, reason: 'Interrupted by user' };
    }, controller.signal);

    expect(result.success).toBe(false);
    expect(hookCalls(project).map((call) => call.env.TAKT_FINISH_STATUS)).toEqual(['failed']);
  });

  it('reports an exceeded task and leaves the saved resume data as written', async () => {
    const withHook = createProject({ mode: 'fail' });
    const withoutHook = createProject('none');
    const records: string[] = [];
    for (const project of [withHook, withoutHook]) {
      const task = claimTask(project);
      stubResolution(project);
      const result = await run(project, task, async () => ({
        success: false, exceeded: true, reason: 'limit',
        exceededInfo: { currentStep: 'implement', newMaxSteps: 20, currentIteration: 10 },
      }));
      expect(result.success).toBe(false);
      const saved = project.runner.listTaskStateItems().find((item) => item.name === task.name)!;
      expect(saved).toMatchObject({ status: 'exceeded', exceededMaxSteps: 20, exceededCurrentIteration: 10 });
      records.push(savedRecord(project).replaceAll(task.name, 'TASK').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/gu, 'TIME')
        .replace(/execution_id: \S+/u, 'execution_id: ID'));
    }

    expect(hookCalls(withHook).map((call) => call.env.TAKT_FINISH_STATUS)).toEqual(['exceeded']);
    expect(hookCalls(withoutHook)).toEqual([]);
    // A failing hook changes nothing: the record equals the one written without any hook.
    expect(records[0]).toBe(records[1]);
  });

  it('reports pr_failed with the branch and worktree of the saved state', async () => {
    const project = createProject();
    const task = claimTask(project);
    const worktreePath = path.join(project.dir, 'clone');
    fs.mkdirSync(path.join(worktreePath, '.takt', 'runs', 'run-1'), { recursive: true });
    stubResolution(project, {
      execCwd: worktreePath, isWorktree: true, worktreePath, branch: 'takt/work', autoPr: true,
      taskSpec: { taskPrompt: 'Do the work' },
    });
    doubles.postExecutionFlow.mockResolvedValue({ prFailed: true, prError: 'gh: not authenticated' });

    const result = await run(project, task, async () => ({ success: true }));

    expect(result).toMatchObject({ success: true, prFailed: true });
    const calls = hookCalls(project);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toMatchObject({
      TAKT_FINISH_STATUS: 'pr_failed',
      TAKT_FINISH_BRANCH: 'takt/work',
      TAKT_FINISH_WORKTREE_PATH: worktreePath,
      TAKT_FINISH_RUN_DIR: path.join(worktreePath, '.takt', 'runs', 'run-1'),
      TAKT_FINISH_FAILURE_REASON: 'PR creation failed: gh: not authenticated',
    });
  });

  it('keeps the slot until a hanging command is killed at its timeout, then returns the unchanged result', async () => {
    const project = createProject({ mode: 'hang', timeoutMs: 400 });
    const task = claimTask(project);
    stubResolution(project);
    let executorDoneAt = 0;

    const result = await run(project, task, async () => {
      executorDoneAt = Date.now();
      return { success: true };
    });
    const heldMs = Date.now() - executorDoneAt;

    expect(result.success).toBe(true);
    expect(hookCalls(project)).toHaveLength(1);
    expect(heldMs).toBeGreaterThanOrEqual(400);
    expect(heldMs).toBeLessThan(10_000);
    expect(project.runner.listTaskStateItems().find((item) => item.name === task.name)!.status).toBe('completed');
  });

  it('does not run when no terminal state was saved', async () => {
    const project = createProject();
    const task = claimTask(project);
    stubResolution(project);
    vi.spyOn(project.runner, 'completeTask').mockImplementation(() => { throw new Error('disk full'); });
    vi.spyOn(project.runner, 'failTask').mockImplementation(() => { throw new Error('disk full'); });

    await expect(run(project, task, async () => ({ success: true }))).rejects.toThrow('disk full');

    expect(project.runner.listTaskStateItems().find((item) => item.name === task.name)!.status).toBe('running');
    expect(hookCalls(project)).toEqual([]);
  });

  it('does not report a terminal state that an earlier execution already saved', async () => {
    const project = createProject();
    const task = claimTask(project);
    stubResolution(project);
    await run(project, task, async () => ({ success: false, reason: 'first failure' }));
    expect(hookCalls(project)).toHaveLength(1);

    // The same stale task is handed in again; nothing new is saved.
    await run(project, task, async () => ({ success: true })).catch(() => undefined);

    expect(hookCalls(project)).toHaveLength(1);
  });

  it('runs once for a queued PR merge task', async () => {
    const project = createProject();
    const settings = resolveMergeSettings(undefined);
    const task = project.runner.startPrMergeTask({
      prNumber: 7, headBranch: 'feature', baseBranch: 'main', headSha: 'a'.repeat(40),
      headRepositoryUrl: 'https://example.invalid/org/repo.git',
      headRepositoryPushUrls: ['https://example.invalid/org/repo.git'],
      until: 'merge', workflow: 'merge-review', method: settings.method,
      worktreePath: path.join(project.dir, 'merge-clone'),
      threatCheckMaxDiffBytes: settings.threatCheckMaxDiffBytes, concurrency: settings.concurrency,
    });

    // The project is not a Git repository, so the merge workflow fails and saves a failed task.
    const result = await run(project, task, async () => ({ success: true }));

    expect(result.success).toBe(false);
    expect(project.runner.listTaskStateItems().find((item) => item.name === task.name)!.status).toBe('failed');
    expect(hookCalls(project).map((call) => call.env.TAKT_FINISH_STATUS)).toEqual(['failed']);
  });

  it('runs once for a PR merge started directly, outside the queue', async () => {
    const project = createProject();
    doubles.gitProvider.mockReturnValue({
      checkCliStatus: () => ({ available: true }),
      fetchPrStatus: vi.fn(),
      fetchPrDetails: async () => ({
        number: 7, headBranch: 'feature', baseBranch: 'main', headSha: 'a'.repeat(40),
        headRepositoryUrl: 'https://example.invalid/org/repo.git', headRepositoryPushUrls: ['https://example.invalid/org/repo.git'], sameRepository: true,
      }),
    });

    // The project is not a Git repository, so the merge workflow fails and saves a failed task.
    const outcome = await executePrWorkflow({
      projectCwd: project.dir, prNumber: 7, workflow: 'merge-review',
      settings: resolveMergeSettings(undefined), display: { outputMode: 'silent' },
    }).then((result) => result.success, () => false);

    expect(outcome).toBe(false);
    const saved = project.runner.listTaskStateItems();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.status).toBe('failed');
    const calls = hookCalls(project);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toMatchObject({ TAKT_FINISH_TASK_NAME: saved[0]!.name, TAKT_FINISH_STATUS: 'failed' });
  });
});

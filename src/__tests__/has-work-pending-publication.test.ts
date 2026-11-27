/**
 * Regression 6 (the `hasWork` part) of docs/design/goal-task-completion-publication.md (#170): the
 * daemon counts a pending goal task completion as work until it is settled, and never counts a
 * record it cannot use.
 *
 * - While a valid pending completion exists, `hasWork()` is `true`.
 * - `aborted`, `completed` and deleted (`goal.json` gone) goals keep the mark unsettled: `hasWork()`
 *   stays `true` until `taskCompletions()` drops the mark without writing to the inbox, then it is
 *   `false`.
 * - A `tasks.yaml` that cannot be read is not work; the failure is reported once.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';

const save = vi.hoisted(() => vi.fn());
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: save }));

import { FileDaemonWatchSource } from '../features/daemon/watchSource.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
import { TaskStore } from '../infra/task/store.js';
import { listWatchEntries } from '../features/daemon/watchers/files.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';
import { goalId as defaultGoalId, goalRecord } from './helpers/goal-fixtures.js';

const CREATED = '2026-11-27T00:00:00.000Z';
const completion = (): Record<string, unknown> => ({
  success: false, interrupted: true, workflowResult: 'error', failureReason: 'Execution process stopped before saving its result',
});

function failedGoalTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'goal-task-a', status: 'failed', content: 'work', goal_id: defaultGoalId,
    created_at: CREATED, started_at: CREATED, completed_at: CREATED, failure: { error: 'boom' },
    run_slug: 'run-a', completion: completion(), completion_publication_pending: true,
    ...overrides,
  };
}

interface Harness {
  project: string;
  source: FileDaemonWatchSource;
  files: DaemonPersistedFiles;
  errors: unknown[];
}

const cleanups: Array<() => Promise<void>> = [];
const roots: string[] = [];

beforeEach(() => {
  save.mockReset();
  save.mockImplementation(() => {});
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function open(goal?: Record<string, unknown> | 'deleted'): Promise<Harness> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-has-work-publication-')));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(join(project, '.takt', 'goals'), { recursive: true });
  writeFileSync(join(project, '.takt', 'config.yaml'), 'language: en\nprovider: mock\n', 'utf-8');
  if (goal !== 'deleted') {
    mkdirSync(join(project, '.takt', 'goals', defaultGoalId), { recursive: true });
    writeFileSync(join(project, '.takt', 'goals', defaultGoalId, 'goal.json'), JSON.stringify({ ...goalRecord(), ...goal }));
  }
  vi.stubEnv('TAKT_CONFIG_DIR', join(root, 'global'));
  invalidateAllResolvedConfigCache();
  const globalDirectory = join(root, 'global');
  await registerProject({ globalConfigDirectory: globalDirectory, projectDirectory: project, command: 'manager', managerUsed: true });
  const errors: unknown[] = [];
  const conversations = new DaemonConversations(new ConversationStateStore(globalDirectory), new DaemonRouting(globalDirectory),
    new DaemonNotifications(globalDirectory), async () => {}, (error) => errors.push(error), { readTurns: async () => [] });
  const source = new FileDaemonWatchSource(conversations, async () => {}, (error) => errors.push(error));
  cleanups.push(async () => {
    await source.close();
    await conversations.close();
    vi.unstubAllEnvs();
  });
  return { project, source, files: new DaemonPersistedFiles(globalDirectory), errors };
}

function writeTasks(project: string, tasks: readonly Record<string, unknown>[]): void {
  writeFileSync(join(project, '.takt', 'tasks.yaml'), stringifyYaml({ tasks }), 'utf8');
}

async function taskCompletionsPass(source: FileDaemonWatchSource): Promise<void> {
  const run = (source as unknown as { taskCompletions?: () => Promise<void> }).taskCompletions;
  expect(run).toBeTypeOf('function');
  await run!.call(source);
}

async function inboxFiles(h: Harness): Promise<string[]> {
  const directory = await h.files.inboxDirectory(h.project);
  return (await listWatchEntries(directory)).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
}

describe('hasWork() counts a pending goal task completion', () => {
  it('is true while a valid mark exists and false once the task settles', async () => {
    const h = await open();
    writeTasks(h.project, [failedGoalTask()]);

    expect(await h.source.hasWork(h.files)).toBe(true);

    writeTasks(h.project, [failedGoalTask({ completion_publication_pending: undefined })]);
    expect(await h.source.hasWork(h.files)).toBe(false);
  });

  it('is false for a mark without an attempt identifier', async () => {
    const h = await open();
    writeTasks(h.project, [failedGoalTask({ run_slug: undefined, execution_id: undefined })]);

    expect(await h.source.hasWork(h.files)).toBe(false);
  });

  it('is false for a mark written as a string', async () => {
    const h = await open();
    writeTasks(h.project, [failedGoalTask({ completion_publication_pending: 'true' })]);

    expect(await h.source.hasWork(h.files)).toBe(false);
  });
});

describe('hasWork() keeps the daemon alive until a finished goal drops its mark', () => {
  it.each([
    ['aborted', { executionStatus: 'aborted' }],
    ['completed', { status: 'completed', executionStatus: 'completed' }],
    ['deleted', 'deleted'],
  ] as const)('settles a %s goal without writing the inbox', async (_label, goal) => {
    const h = await open(goal as Record<string, unknown> | 'deleted');
    writeTasks(h.project, [failedGoalTask()]);

    // The mark is read before the inbox, so the daemon does not exit while it waits to settle.
    expect(await h.source.hasWork(h.files)).toBe(true);

    await taskCompletionsPass(h.source);

    const task = new TaskStore(h.project).read().tasks[0]!;
    expect(task.completion_publication_pending).toBeUndefined();
    expect(await inboxFiles(h)).toEqual([]);
    expect(await h.source.hasWork(h.files)).toBe(false);
  });

  it('still writes the inbox for an active goal', async () => {
    const h = await open();
    writeTasks(h.project, [failedGoalTask()]);

    await taskCompletionsPass(h.source);

    expect(await inboxFiles(h)).toHaveLength(1);
    expect(await h.source.hasWork(h.files)).toBe(false);
  });
});

describe('hasWork() treats an unreadable tasks.yaml as no work and reports it once', () => {
  it('reports a broken tasks.yaml once across repeated checks', async () => {
    const h = await open();
    writeFileSync(join(h.project, '.takt', 'tasks.yaml'), 'tasks: [', 'utf8');

    expect(await h.source.hasWork(h.files)).toBe(false);
    expect(await h.source.hasWork(h.files)).toBe(false);
    await taskCompletionsPass(h.source);

    expect(h.errors.filter((error) => String(error).includes('tasks.yaml')).length).toBeLessThanOrEqual(1);
  });

  it('treats a symbolic link as no work instead of following it', async () => {
    const h = await open();
    const target = join(h.project, 'elsewhere.yaml');
    writeFileSync(target, stringifyYaml({ tasks: [failedGoalTask()] }), 'utf8');
    symlinkSync(target, join(h.project, '.takt', 'tasks.yaml'));

    expect(await h.source.hasWork(h.files)).toBe(false);
  });
});

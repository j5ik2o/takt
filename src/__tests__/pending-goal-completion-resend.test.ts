/**
 * PBT 3 and regressions 1–3 and 6 of docs/design/goal-task-completion-publication.md (#170), on real
 * files with no child process: a goal task failure whose manager notice could not be written stays
 * marked in `.takt/tasks.yaml`, and the daemon sends it again.
 *
 * - Setup failure: `saveManagerEvent` throws, the mark stays, `taskCompletions()` resends it to the
 *   inbox, clears the mark, and `receiveInboxChange` wakes the manager once. `hasWork()` is `true`
 *   while the mark is there and `false` after it is cleared.
 * - Interrupted recovery: the first notice throws and the second is still sent at once; the first
 *   keeps its mark and the daemon resends it.
 * - Lost-run reconciliation: with and without a `runSlug`, the task keeps a valid mark after the
 *   notice failed, and the daemon resends it.
 * - A live `deletion` reservation blocks the rewrite; a dead owner is recovered and the mark and the
 *   reservation are both removed; an `unknown` owner is left alone and is not work for the daemon.
 * - A late clear of the first attempt never removes the second attempt's mark.
 * - A writer copy and a daemon resend of the same attempt are one manager turn, including after a
 *   daemon restart; two normal completions with different `runSlug`s stay two turns.
 * - A `tasks.yaml` over 256 KiB and a `goal.json` over 4 MiB still resend and clear the mark.
 * - The YAML rewrite changes nothing but the mark.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocument, stringify as stringifyYaml } from 'yaml';

const save = vi.hoisted(() => vi.fn());
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: save }));

import { TaskRunner } from '../infra/task/index.js';
import { getSelfProcessIdentity } from '../infra/task/process.js';
import { TaskStore } from '../infra/task/store.js';
import type { GoalTaskSetupGuard } from '../infra/task/goalTaskSetupGuard.js';
import { claimTasksWithGoalCompletions, failInterruptedTasksWithGoalEvents } from '../features/tasks/execute/claimTasks.js';
import { reconcileLostRun } from '../features/daemonTurn/reconcileLostRun.js';
import { FileDaemonWatchSource } from '../features/daemon/watchSource.js';
import { receiveInboxChange } from '../features/daemon/inbox.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import type { EventInput } from '../core/daemon/events.js';
import type { WatchFileChange } from '../features/daemon/watchers/directories.js';
import { listWatchEntries } from '../features/daemon/watchers/files.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';
import { goalId as defaultGoalId, goalRecord } from './helpers/goal-fixtures.js';

const otherGoalId = '550e8400-e29b-41d4-a716-446655440001';
const CREATED = '2026-11-27T00:00:00.000Z';
const ENOSPC = (): Error => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
const COMPLETION_EVENT_ID = /^goal-completion-[a-f0-9]{64}$/;

type Row = Record<string, unknown>;

interface Harness {
  project: string;
  globalDirectory: string;
  source: FileDaemonWatchSource;
  files: DaemonPersistedFiles;
  store: FileEventStore;
  conversations: DaemonConversations;
  errors: unknown[];
}

const cleanups: Array<() => Promise<void>> = [];
const roots: string[] = [];

beforeEach(() => {
  save.mockReset();
  // A notice that cannot be written is the starting fault of every case here.
  save.mockImplementation(() => { throw ENOSPC(); });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A real project and a real daemon wiring, with the global state under an isolated root. */
async function open(goalIds: readonly string[] = [defaultGoalId]): Promise<Harness> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-pending-goal-completion-')));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(join(project, '.takt', 'goals'), { recursive: true });
  writeFileSync(join(project, '.takt', 'config.yaml'), 'language: en\nprovider: mock\n', 'utf-8');
  for (const id of goalIds) {
    mkdirSync(join(project, '.takt', 'goals', id), { recursive: true });
    writeFileSync(join(project, '.takt', 'goals', id, 'goal.json'), JSON.stringify({ ...goalRecord(), id }));
  }
  vi.stubEnv('TAKT_CONFIG_DIR', join(root, 'global'));
  invalidateAllResolvedConfigCache();
  const globalDirectory = join(root, 'global');
  await registerProject({ globalConfigDirectory: globalDirectory, projectDirectory: project, command: 'manager', managerUsed: true });
  const errors: unknown[] = [];
  const conversations = new DaemonConversations(new ConversationStateStore(globalDirectory), new DaemonRouting(globalDirectory),
    new DaemonNotifications(globalDirectory), async () => {}, (error) => errors.push(error), { readTurns: async () => [] });
  const source = new FileDaemonWatchSource(conversations, async () => {}, (error) => errors.push(error));
  const store = new FileEventStore(globalDirectory);
  cleanups.push(async () => {
    await source.close();
    await conversations.close();
    vi.unstubAllEnvs();
  });
  return { project, globalDirectory, source, files: new DaemonPersistedFiles(globalDirectory), store, conversations, errors };
}

function tasksPath(project: string): string {
  return join(project, '.takt', 'tasks.yaml');
}

/** A finished goal keeps the goal loop out of `hasWork`, so only the mark and deletion decide. */
function finishGoal(h: Harness): void {
  writeFileSync(join(h.project, '.takt', 'goals', defaultGoalId, 'goal.json'),
    JSON.stringify({ ...goalRecord(), executionStatus: 'aborted' }));
}

function readTasks(project: string): Row[] {
  return new TaskStore(project).read().tasks as unknown as Row[];
}

function writeTasks(project: string, tasks: readonly Row[]): void {
  writeFileSync(tasksPath(project), stringifyYaml({ tasks }), 'utf8');
}

/** A completion the writer already put in the inbox, with its own file name. */
function writeCompletionInbox(directory: string, name: string, taskName: string, runSlug: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, name), JSON.stringify({
    kind: 'completion', goalId: defaultGoalId, createdAt: CREATED, taskName, runSlug, result: completion(),
  }), 'utf8');
}

function completion(): Row {
  return { success: false, interrupted: true, workflowResult: 'error', failureReason: 'Execution process stopped before saving its result' };
}

/** A failed goal task as a writer saves it, with the mark the design puts beside it. */
function failedGoalTask(name: string, overrides: Row = {}): Row {
  return {
    name, status: 'failed', content: `work for ${name}`, goal_id: defaultGoalId,
    created_at: CREATED, started_at: CREATED, completed_at: CREATED, failure: { error: 'boom' },
    run_slug: `run-${name}`, completion: completion(), completion_publication_pending: true,
    ...overrides,
  };
}

function runningGoalTask(name: string, goal: string, overrides: Row = {}): Row {
  return {
    name, status: 'running', content: `work for ${name}`, goal_id: goal,
    created_at: CREATED, started_at: CREATED, completed_at: null, run_slug: `run-${name}`,
    ...overrides,
  };
}

/** The daemon resend entry (`FileDaemonWatchSource.taskCompletions`), run as `startDaemonWatchers` would. */
async function taskCompletionsPass(source: FileDaemonWatchSource): Promise<void> {
  const run = (source as unknown as { taskCompletions?: () => Promise<void> }).taskCompletions;
  expect(run).toBeTypeOf('function');
  await run!.call(source);
}

/**
 * Empties the manager inbox through `receiveInboxChange` into a real `FileEventStore`, the way the
 * daemon consumes it, and returns the inputs that started a new manager turn. A duplicate is
 * reported back as accepted, like `DaemonDispatcher` does, but does not count as a new turn.
 */
async function consumeInbox(h: Harness, store: FileEventStore = h.store): Promise<EventInput[]> {
  const directory = await h.files.inboxDirectory(h.project);
  const accepted: EventInput[] = [];
  for (const entry of await listWatchEntries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const change: WatchFileChange = { path: join(directory, entry.name), generation: 'g', value: undefined, removed: false,
      target: { kind: 'inbox', targetId: h.project, generation: 'g', directory, conversationId: '' } };
    await receiveInboxChange(change, h.files, h.conversations, { async accept(input) {
      const admission = await store.accept({ ...input, operationId: input.eventId, acceptedSequence: accepted.length + 1, lane: 'other' });
      if (admission.kind === 'duplicate') {
        return { kind: 'accepted', eventId: admission.event.eventId, operationId: admission.event.operationId,
          acceptedSequence: admission.event.acceptedSequence };
      }
      accepted.push(input);
      return { kind: 'accepted', eventId: input.eventId, operationId: input.eventId, acceptedSequence: accepted.length };
    } });
  }
  return accepted;
}

describe('a setup failure whose notice failed is resent by the daemon', () => {
  it('keeps the mark, resends to the inbox, clears it, and wakes the manager once', async () => {
    const h = await open();
    const runner = new TaskRunner(h.project);
    runner.addTask('Broken goal work', { workflow: 'default', goal_id: defaultGoalId, runtime_assignment: 'gone' });
    const guard: GoalTaskSetupGuard = { setupFailureReason: () => 'the runtime assignment is gone' };

    const claimed = runner.claimNextTasks(1, guard);

    expect(claimed.map((task) => task.name)).toEqual([]);
    const saved = readTasks(h.project)[0]!;
    expect(saved.status).toBe('failed');
    expect(saved.completion_publication_pending).toBe(true);
    expect(saved.run_slug ?? saved.execution_id).toBeDefined();
    expect(await h.source.hasWork(h.files)).toBe(true);

    await taskCompletionsPass(h.source);

    expect(readTasks(h.project)[0]!.completion_publication_pending).toBeUndefined();
    const accepted = await consumeInbox(h);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.eventId).toMatch(COMPLETION_EVENT_ID);
    expect(accepted[0]!.event).toMatchObject({ kind: 'task_failed' });
    // The active goal still keeps the daemon up after the mark is gone.
    expect(await h.source.hasWork(h.files)).toBe(true);
  });

  it('still sends the notice at once when the writer can write it', async () => {
    const h = await open();
    const actual = await vi.importActual<typeof import('../infra/goals/events.js')>('../infra/goals/events.js');
    save.mockImplementation((...args: Parameters<typeof actual.saveManagerEvent>) => actual.saveManagerEvent(...args));
    const runner = new TaskRunner(h.project);
    runner.addTask('Broken goal work', { workflow: 'default', goal_id: defaultGoalId, runtime_assignment: 'gone' });

    const claimed = claimTasksWithGoalCompletions(runner, 1, h.project, new AbortController().signal, true);

    expect(claimed.setupFailedTasks).toHaveLength(1);
    expect(save).toHaveBeenCalledOnce();
    // The writer cleared its own mark after the notice, so the daemon has nothing left to resend.
    await taskCompletionsPass(h.source);
    expect(await consumeInbox(h)).toHaveLength(1);
  });
});

describe('one failed notice does not stop the rest of the interrupted recovery', () => {
  it('sends the second notice at once while the first keeps its mark for the daemon', async () => {
    const h = await open([defaultGoalId, otherGoalId]);
    // A dead owner: the recovery treats both running tasks as interrupted.
    writeTasks(h.project, [
      runningGoalTask('interrupted-a', defaultGoalId, { owner_pid: 999_999, owner_start_time: null }),
      runningGoalTask('interrupted-b', otherGoalId, { owner_pid: 999_999, owner_start_time: null }),
    ]);
    const actual = await vi.importActual<typeof import('../infra/goals/events.js')>('../infra/goals/events.js');
    save.mockImplementationOnce(() => { throw ENOSPC(); })
      .mockImplementation((...args: Parameters<typeof actual.saveManagerEvent>) => actual.saveManagerEvent(...args));

    const recovered = failInterruptedTasksWithGoalEvents(new TaskRunner(h.project), h.project);

    // Regression 2: today the exception of the first notice escapes here and the second notice is
    // never attempted. The design catches per task, so the recovered count is 2 and the second
    // notice has reached the inbox.
    expect(recovered).toBe(2);
    expect(save).toHaveBeenCalledTimes(2);
    const tasks = readTasks(h.project);
    expect(tasks.map((task) => [task.name, task.completion_publication_pending])).toEqual([
      ['interrupted-a', true], ['interrupted-b', undefined],
    ]);
    // The second task's notice reached the inbox at once.
    const directory = await h.files.inboxDirectory(h.project);
    expect((await listWatchEntries(directory)).filter((entry) => entry.name.endsWith('.json'))).toHaveLength(1);

    await taskCompletionsPass(h.source);

    expect(readTasks(h.project).map((task) => task.completion_publication_pending)).toEqual([undefined, undefined]);
    const accepted = await consumeInbox(h);
    expect(accepted).toHaveLength(2);
    expect(new Set(accepted.map((input) => input.eventId)).size).toBe(2);
  });
});

describe('a lost run stays recoverable after its notice failed', () => {
  it.each([
    ['with a runSlug', { run_slug: 'run-lost' }],
    // The base record sets a run_slug, so the no-runSlug case has to remove it explicitly.
    ['without a runSlug', { run_slug: undefined }],
  ])('reconciles a running task %s and leaves a valid mark for the daemon', async (_label, identifiers) => {
    const h = await open();
    // The owner identity recorded on the task differs from the live process: the run is lost.
    const recorded = 'darwin-start-v2:1';
    writeTasks(h.project, [runningGoalTask('lost-run', defaultGoalId, { ...identifiers, owner_pid: process.pid, owner_start_time: recorded })]);
    const reference = { repositoryDirectory: h.project, goalId: defaultGoalId, taskName: 'lost-run',
      ...(identifiers.run_slug === undefined ? {} : { runSlug: identifiers.run_slug }) };

    const attempt = () => reconcileLostRun({ kind: 'run_process_lost', targetId: 't', generation: 'g',
      observedAt: CREATED, task: reference, pid: process.pid, startTime: recorded }, new AbortController().signal);
    // Today a failed notice is thrown out of the reconciliation; the design reports it and keeps
    // the mark, so a throwing call is recorded and the mark is still checked below.
    const thrown = (() => { try { return attempt(); } catch (error) { return error; } })();

    expect(thrown, 'the reconciliation must keep the task marked instead of only throwing').toBe(true);
    const task = readTasks(h.project)[0]!;
    expect(task.status).toBe('failed');
    expect(task.completion_publication_pending).toBe(true);
    expect(task.run_slug !== undefined || task.execution_id !== undefined).toBe(true);

    await taskCompletionsPass(h.source);

    expect(readTasks(h.project)[0]!.completion_publication_pending).toBeUndefined();
    const accepted = await consumeInbox(h);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.eventId).toMatch(COMPLETION_EVENT_ID);
  });
});

describe('a deletion reservation decides whether the mark may be cleared', () => {
  it('leaves a mark guarded by a live owner untouched and counts it as work', async () => {
    const h = await open();
    finishGoal(h);
    // A reservation held by this live process: its owner has not finished the deletion yet.
    const live = { id: '5a0e8400-e29b-41d4-a716-446655440002', owner_pid: process.pid,
      owner_start_time: getSelfProcessIdentity()!.startTime };
    writeTasks(h.project, [failedGoalTask('live-deletion', { deletion: live })]);
    const before = readFileSync(tasksPath(h.project), 'utf8');
    expect(await h.source.hasWork(h.files)).toBe(true);

    await taskCompletionsPass(h.source);

    expect(readFileSync(tasksPath(h.project), 'utf8')).toBe(before);
    expect(await consumeInbox(h)).toEqual([]);
  });

  it('recovers a reservation whose owner died and clears the mark with it', async () => {
    const h = await open();
    finishGoal(h);
    const dead = { id: '5a0e8400-e29b-41d4-a716-446655440000', owner_pid: 999_999 };
    writeTasks(h.project, [failedGoalTask('dead-deletion', { deletion: dead })]);

    await taskCompletionsPass(h.source);

    const task = readTasks(h.project)[0]!;
    expect(task.completion_publication_pending).toBeUndefined();
    expect(task.deletion).toBeUndefined();
    // The goal is finished, so the recovered mark is cleared without waking the manager.
    expect(await consumeInbox(h)).toEqual([]);
    expect(await h.source.hasWork(h.files)).toBe(false);
  });

  it('leaves a reservation whose owner is unknown untouched and does not count it as work', async () => {
    const h = await open();
    finishGoal(h);
    // A live pid without a recorded start time cannot be checked: the daemon neither rewrites nor waits.
    const unknown = { id: '5a0e8400-e29b-41d4-a716-446655440001', owner_pid: process.pid };
    writeTasks(h.project, [failedGoalTask('unknown-deletion', { deletion: unknown })]);
    const before = readFileSync(tasksPath(h.project), 'utf8');

    await taskCompletionsPass(h.source);

    expect(readFileSync(tasksPath(h.project), 'utf8')).toBe(before);
    expect(await h.source.hasWork(h.files)).toBe(false);
    expect(await consumeInbox(h)).toEqual([]);
  });
});

describe('one rejected owner inspection does not stop the rest of the project', () => {
  it('publishes the next completion of the same project when one deletion reservation cannot be inspected', async () => {
    const h = await open();
    // Only this reservation fails to be inspected; the second record has no reservation.
    const uninspectablePid = 424_242;
    writeTasks(h.project, [
      failedGoalTask('uninspectable-deletion', {
        deletion: { id: '5a0e8400-e29b-41d4-a716-446655440003', owner_pid: uninspectablePid, owner_start_time: 'darwin-start-v2:1' },
      }),
      failedGoalTask('published-after-rejection'),
    ]);
    const persisted = await import('../infra/daemon/persistedFiles.js');
    const actualInspect = persisted.inspectDeletionOwner;
    const inspection = vi.spyOn(persisted, 'inspectDeletionOwner').mockImplementation(async (deletion) => {
      if (deletion.owner_pid === uninspectablePid) throw new Error('owner inspection rejected');
      return actualInspect(deletion);
    });

    // Today the rejection escapes here and the second completion is never published.
    await taskCompletionsPass(h.source);

    expect(inspection).toHaveBeenCalledTimes(1);
    expect(readTasks(h.project).map((task) => [task.name, task.completion_publication_pending])).toEqual([
      ['uninspectable-deletion', true],
      ['published-after-rejection', undefined],
    ]);
    const accepted = await consumeInbox(h);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.eventId).toMatch(COMPLETION_EVENT_ID);
    expect(accepted[0]!.event).toMatchObject({ kind: 'task_failed', task: { taskName: 'published-after-rejection' } });
  });
});

describe('a late clear of the first attempt never removes the second attempt mark', () => {
  it('keeps the second attempt pending when the first attempt is cleared after the requeue', async () => {
    const h = await open();
    writeTasks(h.project, [failedGoalTask('retried', { run_slug: 'run-1', execution_id: 'exec-1' })]);
    // The task is requeued and fails again before any daemon read of attempt 1.
    writeTasks(h.project, [failedGoalTask('retried', { run_slug: 'run-2', execution_id: 'exec-2' })]);
    const runner = new TaskRunner(h.project);

    const clear = (runner as unknown as {
      clearCompletionPublicationPending?: (name: string, identity: Record<string, unknown>) => Record<string, unknown> | undefined;
    }).clearCompletionPublicationPending;
    expect(clear).toBeTypeOf('function');
    const cleared = clear!.call(runner, 'retried', { goalId: defaultGoalId, status: 'failed', runSlug: 'run-1', executionId: 'exec-1' });

    expect(cleared).toBeUndefined();
    expect(readTasks(h.project)[0]!.run_slug).toBe('run-2');
    expect(readTasks(h.project)[0]!.completion_publication_pending).toBe(true);
  });

  it('clears the mark when the attempt identity matches', async () => {
    const h = await open();
    writeTasks(h.project, [failedGoalTask('retried', { run_slug: 'run-1', execution_id: 'exec-1' })]);
    const runner = new TaskRunner(h.project);

    const clear = (runner as unknown as {
      clearCompletionPublicationPending?: (name: string, identity: Record<string, unknown>) => Record<string, unknown> | undefined;
    }).clearCompletionPublicationPending;
    expect(clear).toBeTypeOf('function');
    clear!.call(runner, 'retried', { goalId: defaultGoalId, status: 'failed', runSlug: 'run-1', executionId: 'exec-1' });

    expect(readTasks(h.project)[0]!.completion_publication_pending).toBeUndefined();
  });
});

describe('the inbox folds a writer copy and a daemon resend of the same attempt', () => {
  it('wakes once when the writer sent the notice but could not clear its mark, including after a restart', async () => {
    const h = await open();
    const actual = await vi.importActual<typeof import('../infra/goals/events.js')>('../infra/goals/events.js');
    save.mockImplementation((...args: Parameters<typeof actual.saveManagerEvent>) => actual.saveManagerEvent(...args));
    const runner = new TaskRunner(h.project);
    const clear = (runner as unknown as {
      clearCompletionPublicationPending?: (name: string, identity: Row) => unknown;
    }).clearCompletionPublicationPending;
    expect(clear).toBeTypeOf('function');
    vi.spyOn(runner as unknown as { clearCompletionPublicationPending: (name: string, identity: Row) => unknown },
      'clearCompletionPublicationPending').mockImplementation(() => { throw ENOSPC(); });
    const added = runner.addTask('Dedup goal work', { workflow: 'default', goal_id: defaultGoalId, runtime_assignment: 'gone' });

    const claimed = claimTasksWithGoalCompletions(runner, 1, h.project, new AbortController().signal, true);
    expect(claimed.setupFailedTasks.map((task) => task.name)).toEqual([added.name]);
    const saved = readTasks(h.project)[0]!;
    const runSlug = String(saved.run_slug);
    expect(saved.completion_publication_pending).toBe(true);
    expect(runSlug).not.toBe('undefined');
    const directory = await h.files.inboxDirectory(h.project);
    const inboxCopies = async (): Promise<string[]> => (await listWatchEntries(directory))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
    // The writer wrote the notice before the clear failed.
    expect(await inboxCopies()).toHaveLength(1);

    await taskCompletionsPass(h.source);

    expect(readTasks(h.project)[0]!.completion_publication_pending).toBeUndefined();
    // The daemon wrote its own copy for the same attempt.
    expect(await inboxCopies()).toHaveLength(2);
    expect(await consumeInbox(h)).toHaveLength(1);

    // A restarted daemon still remembers the accepted attempt and does not wake the manager again.
    writeCompletionInbox(directory, 'writer-retry.json', added.name, runSlug);
    expect(await consumeInbox(h, new FileEventStore(h.globalDirectory))).toEqual([]);
  });

  it('keeps two normal completions with different runSlugs as two separate turns', async () => {
    const h = await open();
    const directory = await h.files.inboxDirectory(h.project);
    writeCompletionInbox(directory, 'run-1.json', 'task-a', 'run-1');
    writeCompletionInbox(directory, 'run-2.json', 'task-a', 'run-2');

    expect(await consumeInbox(h)).toHaveLength(2);
  });
});

describe('the daemon reads the mark and the goal beyond the projection limits', () => {
  it('resends and clears a mark in a tasks.yaml larger than 256 KiB', async () => {
    const h = await open();
    writeTasks(h.project, [failedGoalTask('large-tasks', { content: 'x'.repeat(300 * 1024) })]);

    expect(await h.source.hasWork(h.files)).toBe(true);
    await taskCompletionsPass(h.source);

    expect(readTasks(h.project)[0]!.completion_publication_pending).toBeUndefined();
    expect(await consumeInbox(h)).toHaveLength(1);
  });

  it('resends and clears a mark whose goal.json is larger than 4 MiB', async () => {
    const h = await open();
    writeTasks(h.project, [failedGoalTask('large-goal')]);
    const goalPath = join(h.project, '.takt', 'goals', defaultGoalId, 'goal.json');
    writeFileSync(goalPath, `${JSON.stringify(goalRecord())}${' '.repeat(4 * 1024 * 1024)}`, 'utf8');

    await taskCompletionsPass(h.source);

    expect(readTasks(h.project)[0]!.completion_publication_pending).toBeUndefined();
    expect(await consumeInbox(h)).toHaveLength(1);
  });
});

describe('the rewrite changes nothing but the mark', () => {
  it('keeps other records, columns, comments and formatting', async () => {
    const h = await open();
    const source = [
      '# written by hand: keep this comment',
      'tasks:',
      '  - name: other-task', // comment beside a record
      '    status: completed',
      '    content: untouched',
      '    created_at: 2026-11-27T00:00:00.000Z',
      '    started_at: 2026-11-27T00:00:00.000Z',
      '    completed_at: 2026-11-27T01:00:00.000Z',
      '    workflow:   default   # aligned by hand',
      '  - name: pending-mark',
      '    status: "failed"',
      "    content: 'quoted content'",
      `    goal_id: ${defaultGoalId}`,
      '    created_at: 2026-11-27T00:00:00.000Z',
      '    started_at: 2026-11-27T00:00:00.000Z',
      '    completed_at: 2026-11-27T00:00:00.000Z',
      '    failure:',
      '      error: boom',
      '    run_slug: run-mark',
      '    completion:',
      '      success: false',
      '      interrupted: true',
      '    completion_publication_pending: true',
      '',
    ].join('\n');
    writeFileSync(tasksPath(h.project), source, 'utf8');

    await taskCompletionsPass(h.source);

    const after = readFileSync(tasksPath(h.project), 'utf8');
    expect(after).toContain('# written by hand: keep this comment');
    expect(after).toContain('workflow:   default   # aligned by hand');
    expect(after).toContain('  - name: other-task');
    expect(after).toContain('    status: "failed"');
    expect(after).toContain("    content: 'quoted content'");
    expect(after).not.toContain('completion_publication_pending');
    const document = parseDocument(after);
    expect(document.errors).toEqual([]);
    const before = parseDocument(source).toJS() as { tasks: Row[] };
    const updated = document.toJS() as { tasks: Row[] };
    expect(updated.tasks[0]).toEqual(before.tasks[0]);
    const withoutMark = ({ completion_publication_pending: _mark, ...rest }: Row): Row => rest;
    expect(withoutMark(updated.tasks[1]!)).toEqual(withoutMark(before.tasks[1]!));
  });
});

describe('the minimal rewrite does not delete a neighbouring task', () => {
  it('keeps the next task when a block deletion reservation ends the record', async () => {
    const h = await open();
    const source = [
      'tasks:',
      '  - name: marked-task',
      '    status: failed',
      '    content: work for marked-task',
      `    goal_id: ${defaultGoalId}`,
      '    created_at: 2026-11-27T00:00:00.000Z',
      '    started_at: 2026-11-27T00:00:00.000Z',
      '    completed_at: 2026-11-27T00:00:00.000Z',
      '    failure:',
      '      error: boom',
      '    run_slug: run-marked',
      '    completion_publication_pending: true',
      '    deletion:',
      '      id: 5a0e8400-e29b-41d4-a716-446655440000',
      '      owner_pid: 999999',
      '  - name: next-task',
      '    status: pending',
      '    content: work for next-task',
      '    created_at: 2026-11-27T00:00:00.000Z',
      '    started_at: null',
      '    completed_at: null',
      '',
    ].join('\n');
    writeFileSync(tasksPath(h.project), source, 'utf8');

    const published = await h.files.markGoalTaskCompletionPublished(h.project, {
      goalId: defaultGoalId, taskName: 'marked-task', status: 'failed', runSlug: 'run-marked',
    });

    expect(published).toBe(true);
    const tasks = readTasks(h.project);
    expect(tasks.map((task) => task.name)).toEqual(['marked-task', 'next-task']);
    expect(tasks[0]!.completion_publication_pending).toBeUndefined();
    expect(tasks[0]!.deletion).toBeUndefined();
    expect(tasks[1]!.status).toBe('pending');
  });

  it('keeps a flow-style record when the mark and the task share one line', async () => {
    const h = await open();
    const source = `tasks: [{name: marked-task, status: failed, content: work for marked-task, goal_id: ${defaultGoalId}, created_at: 2026-11-27T00:00:00.000Z, started_at: 2026-11-27T00:00:00.000Z, completed_at: 2026-11-27T00:00:00.000Z, failure: {error: boom}, run_slug: run-marked, completion_publication_pending: true, deletion: {id: 5a0e8400-e29b-41d4-a716-446655440000, owner_pid: 999999}}, {name: next-task, status: pending, content: work for next-task, created_at: 2026-11-27T00:00:00.000Z, started_at: null, completed_at: null}]\n`;
    writeFileSync(tasksPath(h.project), source, 'utf8');

    const published = await h.files.markGoalTaskCompletionPublished(h.project, {
      goalId: defaultGoalId, taskName: 'marked-task', status: 'failed', runSlug: 'run-marked',
    });

    expect(published).toBe(true);
    const tasks = readTasks(h.project);
    expect(tasks.map((task) => task.name)).toEqual(['marked-task', 'next-task']);
    expect(tasks[0]!.completion_publication_pending).toBeUndefined();
    expect(tasks[0]!.deletion).toBeUndefined();
  });
});

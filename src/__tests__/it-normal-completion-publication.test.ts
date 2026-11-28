/**
 * #216: a normal goal task completion gets the same `completion_publication_pending` mark as the
 * #170 failures, in the same tasks.yaml write as the save, when the caller that notifies the
 * manager asks for it. `takt run` notifies through the saved record, clears the mark on success,
 * and keeps the mark (for the daemon to resend) and warns when the notice fails, without counting
 * a finished execution differently. Real tasks.yaml, no child process.
 * Design: docs/design/issue-216-normal-completion-publication.md (R1–R7, R11–R13, R15, and the
 * one-manager-turn check of the decision that backs R13).
 * Model: specs/quint/normal-completion-publication/.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

const { save, executeWithDetails, resolve, post } = vi.hoisted(() => ({
  save: vi.fn(), executeWithDetails: vi.fn(), resolve: vi.fn(), post: vi.fn(),
}));
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: save }));
// R15 runs the real execution with its checkout resolution and post-execution flow stubbed
// (the same doubles as it-goal-task-stop.test.ts). The other cases never reach either.
vi.mock('../features/tasks/execute/resolveTask.js', async (original) => ({
  ...await original<typeof import('../features/tasks/execute/resolveTask.js')>(), resolveTaskExecution: resolve,
}));
vi.mock('../features/tasks/execute/postExecution.js', () => ({ postExecutionFlow: post }));
vi.mock('../features/tasks/execute/providerPreflight.js', () => ({
  checkPendingTaskProviders: vi.fn(async () => undefined),
  checkTaskNameProvider: vi.fn(async () => undefined),
  checkQueuedTaskProviders: vi.fn(async () => undefined),
  terminalProviderConfirmation: vi.fn(() => undefined),
}));
vi.mock('../features/tasks/execute/runTaskExecution.js', () => ({
  executeRunTaskAndComplete: vi.fn(),
  executeRunTaskAndCompleteWithDetails: executeWithDetails,
}));
vi.mock('../features/tasks/execute/inputWait.js', () => ({ isInputWaiting: vi.fn(() => false) }));

import { createHash } from 'node:crypto';
import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';
import { executeTaskAndCompleteWithDetails } from '../features/tasks/execute/taskExecution.js';
import type { ExecuteTaskOptions, TaskExecutionParallelOptions, WorkflowExecutionResult } from '../features/tasks/execute/types.js';
import { publishPendingGoalTaskCompletions } from '../features/daemon/pendingGoalTaskCompletions.js';
import { receiveInboxChange } from '../features/daemon/inbox.js';
import type { DaemonConversations } from '../features/daemon/conversationState.js';
import type { WatchFileChange } from '../features/daemon/watchers/directories.js';
import { listWatchEntries } from '../features/daemon/watchers/files.js';
import type { EventInput } from '../core/daemon/events.js';
import { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import { GoalStore } from '../infra/goals/store.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { TaskRunner, type TaskInfo, type TaskResult } from '../infra/task/index.js';
import type { ExceedTaskOptions } from '../infra/task/taskExceedService.js';
import { TaskStore } from '../infra/task/store.js';
import { readPendingGoalTaskCompletions, type PendingCompletionReports } from '../infra/task/taskStateReader.js';
import type { GoalTaskResult } from '../infra/goals/schema.js';
import { PrivateFileLockAcquisitionError } from '../shared/utils/private-file-lock.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';

type Row = Record<string, unknown>;

/** The request the design adds to the save functions (P2, P3). Typed locally: production has no field yet. */
type Requested = { completionPublicationPending?: true };
/** The request the design adds to the parallel options of a goal task (P5, P8). */
type ParallelRequest = { publishesGoalCompletion?: true } | undefined;

const RUN_SLUG = 'run-normal-completion';
const STARTED = '2026-11-28T00:00:00.000Z';
const FINISHED = '2026-11-28T00:01:00.000Z';
const SAVE_FUNCTIONS = ['completeTask', 'failTask', 'prFailTask', 'exceedTask'] as const;
type SaveFunction = typeof SAVE_FUNCTIONS[number];

const dirs: string[] = [];

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'takt-normal-completion-')));
  dirs.push(dir);
  mkdirSync(join(dir, '.takt', 'goals', goalId), { recursive: true });
  writeFileSync(join(dir, '.takt', 'config.yaml'), 'language: en\nprovider: mock\n', 'utf-8');
  writeFileSync(join(dir, '.takt', 'goals', goalId, 'goal.json'), JSON.stringify(goalRecord()));
  invalidateAllResolvedConfigCache();
  return dir;
}

function tasksPath(dir: string): string {
  return join(dir, '.takt', 'tasks.yaml');
}

/** The record as the file holds it, read without the TAKT schema. */
function rawRecord(dir: string, name: string): Row {
  const parsed = parseYaml(readFileSync(tasksPath(dir), 'utf8')) as { tasks: Row[] };
  const record = parsed.tasks.find((task) => task.name === name);
  if (record === undefined) throw new Error(`no record named ${name} in tasks.yaml`);
  return record;
}

/** What the daemon resend (`watchSource.taskCompletions`) would pick up from this project. */
async function pending(dir: string): Promise<Array<{ name: string; runSlug?: string }>> {
  const invalid: unknown[] = [];
  const reports: PendingCompletionReports = { invalid: (_key, error) => { invalid.push(error); }, valid: () => {} };
  const completions = await readPendingGoalTaskCompletions(dir, reports);
  expect(invalid).toEqual([]);
  return completions.map((completion) => ({ name: completion.name, runSlug: completion.runSlug }));
}

function warnings(): string[] {
  return vi.mocked(console.log).mock.calls.map(([message]) => String(message)).filter((message) => message.includes('[WARN]'));
}

function completion(success: boolean): GoalTaskResult {
  return success
    ? { success: true, interrupted: false, workflowResult: 'completed' }
    : { success: false, interrupted: false, workflowResult: 'error', failureReason: 'review rejected the change' };
}

/** A goal task claimed as `running` and given a run slug, the way an execution starts it. */
function running(dir: string, runner: TaskRunner, options: { goal?: boolean; runSlug?: boolean } = {}): TaskInfo {
  const added = runner.addTask('Normal goal work', {
    workflow: 'default', ...(options.goal === false ? {} : { goal_id: goalId }),
  });
  const claimed = runner.claimNextTasks(1, { setupFailureReason: () => undefined });
  expect(claimed.map((task) => task.name)).toEqual([added.name]);
  if (options.runSlug === false) return claimed[0]!;
  const started = runner.updateRunningTaskExecution(added.name, { runSlug: RUN_SLUG });
  expect(rawRecord(dir, added.name)).toMatchObject({ status: 'running', run_slug: RUN_SLUG });
  return started;
}

function taskResult(task: TaskInfo, success: boolean, requested: boolean, withCompletion = true): TaskResult & Requested {
  return {
    task, success, response: success ? 'done' : 'review rejected the change', executionLog: [],
    startedAt: STARTED, completedAt: FINISHED,
    ...(withCompletion ? { completion: completion(success) } : {}),
    ...(requested ? { completionPublicationPending: true as const } : {}),
  };
}

/** Saves the task through one of the four save functions, with or without the caller's request. */
function saveThrough(runner: TaskRunner, fn: SaveFunction, task: TaskInfo, requested: boolean): void {
  if (fn === 'exceedTask') {
    const options: ExceedTaskOptions & Requested = {
      completion: { success: false, interrupted: false, workflowResult: 'exceeded' },
      currentStep: 'implement', newMaxSteps: 20, currentIteration: 10,
      ...(requested ? { completionPublicationPending: true as const } : {}),
    };
    runner.exceedTask(task.name, options);
    return;
  }
  if (fn === 'completeTask') runner.completeTask(taskResult(task, true, requested));
  else if (fn === 'failTask') runner.failTask(taskResult(task, false, requested));
  else runner.prFailTask(taskResult(task, true, requested), 'gh pr create failed');
}

const SAVED_STATUS: Record<SaveFunction, string> = {
  completeTask: 'completed', failTask: 'failed', prFailTask: 'pr_failed', exceedTask: 'exceeded',
};

/**
 * Stands in for `executeRunTaskAndCompleteWithDetails` (P8): it starts the run like an execution,
 * then saves through the real `completeTask`/`failTask`, asking for the mark exactly when the
 * caller passed `publishesGoalCompletion: true` in the parallel options.
 */
function executeWithRealSave(success: boolean, afterSave: () => void = () => {}): void {
  executeWithDetails.mockImplementation(async (
    task: TaskInfo, runner: TaskRunner, _cwd: string, _options: unknown, parallel: ParallelRequest,
  ) => {
    const started = runner.updateRunningTaskExecution(task.name, { runSlug: RUN_SLUG });
    const result = taskResult(started, success, parallel?.publishesGoalCompletion === true);
    if (success) runner.completeTask(result);
    else runner.failTask(result);
    afterSave();
    return { success, runSlug: RUN_SLUG, completion: result.completion };
  });
}

function expectedEvent(name: string, success: boolean): Row {
  return { kind: 'completion', goalId, taskName: name, runSlug: RUN_SLUG, result: completion(success) };
}

/** A secret built at runtime so no literal token sits in the source. */
function secret(): string {
  return ['sk-', 'Zq24Zq', 'fake', 'fake', 'fake'].join('');
}

function notificationFailure(): PrivateFileLockAcquisitionError {
  return new PrivateFileLockAcquisitionError(`cannot notify completion (${secret()})`, 'ENOSPC', -28, { cause: new Error('ENOSPC') });
}

beforeEach(() => {
  save.mockReset();
  executeWithDetails.mockReset();
  resolve.mockReset();
  post.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the save marks a normal goal completion when the notifying caller asks', () => {
  // R1
  it.each(SAVE_FUNCTIONS)('marks a normal goal completion for resend in the same save: %s', async (fn) => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const task = running(dir, runner);

    saveThrough(runner, fn, task, true);

    const saved = rawRecord(dir, task.name);
    expect(saved).toMatchObject({ status: SAVED_STATUS[fn], goal_id: goalId, run_slug: RUN_SLUG });
    expect(saved.completion).toBeDefined();
    expect(saved.completion_publication_pending).toBe(true);
    expect(await pending(dir)).toEqual([{ name: task.name, runSlug: RUN_SLUG }]);
  });

  // R2: the mark follows the caller's condition (a run slug), not the schema's (a run slug or an execution id).
  it('does not mark a goal completion saved without a run slug', async () => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const task = running(dir, runner, { runSlug: false });
    expect(rawRecord(dir, task.name).execution_id).toBeDefined();

    runner.failTask(taskResult(task, false, true));

    const saved = rawRecord(dir, task.name);
    expect(saved).toMatchObject({ status: 'failed', goal_id: goalId, completion: completion(false) });
    expect(saved.run_slug).toBeUndefined();
    expect(saved.execution_id).toBeDefined();
    expect(saved.completion_publication_pending).toBeUndefined();
    expect(await pending(dir)).toEqual([]);
  });

  // R3
  it('does not mark a completion of a task without a goal', async () => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const task = running(dir, runner, { goal: false });

    runner.completeTask(taskResult(task, true, true));

    const saved = rawRecord(dir, task.name);
    expect(saved).toMatchObject({ status: 'completed', run_slug: RUN_SLUG, completion: completion(true) });
    expect(saved.goal_id).toBeUndefined();
    expect(saved.completion_publication_pending).toBeUndefined();
    expect(await pending(dir)).toEqual([]);
  });

  // R11: the save of instruct's re-execution goes through the same functions but does not ask.
  it.each(SAVE_FUNCTIONS)('does not mark a goal completion saved by a caller that does not publish it: %s', async (fn) => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const task = running(dir, runner);

    saveThrough(runner, fn, task, false);

    const saved = rawRecord(dir, task.name);
    expect(saved).toMatchObject({ status: SAVED_STATUS[fn], goal_id: goalId, run_slug: RUN_SLUG });
    expect(saved.completion).toBeDefined();
    expect(saved.completion_publication_pending).toBeUndefined();
    expect(await pending(dir)).toEqual([]);
  });
});

describe('takt run notifies a normal goal completion through its saved record', () => {
  // R4
  it('clears the mark after takt run notifies a normal completion', async () => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const added = runner.addTask('Normal goal work', { workflow: 'default', goal_id: goalId });
    executeWithRealSave(true);
    const markWhenNotified: unknown[] = [];
    save.mockImplementation(() => { markWhenNotified.push(rawRecord(dir, added.name).completion_publication_pending); });

    const result = await runWithWorkerPool(runner, [], 1, dir, undefined, undefined, 60_000, 'run');

    expect(result).toEqual({ success: 1, fail: 0, executedTaskNames: [added.name] });
    expect(save).toHaveBeenCalledExactlyOnceWith(dir, expectedEvent(added.name, true));
    // The mark was written with the save, so a notice that never lands would still be resent.
    expect(markWhenNotified).toEqual([true]);
    const saved = rawRecord(dir, added.name);
    expect(saved).toMatchObject({ status: 'completed', run_slug: RUN_SLUG });
    expect(saved.completion_publication_pending).toBeUndefined();
    expect(await pending(dir)).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  // R5
  it.each([true, false])('keeps the mark and counts the success when the takt run notification fails: success=%s', async (success) => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const added = runner.addTask('Normal goal work', { workflow: 'default', goal_id: goalId });
    executeWithRealSave(success);
    // The warning passes its detail through the sanitizer, which must hide this secret.
    expect(sanitizeSensitiveText(notificationFailure().message)).not.toContain(secret());
    save.mockImplementation(() => { throw notificationFailure(); });

    const result = await runWithWorkerPool(runner, [], 1, dir, undefined, undefined, 60_000, 'run');

    expect(result).toEqual({ success: success ? 1 : 0, fail: success ? 0 : 1, executedTaskNames: [added.name] });
    expect(save).toHaveBeenCalledExactlyOnceWith(dir, expectedEvent(added.name, success));
    expect(rawRecord(dir, added.name)).toMatchObject({
      status: success ? 'completed' : 'failed', run_slug: RUN_SLUG, completion_publication_pending: true,
    });
    expect(await pending(dir)).toEqual([{ name: added.name, runSlug: RUN_SLUG }]);
    const lines = warnings().filter((line) => line.includes(added.name) && line.includes(goalId)
      && line.includes(RUN_SLUG) && line.includes('manager was not notified'));
    expect(lines).toHaveLength(1);
    const output = vi.mocked(console.log).mock.calls.map((args) => args.map(String).join(' '));
    expect(output.filter((line) => line.includes(secret()))).toEqual([]);
  });

  // R6
  it('names the saved status when the mark cannot be cleared after a notification', async () => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const added = runner.addTask('Normal goal work', { workflow: 'default', goal_id: goalId });
    executeWithRealSave(true);
    const clear = vi.spyOn(runner, 'clearCompletionPublicationPending').mockImplementation(() => {
      throw new PrivateFileLockAcquisitionError('cannot clear the mark', 'ENOSPC', -28, { cause: new Error('ENOSPC') });
    });

    const result = await runWithWorkerPool(runner, [], 1, dir, undefined, undefined, 60_000, 'run');

    expect(result).toEqual({ success: 1, fail: 0, executedTaskNames: [added.name] });
    expect(save).toHaveBeenCalledExactlyOnceWith(dir, expectedEvent(added.name, true));
    expect(clear).toHaveBeenCalledOnce();
    expect(rawRecord(dir, added.name).completion_publication_pending).toBe(true);
    const lines = warnings().filter((line) => line.includes(added.name));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('saved as completed');
    expect(lines[0]).not.toContain('saved as failed');
  });

  // R12
  it('notifies from the run result and keeps the mark when the saved record cannot be read back', async () => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const added = runner.addTask('Normal goal work', { workflow: 'default', goal_id: goalId });
    // Armed by the execution after its save, so only the next read (the read back before the
    // notice) fails; the claim's reads before the execution are untouched.
    let failNextRead = false;
    const read = runner.listTaskStateItems.bind(runner);
    vi.spyOn(runner, 'listTaskStateItems').mockImplementation(() => {
      if (failNextRead) {
        failNextRead = false;
        throw new PrivateFileLockAcquisitionError('cannot read tasks', 'ENOSPC', -28, { cause: new Error('ENOSPC') });
      }
      return read();
    });
    executeWithRealSave(true, () => { failNextRead = true; });

    const result = await runWithWorkerPool(runner, [], 1, dir, undefined, undefined, 60_000, 'run');

    expect(result).toEqual({ success: 1, fail: 0, executedTaskNames: [added.name] });
    expect(save).toHaveBeenCalledExactlyOnceWith(dir, expectedEvent(added.name, true));
    expect(rawRecord(dir, added.name)).toMatchObject({ status: 'completed', completion_publication_pending: true });
    expect(await pending(dir)).toEqual([{ name: added.name, runSlug: RUN_SLUG }]);
    const lines = warnings().filter((line) => line.includes(added.name) && line.includes('could not be read back'));
    expect(lines).toHaveLength(1);
  });
});

describe('an old record without the mark', () => {
  // R7: decision 2 — an unmarked record is never read as waiting for a resend, and nothing rewrites it.
  it('reads an old completed goal record without the mark as not pending', async () => {
    const dir = project();
    writeFileSync(tasksPath(dir), [
      'tasks:',
      '  - name: old-goal-work',
      '    status: completed',
      '    content: Old goal work',
      `    goal_id: ${goalId}`,
      `    created_at: "${STARTED}"`,
      `    started_at: "${STARTED}"`,
      `    completed_at: "${FINISHED}"`,
      '    owner_pid: null',
      '    run_slug: run-old',
      '    completion:',
      '      success: true',
      '      interrupted: false',
      '      workflowResult: completed',
      '',
    ].join('\n'), 'utf8');
    const before = readFileSync(tasksPath(dir));

    expect(await pending(dir)).toEqual([]);
    const tasks = new TaskStore(dir).read().tasks;
    expect(tasks.map((task) => [task.name, task.status, task.completion_publication_pending]))
      .toEqual([['old-goal-work', 'completed', undefined]]);
    expect(new TaskRunner(dir).listTaskStateItems().map((task) => task.completionPublicationPending)).toEqual([undefined]);
    expect(readFileSync(tasksPath(dir)).equals(before)).toBe(true);
  });
});

const SETUP_RUN_SLUG = 'setup-normal-completion';
const ATTEMPT_SHAPES = ['normal', 'paused before the workflow'] as const;
type AttemptShape = typeof ATTEMPT_SHAPES[number];

/** The completion files waiting in this project's manager inbox, in name order. */
async function inboxFiles(dir: string): Promise<string[]> {
  const directory = await new DaemonPersistedFiles(getGlobalConfigDir()).inboxDirectory(dir);
  return (await listWatchEntries(directory))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => join(directory, entry.name)).sort();
}

/**
 * Hands every inbox file to the real `receiveInboxChange` with the real persisted files, the way the
 * daemon consumes the inbox, and passes each input to `accept`.
 */
async function consumeInbox(dir: string, accept: (input: EventInput) => Promise<void>): Promise<void> {
  const files = new DaemonPersistedFiles(getGlobalConfigDir());
  const directory = await files.inboxDirectory(dir);
  const conversations = {
    routing: { async resolve() { return { kind: 'repository', repositoryDirectory: dir }; } },
    async ensure() {},
  } as unknown as DaemonConversations;
  for (const path of await inboxFiles(dir)) {
    const change: WatchFileChange = { path, generation: 'g', value: undefined, removed: false,
      target: { kind: 'inbox', targetId: dir, generation: 'g', directory, conversationId: 'c' } };
    let sequence = 0;
    await receiveInboxChange(change, files, conversations, { async accept(input) {
      await accept(input);
      sequence += 1;
      return { kind: 'accepted', eventId: input.eventId, operationId: input.eventId, acceptedSequence: sequence };
    } });
  }
}

interface DaemonFirst {
  /** Completions the daemon read as pending right after the save. */
  resent: Array<{ name: string; runSlug?: string; executionId?: string }>;
  /** Inbox files after the daemon resend and before the caller's notice. */
  copiesBeforeNotice: number;
  /** The saved record right after the save, as the file holds it. */
  savedRecord?: Row;
  /** Errors `publishPendingGoalTaskCompletions` swallowed. */
  errors: unknown[];
}

/**
 * Stands in for the execution like `executeWithRealSave`, and lets the daemon resend before the
 * caller notifies: after the save it runs the real `readPendingGoalTaskCompletions` →
 * `publishPendingGoalTaskCompletions`. `paused before the workflow` saves the record the way a
 * `GoalPausedError` before the workflow does (no `run_slug` on the record, `setup-…` in the result).
 */
function executeWithDaemonFirst(dir: string, shape: AttemptShape): DaemonFirst {
  const seen: DaemonFirst = { resent: [], copiesBeforeNotice: -1, errors: [] };
  executeWithDetails.mockImplementation(async (
    task: TaskInfo, runner: TaskRunner, _cwd: string, _options: unknown, parallel: ParallelRequest,
  ) => {
    const requested = parallel?.publishesGoalCompletion === true;
    const success = shape === 'normal';
    let runSlug: string;
    let result: TaskResult & Requested;
    if (shape === 'normal') {
      runSlug = RUN_SLUG;
      result = taskResult(runner.updateRunningTaskExecution(task.name, { runSlug }), true, requested);
      runner.completeTask(result);
    } else {
      runSlug = SETUP_RUN_SLUG;
      const started = runner.updateRunningTaskExecution(task.name, { runSlug });
      result = taskResult({ ...started, runSlug: undefined }, false, requested);
      runner.failTask(result);
    }
    seen.savedRecord = rawRecord(dir, task.name);
    const reports: PendingCompletionReports = { invalid: (_key, error) => { seen.errors.push(error); }, valid: () => {} };
    const completions = await readPendingGoalTaskCompletions(dir, reports);
    seen.resent = completions.map((item) => ({ name: item.name, runSlug: item.runSlug, executionId: item.executionId }));
    await publishPendingGoalTaskCompletions(getGlobalConfigDir(),
      completions.map((item) => ({ ...item, repositoryDirectory: dir })),
      async (repositoryDirectory, id) => new GoalStore(repositoryDirectory).getSync(id),
      (error) => { seen.errors.push(error); });
    seen.copiesBeforeNotice = (await inboxFiles(dir)).length;
    return { success, runSlug, completion: result.completion };
  });
  return seen;
}

function completionEventId(inboxDirectory: string, taskName: string, tag: 'run' | 'execution', attemptId: string): string {
  return `goal-completion-${createHash('sha256').update(JSON.stringify([inboxDirectory, goalId, taskName, tag, attemptId])).digest('hex')}`;
}

describe('the caller and the daemon send one attempt under one inbox event id', () => {
  // R13: decision "the same notice delivered twice does not queue twice". The daemon resends before
  // the caller notifies, then the caller notifies through the real saveManagerEvent.
  it.each(ATTEMPT_SHAPES)("gives the caller's notice and the daemon's resend of one attempt one inbox event id: %s", async (shape) => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const added = runner.addTask('Normal goal work', { workflow: 'default', goal_id: goalId });
    const actual = await vi.importActual<typeof import('../infra/goals/events.js')>('../infra/goals/events.js');
    save.mockImplementation((...args: Parameters<typeof actual.saveManagerEvent>) => actual.saveManagerEvent(...args));
    const seen = executeWithDaemonFirst(dir, shape);

    const result = await runWithWorkerPool(runner, [], 1, dir, undefined, undefined, 60_000, 'run');

    const normal = shape === 'normal';
    expect(result).toEqual({ success: normal ? 1 : 0, fail: normal ? 0 : 1, executedTaskNames: [added.name] });
    expect(seen.errors).toEqual([]);
    expect(save).toHaveBeenCalledOnce();
    if (normal) {
      expect(seen.savedRecord).toMatchObject({ status: 'completed', run_slug: RUN_SLUG });
      // Premise: the save marked the attempt, so the daemon really resent it before the caller's notice.
      expect(seen.resent).toEqual([{ name: added.name, runSlug: RUN_SLUG, executionId: expect.any(String) }]);
      expect(seen.copiesBeforeNotice).toBe(1);
    } else {
      expect(seen.savedRecord).toMatchObject({ status: 'failed', execution_id: expect.any(String) });
      expect(seen.savedRecord!.run_slug).toBeUndefined();
      // The paused attempt is not marked (P1), so only the caller's notice reaches the inbox.
      expect(seen.resent).toEqual([]);
      expect(seen.copiesBeforeNotice).toBe(0);
    }
    const copies = await inboxFiles(dir);
    expect(copies).toHaveLength(normal ? 2 : 1);

    const eventIds: string[] = [];
    await consumeInbox(dir, async (input) => { eventIds.push(input.eventId); });

    expect(eventIds).toHaveLength(copies.length);
    const inboxDirectory = await new DaemonPersistedFiles(getGlobalConfigDir()).inboxDirectory(dir);
    expect([...new Set(eventIds)]).toEqual([completionEventId(inboxDirectory, added.name, 'run', normal ? RUN_SLUG : SETUP_RUN_SLUG)]);
    expect(await inboxFiles(dir)).toEqual([]);
    expect(await pending(dir)).toEqual([]);
  });
});

describe('the manager takes one attempt once', () => {
  // Decision "the same notice delivered twice does not make the manager advance the goal twice": the
  // two copies of R13's normal attempt go through the daemon's real event store, which starts one
  // manager turn and folds the other copy as a duplicate.
  it("starts one manager turn for the caller's notice and the daemon's resend of one attempt", async () => {
    const dir = project();
    const runner = new TaskRunner(dir);
    const added = runner.addTask('Normal goal work', { workflow: 'default', goal_id: goalId });
    const actual = await vi.importActual<typeof import('../infra/goals/events.js')>('../infra/goals/events.js');
    save.mockImplementation((...args: Parameters<typeof actual.saveManagerEvent>) => actual.saveManagerEvent(...args));
    const seen = executeWithDaemonFirst(dir, 'normal');

    const result = await runWithWorkerPool(runner, [], 1, dir, undefined, undefined, 60_000, 'run');

    expect(result).toEqual({ success: 1, fail: 0, executedTaskNames: [added.name] });
    expect(seen.errors).toEqual([]);
    // Premise: the daemon resent the marked attempt before the caller's notice, so both copies wait.
    expect(seen.resent).toEqual([{ name: added.name, runSlug: RUN_SLUG, executionId: expect.any(String) }]);
    expect(await inboxFiles(dir)).toHaveLength(2);

    const store = new FileEventStore(getGlobalConfigDir());
    const turns: EventInput[] = [];
    let duplicates = 0;
    await consumeInbox(dir, async (input) => {
      const admission = await store.accept({ ...input, operationId: input.eventId, acceptedSequence: turns.length + 1, lane: 'other' });
      if (admission.kind === 'duplicate') duplicates += 1;
      else turns.push(input);
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]!.event).toMatchObject({ kind: 'task_completed', task: { goalId, taskName: added.name } });
    expect(duplicates).toBe(1);
    expect(await inboxFiles(dir)).toEqual([]);
  });
});

describe('the execution passes the caller request down to the save', () => {
  // R15: the real executeTaskAndCompleteWithDetails → persist* → save function, without the mock of R4–R13.
  it.each(['completed', 'failed'] as const)("passes the caller's request from the execution to the save: %s", async (status) => {
    const dir = project();
    writeFileSync(join(dir, '.takt', 'config.yaml'), 'language: en\nprovider: mock\nmanager:\n  auto_run: false\n', 'utf-8');
    invalidateAllResolvedConfigCache();
    resolve.mockImplementation(async () => ({ execCwd: dir, workflowIdentifier: 'default',
      reportDirName: RUN_SLUG, isWorktree: false, autoPr: false, draftPr: false,
      managedPr: false, shouldPublishBranchToOrigin: false }));
    const runner = new TaskRunner(dir);
    const executor = async (_options: ExecuteTaskOptions): Promise<WorkflowExecutionResult> => (status === 'completed'
      ? { success: true } : { success: false, reason: 'review rejected the change' });
    const asked: TaskExecutionParallelOptions & { publishesGoalCompletion?: true } = { outputMode: 'silent', publishesGoalCompletion: true };
    const notAsked: TaskExecutionParallelOptions = { outputMode: 'silent' };

    for (const [parallel, marked] of [[asked, true], [notAsked, false]] as const) {
      const added = runner.addTask('Normal goal work', { workflow: 'default', goal_id: goalId, worktree: false });
      const task = runner.claimNextTasks(1)[0]!;
      expect(task.name).toBe(added.name);

      const result = await executeTaskAndCompleteWithDetails(task, runner, dir, executor, undefined, parallel);

      expect(result).toMatchObject({ success: status === 'completed', runSlug: RUN_SLUG, completion: { success: status === 'completed' } });
      const saved = rawRecord(dir, added.name);
      expect(saved).toMatchObject({ status, goal_id: goalId, run_slug: RUN_SLUG });
      expect(saved.completion).toBeDefined();
      expect(saved.completion_publication_pending).toBe(marked ? true : undefined);
    }
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
    expect(await pending(dir)).toEqual([{ name: expect.any(String), runSlug: RUN_SLUG }]);
  });
});

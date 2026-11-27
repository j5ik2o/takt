/**
 * PBT 2 (second half) and regression 5 of docs/design/goal-task-completion-publication.md (#170):
 * one invalid record in `.takt/tasks.yaml` does not stop the whole read.
 *
 * - `readWatchTasks` returns every task however the single mark or completion is malformed.
 * - `readPendingGoalTaskCompletions` skips a record whose mark is not `true` without reporting it,
 *   reports a `true` mark whose content is invalid and skips it, and still returns every other
 *   valid pending completion in the same file.
 * - Reading the same content again reports the same record once.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { stringify as stringifyYaml } from 'yaml';
import { readWatchTasks } from '../infra/task/taskStateReader.js';
import { readPendingGoalTaskCompletions } from '../infra/task/taskStateReader.js';
import { isValidCompletionPublicationPending } from '../infra/task/taskRecordSchemas.js';
import { FileDaemonWatchSource } from '../features/daemon/watchSource.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';

const GOAL_ID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_GOAL_ID = '550e8400-e29b-41d4-a716-446655440001';

/** The report record shared by the watch tick and `hasWork` (an `InvalidInquiryFileReports`-shaped dup filter). */
interface Reports {
  invalid(key: string, error: unknown): Promise<void>;
  valid(key: string): void;
}

/** A test double for the daemon's shared report record: it remembers what it was told. */
function reports(): Reports & { invalids: Array<{ key: string; error: unknown }> } {
  const invalids: Array<{ key: string; error: unknown }> = [];
  const seen = new Set<string>();
  return {
    invalids,
    async invalid(key: string, error: unknown) { if (seen.has(key)) return; seen.add(key); invalids.push({ key, error }); },
    valid(key: string) { seen.delete(key); },
  };
}

const created = '2026-11-27T00:00:00.000Z';

// A new object on every call: a shared one would be written as a YAML anchor/alias, which
// `readWatchTasks` rejects before it looks at any record.
const completion = (): Record<string, unknown> => ({ success: false, interrupted: true, workflowResult: 'error', failureReason: 'boom' });

function pendingMarked(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'goal-task-a', status: 'failed', content: 'do the work', goal_id: GOAL_ID,
    created_at: created, started_at: created, completed_at: created, failure: { error: 'boom' },
    run_slug: 'run-a', completion: completion(), completion_publication_pending: true,
    ...overrides,
  };
}

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'takt-watch-invalid-pending-'));
  mkdirSync(join(project, '.takt'), { recursive: true });
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function writeTasks(tasks: readonly Record<string, unknown>[]): void {
  writeFileSync(join(project, '.takt', 'tasks.yaml'), stringifyYaml({ tasks }), 'utf8');
}

describe('one invalid pending completion does not stop readWatchTasks or the run watch', () => {
  const valid = pendingMarked({ name: 'goal-task-valid' });
  const invalidMarks: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['an unknown column in completion', pendingMarked({ name: 'goal-task-unknown', completion: { ...completion(), unknownColumn: 1 } })],
    ['a mark written as a string', pendingMarked({ name: 'goal-task-string', completion_publication_pending: 'true' })],
    ['a mark written as false', pendingMarked({ name: 'goal-task-false', completion_publication_pending: false })],
    ['a non-terminal mark', pendingMarked({ name: 'goal-task-running', status: 'running', started_at: created, completed_at: null,
      failure: undefined, completion: completion(), completion_publication_pending: true })],
    ['a mark without a goal', pendingMarked({ name: 'goal-task-no-goal', goal_id: undefined })],
    ['a mark without an attempt identifier', pendingMarked({ name: 'goal-task-no-attempt', run_slug: undefined, execution_id: undefined })],
    ['a mark without completion', pendingMarked({ name: 'goal-task-no-completion', completion: undefined })],
  ];

  it.each(invalidMarks)('returns every task when one record has %s', async (_label, invalid) => {
    writeTasks([invalid, valid, { name: 'plain', status: 'pending', content: 'x', created_at: created, started_at: null, completed_at: null }]);

    const tasks = await readWatchTasks(project);

    expect(tasks.map((task) => task.name)).toEqual([String(invalid.name), 'goal-task-valid', 'plain']);
  });

  it('returns the same valid task that a file without the invalid record returns', async () => {
    writeTasks([valid]);
    const clean = await readWatchTasks(project);
    writeTasks([valid, invalidMarks[0]![1]]);
    const withInvalid = await readWatchTasks(project);

    expect(withInvalid.filter((task) => task.name === 'goal-task-valid')).toEqual(clean);
  });

  it('keeps runs() returning the running goal tasks next to the invalid record', async () => {
    const running = pendingMarked({ name: 'goal-task-running', status: 'running', started_at: created, completed_at: null,
      failure: undefined, completion: undefined, owner_pid: process.pid, run_slug: 'run-r' });
    writeTasks([invalidMarks[0]![1], running]);
    const errors: unknown[] = [];
    const globalDirectory = join(project, 'global');
    await registerProject({ globalConfigDirectory: globalDirectory, projectDirectory: project, command: 'manager', managerUsed: true });
    const owner = new DaemonConversations(new ConversationStateStore(globalDirectory), new DaemonRouting(globalDirectory),
      new DaemonNotifications(globalDirectory), async () => {}, (error) => errors.push(error), { readTurns: async () => [] });
    const source = new FileDaemonWatchSource(owner, async () => {}, (error) => errors.push(error));
    try {
      const targets = await source.runs();
      expect(targets.map((target) => target.task.taskName)).toEqual(['goal-task-running']);
      expect(errors).toEqual([]);
    } finally {
      await source.close();
      await owner.close();
    }
  });

  it('skips a mark written as a string without reporting it or returning it', async () => {
    const invalidMark = pendingMarked({ name: 'goal-task-string', completion_publication_pending: 'true' });
    writeTasks([invalidMark, valid]);
    const recorded = reports();

    const completions = await readPendingGoalTaskCompletions(project, recorded);

    expect(completions.map((value: { name: string }) => value.name)).toEqual(['goal-task-valid']);
    expect(recorded.invalids).toEqual([]);
  });
});

describe('the two readers separate a bad record from the rest for every shape', () => {
  const status = fc.constantFrom('pending', 'running', 'completed', 'failed', 'exceeded', 'pr_failed');
  const terminal = fc.constantFrom('completed', 'failed', 'exceeded', 'pr_failed');
  const mark = fc.constantFrom(true, false, 'true', 1, null, undefined);

  function generated(name: string, values: {
    status: string; hasGoal: boolean; hasCompletion: boolean; hasRunSlug: boolean;
    hasExecutionId: boolean; unknownColumn: boolean; mark: unknown;
  }): Record<string, unknown> {
    return pendingMarked({
      name,
      status: values.status,
      started_at: values.status === 'pending' ? null : created,
      completed_at: values.status === 'pending' || values.status === 'running' ? null : created,
      failure: values.status === 'failed' || values.status === 'pr_failed' ? { error: 'boom' } : undefined,
      goal_id: values.hasGoal ? GOAL_ID : undefined,
      completion: values.hasCompletion
        ? { ...completion(), ...(values.unknownColumn ? { unknownColumn: 1 } : {}) }
        : undefined,
      run_slug: values.hasRunSlug ? 'run-subject' : undefined,
      execution_id: values.hasRunSlug ? undefined : values.hasExecutionId ? 'exec-subject' : undefined,
      completion_publication_pending: values.mark,
    });
  }

  it('returns every task from readWatchTasks whatever the mark and completion hold', async () => {
    await fc.assert(fc.asyncProperty(status, fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), mark,
      async (value, hasGoal, hasCompletion, hasRunSlug, hasExecutionId, unknownColumn, pending) => {
        writeTasks([generated('goal-task-subject', { status: value, hasGoal, hasCompletion, hasRunSlug, hasExecutionId, unknownColumn, mark: pending }),
          pendingMarked({ name: 'goal-task-valid' })]);

        const tasks = await readWatchTasks(project);

        expect(tasks.map((task) => task.name)).toEqual(['goal-task-subject', 'goal-task-valid']);
      }), { numRuns: 40 });
  });

  it('reports only the invalid pending completion once and returns every valid one', async () => {
    await fc.assert(fc.asyncProperty(terminal, fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(),
      async (value, hasGoal, hasCompletion, hasRunSlug, hasExecutionId, unknownColumn) => {
        const subject = generated('goal-task-subject', { status: value, hasGoal, hasCompletion, hasRunSlug, hasExecutionId, unknownColumn, mark: true });
        writeTasks([subject, pendingMarked({ name: 'goal-task-valid' })]);
        const recorded = reports();
        const valid = hasGoal && hasCompletion && !unknownColumn && (hasRunSlug || hasExecutionId);

        const completions = await readPendingGoalTaskCompletions(project, recorded);

        expect(completions.map((task: { name: string }) => task.name)).toEqual(valid
          ? ['goal-task-subject', 'goal-task-valid'] : ['goal-task-valid']);
        expect(recorded.invalids).toHaveLength(valid ? 0 : 1);
        if (!valid) expect(recorded.invalids[0]!.key).toContain('goal-task-subject');

        await readPendingGoalTaskCompletions(project, recorded);
        expect(recorded.invalids).toHaveLength(valid ? 0 : 1);
      }), { numRuns: 40 });
  });

  it('never reports or returns a mark that is not true, whatever its content holds', async () => {
    const nonTrueMark = fc.constantFrom(false, 'true', 1, null, undefined);

    await fc.assert(fc.asyncProperty(terminal, fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), nonTrueMark,
      async (value, hasGoal, hasCompletion, hasRunSlug, hasExecutionId, unknownColumn, pending) => {
        // A mark that is not `true` is skipped before its completion is parsed, so even an unknown
        // column, a missing goal or a missing attempt identifier is not a reportable record.
        const subject = generated('goal-task-subject', { status: value, hasGoal, hasCompletion, hasRunSlug, hasExecutionId, unknownColumn, mark: pending });
        writeTasks([subject, pendingMarked({ name: 'goal-task-valid' })]);
        const recorded = reports();

        const completions = await readPendingGoalTaskCompletions(project, recorded);

        expect(completions.map((task: { name: string }) => task.name)).toEqual(['goal-task-valid']);
        expect(recorded.invalids).toEqual([]);

        await readPendingGoalTaskCompletions(project, recorded);
        expect(recorded.invalids).toEqual([]);
      }), { numRuns: 40 });
  });
});

describe('readPendingGoalTaskCompletions reports the invalid record and returns the rest', () => {
  it('is provided by the task state reader', () => {
    expect(readPendingGoalTaskCompletions).toBeTypeOf('function');
  });

  it('reports a completion with an unknown column once and keeps every other valid pending completion', async () => {
    const unknown = pendingMarked({ name: 'goal-task-unknown', goal_id: OTHER_GOAL_ID, completion: { ...completion(), unknownColumn: 1 } });
    const first = pendingMarked({ name: 'goal-task-a', run_slug: 'run-a' });
    const second = pendingMarked({ name: 'goal-task-b', run_slug: undefined, execution_id: 'exec-b' });
    writeTasks([unknown, first, second]);
    const recorded = reports();

    const completions = await readPendingGoalTaskCompletions(project, recorded);

    expect(completions.map((value: { name: string }) => value.name)).toEqual(['goal-task-a', 'goal-task-b']);
    expect(recorded.invalids).toHaveLength(1);
    expect(recorded.invalids[0]!.key).toContain('goal-task-unknown');
  });

  it('reports the same record once across repeated reads of the same content', async () => {
    writeTasks([pendingMarked({ name: 'goal-task-unknown', completion: { ...completion(), unknownColumn: 1 } }), pendingMarked({ name: 'goal-task-a' })]);
    const recorded = reports();

    await readPendingGoalTaskCompletions(project, recorded);
    await readPendingGoalTaskCompletions(project, recorded);
    await readPendingGoalTaskCompletions(project, recorded);

    expect(recorded.invalids).toHaveLength(1);
  });

  it('reports a record again after its content changes', async () => {
    const recorded = reports();
    writeTasks([pendingMarked({ name: 'goal-task-unknown', completion: { ...completion(), unknownColumn: 1 } })]);
    await readPendingGoalTaskCompletions(project, recorded);
    writeTasks([pendingMarked({ name: 'goal-task-unknown', completion: { ...completion(), unknownColumn: 2 } })]);
    await readPendingGoalTaskCompletions(project, recorded);

    expect(recorded.invalids).toHaveLength(2);
  });

  it('returns an empty list when tasks.yaml is missing', async () => {
    expect(await readPendingGoalTaskCompletions(project, reports())).toEqual([]);
  });

  it('does not parse the completion of records without the mark', async () => {
    // A normal (unmarked) record may carry whatever the version that wrote it had in `completion`.
    const unmarked = pendingMarked({ name: 'normal-task', completion: { ...completion(), unknownColumn: 1 }, completion_publication_pending: undefined });
    writeTasks([unmarked, pendingMarked({ name: 'goal-task-a' })]);
    const recorded = reports();

    const completions = await readPendingGoalTaskCompletions(project, recorded);

    expect(completions.map((value: { name: string }) => value.name)).toEqual(['goal-task-a']);
    expect(recorded.invalids).toEqual([]);
  });

  it('leaves tasks.yaml unchanged after reporting', async () => {
    writeTasks([pendingMarked({ name: 'goal-task-unknown', completion: { ...completion(), unknownColumn: 1 } })]);
    const before = readFileSync(join(project, '.takt', 'tasks.yaml'), 'utf8');

    await readPendingGoalTaskCompletions(project, reports());

    expect(readFileSync(join(project, '.takt', 'tasks.yaml'), 'utf8')).toBe(before);
  });
});

describe('the shared validity predicate matches the four conditions', () => {
  it('is exported next to the schema', () => {
    expect(isValidCompletionPublicationPending).toBeTypeOf('function');
  });
});

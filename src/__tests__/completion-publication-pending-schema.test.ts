/**
 * PBT 2 (first half) of docs/design/goal-task-completion-publication.md (#170): `TaskRecordSchema`
 * normalizes an invalid `completion_publication_pending` on read instead of rejecting the file.
 *
 * - `true` stays `true` only for a terminal record that has `goal_id`, `completion` and a
 *   `run_slug` or `execution_id`.
 * - Any other `true` (`pending` / `running`, no `goal_id`, no `completion`, no attempt identifier)
 *   and any non-`true` value (`false`, a string, a number, `null`) becomes `undefined` without an
 *   exception, with a `warn` log that names the task. A valid mark is not warned about.
 * - A record whose `completion` carries an unknown column is still rejected as a whole. That is the
 *   behaviour of `GoalTaskResultSchema` (`.strict()`) today and this change keeps it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { TaskRecordSchema } from '../infra/task/taskRecordSchemas.js';

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('../shared/utils/index.js', async (original) => ({
  ...await original<typeof import('../shared/utils/index.js')>(),
  createLogger: () => ({ warn: log.warn, error: log.error, info: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}));

const GOAL_ID = '550e8400-e29b-41d4-a716-446655440000';
const STARTED_AT = '2026-11-27T00:00:00.000Z';
const COMPLETED_AT = '2026-11-27T01:00:00.000Z';
const TERMINAL_STATUSES = ['completed', 'failed', 'exceeded', 'pr_failed'] as const;

const completion = { success: false, interrupted: true, workflowResult: 'error', failureReason: 'Execution process stopped before saving its result' };

/** A record both the current and the designed schema read without complaint. */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'task-a', status: 'failed', content: 'do the work', goal_id: GOAL_ID,
    created_at: STARTED_AT, started_at: STARTED_AT, completed_at: COMPLETED_AT,
    failure: { error: 'boom' }, run_slug: 'run-a', completion,
    ...overrides,
  };
}

function parse(value: Record<string, unknown>) {
  return TaskRecordSchema.parse(value) as Record<string, unknown>;
}

beforeEach(() => { log.warn.mockClear(); log.error.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('a valid completion_publication_pending mark survives the read', () => {
  it.each(TERMINAL_STATUSES)('keeps true on a terminal %s goal task with completion and a run_slug', (status) => {
    expect(parse(record({ status, started_at: STARTED_AT, completed_at: COMPLETED_AT,
      failure: status === 'failed' || status === 'pr_failed' ? { error: 'boom' } : undefined,
      completion_publication_pending: true })).completion_publication_pending).toBe(true);
  });

  it('keeps true when only the execution_id identifies the attempt', () => {
    expect(parse(record({ run_slug: undefined, execution_id: 'exec-1', completion_publication_pending: true })).completion_publication_pending).toBe(true);
  });

  it('leaves a record without the mark without one', () => {
    expect(parse(record())).not.toHaveProperty('completion_publication_pending');
  });
});

describe('an invalid completion_publication_pending mark is dropped on read, not rejected', () => {
  it.each([
    { label: 'pending', status: 'pending', started_at: null, completed_at: null, failure: undefined },
    { label: 'running', status: 'running', started_at: STARTED_AT, completed_at: null, failure: undefined },
    { label: 'no goal_id', status: 'failed', goal_id: undefined },
    { label: 'no completion', status: 'failed', completion: undefined },
    { label: 'no run_slug and no execution_id', status: 'failed', run_slug: undefined },
  ])('drops true for a record with $label', ({ status, ...rest }) => {
    const parsed = parse(record({ status, ...rest, completion_publication_pending: true }));
    expect(parsed.completion_publication_pending).toBeUndefined();
    expect(parsed).not.toHaveProperty('completion_publication_pending');
  });

  it.each([
    ['false', false], ['the string true', 'true'], ['a number', 1], ['null', null], ['an object', { pending: true }],
  ])('drops a mark written as %s', (_label, pending) => {
    expect(parse(record({ completion_publication_pending: pending })).completion_publication_pending).toBeUndefined();
  });

  it('warns while normalizing an invalid mark, and stays silent for a valid one', () => {
    parse(record({ completion_publication_pending: true }));
    expect(log.warn).not.toHaveBeenCalled();

    parse(record({ status: 'pending', started_at: null, completed_at: null, failure: undefined, completion_publication_pending: true }));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]!.map(String).join(' ')).toContain('task-a');

    log.warn.mockClear();
    parse(record({ completion_publication_pending: 'true' }));
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('the mark never breaks reading a whole tasks.yaml', () => {
  const status = fc.constantFrom('pending', 'running', 'completed', 'failed', 'exceeded', 'pr_failed');
  const pending = fc.constantFrom(true, false, 'true', 'false', 1, 0, null, undefined, { level: 1 }, [true]);
  const terminal = fc.constantFrom('completed', 'failed', 'exceeded', 'pr_failed');

  it('parses any status, goal, completion, attempt and mark without an exception', () => {
    fc.assert(fc.property(status, fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), pending,
      (value, hasGoal, hasCompletion, hasRunSlug, hasExecutionId, mark) => {
        const parsed = TaskRecordSchema.safeParse(record({
          status: value,
          started_at: value === 'pending' ? null : STARTED_AT,
          completed_at: value === 'pending' || value === 'running' ? null : COMPLETED_AT,
          goal_id: hasGoal ? GOAL_ID : undefined,
          completion: hasCompletion ? completion : undefined,
          run_slug: hasRunSlug ? 'run-a' : undefined,
          execution_id: hasRunSlug ? undefined : hasExecutionId ? 'exec-1' : undefined,
          failure: value === 'failed' || value === 'pr_failed' ? { error: 'boom' } : undefined,
          completion_publication_pending: mark,
        }));
        expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
        const kept = parsed.success && namedParse(parsed.data).completion_publication_pending;
        const valid = !['pending', 'running'].includes(value) && hasGoal && hasCompletion && (hasRunSlug || hasExecutionId);
        expect(kept).toBe(valid && mark === true ? true : undefined);
      }), { numRuns: 300 });
  });

  it('keeps the mark on every terminal goal task with completion and an attempt identifier', () => {
    fc.assert(fc.property(terminal, fc.boolean(), (value, useExecutionId) => {
      const parsed = TaskRecordSchema.safeParse(record({
        status: value,
        failure: value === 'failed' || value === 'pr_failed' ? { error: 'boom' } : undefined,
        run_slug: useExecutionId ? undefined : 'run-a',
        execution_id: useExecutionId ? 'exec-1' : undefined,
        completion_publication_pending: true,
      }));
      expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
      expect(parsed.success && namedParse(parsed.data).completion_publication_pending).toBe(true);
    }), { numRuns: 64 });
  });

  it('widens the attempt identifiers with long and Unicode text', () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 600 }), fc.boolean(), (identifier, asRunSlug) => {
      const parsed = TaskRecordSchema.safeParse(record({
        run_slug: asRunSlug ? identifier : undefined,
        execution_id: asRunSlug ? undefined : identifier,
        completion_publication_pending: true,
      }));
      expect(parsed.success).toBe(true);
      expect(parsed.success && namedParse(parsed.data).completion_publication_pending).toBe(true);
    }), { numRuns: 100 });
  });

  it('keeps the current strict rejection of a completion with an unknown column', () => {
    expect(() => TaskRecordSchema.parse(record({ completion: { ...completion, unknownColumn: 1 }, completion_publication_pending: true })))
      .toThrow();
  });

  it('accepts the same completion once the unknown column is removed', () => {
    expect(parse(record({ completion_publication_pending: true })).completion_publication_pending).toBe(true);
  });
});

/** Reads a parsed record's mark without relying on the schema type it will gain. */
function namedParse<T extends object>(value: T): { completion_publication_pending?: unknown } {
  return value as { completion_publication_pending?: unknown };
}

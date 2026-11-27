/**
 * PBT 1 of docs/design/goal-task-completion-publication.md (#170): the manager inbox gives every
 * goal task completion a deterministic, injective `eventId`, so the writer and the daemon can both
 * write the same attempt without waking the manager twice.
 *
 * - Same `(inboxDir, goalId, taskName, tag, attemptId)` gives the same `eventId` whatever the file
 *   path is, in the form `goal-completion-<sha256 hex>` (80 characters).
 * - A different `runSlug` gives a different `eventId`; a `runSlug` equal to the `executionId` is
 *   still told apart by the `run` / `execution` tag; two normal completions with different
 *   `runSlug`s are never merged.
 * - Only when a completion has neither `runSlug` nor `executionId` does the old
 *   `inbox-<sha256(path)>` remain.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { receiveInboxChange } from '../features/daemon/inbox.js';
import type { WatchFileChange } from '../features/daemon/watchers/directories.js';
import type { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
import type { DaemonConversations } from '../features/daemon/conversationState.js';
import type { EventInput } from '../core/daemon/events.js';
import { goalId } from './helpers/goal-fixtures.js';

const EVENT_ID = /^goal-completion-[a-f0-9]{64}$/;

const sha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha256Text = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The manager inbox record for an already accepted `kind: 'completion'` event. */
interface SavedCompletion {
  kind: 'completion';
  goalId: string;
  createdAt: string;
  taskName: string;
  runSlug?: string;
  executionId?: string;
  result: { success: boolean; interrupted: boolean; sha?: string };
}

interface Recording {
  /** Every `EventInput.eventId` passed to the ingress, in call order. */
  eventIds: string[];
  /** The event that went with each `eventId`. */
  events: EventInput['event'][];
}

/**
 * The fakes mirror what the daemon really does: the ingress is called once for the file, and
 * `receiveInboxChange` removes the file only after the ingress accepted it.
 */
function fakeFiles(inboxDir: string): { files: DaemonPersistedFiles; saved: SavedCompletion[] } {
  const saved: SavedCompletion[] = [];
  const files = {
    async inboxDirectory() { return inboxDir; },
    async readInboxEvent(repositoryDirectory: string, name: string) {
      expect(repositoryDirectory).toBe('/repo');
      expect(name).toMatch(/\.json$/);
      return saved[0];
    },
  };
  return { files: files as unknown as DaemonPersistedFiles, saved };
}

function fakeConversations(): Pick<DaemonConversations, 'routing' | 'ensure'> {
  return {
    routing: { async resolve() { return { kind: 'repository', repositoryDirectory: '/repo' }; } },
    async ensure() {},
  } as unknown as Pick<DaemonConversations, 'routing' | 'ensure'>;
}

function completionEvent(change: Partial<SavedCompletion> & Pick<SavedCompletion, 'taskName'>): SavedCompletion {
  return {
    kind: 'completion', goalId, createdAt: '2026-11-27T00:00:00.000Z',
    result: { success: false, interrupted: true, sha: 'a'.repeat(40) }, ...change,
  };
}

let filesByDirectory: Map<string, ReturnType<typeof fakeFiles>>;
let recordings: Map<string, Recording>;
let consumptions: number;

/** Reads one inbox file through `receiveInboxChange` and returns the `eventId` the ingress saw. */
async function receive(inboxDir: string, path: string, event: SavedCompletion): Promise<EventInput> {
  const entry = filesByDirectory.get(inboxDir) ?? fakeFiles(inboxDir);
  filesByDirectory.set(inboxDir, entry);
  entry.saved.splice(0, entry.saved.length, event);
  const recording = recordings.get(inboxDir) ?? { eventIds: [], events: [] };
  recordings.set(inboxDir, recording);
  const ingress = {
    async accept(input: EventInput) {
      recording.eventIds.push(input.eventId);
      recording.events.push(input.event);
      consumptions += 1;
      return { kind: 'accepted' as const, eventId: input.eventId, operationId: input.eventId, acceptedSequence: consumptions };
    },
  };
  const change: WatchFileChange = { path, generation: 'g', value: undefined, removed: false,
    target: { kind: 'inbox', targetId: '/repo', generation: 'g', directory: inboxDir, conversationId: 'c' } };
  await receiveInboxChange(change, entry.files, fakeConversations() as unknown as DaemonConversations, ingress);
  return { eventId: recording.eventIds.at(-1)!, requestId: '', conversationId: '', source: 'run', occurredAt: '2026-11-27T00:00:00.000Z',
    event: recording.events.at(-1)! };
}

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-completion-event-id-')));
  filesByDirectory = new Map();
  recordings = new Map();
  consumptions = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const inbox = (name: string): string => join(root, `manager-inbox-${name}`);

describe('a goal task completion gets a deterministic, injective eventId', () => {
  it('gives the same eventId whatever the inbox file path is', async () => {
    const first = await receive(inbox('a'), join(inbox('a'), 'inbox-1-aaa.json'), completionEvent({ taskName: 'task-a', runSlug: 'run-a' }));
    const second = await receive(inbox('a'), join(inbox('a'), 'inbox-2-bbb.json'), completionEvent({ taskName: 'task-a', runSlug: 'run-a' }));

    expect(first.eventId).toMatch(EVENT_ID);
    expect(first.eventId).toBe(second.eventId);
    expect(first.eventId).toBe(`goal-completion-${sha256([inbox('a'), goalId, 'task-a', 'run', 'run-a'])}`);
  });

  it('gives different eventIds for different runSlugs, so two normal completions are not merged', async () => {
    const first = await receive(inbox('b'), join(inbox('b'), 'inbox-1.json'), completionEvent({ taskName: 'task-a', runSlug: 'run-1' }));
    const second = await receive(inbox('b'), join(inbox('b'), 'inbox-2.json'), completionEvent({ taskName: 'task-a', runSlug: 'run-2' }));

    expect(first.eventId).not.toBe(second.eventId);
    expect(recordings.get(inbox('b'))!.eventIds).toEqual([
      `goal-completion-${sha256([inbox('b'), goalId, 'task-a', 'run', 'run-1'])}`,
      `goal-completion-${sha256([inbox('b'), goalId, 'task-a', 'run', 'run-2'])}`,
    ]);
    expect(consumptions).toBe(2);
  });

  it('keeps a runSlug equal to the executionId apart by the run / execution tag', async () => {
    const byRun = await receive(inbox('c'), join(inbox('c'), 'inbox-1.json'), completionEvent({ taskName: 'task-a', runSlug: 'same' }));
    const byExecution = await receive(inbox('c'), join(inbox('c'), 'inbox-2.json'), completionEvent({ taskName: 'task-a', executionId: 'same' }));

    expect(byRun.eventId).not.toBe(byExecution.eventId);
    expect(byRun.eventId).toBe(`goal-completion-${sha256([inbox('c'), goalId, 'task-a', 'run', 'same'])}`);
    expect(byExecution.eventId).toBe(`goal-completion-${sha256([inbox('c'), goalId, 'task-a', 'execution', 'same'])}`);
  });

  it('chooses the runSlug when a completion carries both identifiers', async () => {
    const both = await receive(inbox('d'), join(inbox('d'), 'inbox-1.json'), completionEvent({ taskName: 'task-a', runSlug: 'run-r', executionId: 'exec-e' }));

    expect(both.eventId).toBe(`goal-completion-${sha256([inbox('d'), goalId, 'task-a', 'run', 'run-r'])}`);
  });

  it('uses the executionId when only a reconcile without a runSlug supplied one', async () => {
    const first = await receive(inbox('e'), join(inbox('e'), 'inbox-1.json'), completionEvent({ taskName: 'task-a', executionId: 'exec-e' }));
    const second = await receive(inbox('e'), join(inbox('e'), 'inbox-2.json'), completionEvent({ taskName: 'task-a', executionId: 'exec-e' }));

    expect(first.eventId).toMatch(EVENT_ID);
    expect(first.eventId).toBe(second.eventId);
    expect(first.eventId).toBe(`goal-completion-${sha256([inbox('e'), goalId, 'task-a', 'execution', 'exec-e'])}`);
    // The attempt identifier reaches the manager turn as well, not only the dedup key.
    expect(second.event).toMatchObject({
      kind: 'task_failed', task: { repositoryDirectory: inbox('e'), goalId, taskName: 'task-a', executionId: 'exec-e' },
    });
  });

  it('keeps the inbox-<sha256(path)> id only for a completion with neither identifier', async () => {
    const path = join(inbox('f'), 'inbox-legacy.json');
    const legacy = await receive(inbox('f'), path, completionEvent({ taskName: 'task-a' }));

    expect(legacy.eventId).toBe(`inbox-${sha256Text(path)}`);
    expect(legacy.eventId).toMatch(/^inbox-[a-f0-9]{64}$/);
    const otherPath = await receive(inbox('f'), join(inbox('f'), 'inbox-other.json'), completionEvent({ taskName: 'task-a' }));
    expect(otherPath.eventId).not.toBe(legacy.eventId);
  });

  it('removes the accepted file and does not wake the manager when the inbox file is gone', async () => {
    const path = join(inbox('g'), 'inbox-gone.json');
    const entry = fakeFiles(inbox('g'));
    filesByDirectory.set(inbox('g'), entry);

    await receiveInboxChange({ path, generation: 'g', value: undefined, removed: false,
      target: { kind: 'inbox', targetId: '/repo', generation: 'g', directory: inbox('g'), conversationId: 'c' } },
      entry.files, fakeConversations() as unknown as DaemonConversations, { async accept() { throw new Error('must not accept a missing file'); } });
    expect(consumptions).toBe(0);
    expect(existsSync(path)).toBe(false);
  });
});

describe('the eventId is deterministic and injective for every string', () => {
  /** Separators, Unicode, NUL, quotes and long text inside the identifiers. */
  const identifier = fc.string({ minLength: 1, maxLength: 24 })
    .map((value) => `${value}" , [ ] / \n \t \u0000 ✓ ゴール 🎯 ${'x'.repeat(300)}`);

  const attempt = fc.oneof(
    fc.record({ runSlug: identifier, executionId: fc.option(identifier, { nil: undefined }) }, { requiredKeys: ['runSlug'] }),
    identifier.map((executionId) => ({ executionId })),
  );

  it('keeps the same eventId across file paths and separates every distinct attempt', async () => {
    // A few inbox directories and paths keep the fake wiring small; both are hashed inputs, so a
    // sample varies them too.
    const inboxDirectories = Array.from({ length: 4 }, (_value, index) => inbox(`pbt-${index}`));
    const pathSuffixes = Array.from({ length: 6 }, (_value, index) => `path-${index}`);
    const seen = new Map<string, string>();
    await fc.assert(fc.asyncProperty(
      identifier, identifier, fc.integer({ min: 0, max: 3 }),
      attempt, fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }),
      async (goal, taskName, inboxDirChoice, identifiers, path1Choice, path2Choice) => {
        const inboxDirectory = inboxDirectories[inboxDirChoice]!;
        const path1 = join(inboxDirectory, `inbox-1-${pathSuffixes[path1Choice]}.json`);
        const path2 = join(inboxDirectory, `inbox-2-${pathSuffixes[path2Choice]}.json`);
        const event = completionEvent({ goalId: goal, taskName, ...identifiers });
        const first = await receive(inboxDirectory, path1, event);
        const second = await receive(inboxDirectory, path2, event);

        expect(first.eventId).toMatch(EVENT_ID);
        expect(first.eventId).toHaveLength(80);
        expect(second.eventId).toBe(first.eventId);
        const key = JSON.stringify([inboxDirectory, goal, taskName,
          'runSlug' in identifiers ? ['run', identifiers.runSlug] : ['execution', identifiers.executionId]]);
        const expected = createHash('sha256').update(key).digest('hex');
        expect(first.eventId).toBe(`goal-completion-${expected}`);
        const previous = seen.get(key);
        if (previous !== undefined) expect(previous).toBe(first.eventId);
        seen.set(key, first.eventId);
      },
    ), { numRuns: 150, endOnFailure: true });
    // Different attempts (including a runSlug equal to the other's executionId) never share an id.
    const ids = new Map<string, string>();
    for (const [key, id] of seen) {
      expect(ids.get(id) ?? key).toBe(key);
      ids.set(id, key);
    }
  });

  it('gives distinct attempts distinct eventIds even when the identifiers collide across tags', async () => {
    const value = 'same" , [ ] / \n ✓';
    const byRun = await receive(inbox('h'), join(inbox('h'), 'inbox-1.json'), completionEvent({ taskName: 'task', runSlug: value }));
    const byExecution = await receive(inbox('h'), join(inbox('h'), 'inbox-2.json'), completionEvent({ taskName: 'task', executionId: value }));

    expect(byRun.eventId).not.toBe(byExecution.eventId);
    expect(byRun.eventId).toMatch(EVENT_ID);
    expect(byExecution.eventId).toMatch(EVENT_ID);
  });

  it('stays within the 128 character eventId limit for long identifiers', async () => {
    const long = 'あ'.repeat(2000);
    const result = await receive(inbox('i'), join(inbox('i'), 'inbox-1.json'), completionEvent({ goalId: long, taskName: long, runSlug: long }));

    expect(result.eventId).toMatch(EVENT_ID);
    expect(result.eventId.length).toBe(80);
  });
});

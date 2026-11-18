import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { readEntirePrivateFile } from '../infra/daemon/privateFile.js';

vi.mock('../infra/daemon/privateFile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/daemon/privateFile.js')>();
  return { ...actual, readEntirePrivateFile: vi.fn(async (path: string) => {
    const hold = gate.hold;
    if (hold !== undefined) await hold();
    return actual.readEntirePrivateFile(path);
  }) };
});

const signal = new AbortController().signal;
const gate = vi.hoisted(() => ({ hold: undefined as undefined | (() => Promise<void>) }));
const fileName = (id: string): string => `${createHash('sha256').update(id).digest('hex')}.json`;
const readNames = (): string[] => vi.mocked(readEntirePrivateFile).mock.calls.map(([path]) => path.split('/').at(-1) ?? '');

async function collect(notifications: DaemonNotifications) {
  const values = [];
  for await (const value of notifications.iterate()) values.push(value);
  return values;
}

describe('DaemonNotifications', () => {
  let root: string;
  let directory: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'takt-notifications-'));
    directory = join(root, 'director-notifications');
    gate.hold = undefined;
    vi.mocked(readEntirePrivateFile).mockClear();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does not read notification files again when the directory is unchanged', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await notifications.save({ id: 'second', message: 'two' }, signal);
    const first = await collect(notifications);
    vi.mocked(readEntirePrivateFile).mockClear();

    const second = await collect(notifications);

    expect(second).toEqual(first);
    expect(second.map((value) => value.id).sort()).toEqual(['first', 'second']);
    expect(readEntirePrivateFile).not.toHaveBeenCalled();
  });

  it('reads only the newly saved file after save()', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await collect(notifications);
    await notifications.save({ id: 'second', message: 'two' }, signal);
    vi.mocked(readEntirePrivateFile).mockClear();

    const values = await collect(notifications);

    expect(values.map((value) => value.id).sort()).toEqual(['first', 'second']);
    expect(readNames()).toEqual([fileName('second')]);
  });

  it('reflects files added and removed by another writer', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await notifications.save({ id: 'second', message: 'two' }, signal);
    await collect(notifications);

    await writeFile(join(directory, fileName('third')), JSON.stringify({ id: 'third', message: 'three' }), { mode: 0o600 });
    await unlink(join(directory, fileName('first')));
    vi.mocked(readEntirePrivateFile).mockClear();

    const values = await collect(notifications);

    expect(values.map((value) => value.id).sort()).toEqual(['second', 'third']);
    expect(readNames()).toContain(fileName('third'));
  });

  it('reflects the new content of an already indexed file when the directory stamp changes', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    expect(await collect(notifications)).toEqual([{ id: 'first', message: 'one' }]);

    const temporary = join(directory, '.replacement.tmp');
    await writeFile(temporary, JSON.stringify({ id: 'first', message: 'one-updated' }), { mode: 0o600 });
    await rename(temporary, join(directory, fileName('first')));

    expect(await collect(notifications)).toEqual([{ id: 'first', message: 'one-updated' }]);
  });

  it('evaluates subject duplication against the updated content of an already indexed file', async () => {
    const notifications = new DaemonNotifications(root);
    expect(await notifications.save({ id: 'first', message: 'one', subject: { key: 'goal', state: 'done' } }, signal)).toBe(true);
    await collect(notifications);

    const temporary = join(directory, '.replacement.tmp');
    await writeFile(temporary, JSON.stringify({ id: 'first', message: 'one', subject: { key: 'goal', state: 'blocked' } }), { mode: 0o600 });
    await rename(temporary, join(directory, fileName('first')));

    expect(await notifications.save({ id: 'second', message: 'two', subject: { key: 'goal', state: 'blocked' } }, signal)).toBe(false);
    expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toEqual([fileName('first')]);
  });

  it('returns every notification when two iterates run concurrently on one instance', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await notifications.save({ id: 'second', message: 'two' }, signal);
    await collect(notifications);

    await writeFile(join(directory, fileName('third')), JSON.stringify({ id: 'third', message: 'three' }), { mode: 0o600 });

    const [left, right] = await Promise.all([collect(notifications), collect(notifications)]);

    expect(left.map((value) => value.id).sort()).toEqual(['first', 'second', 'third']);
    expect(right.map((value) => value.id).sort()).toEqual(['first', 'second', 'third']);
  });

  it('keeps every notification after a concurrent iterate and save settle', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await collect(notifications);
    await writeFile(join(directory, fileName('second')), JSON.stringify({ id: 'second', message: 'two' }), { mode: 0o600 });

    const [, saved] = await Promise.all([
      collect(notifications),
      notifications.save({ id: 'third', message: 'three' }, signal),
    ]);

    expect(saved).toBe(true);
    expect((await collect(notifications)).map((value) => value.id).sort()).toEqual(['first', 'second', 'third']);
  });

  it('does not drop an entry that another refresh indexed while this one was reading', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await notifications.save({ id: 'second', message: 'two' }, signal);
    await collect(notifications);

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    gate.hold = () => held;
    const lingering = collect(notifications);
    await new Promise((resolve) => setImmediate(resolve));
    gate.hold = undefined;
    await writeFile(join(directory, fileName('third')), JSON.stringify({ id: 'third', message: 'three' }), { mode: 0o600 });
    const fresh = await collect(notifications);
    release();

    expect(fresh.map((value) => value.id).sort()).toEqual(['first', 'second', 'third']);
    await lingering;
    expect((await collect(notifications)).map((value) => value.id).sort()).toEqual(['first', 'second', 'third']);
  });

  it('returns copies that callers cannot use to change later results', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one', subject: { key: 'goal', state: 'done' } }, signal);
    const [value] = await collect(notifications);
    value!.message = 'changed';
    value!.subject!.state = 'changed';

    expect(await collect(notifications)).toEqual([{ id: 'first', message: 'one', subject: { key: 'goal', state: 'done' } }]);
  });

  it('returns false when a notification with the same subject and state is already saved', async () => {
    const notifications = new DaemonNotifications(root);
    expect(await notifications.save({ id: 'first', message: 'one', subject: { key: 'goal', state: 'done' } }, signal)).toBe(true);

    expect(await notifications.save({ id: 'second', message: 'two', subject: { key: 'goal', state: 'done' } }, signal)).toBe(false);
    expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toEqual([fileName('first')]);
  });

  it('rejects reusing an id with different content', async () => {
    const notifications = new DaemonNotifications(root);
    expect(await notifications.save({ id: 'first', message: 'one' }, signal)).toBe(true);
    await collect(notifications);

    await expect(notifications.save({ id: 'first', message: 'two' }, signal)).rejects.toThrow('Notification ID reused with different content');
  });

  it('reads back a notification larger than 1 MiB through the index', async () => {
    const notifications = new DaemonNotifications(root);
    const large = { id: 'large', message: 'n'.repeat(2 * 1024 * 1024) };
    expect(await notifications.save(large, signal)).toBe(true);

    expect(await collect(notifications)).toEqual([large]);
    vi.mocked(readEntirePrivateFile).mockClear();
    expect(await collect(notifications)).toEqual([large]);
    expect(readEntirePrivateFile).not.toHaveBeenCalled();
  });

  it('keeps failing on a broken notification file', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await collect(notifications);
    await writeFile(join(directory, fileName('broken')), '{not json', { mode: 0o600 });

    await expect(collect(notifications)).rejects.toThrow(SyntaxError);
    await expect(collect(notifications)).rejects.toThrow(SyntaxError);
  });
});

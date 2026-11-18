import { createHash } from 'node:crypto';
import { opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { FileAsyncLock } from './lock.js';
import { ensurePrivateDirectory, hasCode, readEntirePrivateFile, writePrivateFile } from './privateFile.js';

const notification = z.object({ id: z.string().min(1).max(128), message: z.string().min(1), turnOperationId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  subject: z.object({ key: z.string().min(1), state: z.string().min(1) }).strict().optional() }).strict();
export type DirectorNotification = Pick<z.infer<typeof notification>, 'id' | 'message'>;
export type DirectorNotificationSubject = NonNullable<z.infer<typeof notification>['subject']>;
type Notification = z.infer<typeof notification>;
const key = (value: string): string => createHash('sha256').update(value).digest('hex');

export class DaemonNotifications {
  private readonly directory: string;
  private readonly lock = new FileAsyncLock();
  private readonly index: { stamp: string | undefined; values: Map<string, { value: Notification; fingerprint: string | undefined }> } = { stamp: undefined, values: new Map() };
  private prepared: Promise<void> | undefined;
  private refreshing: Promise<void> | undefined;
  constructor(directory: string) { this.directory = join(directory, 'director-notifications'); }

  async save(input: z.infer<typeof notification>, signal: AbortSignal): Promise<boolean> {
    const value = notification.parse(input);
    return this.lock.exclusive(join(this.directory, '.lock'), async () => {
      signal.throwIfAborted();
      const path = join(this.directory, `${key(value.id)}.json`);
      const prior = await readEntirePrivateFile(path)
        ?? (z.uuid().safeParse(value.id).success ? await readEntirePrivateFile(join(this.directory, `${value.id}.json`)) : undefined);
      if (prior !== undefined) {
        if (prior.toString('utf8') !== JSON.stringify(value)) throw new Error('Notification ID reused with different content');
        return false;
      }
      if (value.subject !== undefined) {
        for await (const saved of this.iterate()) {
          if (saved.subject?.key === value.subject.key && saved.subject.state === value.subject.state) return false;
        }
      }
      await writePrivateFile(path, JSON.stringify(value), signal);
      this.index.stamp = undefined;
      return true;
    }, { signal, timeoutMs: 5000 });
  }

  async *iterate(): AsyncGenerator<Notification> {
    for (const value of await this.refresh()) yield structuredClone(value);
  }

  private async stampOfDirectory(): Promise<string> {
    const info = await stat(this.directory);
    return JSON.stringify([info.dev, info.ino, info.mtimeMs]);
  }

  private async refresh(): Promise<Notification[]> {
    this.prepared ??= ensurePrivateDirectory(this.directory).catch((error: unknown) => {
      this.prepared = undefined;
      throw error;
    });
    await this.prepared;
    // 共有索引と stamp を更新する区間は直列化する。並行進入すると、先発の差分削除が後発の追加を落としたり、古い stamp を書き戻したりする。
    const run = (this.refreshing ?? Promise.resolve()).then(() => this.refreshOnce());
    this.refreshing = run.then(() => undefined, () => undefined);
    return run;
  }

  private async refreshOnce(): Promise<Notification[]> {
    const stamp = await this.stampOfDirectory();
    if (stamp === this.index.stamp) return this.values();
    const names = new Set<string>();
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      names.add(entry.name);
      const file = await stat(join(this.directory, entry.name)).catch((error: unknown) => {
        if (hasCode(error, 'ENOENT')) return undefined;
        throw error;
      });
      const fingerprint = file === undefined ? undefined : `${file.ino}:${file.mtimeMs}:${file.size}`;
      const cached = this.index.values.get(entry.name);
      if (cached !== undefined && cached.fingerprint === fingerprint) continue;
      const content = await readEntirePrivateFile(join(this.directory, entry.name));
      if (content === undefined) throw new Error('Notification disappeared during read');
      const value = notification.parse(JSON.parse(content.toString('utf8')) as unknown);
      if (entry.name !== `${key(value.id)}.json` && entry.name !== `${z.uuid().parse(value.id)}.json`) throw new Error('Notification identity mismatch');
      this.index.values.set(entry.name, { value, fingerprint });
    }
    for (const name of this.index.values.keys()) if (!names.has(name)) this.index.values.delete(name);
    this.index.stamp = stamp;
    return this.values();
  }

  private values(): Notification[] {
    return [...this.index.values.values()].map((entry) => entry.value);
  }
}

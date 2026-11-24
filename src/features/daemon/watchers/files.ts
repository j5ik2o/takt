import { open, opendir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';

export const MAX_WATCH_FILE_BYTES = 256 * 1024;
export const MAX_WATCH_ENTRIES = 128;

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** 上限を超えたファイルは全体を取得・解析せず、観測不能として返す。 */
export async function readSmallText(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const file = await open(path, 'r');
  try {
    signal?.throwIfAborted();
    const stats = await file.stat();
    signal?.throwIfAborted();
    if (!stats.isFile() || stats.size > MAX_WATCH_FILE_BYTES) throw new Error('Watch file exceeds the read limit or is not regular');
    const buffer = Buffer.alloc(MAX_WATCH_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_WATCH_FILE_BYTES) throw new Error('Watch file exceeds the read limit');
    return buffer.toString('utf8', 0, length);
  } finally {
    await file.close();
  }
}

export async function readSmallJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const text = await readSmallText(path, signal);
  signal?.throwIfAborted();
  return JSON.parse(text) as unknown;
}

export async function listWatchEntries(path: string, signal?: AbortSignal): Promise<readonly Dirent[]> {
  signal?.throwIfAborted();
  let directory;
  try { directory = await opendir(path, { bufferSize: 16 }); }
  catch (error) {
    signal?.throwIfAborted();
    if (isMissing(error)) return [];
    throw error;
  }
  const entries: Dirent[] = [];
  try {
    for (;;) {
      signal?.throwIfAborted();
      const entry = await directory.read();
      signal?.throwIfAborted();
      if (entry === null) break;
      entries.push(entry);
    }
  } finally { await directory.close(); }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

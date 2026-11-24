import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as filesystem from 'node:fs/promises';
import { DaemonRouting } from '../features/daemon/routing.js';
import { ConversationError } from '../features/manager/conversationErrors.js';
import { readDaemonProjectRoutes } from '../features/daemon/projects.js';
import { listWatchEntries, MAX_WATCH_ENTRIES, MAX_WATCH_FILE_BYTES, readSmallText } from '../features/daemon/watchers/files.js';
import { readWatchTasks } from '../features/daemon/watchers/state.js';
import { registerProject, readProjectRegistry } from '../infra/config/global/projectRegistry.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }));

async function projects(directory: string) { return (await readDaemonProjectRoutes(directory)).map((route) => route.repositoryDirectory); }

let root: string;
let cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-daemon-projects-')));
  cwd = join(root, 'project');
  mkdirSync(cwd);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it.each(['file-open', 'file-stat', 'file-read', 'directory-open', 'directory-read'] as const)(
  'finishes in-flight %s and closes the handle before rejecting cancellation', async (pause) => {
    const path = join(root, pause.startsWith('file') ? 'data.json' : 'entries');
    if (pause.startsWith('file')) await writeFile(path, '{}');
    else { await mkdir(path); await writeFile(join(path, 'one'), '{}'); await writeFile(join(path, 'two'), '{}'); }
    const abort = new AbortController(); const reason = new Error('read disconnected');
    let reached!: () => void; const entered = new Promise<void>((resolve) => { reached = resolve; });
    let resume!: () => void; const gate = new Promise<void>((resolve) => { resume = resolve; });
    let reads = 0; let stats = 0; let closed = false; let finished = false;
    const hold = async () => { reached(); await gate; };
    const nativeOpen = filesystem.open; const nativeOpendir = filesystem.opendir;
    vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
      const file = await nativeOpen(...args);
      if (args[0] !== path) return file;
      if (pause === 'file-open') await hold();
      return new Proxy(file, { get(target, property) {
        if (property === 'stat') return async () => { stats++; const result = await target.stat(); if (pause === 'file-stat') await hold(); return result; };
        if (property === 'read') return async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          reads++; const result = await target.read(buffer, offset, length, position); if (pause === 'file-read') await hold(); return result;
        };
        if (property === 'close') return async () => { await target.close(); closed = true; };
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    vi.spyOn(filesystem, 'opendir').mockImplementation(async (...args) => {
      const directory = await nativeOpendir(...args);
      if (args[0] !== path) return directory;
      if (pause === 'directory-open') await hold();
      return new Proxy(directory, { get(target, property) {
        if (property === 'read') return async () => { reads++; const result = await target.read(); if (pause === 'directory-read') await hold(); return result; };
        if (property === 'close') return async () => { await target.close(); closed = true; };
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    const operation = (pause.startsWith('file') ? readSmallText(path, abort.signal) : listWatchEntries(path, abort.signal))
      .finally(() => { finished = true; });
    const rejected = expect(operation).rejects.toBe(reason);
    try {
      await entered; abort.abort(reason);
      expect(finished).toBe(false); expect(closed).toBe(false);
      resume(); await rejected;
      expect(closed).toBe(true);
      expect(reads).toBe(pause.endsWith('read') ? 1 : 0);
      expect(stats).toBe(pause === 'file-stat' || pause === 'file-read' ? 1 : 0);
    } finally { resume(); await rejected; }
  },
);

it('does not report cancellation as a project read error or convert it to a denied assignment', async () => {
  const directory = getGlobalConfigDir();
  await registerProject({ globalConfigDirectory: directory, projectDirectory: cwd, command: 'manager', managerUsed: true });
  const abort = new AbortController(); const reason = new ConversationError('invalid_assignment'); const errors = vi.fn();
  vi.spyOn(filesystem, 'realpath').mockImplementation(async () => { abort.abort(reason); throw new Error('lookup interrupted'); });
  await expect(readDaemonProjectRoutes(directory, errors, abort.signal)).rejects.toBe(reason);
  expect(errors).not.toHaveBeenCalled();
  await expect(new DaemonRouting(directory).permits({ kind: 'repository', repositoryDirectory: cwd }, 'unused', abort.signal)).rejects.toBe(reason);
});

it('preserves the manager mark across other commands and keeps legacy registrations valid', async () => {
  const options = { globalConfigDirectory: getGlobalConfigDir(), projectDirectory: cwd };
  const legacy = await registerProject({ ...options, command: 'ui' });
  expect(legacy.managerUsed).toBeUndefined();
  expect(await projects(getGlobalConfigDir())).toEqual([]);
  const marked = await registerProject({ ...options, command: 'manager', managerUsed: true });
  const later = await registerProject({ ...options, command: 'run' });
  expect(later.managerUsed).toBe(true);
  expect(later.stateId).toBe(marked.stateId);
  expect((await readProjectRegistry(getGlobalConfigDir())).warnings).toEqual([]);
  expect(await projects(getGlobalConfigDir())).toEqual([cwd]);
});

it('combines marked projects and workspace assignments once, skipping unavailable directories', async () => {
  const globalConfigDirectory = getGlobalConfigDir();
  const assigned = join(root, 'assigned');
  mkdirSync(assigned);
  await registerProject({ globalConfigDirectory, projectDirectory: cwd, command: 'manager', managerUsed: true });
  const id = randomUUID();
  const workspaceDirectory = join(globalConfigDirectory, 'workspaces', id);
  mkdirSync(workspaceDirectory, { recursive: true });
  writeFileSync(join(workspaceDirectory, 'workspace.json'), JSON.stringify({
    id, name: 'test', repositoryDirectories: [assigned, cwd, join(root, 'missing')],
  }));
  expect(await projects(globalConfigDirectory)).toEqual([assigned, cwd].sort());
  renameSync(cwd, join(root, 'original-project'));
  mkdirSync(cwd);
  expect((await readProjectRegistry(globalConfigDirectory)).projects).toEqual([
    expect.objectContaining({ canonicalDirectory: cwd, available: true }),
  ]);
  expect(await projects(globalConfigDirectory)).toEqual([assigned, cwd].sort());
  rmSync(cwd, { recursive: true });
  expect(await projects(globalConfigDirectory)).toEqual([assigned]);
});

it.each(['dev', 'ino', 'absent', 'malformed'] as const)(
  'routes a manager project with an ignored %s fingerprint', async (variant) => {
    const globalConfigDirectory = getGlobalConfigDir();
    const registered = await registerProject({
      globalConfigDirectory, projectDirectory: cwd, command: 'manager', managerUsed: true,
    });
    const path = join(globalConfigDirectory, 'projects', `${registered.locationId}.json`);
    const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const current = await stat(cwd);
    if (variant === 'absent') delete stored.fingerprint;
    else if (variant === 'malformed') stored.fingerprint = { dev: current.dev };
    else stored.fingerprint = { dev: current.dev, ino: current.ino, [variant]: current[variant] + 1 };
    await writeFile(path, JSON.stringify(stored));
    const errors: unknown[] = [];

    expect(await readDaemonProjectRoutes(globalConfigDirectory, (error) => errors.push(error)))
      .toEqual([{ repositoryDirectory: cwd, workspaceId: null }]);
    expect(errors).toEqual([]);

    await writeFile(path, JSON.stringify({ ...stored, managerUsed: false }));
    expect(await projects(globalConfigDirectory)).toEqual([]);
  },
);

it('routes workspace repositories together without importing a synchronous business store', async () => {
  const configDirectory = join(root, 'config');
  await registerProject({ globalConfigDirectory: configDirectory, projectDirectory: cwd, command: 'manager', managerUsed: true });
  const id = randomUUID();
  const directory = join(configDirectory, 'workspaces', id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ id, name: 'workspace', repositoryDirectories: [cwd] }));
  expect(await readDaemonProjectRoutes(configDirectory)).toEqual([{ repositoryDirectory: cwd, workspaceId: id }]);
});

it('bounds small-file reads before parsing and rejects growth beyond the limit', async () => {
  const file = join(root, 'small.json');
  await writeFile(file, 'x'.repeat(MAX_WATCH_FILE_BYTES));
  expect((await readSmallText(file)).length).toBe(MAX_WATCH_FILE_BYTES);
  await writeFile(file, 'x'.repeat(MAX_WATCH_FILE_BYTES + 1));
  await expect(readSmallText(file)).rejects.toThrow();
  await expect(readSmallText(root)).rejects.toThrow();
});

it('enumerates directories above one watch page without rejecting or dropping entries', async () => {
  const directory = join(root, 'bounded');
  await mkdir(directory);
  for (let index = 0; index < MAX_WATCH_ENTRIES; index++) await writeFile(join(directory, `${index}.json`), '{}');
  expect((await listWatchEntries(directory)).length).toBe(MAX_WATCH_ENTRIES);
  await writeFile(join(directory, 'extra.json'), '{}');
  expect(await listWatchEntries(directory)).toHaveLength(MAX_WATCH_ENTRIES + 1);
});

it('rejects YAML aliases without expanding them into a large observation payload', async () => {
  await mkdir(join(cwd, '.takt'));
  await writeFile(join(cwd, '.takt', 'tasks.yaml'), 'shared: &shared []\ntasks: *shared\n');
  await expect(readWatchTasks(cwd)).rejects.toThrow();
});

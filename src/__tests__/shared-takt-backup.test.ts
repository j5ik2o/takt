/**
 * The daily copy of the shared TAKT configuration and managed providers.
 *
 * Every case builds its own fake config directory under tmp; the real one is never opened.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupSharedTakt, listGenerations, main, verifyGeneration } from '../../scripts/shared-takt-backup.mjs';

const SECRET = 'sk-secret-value-that-must-not-leak';
const CONFIG = `provider: mock\napi_key: ${SECRET}\n`;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let root: string;
let source: string;
let dest: string;

function write(relativePath: string, content: string, mode = 0o600): void {
  const path = join(source, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, { mode });
}

function at(day: number): Date {
  return new Date(Date.UTC(2026, 10, day, 3, 0, 0));
}

function nameAt(day: number): string {
  return `202611${day}T030000Z`;
}

function generationPath(name: string, ...segments: string[]): string {
  return join(dest, 'generations', name, ...segments);
}

function logRecords(): Array<Record<string, unknown>> {
  return readFileSync(join(dest, 'backup.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function capture(): { stdout: { write(text: string): void }; stderr: { write(text: string): void }; text: () => string } {
  const chunks: string[] = [];
  const sink = { write: (text: string): void => { chunks.push(text); } };
  return { stdout: sink, stderr: sink, text: () => chunks.join('') };
}

async function failureCode(action: Promise<unknown>): Promise<string | undefined> {
  try {
    await action;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** Every path under a directory with its type, to show that a refused run wrote nothing there. */
function snapshot(directory: string): string[] {
  const walk = (relativePath: string): string[] => readdirSync(join(directory, relativePath)).sort().flatMap((name) => {
    const path = join(relativePath, name);
    const stats = lstatSync(join(directory, path));
    if (stats.isDirectory()) return [`${path}/`, ...walk(path)];
    return [stats.isSymbolicLink() ? `${path}@` : `${path}=${readFileSync(join(directory, path), 'utf8')}`];
  });
  return walk('');
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stb-')));
  source = join(root, 'takt');
  dest = join(root, 'backup');
  write('config.yaml', CONFIG);
  write('workflows/custom.yaml', 'name: custom\n', 0o644);
  write('facets/personas/coder.md', '# coder\n', 0o644);
  write('pi/sdk-11111111/package.json', '{"name":"managed"}\n', 0o644);
  write('pi/sdk-11111111/node_modules/tool/bin/run', '#!/bin/sh\n', 0o755);
  write('pi/sdk-11111111/.ready.json', '{}\n');
  symlinkSync('sdk-11111111', join(source, 'pi', 'sdk'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('backup', () => {
  it('copies the configuration and the current managed provider generation into a private directory', async () => {
    write('logs/session.jsonl', 'runtime state\n');
    write('pi/sdk-00000000/package.json', '{"name":"superseded"}\n');
    write('pi/.sdk-stage-abc/package.json', '{"name":"staging"}\n');
    write('pi/install.lock', '');
    const before = snapshot(source);

    const summary = await backupSharedTakt({ source, dest, now: at(24) });

    expect(summary.generation).toBe(nameAt(24));
    expect(statSync(dest).mode & 0o077).toBe(0);
    const data = generationPath(summary.generation, 'data');
    expect(readFileSync(join(data, 'config.yaml'), 'utf8')).toBe(CONFIG);
    expect(statSync(join(data, 'config.yaml')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(data, 'workflows', 'custom.yaml'), 'utf8')).toBe('name: custom\n');
    expect(readlinkSync(join(data, 'pi', 'sdk'))).toBe('sdk-11111111');
    expect(statSync(join(data, 'pi', 'sdk', 'node_modules', 'tool', 'bin', 'run')).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(data, 'pi')).sort()).toEqual(['sdk', 'sdk-11111111']);
    expect(existsSync(join(data, 'logs'))).toBe(false);
    expect(summary.targets.filter((target) => target.status === 'copied').map((target) => target.name))
      .toEqual(['config.yaml', 'workflows', 'facets', 'pi']);
    expect(readlinkSync(join(dest, 'latest'))).toBe(join('generations', summary.generation));
    await expect(verifyGeneration({ dest })).resolves.toMatchObject({ generation: summary.generation });
    expect(snapshot(source)).toEqual(before);
  });

  it.skipIf(isRoot)('leaves the earlier generation untouched when a copy fails part-way', async () => {
    const first = await backupSharedTakt({ source, dest, now: at(24) });
    write('config.yaml', 'provider: mock\nchanged: true\n');
    write('workflows/unreadable.yaml', 'name: unreadable\n', 0o000);

    expect(await failureCode(backupSharedTakt({ source, dest, now: at(25) }))).toBe('EACCES');

    chmodSync(join(source, 'workflows', 'unreadable.yaml'), 0o600);
    expect(await listGenerations(dest)).toEqual([first.generation]);
    expect(readlinkSync(join(dest, 'latest'))).toBe(join('generations', first.generation));
    expect(readFileSync(generationPath(first.generation, 'data', 'config.yaml'), 'utf8')).toBe(CONFIG);
    await expect(verifyGeneration({ dest })).resolves.toMatchObject({ generation: first.generation });
    expect(readdirSync(dest).filter((name) => name.startsWith('.'))).toEqual([]);
    expect(logRecords().map((record) => record.result)).toEqual(['ok', 'failed']);
    expect(logRecords()[1]).toMatchObject({ generation: nameAt(25), error: { code: 'EACCES' } });
  });

  it('removes no older generation when the new one cannot be logged', async () => {
    const first = await backupSharedTakt({ source, dest, keep: 1, now: at(24) });
    const failingLog = async () => ({
      write: async (record: { result: string }) => { if (record.result === 'ok') throw new Error('log device failed'); },
      close: async () => {},
    });

    expect(await failureCode(backupSharedTakt({ source, dest, keep: 1, now: at(25), openLogFile: failingLog }))).toBe('LOG_FAILED');

    expect(await listGenerations(dest)).toEqual([first.generation, nameAt(25)]);
    await expect(verifyGeneration({ dest, generation: first.generation })).resolves.toBeDefined();
    await expect(verifyGeneration({ dest })).resolves.toMatchObject({ generation: nameAt(25) });
  });

  it('publishes nothing when the staged generation does not pass its own verification', async () => {
    const first = await backupSharedTakt({ source, dest, keep: 1, now: at(24) });

    expect(await failureCode(backupSharedTakt({ source, dest, keep: 1, now: at(25), readBack: async () => '{' }))).toBe('GENERATION_DAMAGED');

    expect(await listGenerations(dest)).toEqual([first.generation]);
    await expect(verifyGeneration({ dest })).resolves.toMatchObject({ generation: first.generation });
  });

  it('fails on a symbolic link that leaves its backup target, and keeps one that stays inside', async () => {
    const elsewhere = join(root, 'elsewhere.yaml');
    writeFileSync(elsewhere, CONFIG);
    symlinkSync('custom.yaml', join(source, 'workflows', 'alias.yaml'));
    const first = await backupSharedTakt({ source, dest, now: at(20) });
    expect(readlinkSync(generationPath(first.generation, 'data', 'workflows', 'alias.yaml'))).toBe('custom.yaml');

    const cases: Array<[string, string]> = [
      ['workflows/absolute.yaml', elsewhere],
      ['workflows/absolute-inside.yaml', join(source, 'workflows', 'custom.yaml')],
      ['workflows/sibling.yaml', '../config.yaml'],
      ['facets/personas/outside.md', '../../../elsewhere.yaml'],
      ['schemas', elsewhere],
    ];
    for (const [path, target] of cases) {
      symlinkSync(target, join(source, path));
      expect(await failureCode(backupSharedTakt({ source, dest, now: at(21) }))).toBe('EXTERNAL_LINK');
      rmSync(join(source, path));
    }
    rmSync(join(source, 'config.yaml'));
    symlinkSync(elsewhere, join(source, 'config.yaml'));
    expect(await failureCode(backupSharedTakt({ source, dest, now: at(22) }))).toBe('EXTERNAL_LINK');

    expect(await listGenerations(dest)).toEqual([first.generation]);
  });

  it('requires config.yaml', async () => {
    const first = await backupSharedTakt({ source, dest, keep: 1, now: at(24) });
    rmSync(join(source, 'config.yaml'));

    expect(await failureCode(backupSharedTakt({ source, dest, keep: 1, now: at(25), acceptRemoved: true }))).toBe('CONFIG_MISSING');
    expect(await listGenerations(dest)).toEqual([first.generation]);
  });

  it('removes a generation that was never published before counting the ones to keep', async () => {
    await backupSharedTakt({ source, dest, keep: 2, now: at(24) });
    await backupSharedTakt({ source, dest, keep: 2, now: at(25) });
    mkdirSync(generationPath(nameAt(26), 'data'), { recursive: true });
    writeFileSync(join(dest, `.unpublished-${nameAt(26)}`), '');

    await backupSharedTakt({ source, dest, keep: 2, now: at(27) });

    expect(await listGenerations(dest)).toEqual([nameAt(25), nameAt(27)]);
    expect(readdirSync(dest).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('takes the generation back and leaves latest alone when latest cannot be pointed at it', async () => {
    await backupSharedTakt({ source, dest, now: at(25) });
    await backupSharedTakt({ source, dest, now: at(24) });
    expect(readlinkSync(join(dest, 'latest'))).toBe(join('generations', nameAt(24)));
    rmSync(join(dest, 'latest'));
    mkdirSync(join(dest, 'latest', 'in-the-way'), { recursive: true });

    await expect(backupSharedTakt({ source, dest, now: at(26) })).rejects.toThrow();
    expect(await listGenerations(dest)).toEqual([nameAt(24), nameAt(25)]);
    expect(readdirSync(dest).filter((name) => name.startsWith('.'))).toEqual([]);

    rmSync(join(dest, 'latest'), { recursive: true });
    symlinkSync(join('generations', nameAt(24)), join(dest, 'latest'));
    const failingLog = async () => ({
      write: async (record: { result: string }) => { if (record.result === 'ok') throw new Error('log device failed'); },
      close: async () => {},
    });
    expect(await failureCode(backupSharedTakt({ source, dest, now: at(23), openLogFile: failingLog }))).toBe('LOG_FAILED');
    await expect(verifyGeneration({ dest })).resolves.toMatchObject({ generation: nameAt(23) });
    expect(readdirSync(dest).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('compares a run with the generation latest points at, not with the newest name', async () => {
    await backupSharedTakt({ source, dest, now: at(25) });
    rmSync(join(source, 'pi'), { recursive: true });
    await backupSharedTakt({ source, dest, now: at(24), acceptRemoved: true });

    const third = await backupSharedTakt({ source, dest, now: at(26) });

    expect(third.targets.find((target) => target.name === 'pi')?.status).toBe('absent');
    expect(readlinkSync(join(dest, 'latest'))).toBe(join('generations', nameAt(26)));
  });

  it('refuses a run in which a file that held content is empty, unless that is accepted', async () => {
    const first = await backupSharedTakt({ source, dest, keep: 1, now: at(20) });

    write('config.yaml', '');
    expect(await failureCode(backupSharedTakt({ source, dest, keep: 1, now: at(21) }))).toBe('FILE_EMPTIED');
    write('config.yaml', CONFIG);
    write('workflows/custom.yaml', '', 0o644);
    write('workflows/other.yaml', 'name: other\n', 0o644);
    expect(await failureCode(backupSharedTakt({ source, dest, keep: 1, now: at(22) }))).toBe('FILE_EMPTIED');

    expect(await listGenerations(dest)).toEqual([first.generation]);
    expect(readFileSync(generationPath(first.generation, 'data', 'config.yaml'), 'utf8')).toBe(CONFIG);

    await expect(backupSharedTakt({ source, dest, keep: 1, now: at(23), acceptRemoved: true })).resolves.toBeDefined();
  });

  it('refuses a first run that finds config.yaml empty', async () => {
    write('config.yaml', '');

    expect(await failureCode(backupSharedTakt({ source, dest, now: at(24) }))).toBe('FILE_EMPTIED');
    expect(await listGenerations(dest)).toEqual([]);
  });

  it('publishes a generation that verifies whatever the umask of the run', async () => {
    chmodSync(join(source, 'pi'), 0o755);
    const umask = process.umask(0o022);
    try {
      await backupSharedTakt({ source, dest, keep: 1, now: at(24) });
      process.umask(0o077);
      const second = await backupSharedTakt({ source, dest, keep: 1, now: at(25) });

      expect(statSync(generationPath(second.generation, 'data', 'pi')).mode & 0o777).toBe(0o755);
      await expect(verifyGeneration({ dest })).resolves.toMatchObject({ generation: second.generation });
    } finally {
      process.umask(umask);
    }
  });

  it('records a run that finds the config directory gone, and publishes nothing', async () => {
    const first = await backupSharedTakt({ source, dest, keep: 1, now: at(24) });
    rmSync(source, { recursive: true });

    expect(await failureCode(backupSharedTakt({ source, dest, keep: 1, now: at(25) }))).toBe('SOURCE_MISSING');
    mkdirSync(source);
    expect(await failureCode(backupSharedTakt({ source, dest, keep: 1, now: at(26) }))).toBe('NOTHING_TO_COPY');

    expect(await listGenerations(dest)).toEqual([first.generation]);
    expect(logRecords().slice(1)).toMatchObject([
      { result: 'failed', generation: nameAt(25), error: { code: 'SOURCE_MISSING' } },
      { result: 'failed', generation: nameAt(26), error: { code: 'NOTHING_TO_COPY' } },
    ]);
  });

  it('refuses a run in which a target of the previous generation is gone or holds no file, unless that is accepted', async () => {
    const first = await backupSharedTakt({ source, dest, keep: 1, now: at(20) });
    rmSync(join(source, 'pi'), { recursive: true });
    expect(await failureCode(backupSharedTakt({ source, dest, keep: 1, now: at(21) }))).toBe('TARGET_DISAPPEARED');

    write('pi/sdk-11111111/package.json', '{"name":"managed"}\n', 0o644);
    symlinkSync('sdk-11111111', join(source, 'pi', 'sdk'));
    rmSync(join(source, 'workflows', 'custom.yaml'));
    expect(await failureCode(backupSharedTakt({ source, dest, keep: 1, now: at(22) }))).toBe('TARGET_DISAPPEARED');

    expect(await listGenerations(dest)).toEqual([first.generation]);
    await expect(verifyGeneration({ dest })).resolves.toMatchObject({ generation: first.generation });

    const accepted = await backupSharedTakt({ source, dest, keep: 1, now: at(23), acceptRemoved: true });
    expect(accepted.targets.find((target) => target.name === 'workflows')?.status).toBe('empty');
  });

  it('fails on a target that is neither a file, a directory, nor a link', async () => {
    const first = await backupSharedTakt({ source, dest, keep: 1, now: at(24) });
    rmSync(join(source, 'config.yaml'));
    expect(spawnSync('mkfifo', [join(source, 'config.yaml')]).status).toBe(0);

    expect(await failureCode(backupSharedTakt({ source, dest, keep: 1, now: at(25) }))).toBe('UNSUPPORTED_FILE');
    expect(await listGenerations(dest)).toEqual([first.generation]);
  });

  it('fails when a managed provider link names no usable generation', async () => {
    rmSync(join(source, 'pi', 'sdk-11111111'), { recursive: true });

    expect(await failureCode(backupSharedTakt({ source, dest, now: at(24) }))).toBe('MANAGED_PROVIDER_BROKEN');
    expect(await listGenerations(dest)).toEqual([]);
  });

  it('keeps the newest generations, each with its own files', async () => {
    for (const day of [20, 21, 22]) await backupSharedTakt({ source, dest, keep: 2, now: at(day) });

    expect(await listGenerations(dest)).toEqual([nameAt(21), nameAt(22)]);
    const unchanged = join('data', 'pi', 'sdk-11111111', 'package.json');
    expect(statSync(generationPath(nameAt(22), unchanged)).nlink).toBe(1);

    writeFileSync(generationPath(nameAt(21), unchanged), '{"name":"damaged"}\n');
    expect(await failureCode(verifyGeneration({ dest, generation: nameAt(21) }))).toBe('GENERATION_DAMAGED');
    await expect(verifyGeneration({ dest, generation: nameAt(22) })).resolves.toBeDefined();
  });

  it('writes targets, generations, and results to the log and the terminal, and never file contents', async () => {
    const output = capture();

    expect(await main(['backup', '--source', source, '--dest', dest], { ...output, now: () => at(24) })).toBe(0);
    rmSync(join(source, 'pi', 'sdk-11111111'), { recursive: true });
    expect(await main(['backup', '--source', source, '--dest', dest], { ...output, now: () => at(25) })).toBe(1);

    const [generation] = await listGenerations(dest);
    expect(output.text()).toMatch(new RegExp(`^backup ok generation=${generation} files=6 bytes=\\d+ targets=config.yaml,workflows,facets,pi\\n`, 'u'));
    expect(output.text()).toContain('backup failed: MANAGED_PROVIDER_BROKEN');
    expect(logRecords()).toMatchObject([
      { action: 'backup', source, result: 'ok', generation },
      { action: 'backup', source, result: 'failed', error: { code: 'MANAGED_PROVIDER_BROKEN' } },
    ]);
    for (const text of [output.text(), readFileSync(join(dest, 'backup.log'), 'utf8'), readFileSync(generationPath(generation!, 'manifest.json'), 'utf8')]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('provider: mock');
    }
  });

  it('reports an unexpected error by its kind, without its message', async () => {
    const output = capture();

    const status = await main(['backup', '--source', source, '--dest', dest], { ...output, now: () => { throw new Error(`could not parse ${SECRET}`); } });

    expect(status).toBe(1);
    expect(output.text()).toBe('backup failed: Error\n');
  });

  it('refuses a backup directory that overlaps the config directory or is readable by others', async () => {
    const before = snapshot(source);
    expect(await failureCode(backupSharedTakt({ source, dest: join(source, 'backup') }))).toBe('DEST_OVERLAPS_SOURCE');
    expect(await failureCode(backupSharedTakt({ source, dest: root }))).toBe('DEST_OVERLAPS_SOURCE');
    symlinkSync(source, join(root, 'alias'));
    expect(await failureCode(backupSharedTakt({ source, dest: join(root, 'alias', 'backup') }))).toBe('DEST_OVERLAPS_SOURCE');
    expect(snapshot(source)).toEqual(before);

    mkdirSync(dest, { mode: 0o755 });
    chmodSync(dest, 0o755);
    expect(await failureCode(backupSharedTakt({ source, dest }))).toBe('DEST_NOT_PRIVATE');
    expect(readdirSync(dest)).toEqual([]);
  });

  it('refuses a backup directory inside any TAKT config directory, whichever one is being copied', async () => {
    const live = join(root, 'live');
    mkdirSync(join(live, '.staging-in-use'), { recursive: true, mode: 0o700 });
    chmodSync(live, 0o700);
    const home = join(homedir(), '.takt');
    const homeBefore = existsSync(home) ? readdirSync(home).sort() : undefined;

    for (const target of [live, join(live, 'backup')]) {
      expect(await failureCode(backupSharedTakt({ source, dest: target, env: { TAKT_CONFIG_DIR: live } }))).toBe('DEST_OVERLAPS_SOURCE');
    }
    // TAKT_CONFIG_DIR naming another place does not unprotect ~/.takt.
    for (const env of [{ TAKT_CONFIG_DIR: live }, {}]) {
      expect(await failureCode(backupSharedTakt({ source, dest: join(home, 'backup'), env }))).toBe('DEST_OVERLAPS_SOURCE');
      expect(await failureCode(backupSharedTakt({ source, dest: home, env }))).toBe('DEST_OVERLAPS_SOURCE');
    }

    expect(readdirSync(live)).toEqual(['.staging-in-use']);
    expect(existsSync(home) ? readdirSync(home).sort() : undefined).toEqual(homeBefore);
  });

  it.skipIf(!['darwin', 'win32'].includes(process.platform))('refuses a config directory that does not exist yet under another spelling of its name', async () => {
    const missing = join(root, 'not-yet', '.takt');

    for (const target of [join(root, 'not-yet', '.TAKT'), join(root, 'NOT-YET', '.takt', 'backup')]) {
      expect(await failureCode(backupSharedTakt({ source, dest: target, env: { TAKT_CONFIG_DIR: missing } }))).toBe('DEST_OVERLAPS_SOURCE');
    }
    expect(existsSync(join(root, 'not-yet'))).toBe(false);
  });

  it('refuses a backup directory reached through a link in its path', async () => {
    const real = join(root, 'real');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(root, 'via'));

    expect(await failureCode(backupSharedTakt({ source, dest: join(root, 'via', 'backup'), now: at(24) }))).toBe('DEST_IS_LINK');
    expect(readdirSync(real)).toEqual([]);
  });

  it('refuses a backup directory whose own entries are links, and writes nothing through them', async () => {
    const before = snapshot(source);
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, dest);
    expect(await failureCode(backupSharedTakt({ source, dest, now: at(24) }))).toBe('DEST_IS_LINK');
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(dest);

    mkdirSync(dest, { mode: 0o700 });
    symlinkSync(join(source, 'config.yaml'), join(dest, 'backup.log'));
    expect(await failureCode(backupSharedTakt({ source, dest, now: at(24) }))).toBe('DEST_UNSAFE');
    rmSync(join(dest, 'backup.log'));

    linkSync(join(source, 'config.yaml'), join(dest, 'backup.log'));
    expect(await failureCode(backupSharedTakt({ source, dest, now: at(24) }))).toBe('DEST_UNSAFE');
    rmSync(join(dest, 'backup.log'));

    rmSync(join(dest, 'generations'), { recursive: true });
    symlinkSync(source, join(dest, 'generations'));
    expect(await failureCode(backupSharedTakt({ source, dest, now: at(24) }))).toBe('DEST_UNSAFE');
    expect(await listGenerations(dest)).toEqual([]);

    expect(snapshot(source)).toEqual(before);
  });

  it('runs one backup at a time and never takes over a lock by itself', async () => {
    mkdirSync(dest, { mode: 0o700 });
    writeFileSync(join(dest, '.lock'), String(process.pid));
    expect(await failureCode(backupSharedTakt({ source, dest, now: at(24) }))).toBe('LOCKED');

    writeFileSync(join(dest, '.lock'), '2147483646');
    expect(await failureCode(backupSharedTakt({ source, dest, now: at(25) }))).toBe('LOCK_STALE');
    expect(readFileSync(join(dest, '.lock'), 'utf8')).toBe('2147483646');

    writeFileSync(join(dest, '.lock'), '');
    expect(await failureCode(backupSharedTakt({ source, dest, now: at(26) }))).toBe('LOCKED');
    expect(existsSync(join(dest, '.lock'))).toBe(true);

    rmSync(join(dest, '.lock'));
    mkdirSync(join(dest, '.staging-leftover'));
    await backupSharedTakt({ source, dest, now: at(27) });
    expect(readdirSync(dest).filter((name) => name.startsWith('.'))).toEqual([]);
  });
});

describe('verify', () => {
  it('reports changed contents and changed permissions, and the next generation takes neither over', async () => {
    const { generation } = await backupSharedTakt({ source, dest, now: at(24) });

    chmodSync(generationPath(generation, 'data', 'config.yaml'), 0o644);
    expect(await failureCode(verifyGeneration({ dest }))).toBe('GENERATION_DAMAGED');
    chmodSync(generationPath(generation, 'data', 'config.yaml'), 0o600);
    await expect(verifyGeneration({ dest })).resolves.toBeDefined();

    writeFileSync(generationPath(generation, 'data', 'workflows', 'custom.yaml'), 'name: tamper\n');
    chmodSync(generationPath(generation, 'data', 'config.yaml'), 0o644);
    expect(await failureCode(verifyGeneration({ dest }))).toBe('GENERATION_DAMAGED');

    const next = await backupSharedTakt({ source, dest, now: at(25) });
    expect(statSync(generationPath(next.generation, 'data', 'config.yaml')).mode & 0o777).toBe(0o600);
    expect(readFileSync(generationPath(next.generation, 'data', 'workflows', 'custom.yaml'), 'utf8')).toBe('name: custom\n');
    await expect(verifyGeneration({ dest })).resolves.toMatchObject({ generation: next.generation });
  });

  it('reports anything in a generation that its manifest does not list', async () => {
    const { generation } = await backupSharedTakt({ source, dest, now: at(24) });

    writeFileSync(generationPath(generation, 'data', 'workflows', 'added.yaml'), 'name: added\n');
    expect(await failureCode(verifyGeneration({ dest }))).toBe('GENERATION_DAMAGED');
    rmSync(generationPath(generation, 'data', 'workflows', 'added.yaml'));

    mkdirSync(generationPath(generation, 'data', 'pi', 'sdk-11111111', 'node_modules', 'added'));
    expect(await failureCode(verifyGeneration({ dest }))).toBe('GENERATION_DAMAGED');
    rmSync(generationPath(generation, 'data', 'pi', 'sdk-11111111', 'node_modules', 'added'), { recursive: true });

    writeFileSync(generationPath(generation, 'added.yaml'), 'name: added\n');
    expect(await failureCode(verifyGeneration({ dest }))).toBe('GENERATION_DAMAGED');
    rmSync(generationPath(generation, 'added.yaml'));

    await expect(verifyGeneration({ dest })).resolves.toBeDefined();
  });

  it('checks the generation that latest points at', async () => {
    await backupSharedTakt({ source, dest, now: at(24) });
    mkdirSync(generationPath(nameAt(30)));

    await expect(verifyGeneration({ dest })).resolves.toMatchObject({ generation: nameAt(24) });
    expect(await failureCode(verifyGeneration({ dest, generation: nameAt(30) }))).toBe('GENERATION_DAMAGED');
  });
});

describe('command line', () => {
  it('runs backup and verify, and rejects unknown commands and incomplete arguments', async () => {
    const output = capture();

    expect(await main(['backup', '--source', source, '--dest', dest], output)).toBe(0);
    expect(await main(['verify', '--dest', dest], output)).toBe(0);
    expect(output.text()).toMatch(/^backup ok generation=(\S+) .*\nverify ok generation=\1 /u);
    expect(await main(['backup', '--source', source], output)).toBe(2);
    expect(await main(['restore', '--dest', dest], output)).toBe(2);
    expect(output.text()).toContain('Usage:');
  });

  it('runs when the script is started through a symbolic link', async () => {
    const linked = join(root, 'linked-checkout');
    symlinkSync(fileURLToPath(new URL('../../scripts', import.meta.url)), linked);

    const run = spawnSync(process.execPath, [join(linked, 'shared-takt-backup.mjs'), 'backup', '--source', source, '--dest', dest], { encoding: 'utf8' });

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^backup ok generation=/u);
    expect(await listGenerations(dest)).toHaveLength(1);
  });

  it('reads the config directory from TAKT_CONFIG_DIR when --source is omitted', async () => {
    const output = capture();

    expect(await main(['backup', '--dest', dest], { ...output, env: { TAKT_CONFIG_DIR: source } })).toBe(0);

    const [generation] = await listGenerations(dest);
    expect(readFileSync(generationPath(generation!, 'data', 'config.yaml'), 'utf8')).toBe(CONFIG);
  });
});

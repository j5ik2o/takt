/**
 * The daily copy of the shared TAKT configuration and managed providers.
 *
 * Every case builds its own fake config directory under tmp; the real one is never opened.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupSharedTakt, checkRestoredConfigDirectory, listGenerations, main, restoreGeneration, verifyGeneration,
} from '../../scripts/shared-takt-backup.mjs';

const SECRET = 'sk-secret-value-that-must-not-leak';
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

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stb-')));
  source = join(root, 'takt');
  dest = join(root, 'backup');
  write('config.yaml', `provider: mock\napi_key: ${SECRET}\n`);
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

    const summary = await backupSharedTakt({ source, dest, now: at(24) });

    expect(summary.generation).toBe('20261124T030000Z');
    expect(statSync(dest).mode & 0o077).toBe(0);
    const data = generationPath(summary.generation, 'data');
    expect(readFileSync(join(data, 'config.yaml'), 'utf8')).toContain(SECRET);
    expect(readFileSync(join(data, 'workflows', 'custom.yaml'), 'utf8')).toBe('name: custom\n');
    expect(readlinkSync(join(data, 'pi', 'sdk'))).toBe('sdk-11111111');
    expect(statSync(join(data, 'pi', 'sdk', 'node_modules', 'tool', 'bin', 'run')).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(data, 'pi')).sort()).toEqual(['sdk', 'sdk-11111111']);
    expect(existsSync(join(data, 'logs'))).toBe(false);
    expect(summary.targets.filter((target) => target.status === 'copied').map((target) => target.name))
      .toEqual(['config.yaml', 'workflows', 'facets', 'pi']);
    expect(readlinkSync(join(dest, 'latest'))).toBe(join('generations', summary.generation));
    await expect(verifyGeneration({ dest })).resolves.toMatchObject({ generation: summary.generation });
  });

  it.skipIf(isRoot)('leaves the earlier generation untouched when a copy fails part-way', async () => {
    const first = await backupSharedTakt({ source, dest, now: at(24) });
    write('config.yaml', 'provider: mock\nchanged: true\n');
    write('workflows/unreadable.yaml', 'name: unreadable\n', 0o000);

    expect(await failureCode(backupSharedTakt({ source, dest, now: at(25) }))).toBe('EACCES');

    chmodSync(join(source, 'workflows', 'unreadable.yaml'), 0o600);
    expect(await listGenerations(dest)).toEqual([first.generation]);
    expect(readlinkSync(join(dest, 'latest'))).toBe(join('generations', first.generation));
    expect(readFileSync(generationPath(first.generation, 'data', 'config.yaml'), 'utf8')).toContain(SECRET);
    await expect(verifyGeneration({ dest })).resolves.toMatchObject({ generation: first.generation });
    expect(readdirSync(dest).filter((name) => name.startsWith('.'))).toEqual([]);
    expect(logRecords().map((record) => record.result)).toEqual(['ok', 'failed']);
    expect(logRecords()[1]).toMatchObject({ generation: '20261125T030000Z', error: { code: 'EACCES' } });
  });

  it('does not publish a generation when the config directory has disappeared', async () => {
    const first = await backupSharedTakt({ source, dest, now: at(24) });
    rmSync(source, { recursive: true });

    expect(await failureCode(backupSharedTakt({ source, dest, now: at(25) }))).toBe('SOURCE_MISSING');
    mkdirSync(source);
    expect(await failureCode(backupSharedTakt({ source, dest, now: at(26) }))).toBe('NOTHING_TO_COPY');

    expect(await listGenerations(dest)).toEqual([first.generation]);
  });

  it('refuses a run in which a target of the previous generation is missing, unless that is accepted', async () => {
    await backupSharedTakt({ source, dest, now: at(24) });
    rmSync(join(source, 'pi'), { recursive: true });

    expect(await failureCode(backupSharedTakt({ source, dest, now: at(25) }))).toBe('TARGET_DISAPPEARED');
    expect(await listGenerations(dest)).toEqual(['20261124T030000Z']);

    const accepted = await backupSharedTakt({ source, dest, now: at(26), acceptRemoved: true });
    expect(accepted.targets.find((target) => target.name === 'pi')?.status).toBe('absent');
  });

  it('fails when a managed provider link names no usable generation', async () => {
    rmSync(join(source, 'pi', 'sdk-11111111'), { recursive: true });

    expect(await failureCode(backupSharedTakt({ source, dest, now: at(24) }))).toBe('MANAGED_PROVIDER_BROKEN');
    expect(await listGenerations(dest)).toEqual([]);
  });

  it('keeps the newest generations and removes older ones only after a successful run', async () => {
    for (const day of [20, 21, 22]) await backupSharedTakt({ source, dest, keep: 2, now: at(day) });

    expect(await listGenerations(dest)).toEqual(['20261121T030000Z', '20261122T030000Z']);
    await expect(verifyGeneration({ dest, generation: '20261121T030000Z' })).resolves.toBeDefined();
    // An unchanged file is stored once across generations.
    expect(statSync(generationPath('20261122T030000Z', 'data', 'pi', 'sdk-11111111', 'package.json')).nlink).toBe(2);
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

  it('refuses a backup directory that overlaps the config directory or is readable by others', async () => {
    expect(await failureCode(backupSharedTakt({ source, dest: join(source, 'backup') }))).toBe('DEST_OVERLAPS_SOURCE');
    expect(existsSync(join(source, 'backup'))).toBe(false);
    expect(await failureCode(backupSharedTakt({ source, dest: root }))).toBe('DEST_OVERLAPS_SOURCE');

    mkdirSync(dest, { mode: 0o755 });
    chmodSync(dest, 0o755);
    expect(await failureCode(backupSharedTakt({ source, dest }))).toBe('DEST_NOT_PRIVATE');
    expect(readdirSync(dest)).toEqual([]);
  });

  it('refuses to run beside a live backup and takes over the lock of a dead one', async () => {
    mkdirSync(dest, { mode: 0o700 });
    writeFileSync(join(dest, '.lock'), String(process.pid));
    expect(await failureCode(backupSharedTakt({ source, dest, now: at(24) }))).toBe('LOCKED');

    writeFileSync(join(dest, '.lock'), '2147483646');
    mkdirSync(join(dest, '.staging-leftover'));
    await backupSharedTakt({ source, dest, now: at(25) });
    expect(readdirSync(dest).filter((name) => name.startsWith('.'))).toEqual([]);
  });
});

describe('verify and restore', () => {
  it('restores a generation into an empty directory with the same contents, links, and modes', async () => {
    await backupSharedTakt({ source, dest, now: at(24) });
    const restored = join(root, 'restored');

    await restoreGeneration({ dest, to: restored });

    expect(readFileSync(join(restored, 'config.yaml'), 'utf8')).toBe(readFileSync(join(source, 'config.yaml'), 'utf8'));
    expect(statSync(join(restored, 'config.yaml')).mode & 0o777).toBe(0o600);
    expect(readlinkSync(join(restored, 'pi', 'sdk'))).toBe('sdk-11111111');
    expect(statSync(join(restored, 'pi', 'sdk', 'node_modules', 'tool', 'bin', 'run')).mode & 0o777).toBe(0o755);
    // The restored copy is independent of the generation it came from.
    expect(lstatSync(join(restored, 'config.yaml')).nlink).toBe(1);
  });

  it('reports a damaged generation and restores nothing from it', async () => {
    const { generation } = await backupSharedTakt({ source, dest, now: at(24) });
    writeFileSync(generationPath(generation, 'data', 'workflows', 'custom.yaml'), 'name: tamper\n');
    const restored = join(root, 'restored');

    expect(await failureCode(verifyGeneration({ dest }))).toBe('GENERATION_DAMAGED');
    expect(await failureCode(restoreGeneration({ dest, to: restored }))).toBe('GENERATION_DAMAGED');
    expect(existsSync(restored)).toBe(false);
  });

  it('refuses to restore over a directory that has contents', async () => {
    await backupSharedTakt({ source, dest, now: at(24) });

    expect(await failureCode(restoreGeneration({ dest, to: source }))).toBe('RESTORE_TARGET_NOT_EMPTY');
    expect(readFileSync(join(source, 'config.yaml'), 'utf8')).toContain(SECRET);
  });
});

describe('check', () => {
  function builtTakt(states: Record<string, 'missing' | 'stale' | 'ready'>, seen: string[], loadConfig = (): void => {}) {
    return async () => ({
      loadConfig,
      providers: ['pi', 'codex'],
      inspectProvider: async (provider: string) => {
        seen.push(`${provider}@${process.env.TAKT_CONFIG_DIR}`);
        return { state: states[provider] ?? 'missing' };
      },
    });
  }

  it('inspects the restored directory, not the live one, and reports each provider', async () => {
    const seen: string[] = [];
    const before = process.env.TAKT_CONFIG_DIR;

    const result = await checkRestoredConfigDirectory({ configDirectory: source, taktRoot: root, importTakt: builtTakt({ pi: 'ready' }, seen) });

    expect(result).toEqual({ config: 'readable', providers: { pi: 'ready', codex: 'absent' }, ok: true });
    expect(seen).toEqual([`pi@${source}`]);
    expect(process.env.TAKT_CONFIG_DIR).toBe(before);
  });

  it('fails when a restored provider does not pass inspection or the configuration cannot be loaded', async () => {
    const missing = await checkRestoredConfigDirectory({ configDirectory: source, taktRoot: root, importTakt: builtTakt({}, []) });
    expect(missing).toMatchObject({ providers: { pi: 'missing' }, ok: false });

    const unreadable = await checkRestoredConfigDirectory({
      configDirectory: source,
      taktRoot: root,
      importTakt: builtTakt({ pi: 'ready' }, [], () => { throw new Error(`invalid value ${SECRET}`); }),
    });
    expect(unreadable.ok).toBe(false);
    expect(JSON.stringify(unreadable)).not.toContain(SECRET);
  });
});

describe('command line', () => {
  it('runs backup, verify, and restore, and rejects incomplete arguments', async () => {
    const output = capture();
    const restored = join(root, 'restored');

    expect(await main(['backup', '--source', source, '--dest', dest], output)).toBe(0);
    expect(await main(['verify', '--dest', dest], output)).toBe(0);
    expect(await main(['restore', '--dest', dest, '--to', restored], output)).toBe(0);
    expect(readFileSync(join(restored, 'workflows', 'custom.yaml'), 'utf8')).toBe('name: custom\n');
    expect(await main(['backup', '--source', source], output)).toBe(2);
    expect(await main(['unknown'], output)).toBe(2);
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
    expect(readFileSync(generationPath(generation!, 'data', 'config.yaml'), 'utf8')).toContain(SECRET);
  });
});

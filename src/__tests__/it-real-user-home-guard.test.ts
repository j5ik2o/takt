/**
 * The shared test setup must keep tests away from the developer's real ~/.takt.
 *
 * Every case below protects a fake "real" TAKT directory under tmp; the real one is
 * never opened. The incident shape: a sentinel test wrote join(homedir(), '.takt')
 * and removed it recursively while HOME was the real home.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  chownSync, existsSync, linkSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { rm as rmPromise, writeFile as writeFilePromise } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import {
  RealUserHomeAccessError,
  assertIsolatedUserDirectories,
  protectDirectory,
  touchesProtectedDirectory,
  unprotectDirectory,
} from './helpers/realUserHomeGuard.js';
import {
  ISOLATION_ROOT_ENV, ORIGINAL_HOME_ENV, ORIGINAL_TAKT_CONFIG_DIR_ENV, isolateUserDirectoriesForTestRun,
} from '../../scripts/test-user-isolation.mjs';

describe('real user home guard', () => {
  let workspace: string;
  let fakeRealHome: string;
  let fakeRealTakt: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'takt-home-guard-'));
    fakeRealHome = join(workspace, 'real-home');
    fakeRealTakt = join(fakeRealHome, '.takt');
    mkdirSync(join(fakeRealTakt, 'claude-sdk'), { recursive: true });
    writeFileSync(join(fakeRealTakt, 'config.yaml'), 'provider: claude-sdk\n');
    writeFileSync(join(fakeRealTakt, 'claude-sdk', 'marker'), 'installed\n');
    protectDirectory(fakeRealTakt);
  });

  afterEach(() => {
    unprotectDirectory(fakeRealTakt);
    rmSync(workspace, { recursive: true, force: true });
  });

  function expectFakeRealTaktIntact(): void {
    expect(readFileSync(join(fakeRealTakt, 'config.yaml'), 'utf-8')).toBe('provider: claude-sdk\n');
    expect(readFileSync(join(fakeRealTakt, 'claude-sdk', 'marker'), 'utf-8')).toBe('installed\n');
  }

  it('runs every test with HOME, os.homedir(), and the global config dir outside the real ~/.takt', () => {
    expect(homedir()).toBe(process.env.HOME);
    for (const value of [process.env.HOME!, homedir(), getGlobalConfigDir(), process.env.TAKT_CONFIG_DIR!]) {
      expect(touchesProtectedDirectory(value)).toBe(false);
    }
    expect(() => assertIsolatedUserDirectories()).not.toThrow();
  });

  it('refuses to run when HOME or TAKT_CONFIG_DIR points at the real directory, directly or through a symlink', () => {
    const isolated = join(workspace, 'isolated');
    const link = join(workspace, 'link-to-real');
    symlinkSync(fakeRealTakt, link, 'dir');

    expect(() => assertIsolatedUserDirectories({ HOME: fakeRealHome, TAKT_CONFIG_DIR: isolated }))
      .toThrow(RealUserHomeAccessError);
    expect(() => assertIsolatedUserDirectories({ HOME: isolated, TAKT_CONFIG_DIR: fakeRealTakt }))
      .toThrow(RealUserHomeAccessError);
    expect(() => assertIsolatedUserDirectories({ HOME: isolated, TAKT_CONFIG_DIR: link }))
      .toThrow(RealUserHomeAccessError);
    expect(() => assertIsolatedUserDirectories({ HOME: isolated })).toThrow(RealUserHomeAccessError);
    expect(() => assertIsolatedUserDirectories({ HOME: isolated, TAKT_CONFIG_DIR: join(isolated, '.takt') }))
      .not.toThrow();
  });

  it('rejects recursive deletion of the real directory, its contents, and its ancestors', async () => {
    expect(() => rmSync(fakeRealTakt, { recursive: true, force: true })).toThrow(RealUserHomeAccessError);
    expect(() => rmSync(fakeRealHome, { recursive: true, force: true })).toThrow(RealUserHomeAccessError);
    expect(() => fs.rmSync(join(fakeRealTakt, 'claude-sdk'), { recursive: true })).toThrow(RealUserHomeAccessError);
    expect(() => renameSync(fakeRealTakt, join(workspace, 'moved'))).toThrow(RealUserHomeAccessError);
    await expect(rmPromise(fakeRealTakt, { recursive: true, force: true })).rejects.toThrow(RealUserHomeAccessError);
    expect(() => fs.rm(fakeRealTakt, { recursive: true }, () => undefined)).toThrow(RealUserHomeAccessError);

    expectFakeRealTaktIntact();
  });

  it('rejects writes into the real directory, including through a symlink', async () => {
    const link = join(workspace, 'link-to-real');
    symlinkSync(fakeRealTakt, link, 'dir');

    expect(() => writeFileSync(join(fakeRealTakt, 'config.yaml'), 'enable_builtin_workflows: false\n'))
      .toThrow(RealUserHomeAccessError);
    expect(() => writeFileSync(join(link, 'config.yaml'), 'enable_builtin_workflows: false\n'))
      .toThrow(RealUserHomeAccessError);
    expect(() => rmSync(join(link, 'claude-sdk'), { recursive: true })).toThrow(RealUserHomeAccessError);
    expect(() => mkdirSync(join(fakeRealTakt, 'projects'))).toThrow(RealUserHomeAccessError);
    await expect(writeFilePromise(join(fakeRealTakt, 'config.yaml'), 'x')).rejects.toThrow(RealUserHomeAccessError);
    expect(() => fs.openSync(join(fakeRealTakt, 'config.yaml'), 'w')).toThrow(RealUserHomeAccessError);

    expect(fs.readFileSync(join(link, 'config.yaml'), 'utf-8')).toBe('provider: claude-sdk\n');
    expectFakeRealTaktIntact();
  });

  it('follows a symlink before ".." and rejects aliases and less common calls that reach the real directory', () => {
    const linkParent = join(workspace, 'w');
    mkdirSync(linkParent);
    symlinkSync(join(fakeRealTakt, 'claude-sdk'), join(linkParent, 'link'), 'dir');

    expect(() => writeFileSync(`${linkParent}${sep}link${sep}..${sep}config.yaml`, 'x')).toThrow(RealUserHomeAccessError);
    expect(() => rmSync(`${linkParent}${sep}link${sep}..${sep}claude-sdk`, { recursive: true })).toThrow(RealUserHomeAccessError);
    expect(() => linkSync(join(fakeRealTakt, 'config.yaml'), join(workspace, 'alias'))).toThrow(RealUserHomeAccessError);
    expect(() => mkdtempSync(join(fakeRealTakt, 'tmp-'))).toThrow(RealUserHomeAccessError);
    expect(() => chownSync(join(fakeRealTakt, 'config.yaml'), process.getuid?.() ?? 0, process.getgid?.() ?? 0))
      .toThrow(RealUserHomeAccessError);
    expect(() => lutimesSync(join(fakeRealTakt, 'config.yaml'), new Date(), new Date())).toThrow(RealUserHomeAccessError);
    expect(() => writeFileSync(pathToFileURL(join(fakeRealTakt, 'config.yaml')), 'x')).toThrow(RealUserHomeAccessError);

    expect(existsSync(join(workspace, 'alias'))).toBe(false);
    expectFakeRealTaktIntact();
  });

  it('rejects writes through a symlink outside the real directory whose target inside it does not exist yet', async () => {
    const missing = join(fakeRealTakt, 'not-created-yet.yaml');
    const absoluteLink = join(workspace, 'dangling-absolute');
    const relativeLink = join(workspace, 'dangling-relative');
    const chainedLink = join(workspace, 'dangling-chained');
    const missingDirLink = join(workspace, 'dangling-dir');
    symlinkSync(missing, absoluteLink);
    symlinkSync(join('real-home', '.takt', 'not-created-yet.yaml'), relativeLink);
    symlinkSync(absoluteLink, chainedLink);
    symlinkSync(join(fakeRealTakt, 'not-created-dir'), missingDirLink);

    for (const link of [absoluteLink, relativeLink, chainedLink]) {
      expect(touchesProtectedDirectory(link)).toBe(true);
      expect(() => writeFileSync(link, 'x')).toThrow(RealUserHomeAccessError);
      expect(() => fs.openSync(link, 'w')).toThrow(RealUserHomeAccessError);
      expect(() => fs.createWriteStream(link)).toThrow(RealUserHomeAccessError);
      await expect(writeFilePromise(link, 'x')).rejects.toThrow(RealUserHomeAccessError);
    }
    expect(() => mkdirSync(missingDirLink)).toThrow(RealUserHomeAccessError);
    expect(() => writeFileSync(join(missingDirLink, 'child'), 'x')).toThrow(RealUserHomeAccessError);

    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(fakeRealTakt, 'not-created-dir'))).toBe(false);
    expectFakeRealTaktIntact();
  });

  it('keeps dangling and looping symlinks that stay outside the real directory writable', () => {
    const target = join(workspace, 'plain-target');
    const link = join(workspace, 'dangling-plain');
    symlinkSync(target, link);
    symlinkSync(join(workspace, 'loop-b'), join(workspace, 'loop-a'));
    symlinkSync(join(workspace, 'loop-a'), join(workspace, 'loop-b'));

    writeFileSync(link, 'x');

    expect(readFileSync(target, 'utf-8')).toBe('x');
    expect(touchesProtectedDirectory(join(workspace, 'loop-a'))).toBe(false);
    expectFakeRealTaktIntact();
  });

  it('still allows the incident sentinel pattern against a home this test created and other temporary directories', () => {
    // Never homedir(): under a config that skips the shared setup it is the real home.
    const sentinel = join(workspace, 'isolated-home', '.takt');
    mkdirSync(join(sentinel, 'projects'), { recursive: true });
    writeFileSync(join(sentinel, 'config.yaml'), 'language: ja\n');
    rmSync(sentinel, { recursive: true, force: true });
    const scratch = join(workspace, 'scratch');
    mkdirSync(scratch);
    writeFileSync(join(scratch, 'file'), 'x');
    rmSync(scratch, { recursive: true });

    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
    expectFakeRealTaktIntact();
  });

  it('refuses to create the isolated root when the temporary directory lies inside a real TAKT directory', () => {
    const script = pathToFileURL(join(process.cwd(), 'scripts', 'test-user-isolation.mjs')).href;
    const tmpInsideRealTakt = join(fakeRealTakt, 'tmp');
    const linkToRealTakt = join(workspace, 'tmp-link');
    unprotectDirectory(fakeRealTakt);
    mkdirSync(tmpInsideRealTakt);
    symlinkSync(tmpInsideRealTakt, linkToRealTakt, 'dir');
    protectDirectory(fakeRealTakt);
    const run = (tmp: string, extra: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> => {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(workspace, 'other-home'), TMPDIR: tmp, TMP: tmp, TEMP: tmp, ...extra };
      return spawnSync(process.execPath, [
        '--input-type=module',
        '-e',
        `import { isolateUserDirectoriesForTestRun } from ${JSON.stringify(script)}; isolateUserDirectoriesForTestRun();`,
      ], { encoding: 'utf-8', env });
    };

    const linkedHome = join(workspace, 'linked-home');
    mkdirSync(linkedHome);
    symlinkSync(fakeRealTakt, join(linkedHome, '.takt'), 'dir');
    const cases: Array<[string, NodeJS.ProcessEnv]> = [
      [tmpInsideRealTakt, { HOME: fakeRealHome }],
      [linkToRealTakt, { HOME: fakeRealHome }],
      [tmpInsideRealTakt, { TAKT_CONFIG_DIR: fakeRealTakt }],
      // The TAKT directory itself is a symlink.
      [tmpInsideRealTakt, { HOME: linkedHome }],
    ];
    const misspelledTmp = join(fakeRealHome, '.TAKT', 'tmp');
    if (existsSync(misspelledTmp)) {
      // Case-insensitive filesystem: another spelling names the same directory.
      cases.push([misspelledTmp, { HOME: fakeRealHome }]);
      cases.push([tmpInsideRealTakt, { TAKT_CONFIG_DIR: join(fakeRealHome, '.TAKT') }]);
    }

    for (const [tmp, extra] of cases) {
      const result = run(tmp, extra);
      expect(result.status, `${tmp} ${JSON.stringify(extra)}`).not.toBe(0);
      expect(String(result.stderr)).toContain('Refusing to isolate test user directories');
    }

    expectFakeRealTaktIntact();
  });

  it('hands child processes the isolated HOME, XDG, TMPDIR, and TAKT config dir from before the workers started', () => {
    const output = execFileSync(process.execPath, [
      '-e',
      'const os = require("os"); process.stdout.write(JSON.stringify([os.homedir(), os.tmpdir(), '
        + 'process.env.XDG_CONFIG_HOME, process.env.TAKT_CONFIG_DIR, process.env.TEST_USER_ISOLATION_ROOT]))',
    ], { encoding: 'utf-8' });
    const [childHome, childTmp, childXdg, childConfigDir, root] = JSON.parse(output) as string[];

    expect(root).toBeTruthy();
    for (const value of [childHome, childTmp, childXdg, childConfigDir]) {
      expect(value!.startsWith(`${root}${sep}`)).toBe(true);
      expect(value!.startsWith(join(userInfo().homedir, '.takt'))).toBe(false);
    }
  });

  it('removes the isolated root when the process that created it exits', () => {
    const script = pathToFileURL(join(process.cwd(), 'scripts', 'test-user-isolation.mjs')).href;
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env[ISOLATION_ROOT_ENV];
    const root = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { isolateUserDirectoriesForTestRun } from ${JSON.stringify(script)};`
        + 'import { existsSync } from "node:fs";'
        + 'const root = isolateUserDirectoriesForTestRun();'
        + 'if (!existsSync(process.env.TAKT_CONFIG_DIR)) process.exit(2);'
        + 'process.stdout.write(root);',
    ], { encoding: 'utf-8', env });

    expect(root.startsWith(`${process.env[ISOLATION_ROOT_ENV]}${sep}`)).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it('moves every user directory of a runner environment under one temporary root and reuses it when nested', () => {
    const playwrightCache = process.platform === 'darwin'
      ? join(fakeRealHome, 'Library', 'Caches', 'ms-playwright')
      : join(fakeRealHome, '.cache', 'ms-playwright');
    mkdirSync(playwrightCache, { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: fakeRealHome, PATH: process.env.PATH, TAKT_CONFIG_DIR: fakeRealTakt };
    const root = isolateUserDirectoriesForTestRun(env);

    try {
      expect(env[ORIGINAL_HOME_ENV]).toBe(fakeRealHome);
      expect(env[ORIGINAL_TAKT_CONFIG_DIR_ENV]).toBe(fakeRealTakt);
      if (process.platform !== 'win32') expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(playwrightCache);
      expect(env.MISE_DATA_DIR).toBeUndefined();
      expect(env[ISOLATION_ROOT_ENV]).toBe(root);
      for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
        'TMPDIR', 'TMP', 'TEMP', 'TAKT_CONFIG_DIR']) {
        expect(env[key]!.startsWith(`${root}${sep}`)).toBe(true);
        expect(existsSync(env[key]!)).toBe(true);
      }
      expect(() => assertIsolatedUserDirectories(env)).not.toThrow();
      expect(isolateUserDirectoriesForTestRun(env)).toBe(root);
      expect(env[ORIGINAL_HOME_ENV]).toBe(fakeRealHome);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expectFakeRealTaktIntact();
  });
});

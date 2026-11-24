import { Console } from 'node:console';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach } from 'vitest';
import { clearTaktEnv, restoreTaktEnv, type TaktEnvSnapshot } from './helpers/taktEnv.js';
import {
  assertIsolatedUserDirectories,
  detectRealUserTaktDirectories,
  installRealUserHomeFsGuard,
  isWithinOrEqual,
  protectDirectory,
} from './helpers/realUserHomeGuard.js';
import { ISOLATION_ROOT_ENV, ORIGINAL_HOME_ENV, ORIGINAL_TAKT_CONFIG_DIR_ENV } from '../../scripts/test-user-isolation.mjs';

globalThis.console.Console = Console;

const shouldForceNoTty = process.env.TAKT_TEST_FLG_TOUCH_TTY !== '1';
const TEST_TMPDIR = realpathSync(tmpdir());

process.env.TMPDIR = TEST_TMPDIR;

// vitest.config.shared.ts moved HOME, XDG_*, TMPDIR, and TAKT_CONFIG_DIR to a
// temporary root before any worker started. Refuse to run if that did not
// happen, and reject fs writes and deletions that still reach the real ~/.takt.
for (const directory of detectRealUserTaktDirectories(process.env[ORIGINAL_HOME_ENV])) protectDirectory(directory);
// A config dir the developer exported is real too, unless it encloses the
// isolated root (protecting it would refuse every test write).
const originalConfigDir = process.env[ORIGINAL_TAKT_CONFIG_DIR_ENV];
if (originalConfigDir && !isWithinOrEqual(resolve(originalConfigDir), process.env[ISOLATION_ROOT_ENV] ?? '')) {
  protectDirectory(originalConfigDir);
}
installRealUserHomeFsGuard();
assertIsolatedUserDirectories();

if (shouldForceNoTty) {
  process.env.TAKT_NO_TTY = '1';
}

let isolatedRootDir: string | undefined;
let taktEnvSnapshot: TaktEnvSnapshot;
const gitEnvKeys = [
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_TEMPLATE_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_KEY_1',
  'GIT_CONFIG_VALUE_1',
] as const;
let gitEnvSnapshot: Map<string, string | undefined>;
// Captured before any test can install fake timers.
const realSetImmediate = globalThis.setImmediate;
beforeEach(async () => {
  // A file whose tests never wait on real I/O keeps the worker's event loop busy
  // across tests, so Vitest's RPC replies are not processed and its fixed 60s
  // timeout fires ("Timeout calling onTaskUpdate"). Yield one macrotask per test.
  await new Promise<void>((resolve) => realSetImmediate(resolve));
  taktEnvSnapshot = clearTaktEnv();
  process.env.TMPDIR = TEST_TMPDIR;
  isolatedRootDir = realpathSync(mkdtempSync(join(tmpdir(), 'takt-test-global-')));
  gitEnvSnapshot = new Map(gitEnvKeys.map((key) => [key, process.env[key]]));
  process.env.TAKT_CONFIG_DIR = join(isolatedRootDir, '.takt');
  const emptyGitConfig = join(isolatedRootDir, 'gitconfig');
  const emptyGitTemplate = join(isolatedRootDir, 'git-template');
  const emptyGitHooks = join(isolatedRootDir, 'git-hooks');
  writeFileSync(emptyGitConfig, '');
  mkdirSync(emptyGitTemplate, { recursive: true });
  mkdirSync(emptyGitHooks, { recursive: true });
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
  process.env.GIT_TEMPLATE_DIR = emptyGitTemplate;
  process.env.GIT_CONFIG_COUNT = '2';
  process.env.GIT_CONFIG_KEY_0 = 'commit.gpgSign';
  process.env.GIT_CONFIG_VALUE_0 = 'false';
  process.env.GIT_CONFIG_KEY_1 = 'core.hooksPath';
  process.env.GIT_CONFIG_VALUE_1 = emptyGitHooks;
  if (shouldForceNoTty) {
    process.env.TAKT_NO_TTY = '1';
  }
  mkdirSync(process.env.TAKT_CONFIG_DIR, { recursive: true });
  assertIsolatedUserDirectories();
});

afterEach(() => {
  restoreTaktEnv(taktEnvSnapshot);
  for (const [key, value] of gitEnvSnapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  if (isolatedRootDir) {
    rmSync(isolatedRootDir, { recursive: true, force: true });
  }
});

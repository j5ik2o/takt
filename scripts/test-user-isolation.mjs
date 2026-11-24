/**
 * Isolate the user directories of a Vitest run before any worker exists.
 *
 * vitest.config.shared.ts calls this while the config loads in the parent
 * process, so every thread, fork, and child process inherits a temporary HOME,
 * USERPROFILE, XDG_*, TMPDIR/TMP/TEMP, and TAKT_CONFIG_DIR from the real
 * process environment. Assigning HOME inside a `threads` worker does not move
 * os.homedir(); only the parent environment does.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Set on the isolated root so a nested config load reuses it. Not TAKT_-prefixed: tests clear those. */
export const ISOLATION_ROOT_ENV = 'TEST_USER_ISOLATION_ROOT';
/** The HOME the run started with, protected by the in-worker guard. */
export const ORIGINAL_HOME_ENV = 'TEST_USER_ISOLATION_ORIGINAL_HOME';

export function isolateUserDirectoriesForTestRun(env = process.env) {
  const existing = env[ISOLATION_ROOT_ENV];
  if (existing && existsSync(existing)) return existing;
  // Keep the prefix short: macOS limits Unix socket paths under TMPDIR to 104 bytes.
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'tt-')));
  const home = join(root, 'h');
  const directories = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, 'x', 'config'),
    XDG_DATA_HOME: join(root, 'x', 'data'),
    XDG_CACHE_HOME: join(root, 'x', 'cache'),
    XDG_STATE_HOME: join(root, 'x', 'state'),
    TMPDIR: join(root, 't'),
    TMP: join(root, 't'),
    TEMP: join(root, 't'),
    TAKT_CONFIG_DIR: join(home, '.takt'),
  };
  if (env[ORIGINAL_HOME_ENV] === undefined) env[ORIGINAL_HOME_ENV] = env.HOME ?? '';
  for (const [key, value] of Object.entries(directories)) {
    mkdirSync(value, { recursive: true });
    env[key] = value;
  }
  env[ISOLATION_ROOT_ENV] = root;
  process.once('exit', () => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

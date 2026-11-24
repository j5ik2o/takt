/**
 * Keeps tests away from the developer's real `~/.takt`.
 *
 * A sentinel test once wrote `join(homedir(), '.takt')` and removed it recursively
 * while HOME still pointed at the real home, deleting the user's config and managed
 * providers. The shared setup therefore isolates HOME before any test module loads,
 * refuses to start while HOME or TAKT_CONFIG_DIR still resolves to the real
 * directory, and rejects fs writes, renames, and deletions that reach it.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const protectedDirectories = new Set<string>();
let installed = false;

const realpathNative = fs.realpathSync.native;

/**
 * Resolve a path the way the OS does: follow each existing component's symlink
 * before applying the next `..`. A missing tail is kept as written.
 */
export function resolveThroughExistingPrefix(path: string): string {
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  try {
    // The OS resolves an existing path component by component already.
    return realpathNative(absolute);
  } catch {
    // Walk the components ourselves for a path whose tail does not exist yet.
  }
  const { root } = parse(absolute);
  let current = root;
  for (const segment of absolute.slice(root.length).split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    try {
      current = realpathNative(next);
    } catch {
      current = next;
    }
  }
  return current;
}

export function isWithinOrEqual(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** The real `~/.takt`, from the account database so a redirected HOME cannot hide it. */
export function detectRealUserTaktDirectories(initialHome: string | undefined): string[] {
  const homes = new Set<string>();
  try {
    homes.add(userInfo().homedir);
  } catch {
    // No account database entry (some containers): fall back to the inherited HOME.
  }
  if (initialHome !== undefined && initialHome !== '') homes.add(initialHome);
  return [...homes].map((home) => resolveThroughExistingPrefix(join(home, '.takt')));
}

/** True when `path` is the protected directory, inside it, or one of its ancestors. */
export function touchesProtectedDirectory(path: string, directories: Iterable<string> = protectedDirectories): boolean {
  const candidates = [resolve(path), resolveThroughExistingPrefix(path)];
  for (const directory of directories) {
    for (const candidate of candidates) {
      if (isWithinOrEqual(directory, candidate) || isWithinOrEqual(candidate, directory)) return true;
    }
  }
  return false;
}

export function protectDirectory(directory: string): void {
  protectedDirectories.add(resolveThroughExistingPrefix(directory));
}

export function unprotectDirectory(directory: string): void {
  protectedDirectories.delete(resolveThroughExistingPrefix(directory));
}

export class RealUserHomeAccessError extends Error {}

function refuse(operation: string, path: string): never {
  throw new RealUserHomeAccessError(
    `Refusing ${operation} on "${path}": it reaches the real user TAKT directory. `
    + 'Tests must run with HOME and TAKT_CONFIG_DIR pointing at a temporary directory.',
  );
}

/**
 * Directory-level checks only apply to deletions and renames: removing an ancestor
 * removes the protected directory too. Writes are refused only inside it.
 */
function assertAllowed(operation: string, path: unknown, ancestorMatters: boolean): void {
  if (typeof path !== 'string' && !(path instanceof URL) && !Buffer.isBuffer(path)) return;
  const text = path instanceof URL ? (path.protocol === 'file:' ? fileURLToPath(path) : '') : String(path);
  if (text === '') return;
  const candidates = [resolve(text), resolveThroughExistingPrefix(text)];
  for (const directory of protectedDirectories) {
    for (const candidate of candidates) {
      if (isWithinOrEqual(directory, candidate) || (ancestorMatters && isWithinOrEqual(candidate, directory))) {
        refuse(operation, text);
      }
    }
  }
}

function isWriteFlag(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0;
  return typeof flags === 'string' && /[wa+]/.test(flags);
}

type Rule = { readonly destructive: readonly number[]; readonly write: readonly number[]; readonly openFlags?: number };

const RULES: Record<string, Rule> = {
  rm: { destructive: [0], write: [] },
  rmdir: { destructive: [0], write: [] },
  unlink: { destructive: [0], write: [] },
  rename: { destructive: [0, 1], write: [] },
  writeFile: { destructive: [], write: [0] },
  appendFile: { destructive: [], write: [0] },
  mkdir: { destructive: [], write: [0] },
  copyFile: { destructive: [], write: [1] },
  cp: { destructive: [], write: [1] },
  symlink: { destructive: [], write: [1] },
  // A hard link from a protected file is a writable alias of it.
  link: { destructive: [], write: [0, 1] },
  mkdtemp: { destructive: [], write: [0] },
  chown: { destructive: [], write: [0] },
  lchown: { destructive: [], write: [0] },
  lutimes: { destructive: [], write: [0] },
  truncate: { destructive: [], write: [0] },
  chmod: { destructive: [], write: [0] },
  utimes: { destructive: [], write: [0] },
  open: { destructive: [], write: [], openFlags: 1 },
};

function guard<T extends (...args: never[]) => unknown>(name: string, rule: Rule, original: T, async = false): T {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    try {
      for (const index of rule.destructive) assertAllowed(name, args[index], true);
      for (const index of rule.write) assertAllowed(name, args[index], false);
      if (rule.openFlags !== undefined && isWriteFlag(args[rule.openFlags])) assertAllowed(name, args[0], false);
    } catch (error) {
      if (async) return Promise.reject(error);
      throw error;
    }
    return Reflect.apply(original, this, args);
  };
  return wrapped as unknown as T;
}

/** Patch node:fs (callback, sync, and promises APIs) once per worker. */
export function installRealUserHomeFsGuard(): void {
  if (installed) return;
  installed = true;
  const target = fs as unknown as Record<string, unknown>;
  const promises = fs.promises as unknown as Record<string, unknown>;
  for (const [name, rule] of Object.entries(RULES)) {
    for (const key of [name, `${name}Sync`]) {
      const original = target[key];
      if (typeof original === 'function') target[key] = guard(key, rule, original as (...args: never[]) => unknown);
    }
    const original = promises[name];
    if (typeof original === 'function') promises[name] = guard(`promises.${name}`, rule, original as (...args: never[]) => unknown, true);
  }
  const createWriteStream = fs.createWriteStream;
  target.createWriteStream = function (this: unknown, ...args: unknown[]): unknown {
    assertAllowed('createWriteStream', args[0], false);
    return Reflect.apply(createWriteStream, this, args);
  };
  syncBuiltinESMExports();
}

/** True when `path` resolves to the protected directory or somewhere inside it. */
function isInsideProtectedDirectory(path: string): boolean {
  const candidates = [resolve(path), resolveThroughExistingPrefix(path)];
  return [...protectedDirectories].some((directory) => candidates.some((candidate) => isWithinOrEqual(directory, candidate)));
}

/**
 * Refuse to run while a home-like variable would make `<home>/.takt` the real
 * directory, or a config/temp directory lies inside it.
 */
export function assertIsolatedUserDirectories(env: NodeJS.ProcessEnv = process.env): void {
  const homes: Array<[string, string | undefined]> = [
    ['HOME', env.HOME],
    ['USERPROFILE', env.USERPROFILE],
    ['os.homedir()', homedir()],
  ];
  const directories: Array<[string, string | undefined]> = [
    ['TAKT_CONFIG_DIR', env.TAKT_CONFIG_DIR],
    ['XDG_CONFIG_HOME', env.XDG_CONFIG_HOME],
    ['TMPDIR', env.TMPDIR],
    ['os.tmpdir()', tmpdir()],
  ];
  const offending = [
    ...homes.filter(([, value]) => value !== undefined && value !== '' && isInsideProtectedDirectory(join(value, '.takt'))),
    ...directories.filter(([, value]) => value !== undefined && value !== '' && isInsideProtectedDirectory(value)),
  ];
  for (const [label, value] of offending) {
    throw new RealUserHomeAccessError(
      `Refusing to run tests: ${label}="${value}" reaches the real user TAKT directory. `
      + 'Point HOME and TAKT_CONFIG_DIR at a temporary directory.',
    );
  }
  if (env.TAKT_CONFIG_DIR === undefined || env.TAKT_CONFIG_DIR === '') {
    throw new RealUserHomeAccessError('Refusing to run tests: TAKT_CONFIG_DIR is not set to an isolated directory.');
  }
}

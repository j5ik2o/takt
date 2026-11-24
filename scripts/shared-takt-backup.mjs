#!/usr/bin/env node
/**
 * Daily copy of the shared TAKT configuration and managed providers.
 *
 * Fork-only operations tool; see docs/shared-takt-backup.md.
 *
 *   backup   copy the configuration and the current managed provider generations
 *            into a new generation under a private directory outside the source
 *   verify   compare a generation with its manifest (contents, sizes, modes)
 *   restore  copy a verified generation into a new directory
 *   check    compare a restored directory with the generation it came from, then
 *            load its configuration and inspect its managed providers with a built TAKT
 *
 * Rules the code below keeps:
 *   - The config directory is only read. Every write goes under the backup
 *     directory or a restore target, and neither may overlap the config directory.
 *   - A generation is staged and renamed into place only after every copied file
 *     matches its source. Older generations are removed last, after the new one is
 *     published and logged, so a run that could not publish has removed nothing.
 *   - Generations share no files: damage to one cannot reach another.
 *   - Output and the log name targets, generations, and results only: never file
 *     contents, and never the message of an error this tool did not raise.
 *
 * POSIX only (macOS, Linux): the managed provider link is read as a relative
 * symbolic link, which is not how TAKT publishes it on Windows.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, realpathSync, rmSync } from 'node:fs';
import {
  chmod, copyFile, link, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Files and directories of the config directory that hold configuration. Runtime state is not listed. */
export const CONFIG_TARGETS = Object.freeze([
  'config.yaml', 'runtime.yaml', 'preferences', 'workflows', 'facets', 'personas', 'agents', 'schemas',
  'provider-options', 'steps', 'companions', 'facet-pools', 'repertoire',
]);
export const MANAGED_PROVIDER_TARGETS = Object.freeze(['claude-sdk', 'codex', 'opencode', 'pi', 'deepseek-harness']);
export const DEFAULT_KEEP = 7;

const GENERATIONS = 'generations';
const LATEST = 'latest';
const LOG = 'backup.log';
const LOCK = '.lock';
const STAGING_PREFIX = '.staging-';
const MANIFEST = 'manifest.json';
const DATA = 'data';
const GENERATION_NAME = /^\d{8}T\d{6}Z$/u;
const MANAGED_GENERATION_NAME = /^sdk-[A-Za-z0-9-]+$/u;

/** A failure this tool raised on purpose. Its message is written for the operator and holds no file contents. */
export class BackupError extends Error {
  constructor(code, message, path) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

/** What may be shown about a failure: a code and a path, never the message of an error this tool did not raise. */
function describeFailure(error) {
  if (error instanceof BackupError) return { code: error.code, message: error.message, ...(error.path === undefined ? {} : { path: error.path }) };
  const code = typeof error?.code === 'string' ? error.code : (error?.name ?? 'Error');
  return { code, ...(typeof error?.path === 'string' ? { path: error.path } : {}) };
}

async function lstatOrUndefined(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function isRealDirectory(path) {
  return (await lstatOrUndefined(path))?.isDirectory() === true;
}

function hashFile(path) {
  return new Promise((resolvePromise, reject) => {
    const digest = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (chunk) => digest.update(chunk))
      .on('end', () => resolvePromise(digest.digest('hex')));
  });
}

/** Resolve a path that may not exist yet through its nearest existing ancestor. */
async function realpathOfMaybeMissing(path) {
  const missing = [];
  let current = resolve(path);
  while (true) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(current) === current) throw error;
      missing.unshift(basename(current));
      current = dirname(current);
    }
  }
}

function isInsideOrEqual(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function overlaps(first, second) {
  const [realFirst, realSecond] = [await realpathOfMaybeMissing(first), await realpathOfMaybeMissing(second)];
  return isInsideOrEqual(realFirst, realSecond) || isInsideOrEqual(realSecond, realFirst);
}

function liveConfigDirectory(env) {
  return resolve(env.TAKT_CONFIG_DIR || join(homedir(), '.takt'));
}

function unsafeEntry(name) {
  return new BackupError('DEST_UNSAFE', 'An entry of the backup directory is not what this tool creates there.', name);
}

/**
 * Make sure every path a run writes under the backup directory is what it
 * seems: the root and `generations` are real private directories, and the log
 * is a regular file. A link in any of these places could lead back into the
 * config directory.
 */
async function prepareBackupRoot(source, dest) {
  if (await overlaps(source, dest)) {
    throw new BackupError('DEST_OVERLAPS_SOURCE', 'The backup directory and the TAKT config directory must not contain each other.');
  }
  if (await lstatOrUndefined(dest) === undefined) await mkdir(dest, { recursive: true, mode: 0o700 });
  const root = await lstat(dest);
  if (root.isSymbolicLink()) throw new BackupError('DEST_IS_LINK', 'The backup directory is a symbolic link. Name the directory itself.');
  if (!root.isDirectory()) throw new BackupError('DEST_NOT_DIRECTORY', 'The backup path is not a directory.');
  if (typeof process.getuid === 'function' && root.uid !== process.getuid()) {
    throw new BackupError('DEST_NOT_OWNED', 'The backup directory belongs to another user.');
  }
  if ((root.mode & 0o077) !== 0) {
    throw new BackupError('DEST_NOT_PRIVATE', 'The backup directory is readable by other users. Run chmod 700 on it.');
  }
  const generations = await lstatOrUndefined(join(dest, GENERATIONS));
  if (generations === undefined) await mkdir(join(dest, GENERATIONS), { mode: 0o700 });
  else if (!generations.isDirectory()) throw unsafeEntry(GENERATIONS);
  const log = await lstatOrUndefined(join(dest, LOG));
  if (log !== undefined && !log.isFile()) throw unsafeEntry(LOG);
}

async function openLog(dest) {
  const handle = await open(join(dest, LOG), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  return { write: (record) => handle.write(`${JSON.stringify(record)}\n`), close: () => handle.close() };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const heldLocks = new Set();

/**
 * One backup at a time. The lock appears with its owner already written (link
 * is atomic), and a lock left by a dead process is never taken over: two runs
 * removing the same stale lock could both believe they hold it.
 */
async function withLock(dest, action) {
  const lockPath = join(dest, LOCK);
  const pending = join(dest, `.lock-pending-${randomBytes(4).toString('hex')}`);
  await writeFile(pending, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    await link(pending, lockPath);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10);
    if (Number.isInteger(owner) && !processIsAlive(owner)) {
      throw new BackupError('LOCK_STALE', `A backup run (process ${owner}) ended without releasing the lock. Remove the .lock file in the backup directory.`);
    }
    throw new BackupError('LOCKED', 'Another backup run holds the lock.');
  } finally {
    await rm(pending, { force: true });
  }
  heldLocks.add(lockPath);
  try {
    return await action();
  } finally {
    heldLocks.delete(lockPath);
    await rm(lockPath, { force: true });
  }
}

async function removeStagingLeftovers(dest) {
  for (const name of await readdir(dest)) {
    if (name.startsWith(STAGING_PREFIX)) await rm(join(dest, name), { recursive: true, force: true });
  }
}

function damaged(reason, path) {
  return new BackupError('GENERATION_DAMAGED', `The generation is damaged (${reason}).`, path);
}

function isMode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0o7777;
}

/**
 * Parse a manifest and reject anything that could send a reader outside the
 * tree it describes: every path is relative and normalized, and its parent is
 * a directory the manifest listed earlier.
 */
function parseManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw damaged('manifest is not JSON', MANIFEST);
  }
  if (manifest?.version !== 1 || !GENERATION_NAME.test(manifest.generation) || typeof manifest.source !== 'string'
    || !isAbsolute(manifest.source) || !Array.isArray(manifest.targets) || !Array.isArray(manifest.entries)) {
    throw damaged('manifest is malformed', MANIFEST);
  }
  for (const target of manifest.targets) {
    if (typeof target?.name !== 'string' || !['copied', 'link', 'empty', 'absent'].includes(target.status)
      || !['config', 'managed-provider'].includes(target.kind)) throw damaged('manifest is malformed', MANIFEST);
  }
  const directories = new Set(['.']);
  const seen = new Set();
  for (const entry of manifest.entries) {
    const path = entry?.path;
    // The parent rule also rejects absolute paths: their parent is never a listed directory.
    const validPath = typeof path === 'string' && !path.includes('\0')
      && path.split(sep).every((segment) => segment !== '' && segment !== '.' && segment !== '..')
      && directories.has(dirname(path)) && !seen.has(path);
    const validShape = (entry?.type === 'directory' && isMode(entry.mode))
      || (entry?.type === 'link' && typeof entry.target === 'string' && entry.target !== '')
      || (entry?.type === 'file' && isMode(entry.mode) && Number.isInteger(entry.size) && entry.size >= 0 && /^[a-f0-9]{64}$/u.test(entry.sha256));
    if (!validPath || !validShape) throw damaged('manifest is malformed', MANIFEST);
    seen.add(path);
    if (entry.type === 'directory') directories.add(path);
  }
  return manifest;
}

/** Published generation names, oldest first. Links and stray files in `generations` are not generations. */
export async function listGenerations(dest) {
  if (!await isRealDirectory(join(dest, GENERATIONS))) return [];
  const names = [];
  for (const name of (await readdir(join(dest, GENERATIONS))).sort()) {
    if (GENERATION_NAME.test(name) && await isRealDirectory(join(dest, GENERATIONS, name))) names.push(name);
  }
  return names;
}

async function latestGeneration(dest) {
  const target = (await lstatOrUndefined(join(dest, LATEST)))?.isSymbolicLink() ? await readlink(join(dest, LATEST)) : undefined;
  return target !== undefined && dirname(target) === GENERATIONS && GENERATION_NAME.test(basename(target)) ? basename(target) : undefined;
}

/** Open a generation by name, or the one `latest` points at. */
async function openGeneration(dest, generation) {
  const name = generation ?? await latestGeneration(dest);
  const directory = join(dest, GENERATIONS, String(name));
  if (name === undefined || !GENERATION_NAME.test(name) || !await isRealDirectory(join(dest, GENERATIONS)) || !await isRealDirectory(directory)) {
    throw new BackupError('GENERATION_MISSING', 'No such generation in the backup directory.');
  }
  if (!(await lstatOrUndefined(join(directory, MANIFEST)))?.isFile()) throw damaged('manifest is missing', MANIFEST);
  const manifest = parseManifest(await readFile(join(directory, MANIFEST), 'utf8'));
  if (manifest.generation !== name) throw damaged('manifest belongs to another generation', MANIFEST);
  return { name, directory, manifest };
}

function generationName(now) {
  return `${now.toISOString().replace(/[-:]/gu, '').slice(0, 15)}Z`;
}

/** Directories stay writable by the owner inside a generation so that it can be removed. */
function storedDirectoryMode(mode) {
  return mode | 0o700;
}

/**
 * Copy one tree entry into the staged generation and record it.
 * Symbolic links are copied as links and never followed.
 */
async function copyEntry(context, relativePath) {
  const sourcePath = join(context.source, relativePath);
  const stagedPath = join(context.data, relativePath);
  const before = await lstat(sourcePath);
  const mode = before.mode & 0o7777;
  if (before.isSymbolicLink()) {
    const target = await readlink(sourcePath);
    await symlink(target, stagedPath);
    if (!isInsideOrEqual(context.realSource, resolve(dirname(join(context.realSource, relativePath)), target))) context.totals.externalLinks += 1;
    context.entries.push({ path: relativePath, type: 'link', target });
    return;
  }
  if (before.isDirectory()) {
    await mkdir(stagedPath, { mode: 0o700 });
    context.entries.push({ path: relativePath, type: 'directory', mode });
    for (const name of (await readdir(sourcePath)).sort()) await copyEntry(context, join(relativePath, name));
    await chmod(stagedPath, storedDirectoryMode(mode));
    return;
  }
  if (!before.isFile()) throw new BackupError('UNSUPPORTED_FILE', 'A backup target holds something that is not a file, directory, or link.', relativePath);
  await copyFile(sourcePath, stagedPath, constants.COPYFILE_EXCL);
  await chmod(stagedPath, mode);
  const sha256 = await hashFile(sourcePath);
  if (await hashFile(stagedPath) !== sha256) throw new BackupError('COPY_MISMATCH', 'A copied file does not match its source.', relativePath);
  const after = await lstat(sourcePath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new BackupError('SOURCE_CHANGED', 'A file changed while it was being copied.', relativePath);
  }
  context.entries.push({ path: relativePath, type: 'file', mode, size: before.size, sha256 });
  context.totals.files += 1;
  context.totals.bytes += before.size;
}

/** `copied` means the generation holds at least one file of the target. */
async function copyTarget(context, name, kind, copy) {
  const filesBefore = context.totals.files;
  const entriesBefore = context.entries.length;
  const extra = await copy();
  if (extra === undefined) return { name, kind, status: 'absent', files: 0 };
  const files = context.totals.files - filesBefore;
  const status = files > 0 ? 'copied' : (context.entries[entriesBefore]?.type === 'link' ? 'link' : 'empty');
  return { name, kind, status, files, ...extra };
}

async function copyConfigTarget(context, name) {
  if (await lstatOrUndefined(join(context.source, name)) === undefined) return undefined;
  await copyEntry(context, name);
  return {};
}

/** Copy the `sdk` link and the one generation it names; staging and superseded generations stay behind. */
async function copyManagedProvider(context, name) {
  const linkPath = join(context.source, name, 'sdk');
  const linkStats = await lstatOrUndefined(linkPath);
  if (linkStats === undefined) return undefined;
  const current = linkStats.isSymbolicLink() ? await readlink(linkPath) : undefined;
  if (current === undefined || !MANAGED_GENERATION_NAME.test(current)
    || !(await lstatOrUndefined(join(context.source, name, current)))?.isDirectory()) {
    throw new BackupError('MANAGED_PROVIDER_BROKEN', 'The managed provider has no usable current generation.', join(name, 'sdk'));
  }
  const rootMode = (await lstat(join(context.source, name))).mode & 0o7777;
  await mkdir(join(context.data, name), { mode: storedDirectoryMode(rootMode) });
  context.entries.push({ path: name, type: 'directory', mode: rootMode });
  await copyEntry(context, join(name, current));
  await copyEntry(context, join(name, 'sdk'));
  if (await readlink(linkPath).catch(() => undefined) !== current) {
    throw new BackupError('SOURCE_CHANGED', 'The managed provider was reinstalled while it was being copied.', join(name, 'sdk'));
  }
  return { generation: current };
}

async function pointLatestAt(dest, name) {
  const pending = join(dest, `${STAGING_PREFIX}latest-${randomBytes(4).toString('hex')}`);
  await symlink(join(GENERATIONS, name), pending);
  await rename(pending, join(dest, LATEST));
}

/** Stage, check, and publish one generation. Runs under the lock. */
async function createGeneration({ source, dest, keep, acceptRemoved, name, startedAt, log }) {
  await removeStagingLeftovers(dest);
  if (!await isRealDirectory(await realpathOfMaybeMissing(source))) throw new BackupError('SOURCE_MISSING', 'The TAKT config directory does not exist.');
  const published = await listGenerations(dest);
  if (published.includes(name)) throw new BackupError('GENERATION_EXISTS', 'A generation with this timestamp already exists.');
  const previousName = published.at(-1);
  const previous = previousName === undefined ? undefined : (await openGeneration(dest, previousName)).manifest;
  const staging = join(dest, `${STAGING_PREFIX}${name}-${randomBytes(4).toString('hex')}`);
  const final = join(dest, GENERATIONS, name);
  try {
    await mkdir(staging, { mode: 0o700 });
    const context = {
      source,
      realSource: await realpath(source),
      data: join(staging, DATA),
      entries: [],
      totals: { files: 0, bytes: 0, externalLinks: 0 },
    };
    await mkdir(context.data, { mode: 0o700 });
    const targets = [];
    for (const target of CONFIG_TARGETS) targets.push(await copyTarget(context, target, 'config', () => copyConfigTarget(context, target)));
    for (const target of MANAGED_PROVIDER_TARGETS) targets.push(await copyTarget(context, target, 'managed-provider', () => copyManagedProvider(context, target)));
    const copied = new Set(targets.filter((target) => target.status === 'copied').map((target) => target.name));
    if (copied.size === 0) throw new BackupError('NOTHING_TO_COPY', 'The TAKT config directory holds no file of any backup target.');
    const lost = (previous?.targets ?? []).filter((target) => target.status === 'copied' && !copied.has(target.name)).map((target) => target.name);
    if (lost.length > 0 && !acceptRemoved) {
      throw new BackupError('TARGET_DISAPPEARED', `Held files in the previous generation but holds none now: ${lost.join(', ')}. Pass --accept-removed if this is intended.`);
    }
    const manifest = { version: 1, generation: name, createdAt: startedAt, source: context.realSource, targets, totals: context.totals, entries: context.entries };
    await writeFile(join(staging, MANIFEST), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    const pruned = [...published, name].slice(0, -keep);
    const summary = { generation: name, targets, totals: context.totals, pruned };

    await rename(staging, final);
    try {
      await pointLatestAt(dest, name);
      await log.write({ time: startedAt, action: 'backup', source, result: 'ok', ...summary });
    } catch (error) {
      // Not published after all: take the generation back so that the earlier one stays the newest.
      if (previousName === undefined) await rm(join(dest, LATEST), { force: true }).catch(() => {});
      else await pointLatestAt(dest, previousName).catch(() => {});
      await rename(final, staging).catch(() => {});
      throw error;
    }
    try {
      for (const old of pruned) {
        const doomed = join(dest, `${STAGING_PREFIX}pruned-${old}`);
        await rename(join(dest, GENERATIONS, old), doomed);
        await rm(doomed, { recursive: true, force: true });
      }
    } catch (error) {
      throw new BackupError('PRUNE_FAILED', `Generation ${name} is published, but an older generation could not be removed (${describeFailure(error).code}).`);
    }
    return summary;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Create one generation.
 *
 * @returns the published generation's summary. Throws without publishing when anything fails.
 */
export async function backupSharedTakt({ source, dest, keep = DEFAULT_KEEP, acceptRemoved = false, now = new Date(), openLogFile = openLog }) {
  if (!Number.isInteger(keep) || keep < 1) throw new BackupError('INVALID_KEEP', '--keep must be a whole number of at least 1.');
  await prepareBackupRoot(source, dest);
  const log = await openLogFile(dest);
  const name = generationName(now);
  const startedAt = now.toISOString();
  try {
    return await withLock(dest, () => createGeneration({ source, dest, keep, acceptRemoved, name, startedAt, log }));
  } catch (error) {
    await log.write({ time: startedAt, action: 'backup', source, result: 'failed', generation: name, error: describeFailure(error) }).catch(() => {});
    throw error;
  } finally {
    await log.close();
  }
}

/** Compare one manifest entry with what is on disk under `root`. Returns the difference, if any. */
async function entryDifference(root, entry, directoryMode) {
  const stats = await lstatOrUndefined(join(root, entry.path));
  if (stats === undefined) return 'missing';
  const mode = stats.mode & 0o7777;
  if (entry.type === 'directory') {
    if (!stats.isDirectory()) return 'not a directory';
    return mode === directoryMode(entry.mode) ? undefined : 'mode changed';
  }
  if (entry.type === 'link') return stats.isSymbolicLink() && await readlink(join(root, entry.path)) === entry.target ? undefined : 'link changed';
  if (!stats.isFile() || stats.size !== entry.size) return 'size changed';
  if (mode !== entry.mode) return 'mode changed';
  return await hashFile(join(root, entry.path)) === entry.sha256 ? undefined : 'content changed';
}

async function openVerifiedGeneration(dest, generation) {
  const opened = await openGeneration(dest, generation);
  if (!await isRealDirectory(join(opened.directory, DATA))) throw damaged('data is missing', DATA);
  for (const entry of opened.manifest.entries) {
    const difference = await entryDifference(join(opened.directory, DATA), entry, storedDirectoryMode);
    if (difference !== undefined) throw damaged(difference, entry.path);
  }
  return opened;
}

function summaryOf({ name, manifest }) {
  return { generation: name, targets: manifest.targets, totals: manifest.totals };
}

/** Compare a generation with its manifest: contents, sizes, and modes. Throws on the first difference. */
export async function verifyGeneration({ dest, generation }) {
  return summaryOf(await openVerifiedGeneration(dest, generation));
}

/** Refuse a directory this tool would write to, or let TAKT write to, when it touches a config directory in use. */
async function assertIsolated(directory, protectedDirectories) {
  for (const protectedDirectory of protectedDirectories) {
    if (await overlaps(directory, protectedDirectory)) {
      throw new BackupError('NOT_ISOLATED', 'The directory overlaps the TAKT config directory or the backup directory. Use a separate, new directory.');
    }
  }
}

/**
 * Copy a verified generation into a directory that does not exist yet.
 * The target may not overlap the config directory the generation came from,
 * the config directory in use, or the backup directory: putting a restored
 * directory in place is the operator's step, done by renaming it.
 */
export async function restoreGeneration({ dest, generation, to, env = process.env }) {
  const opened = await openGeneration(dest, generation);
  await assertIsolated(to, [opened.manifest.source, liveConfigDirectory(env), dest]);
  if (await lstatOrUndefined(to) !== undefined) throw new BackupError('RESTORE_TARGET_EXISTS', 'The restore target already exists. Name a directory that does not exist yet.');
  const { directory, manifest } = await openVerifiedGeneration(dest, opened.name);
  await mkdir(to, { mode: 0o700 });
  for (const entry of manifest.entries) {
    const target = join(to, entry.path);
    if (entry.type === 'directory') await mkdir(target, { mode: 0o700 });
    else if (entry.type === 'link') await symlink(entry.target, target);
    else {
      await copyFile(join(directory, DATA, entry.path), target, constants.COPYFILE_EXCL);
      await chmod(target, entry.mode);
      if (await hashFile(target) !== entry.sha256) throw new BackupError('COPY_MISMATCH', 'A restored file does not match the generation.', entry.path);
    }
  }
  for (const entry of manifest.entries.filter((candidate) => candidate.type === 'directory').reverse()) {
    await chmod(join(to, entry.path), entry.mode);
  }
  return summaryOf(opened);
}

async function importBuiltTakt(taktRoot) {
  const load = (path) => import(pathToFileURL(join(taktRoot, 'dist', path)).href);
  try {
    const [config, loader] = await Promise.all([load('infra/config/global/globalConfigCore.js'), load('infra/managed-providers/loader.js')]);
    return {
      loadConfig: () => { config.loadGlobalConfig(); },
      inspectProvider: (provider) => loader.inspectProviderInstallation(provider),
    };
  } catch (error) {
    throw new BackupError('TAKT_NOT_BUILT', `Could not load a built TAKT (dist/) from the --takt directory (${describeFailure(error).code}).`);
  }
}

/**
 * Check a restored directory against the generation it came from: every entry
 * of the manifest is there unchanged, the configuration loads, and each managed
 * provider the generation holds passes TAKT's own inspection, with
 * TAKT_CONFIG_DIR pointing at the restored directory.
 */
export async function checkRestoredConfigDirectory({ dest, generation, configDirectory, taktRoot, env = process.env, importTakt = importBuiltTakt }) {
  if (!await isRealDirectory(configDirectory)) throw new BackupError('CONFIG_DIR_MISSING', 'The directory to check does not exist.');
  const { name, manifest } = await openGeneration(dest, generation);
  // TAKT's inspection may repair what it inspects, so it must not be pointed at a config directory in use.
  await assertIsolated(configDirectory, [manifest.source, liveConfigDirectory(env), dest]);
  const result = { generation: name, restored: 'complete', config: 'absent', providers: {} };
  for (const entry of manifest.entries) {
    const difference = await entryDifference(configDirectory, entry, (mode) => mode);
    if (difference !== undefined) {
      result.restored = `differs from the generation (${entry.path}: ${difference})`;
      break;
    }
  }
  const held = (targetName) => manifest.targets.some((target) => target.name === targetName && target.status === 'copied');
  const previous = process.env.TAKT_CONFIG_DIR;
  process.env.TAKT_CONFIG_DIR = await realpath(configDirectory);
  try {
    const takt = await importTakt(taktRoot);
    if (held('config.yaml')) {
      try {
        takt.loadConfig();
        result.config = 'readable';
      } catch (error) {
        // TAKT's own message can quote configuration values, so only the kind of failure is reported.
        result.config = `unreadable (${describeFailure(error).code})`;
      }
    }
    for (const provider of manifest.targets.filter((target) => target.kind === 'managed-provider')) {
      result.providers[provider.name] = held(provider.name) ? (await takt.inspectProvider(provider.name)).state : 'absent';
    }
  } finally {
    if (previous === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previous;
  }
  result.ok = result.restored === 'complete' && !result.config.startsWith('unreadable') && !Object.values(result.providers).includes('missing');
  return result;
}

const USAGE = `Usage:
  shared-takt-backup.mjs backup  --dest <dir> [--source <dir>] [--keep <n>] [--accept-removed]
  shared-takt-backup.mjs verify  --dest <dir> [--generation <name>]
  shared-takt-backup.mjs restore --dest <dir> --to <new dir> [--generation <name>]
  shared-takt-backup.mjs check   --dest <dir> --config-dir <restored dir> [--generation <name>] [--takt <built TAKT checkout>]

--source defaults to TAKT_CONFIG_DIR, then ~/.takt. --generation defaults to the one "latest" points at.
`;

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--accept-removed') options.acceptRemoved = true;
    else if (['--source', '--dest', '--keep', '--generation', '--to', '--config-dir', '--takt'].includes(flag) && rest[index + 1] !== undefined) {
      options[flag.slice(2)] = rest[index += 1];
    } else throw new BackupError('USAGE', `Unknown or incomplete argument: ${flag}`);
  }
  return { command, options };
}

function required(options, flag) {
  if (options[flag] === undefined) throw new BackupError('USAGE', `--${flag} is required.`);
  return options[flag];
}

function summaryLine(action, summary) {
  const targets = summary.targets.filter((target) => target.status === 'copied').map((target) => target.name).join(',');
  return `${action} ok generation=${summary.generation} files=${summary.totals.files} bytes=${summary.totals.bytes} targets=${targets}\n`;
}

/** Run the command line. Returns the process exit code. */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, now = () => new Date() } = {}) {
  let command;
  try {
    const parsed = parseArguments(argv);
    command = parsed.command;
    const { options } = parsed;
    if (command === 'backup') {
      const summary = await backupSharedTakt({
        source: options.source === undefined ? liveConfigDirectory(env) : resolve(options.source),
        dest: resolve(required(options, 'dest')),
        keep: options.keep === undefined ? DEFAULT_KEEP : Number(options.keep),
        acceptRemoved: options.acceptRemoved === true,
        now: now(),
      });
      stdout.write(summaryLine('backup', summary));
      const unsaved = summary.targets.filter((target) => target.status === 'link' || target.status === 'empty').map((target) => `${target.name} (${target.status})`);
      if (unsaved.length > 0) stdout.write(`note: no file was saved for ${unsaved.join(', ')}\n`);
      if (summary.totals.externalLinks > 0) stdout.write(`note: ${summary.totals.externalLinks} symbolic link(s) point outside the config directory; their targets are not in the backup\n`);
      return 0;
    }
    if (command === 'verify') {
      stdout.write(summaryLine('verify', await verifyGeneration({ dest: resolve(required(options, 'dest')), generation: options.generation })));
      return 0;
    }
    if (command === 'restore') {
      const summary = await restoreGeneration({ dest: resolve(required(options, 'dest')), generation: options.generation, to: resolve(required(options, 'to')), env });
      stdout.write(summaryLine('restore', summary));
      return 0;
    }
    if (command === 'check') {
      const result = await checkRestoredConfigDirectory({
        dest: resolve(required(options, 'dest')),
        generation: options.generation,
        configDirectory: resolve(required(options, 'config-dir')),
        taktRoot: resolve(options.takt ?? fileURLToPath(new URL('..', import.meta.url))),
        env,
      });
      stdout.write(`generation: ${result.generation}\nrestored: ${result.restored}\nconfig: ${result.config}\n`);
      for (const [provider, state] of Object.entries(result.providers)) stdout.write(`${provider}: ${state}\n`);
      stdout.write(`check ${result.ok ? 'ok' : 'failed'}\n`);
      return result.ok ? 0 : 1;
    }
    stderr.write(USAGE);
    return 2;
  } catch (error) {
    const failure = describeFailure(error);
    stderr.write(`${command ?? 'shared-takt-backup'} failed: ${failure.code}${failure.message === undefined ? '' : ` ${failure.message}`}${failure.path === undefined ? '' : ` (${failure.path})`}\n`);
    if (failure.code === 'USAGE') stderr.write(USAGE);
    return failure.code === 'USAGE' ? 2 : 1;
  }
}

// realpath: a daily job may start this file through a link (such as ~/local/takt-custom), and must not exit silently.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => {
      for (const lockPath of heldLocks) rmSync(lockPath, { force: true });
      process.exit(status);
    });
  }
  process.exitCode = await main(process.argv.slice(2));
}

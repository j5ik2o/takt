#!/usr/bin/env node
/**
 * Daily copy of the shared TAKT configuration and managed providers.
 *
 * Fork-only operations tool; see docs/shared-takt-backup.md.
 *
 *   backup   copy the configuration and the current managed provider generations
 *            into a new generation under a private directory outside the source
 *   verify   compare a generation with its manifest (contents, sizes, modes)
 *
 * Restoring is a manual procedure in the document above; this tool never
 * writes anywhere but the backup directory.
 *
 * Rules the code below keeps:
 *   - The config directory is only read. Every write goes under the backup
 *     directory, which may not overlap any TAKT config directory.
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
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const UNPUBLISHED_PREFIX = '.unpublished-';
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

/**
 * The spelling under which two paths are compared. macOS and Windows volumes usually ignore case, and the part
 * of a path that does not exist yet has no spelling on disk to resolve to, so `.TAKT` must count as `.takt`.
 */
function comparable(path) {
  return ['darwin', 'win32'].includes(process.platform) ? path.normalize('NFC').toLowerCase() : path;
}

async function overlaps(first, second) {
  const [realFirst, realSecond] = [comparable(await realpathOfMaybeMissing(first)), comparable(await realpathOfMaybeMissing(second))];
  return isInsideOrEqual(realFirst, realSecond) || isInsideOrEqual(realSecond, realFirst);
}

function liveConfigDirectory(env) {
  return resolve(env.TAKT_CONFIG_DIR || join(homedir(), '.takt'));
}

/** Every place a TAKT config directory can be, whichever one this run copies. */
function knownConfigDirectories(env) {
  const directories = [join(homedir(), '.takt')];
  if (env.TAKT_CONFIG_DIR) directories.push(resolve(env.TAKT_CONFIG_DIR));
  try {
    directories.push(join(userInfo().homedir, '.takt'));
  } catch {
    // No account database entry (some containers): HOME is all there is.
  }
  return directories;
}

function unsafeEntry(name) {
  return new BackupError('DEST_UNSAFE', 'An entry of the backup directory is not what this tool creates there.', name);
}

/**
 * Make sure every path a run writes under the backup directory is what it
 * seems: the root and `generations` are real private directories, and the log
 * is a regular file of its own. A link in any of these places could lead back
 * into the config directory, and so could the config directory in use when
 * `--source` names another one.
 */
async function prepareBackupRoot(source, dest, env) {
  for (const configDirectory of [source, ...knownConfigDirectories(env)]) {
    if (await overlaps(configDirectory, dest)) {
      throw new BackupError('DEST_OVERLAPS_SOURCE', 'The backup directory must not contain, or lie inside, a TAKT config directory: the one being copied, TAKT_CONFIG_DIR, or ~/.takt.');
    }
  }
  if (comparable(await realpathOfMaybeMissing(dest)) !== comparable(resolve(dest))) {
    throw new BackupError('DEST_IS_LINK', 'The backup directory path passes through a symbolic link. Name the real path.');
  }
  if (await lstatOrUndefined(dest) === undefined) await mkdir(dest, { recursive: true, mode: 0o700 });
  const root = await lstat(dest);
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

/** The log is checked on the open handle: a hard link to a file elsewhere passes every check made by path. */
async function openLog(dest) {
  const handle = await open(join(dest, LOG), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const stats = await handle.stat();
  if (!stats.isFile() || stats.nlink !== 1) {
    await handle.close();
    throw unsafeEntry(LOG);
  }
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

/**
 * Remove what an interrupted or failed run left behind: staging directories, and a generation that reached
 * `generations` without `latest` ever pointing at it. Such a generation is named by a marker written before it
 * moved there, so it is never counted among the published ones.
 */
async function removeLeftovers(dest) {
  const latest = await latestGeneration(dest);
  for (const name of await readdir(dest)) {
    if (name.startsWith(STAGING_PREFIX)) await rm(join(dest, name), { recursive: true, force: true });
    if (name.startsWith(UNPUBLISHED_PREFIX)) {
      const generation = name.slice(UNPUBLISHED_PREFIX.length);
      if (GENERATION_NAME.test(generation) && generation !== latest) await rm(join(dest, GENERATIONS, generation), { recursive: true, force: true });
      await rm(join(dest, name), { force: true });
    }
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
    if (typeof target?.name !== 'string' || !['copied', 'empty', 'absent'].includes(target.status)
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
 * Whether a link under `root` ends up, when the OS follows it, inside the backup target (the first path segment)
 * it belongs to. The answer comes from resolving the link, not from its text: `..` after a linked directory
 * leads somewhere else than the text suggests. A link kept by this rule resolves the same way in any copy of the
 * tree; any other link would make a copy read or write a file that is not in the backup.
 */
async function linkStaysInTarget(root, relativePath, target) {
  const targetRoot = relativePath.split(sep)[0];
  if (isAbsolute(target)) return false;
  try {
    return isInsideOrEqual(join(await realpath(root), targetRoot), await realpath(join(root, relativePath)));
  } catch {
    return false;
  }
}

/**
 * Copy one tree entry into the staged generation and record it.
 * Symbolic links are copied as links and never followed; one that leaves its backup target fails the run.
 */
async function copyEntry(context, relativePath) {
  const sourcePath = join(context.source, relativePath);
  const stagedPath = join(context.data, relativePath);
  const before = await lstat(sourcePath);
  const mode = before.mode & 0o7777;
  if (before.isSymbolicLink()) {
    const target = await readlink(sourcePath);
    await symlink(target, stagedPath);
    if (!await linkStaysInTarget(context.source, relativePath, target)) {
      throw new BackupError('EXTERNAL_LINK', 'A symbolic link does not resolve inside the backup target it is in. Replace it with the files themselves.', relativePath);
    }
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
  const extra = await copy();
  if (extra === undefined) return { name, kind, status: 'absent', files: 0 };
  const files = context.totals.files - filesBefore;
  const status = files > 0 ? 'copied' : 'empty';
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
  await mkdir(join(context.data, name), { mode: 0o700 });
  context.entries.push({ path: name, type: 'directory', mode: rootMode });
  await copyEntry(context, join(name, current));
  await copyEntry(context, join(name, 'sdk'));
  if (await readlink(linkPath).catch(() => undefined) !== current) {
    throw new BackupError('SOURCE_CHANGED', 'The managed provider was reinstalled while it was being copied.', join(name, 'sdk'));
  }
  await chmod(join(context.data, name), storedDirectoryMode(rootMode));
  return { generation: current };
}

/** Stage, check, and publish one generation. Runs under the lock. */
async function createGeneration({ source, dest, keep, acceptRemoved, name, startedAt, log, readBack }) {
  await removeLeftovers(dest);
  if (!await isRealDirectory(await realpathOfMaybeMissing(source))) throw new BackupError('SOURCE_MISSING', 'The TAKT config directory does not exist.');
  const published = await listGenerations(dest);
  if (published.includes(name)) throw new BackupError('GENERATION_EXISTS', 'A generation with this timestamp already exists.');
  // The generation this run must not make worse: the one `latest` pointed at when the run began.
  const latestBefore = await latestGeneration(dest);
  const previousName = latestBefore !== undefined && published.includes(latestBefore) ? latestBefore : published.at(-1);
  const previous = previousName === undefined ? undefined : (await openGeneration(dest, previousName)).manifest;
  const staging = join(dest, `${STAGING_PREFIX}${name}-${randomBytes(4).toString('hex')}`);
  const final = join(dest, GENERATIONS, name);
  try {
    await mkdir(staging, { mode: 0o700 });
    const context = {
      source,
      data: join(staging, DATA),
      entries: [],
      totals: { files: 0, bytes: 0 },
    };
    await mkdir(context.data, { mode: 0o700 });
    const targets = [];
    for (const target of CONFIG_TARGETS) targets.push(await copyTarget(context, target, 'config', () => copyConfigTarget(context, target)));
    for (const target of MANAGED_PROVIDER_TARGETS) targets.push(await copyTarget(context, target, 'managed-provider', () => copyManagedProvider(context, target)));
    const copied = new Set(targets.filter((target) => target.status === 'copied').map((target) => target.name));
    if (copied.size === 0) throw new BackupError('NOTHING_TO_COPY', 'The TAKT config directory holds no file of any backup target.');
    const config = context.entries.find((entry) => entry.path === 'config.yaml');
    if (config?.type !== 'file' || config.size === 0) throw new BackupError('CONFIG_MISSING', 'The TAKT config directory has no config.yaml that is a file with content.');
    const lost = (previous?.targets ?? []).filter((target) => target.status === 'copied' && !copied.has(target.name)).map((target) => target.name);
    if (lost.length > 0 && !acceptRemoved) {
      throw new BackupError('TARGET_DISAPPEARED', `Held files in the previous generation but holds none now: ${lost.join(', ')}. Pass --accept-removed if this is intended.`);
    }
    const previousSizes = new Map((previous?.entries ?? []).filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry.size]));
    const emptied = context.entries.find((entry) => entry.type === 'file' && entry.size === 0 && previousSizes.get(entry.path) > 0);
    if (emptied !== undefined && !acceptRemoved) {
      throw new BackupError('FILE_EMPTIED', 'A file that held content is empty now. Pass --accept-removed if this is intended.', emptied.path);
    }
    const manifest = { version: 1, generation: name, createdAt: startedAt, source: await realpath(source), targets, totals: context.totals, entries: context.entries };
    await writeFile(join(staging, MANIFEST), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    // What is about to be published must pass the same check a later verify runs, or it replaces nothing.
    await verifyTree(context.data, parseManifest(await readBack(join(staging, MANIFEST), 'utf8')).entries);
    const pruned = published.slice(0, Math.max(0, published.length + 1 - keep));
    const summary = { generation: name, targets, totals: context.totals, pruned };

    // The link is made before the generation is published, so that pointing latest at it is one rename.
    // If that rename fails, latest still names what it named before, and the generation is removed.
    const pendingLatest = join(dest, `${STAGING_PREFIX}latest-${randomBytes(4).toString('hex')}`);
    await symlink(join(GENERATIONS, name), pendingLatest);
    await writeFile(join(dest, `${UNPUBLISHED_PREFIX}${name}`), '', { flag: 'wx', mode: 0o600 });
    try {
      await rename(staging, final);
      await rename(pendingLatest, join(dest, LATEST));
    } catch (error) {
      // Still unpublished: remove it now, or leave the marker for the next run to do so.
      await removeLeftovers(dest).catch(() => {});
      throw error;
    }
    await rm(join(dest, `${UNPUBLISHED_PREFIX}${name}`), { force: true });
    try {
      await log.write({ time: startedAt, action: 'backup', source, result: 'ok', ...summary });
    } catch (error) {
      throw new BackupError('LOG_FAILED', `Generation ${name} is published, but the log could not be written (${describeFailure(error).code}). No older generation was removed.`);
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
export async function backupSharedTakt({ source, dest, keep = DEFAULT_KEEP, acceptRemoved = false, now = new Date(), env = process.env, openLogFile = openLog, readBack = readFile }) {
  if (!Number.isInteger(keep) || keep < 1) throw new BackupError('INVALID_KEEP', '--keep must be a whole number of at least 1.');
  await prepareBackupRoot(source, dest, env);
  const log = await openLogFile(dest);
  const name = generationName(now);
  const startedAt = now.toISOString();
  try {
    return await withLock(dest, () => createGeneration({ source, dest, keep, acceptRemoved, name, startedAt, log, readBack }));
  } catch (error) {
    await log.write({ time: startedAt, action: 'backup', source, result: 'failed', generation: name, error: describeFailure(error) }).catch(() => {});
    throw error;
  } finally {
    await log.close();
  }
}

/** The tree under `root` is exactly what the manifest lists: nothing changed, nothing missing, nothing added. */
async function verifyTree(root, entries) {
  for (const entry of entries) {
    const difference = await entryDifference(root, entry);
    if (difference !== undefined) throw damaged(difference, entry.path);
  }
  const listed = new Set(entries.map((entry) => entry.path));
  const walk = async (relativePath) => {
    for (const name of await readdir(join(root, relativePath))) {
      const path = join(relativePath, name);
      if (!listed.has(path)) throw damaged('not in the manifest', path);
      if ((await lstat(join(root, path))).isDirectory()) await walk(path);
    }
  };
  await walk('');
}

/** Compare one manifest entry with what is on disk under `root`. Returns the difference, if any. */
async function entryDifference(root, entry) {
  const stats = await lstatOrUndefined(join(root, entry.path));
  if (stats === undefined) return 'missing';
  const mode = stats.mode & 0o7777;
  if (entry.type === 'directory') {
    if (!stats.isDirectory()) return 'not a directory';
    return mode === storedDirectoryMode(entry.mode) ? undefined : 'mode changed';
  }
  if (entry.type === 'link') {
    if (!stats.isSymbolicLink() || await readlink(join(root, entry.path)) !== entry.target) return 'link changed';
    return await linkStaysInTarget(root, entry.path, entry.target) ? undefined : 'link leaves its target';
  }
  if (!stats.isFile() || stats.size !== entry.size) return 'size changed';
  if (mode !== entry.mode) return 'mode changed';
  return await hashFile(join(root, entry.path)) === entry.sha256 ? undefined : 'content changed';
}

async function openVerifiedGeneration(dest, generation) {
  const opened = await openGeneration(dest, generation);
  if (!await isRealDirectory(join(opened.directory, DATA))) throw damaged('data is missing', DATA);
  const stray = (await readdir(opened.directory)).find((name) => name !== DATA && name !== MANIFEST);
  if (stray !== undefined) throw damaged('not in the manifest', stray);
  await verifyTree(join(opened.directory, DATA), opened.manifest.entries);
  return opened;
}

function summaryOf({ name, manifest }) {
  return { generation: name, targets: manifest.targets, totals: manifest.totals };
}

/** Compare a generation with its manifest: contents, sizes, and modes. Throws on the first difference. */
export async function verifyGeneration({ dest, generation }) {
  return summaryOf(await openVerifiedGeneration(dest, generation));
}

const USAGE = `Usage:
  shared-takt-backup.mjs backup  --dest <dir> [--source <dir>] [--keep <n>] [--accept-removed]
  shared-takt-backup.mjs verify  --dest <dir> [--generation <name>]

--source defaults to TAKT_CONFIG_DIR, then ~/.takt. --generation defaults to the one "latest" points at.
`;

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--accept-removed') options.acceptRemoved = true;
    else if (['--source', '--dest', '--keep', '--generation'].includes(flag) && rest[index + 1] !== undefined) {
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
        env,
      });
      stdout.write(summaryLine('backup', summary));
      const empty = summary.targets.filter((target) => target.status === 'empty').map((target) => target.name);
      if (empty.length > 0) stdout.write(`note: no file was saved for ${empty.join(', ')} (empty)\n`);
      return 0;
    }
    if (command === 'verify') {
      stdout.write(summaryLine('verify', await verifyGeneration({ dest: resolve(required(options, 'dest')), generation: options.generation })));
      return 0;
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

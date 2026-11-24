#!/usr/bin/env node
/**
 * Daily copy of the shared TAKT configuration and managed providers.
 *
 * Fork-only operations tool; see docs/shared-takt-backup.md.
 *
 *   backup   copy the configuration and the current managed provider generations
 *            into a new generation under a private directory outside the source
 *   verify   re-hash a generation against its manifest
 *   restore  copy a verified generation into an empty directory
 *   check    load the configuration and inspect the managed providers of a
 *            restored directory with a built TAKT
 *
 * A generation is staged next to the published ones and renamed into place only
 * after every copied file matches its hash, so a failed run leaves the earlier
 * generations as they were. Output and the log name targets, generations, and
 * results only: never file contents, and never the message of an unexpected error.
 *
 * POSIX only (macOS, Linux): the managed provider link is read as a relative
 * symbolic link, which is not how TAKT publishes it on Windows.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import {
  appendFile, chmod, copyFile, link, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile,
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

/** What may be logged about a failure: a code and a path, never the message of an error this tool did not raise. */
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

function hashFile(path) {
  return new Promise((resolvePromise, reject) => {
    const digest = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (chunk) => digest.update(chunk))
      .on('end', () => resolvePromise(digest.digest('hex')));
  });
}

/** Resolve a path that may not exist yet through its nearest existing ancestor. */
async function realpathOfMaybeMissing(path) {
  const absolute = resolve(path);
  const missing = [];
  let current = absolute;
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

async function assertSeparate(source, dest) {
  const [realSource, realDest] = [await realpath(source), await realpathOfMaybeMissing(dest)];
  if (isInsideOrEqual(realSource, realDest) || isInsideOrEqual(realDest, realSource)) {
    throw new BackupError('DEST_OVERLAPS_SOURCE', 'The backup directory and the TAKT config directory must not contain each other.');
  }
}

/** Create the backup directory for its owner only, or refuse one that others can read. */
async function preparePrivateDirectory(dest) {
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const stats = await lstat(await realpath(dest));
  if (!stats.isDirectory()) throw new BackupError('DEST_NOT_DIRECTORY', 'The backup path is not a directory.');
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new BackupError('DEST_NOT_OWNED', 'The backup directory belongs to another user.');
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new BackupError('DEST_NOT_PRIVATE', 'The backup directory is readable by other users. Run chmod 700 on it.');
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function withLock(dest, action) {
  const lockPath = join(dest, LOCK);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10);
      if (attempt > 0 || (Number.isInteger(owner) && processIsAlive(owner))) {
        throw new BackupError('LOCKED', 'Another backup run holds the lock.');
      }
      await rm(lockPath, { force: true });
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function removeStagingLeftovers(dest) {
  for (const name of await readdir(dest)) {
    if (name.startsWith(STAGING_PREFIX)) await rm(join(dest, name), { recursive: true, force: true });
  }
}

async function readManifest(generationDirectory) {
  return JSON.parse(await readFile(join(generationDirectory, MANIFEST), 'utf8'));
}

/** Published generation names, oldest first. */
export async function listGenerations(dest) {
  let names;
  try {
    names = await readdir(join(dest, GENERATIONS));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => GENERATION_NAME.test(name)).sort();
}

function generationName(now) {
  return `${now.toISOString().replace(/[-:]/gu, '').slice(0, 15)}Z`;
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
    await chmod(stagedPath, mode | 0o700);
    return;
  }
  if (!before.isFile()) {
    context.totals.skippedSpecial += 1;
    return;
  }
  const sha256 = await hashFile(sourcePath);
  const previous = context.previous.get(relativePath);
  let linked = false;
  if (previous !== undefined && previous.sha256 === sha256 && previous.mode === mode && previous.size === before.size) {
    try {
      await link(join(context.previousData, relativePath), stagedPath);
      linked = await hashFile(stagedPath) === sha256;
      if (!linked) await rm(stagedPath);
    } catch {
      await rm(stagedPath, { force: true });
    }
  }
  if (!linked) {
    await copyFile(sourcePath, stagedPath);
    await chmod(stagedPath, mode);
    if (await hashFile(stagedPath) !== sha256) throw new BackupError('COPY_MISMATCH', 'A copied file does not match its source.', relativePath);
  }
  const after = await lstat(sourcePath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new BackupError('SOURCE_CHANGED', 'A file changed while it was being copied.', relativePath);
  }
  context.entries.push({ path: relativePath, type: 'file', mode, size: before.size, sha256 });
  context.totals.files += 1;
  context.totals.bytes += before.size;
  if (linked) context.totals.linkedFiles += 1;
}

async function copyConfigTarget(context, name) {
  if (await lstatOrUndefined(join(context.source, name)) === undefined) return { name, kind: 'config', status: 'absent' };
  await copyEntry(context, name);
  return { name, kind: 'config', status: 'copied' };
}

/** Copy the `sdk` link and the one generation it names; staging and superseded generations stay behind. */
async function copyManagedProvider(context, name) {
  const linkPath = join(context.source, name, 'sdk');
  const linkStats = await lstatOrUndefined(linkPath);
  if (linkStats === undefined) return { name, kind: 'managed-provider', status: 'absent' };
  const current = linkStats.isSymbolicLink() ? await readlink(linkPath) : undefined;
  if (current === undefined || !MANAGED_GENERATION_NAME.test(current)
    || !(await lstatOrUndefined(join(context.source, name, current)))?.isDirectory()) {
    throw new BackupError('MANAGED_PROVIDER_BROKEN', 'The managed provider has no usable current generation.', join(name, 'sdk'));
  }
  const rootMode = (await lstat(join(context.source, name))).mode & 0o7777;
  await mkdir(join(context.data, name), { mode: rootMode | 0o700 });
  context.entries.push({ path: name, type: 'directory', mode: rootMode });
  await copyEntry(context, join(name, current));
  await copyEntry(context, join(name, 'sdk'));
  if (await readlink(linkPath).catch(() => undefined) !== current) {
    throw new BackupError('SOURCE_CHANGED', 'The managed provider was reinstalled while it was being copied.', join(name, 'sdk'));
  }
  return { name, kind: 'managed-provider', status: 'copied', generation: current };
}

async function writeLog(dest, record) {
  await appendFile(join(dest, LOG), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function publishLatest(dest, name) {
  const pending = join(dest, `${STAGING_PREFIX}latest-${randomBytes(4).toString('hex')}`);
  await symlink(join(GENERATIONS, name), pending);
  await rename(pending, join(dest, LATEST));
}

/**
 * Create one generation.
 *
 * @returns the published generation's summary. Throws without publishing when anything fails.
 */
export async function backupSharedTakt({ source, dest, keep = DEFAULT_KEEP, acceptRemoved = false, now = new Date() }) {
  if (!Number.isInteger(keep) || keep < 1) throw new BackupError('INVALID_KEEP', '--keep must be a whole number of at least 1.');
  if (!(await lstatOrUndefined(source))) throw new BackupError('SOURCE_MISSING', 'The TAKT config directory does not exist.');
  await assertSeparate(source, dest);
  await preparePrivateDirectory(dest);
  const name = generationName(now);
  const startedAt = now.toISOString();
  try {
    const summary = await withLock(dest, async () => {
      await removeStagingLeftovers(dest);
      await mkdir(join(dest, GENERATIONS), { recursive: true, mode: 0o700 });
      const published = await listGenerations(dest);
      if (published.includes(name)) throw new BackupError('GENERATION_EXISTS', 'A generation with this timestamp already exists.');
      const previousName = published.at(-1);
      const previousManifest = previousName === undefined ? undefined : await readManifest(join(dest, GENERATIONS, previousName));
      const staging = join(dest, `${STAGING_PREFIX}${name}-${randomBytes(4).toString('hex')}`);
      try {
        const context = {
          source,
          realSource: await realpath(source),
          data: join(staging, DATA),
          previous: new Map((previousManifest?.entries ?? []).filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry])),
          previousData: previousName === undefined ? undefined : join(dest, GENERATIONS, previousName, DATA),
          entries: [],
          totals: { files: 0, bytes: 0, linkedFiles: 0, externalLinks: 0, skippedSpecial: 0 },
        };
        await mkdir(context.data, { recursive: true, mode: 0o700 });
        const targets = [];
        for (const target of CONFIG_TARGETS) targets.push(await copyConfigTarget(context, target));
        for (const target of MANAGED_PROVIDER_TARGETS) targets.push(await copyManagedProvider(context, target));
        if (!targets.some((target) => target.status === 'copied')) {
          throw new BackupError('NOTHING_TO_COPY', 'The TAKT config directory holds none of the backup targets.');
        }
        const copied = new Set(targets.filter((target) => target.status === 'copied').map((target) => target.name));
        const removed = (previousManifest?.targets ?? []).filter((target) => target.status === 'copied' && !copied.has(target.name)).map((target) => target.name);
        if (removed.length > 0 && !acceptRemoved) {
          throw new BackupError('TARGET_DISAPPEARED', `Present in the previous generation but missing now: ${removed.join(', ')}. Pass --accept-removed if this is intended.`);
        }
        const manifest = { version: 1, generation: name, createdAt: startedAt, source: context.realSource, targets, totals: context.totals, entries: context.entries };
        await writeFile(join(staging, MANIFEST), JSON.stringify(manifest), { mode: 0o600 });
        await rename(staging, join(dest, GENERATIONS, name));
        await publishLatest(dest, name);
        const pruned = [...published, name].slice(0, -keep);
        for (const old of pruned) await rm(join(dest, GENERATIONS, old), { recursive: true, force: true });
        return { generation: name, targets, totals: context.totals, pruned };
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
    await writeLog(dest, { time: startedAt, action: 'backup', source, result: 'ok', ...summary });
    return summary;
  } catch (error) {
    await writeLog(dest, { time: startedAt, action: 'backup', source, result: 'failed', generation: name, error: describeFailure(error) });
    throw error;
  }
}

async function resolveGeneration(dest, generation) {
  const name = generation ?? (await listGenerations(dest)).at(-1);
  if (name === undefined || !GENERATION_NAME.test(name) || !(await lstatOrUndefined(join(dest, GENERATIONS, name, MANIFEST)))) {
    throw new BackupError('GENERATION_MISSING', 'No such generation in the backup directory.');
  }
  return { name, directory: join(dest, GENERATIONS, name) };
}

async function verifyEntry(data, entry) {
  const stats = await lstatOrUndefined(join(data, entry.path));
  if (stats === undefined) return 'missing';
  if (entry.type === 'directory') return stats.isDirectory() ? undefined : 'not a directory';
  if (entry.type === 'link') return stats.isSymbolicLink() && await readlink(join(data, entry.path)) === entry.target ? undefined : 'link changed';
  if (!stats.isFile() || stats.size !== entry.size) return 'size changed';
  return await hashFile(join(data, entry.path)) === entry.sha256 ? undefined : 'content changed';
}

/** Re-hash a generation against its manifest. Throws on the first difference. */
export async function verifyGeneration({ dest, generation }) {
  const { name, directory } = await resolveGeneration(dest, generation);
  const manifest = await readManifest(directory);
  for (const entry of manifest.entries) {
    const difference = await verifyEntry(join(directory, DATA), entry);
    if (difference !== undefined) throw new BackupError('GENERATION_DAMAGED', `Generation ${name} is damaged (${difference}).`, entry.path);
  }
  return { generation: name, targets: manifest.targets, totals: manifest.totals };
}

/** Copy a verified generation into a directory that is missing or empty. Nothing existing is overwritten. */
export async function restoreGeneration({ dest, generation, to }) {
  if (await lstatOrUndefined(to) !== undefined && (!(await lstat(to)).isDirectory() || (await readdir(to)).length > 0)) {
    throw new BackupError('RESTORE_TARGET_NOT_EMPTY', 'The restore target exists and is not an empty directory.');
  }
  const verified = await verifyGeneration({ dest, generation });
  const directory = join(dest, GENERATIONS, verified.generation);
  const manifest = await readManifest(directory);
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of manifest.entries) {
    const target = join(to, entry.path);
    if (entry.type === 'directory') await mkdir(target, { mode: 0o700 });
    else if (entry.type === 'link') await symlink(entry.target, target);
    else {
      await copyFile(join(directory, DATA, entry.path), target);
      await chmod(target, entry.mode);
      if (await hashFile(target) !== entry.sha256) throw new BackupError('COPY_MISMATCH', 'A restored file does not match the generation.', entry.path);
    }
  }
  for (const entry of manifest.entries.filter((candidate) => candidate.type === 'directory').reverse()) {
    await chmod(join(to, entry.path), entry.mode);
  }
  return verified;
}

async function importBuiltTakt(taktRoot) {
  const load = (path) => import(pathToFileURL(join(taktRoot, 'dist', path)).href);
  try {
    const [config, definitions, loader] = await Promise.all([
      load('infra/config/global/globalConfigCore.js'), load('infra/managed-providers/definitions.js'), load('infra/managed-providers/loader.js'),
    ]);
    return {
      loadConfig: () => { config.loadGlobalConfig(); },
      providers: definitions.MANAGED_PROVIDERS,
      inspectProvider: (provider) => loader.inspectProviderInstallation(provider),
    };
  } catch (error) {
    throw new BackupError('TAKT_NOT_BUILT', `Could not load a built TAKT (dist/) from the --takt directory (${describeFailure(error).code}).`);
  }
}

/**
 * Load the configuration and inspect the managed providers of a restored
 * directory, the way TAKT itself would with TAKT_CONFIG_DIR pointing at it.
 * A provider with an `sdk` link must not be `missing`.
 */
export async function checkRestoredConfigDirectory({ configDirectory, taktRoot, importTakt = importBuiltTakt }) {
  if (!(await lstatOrUndefined(configDirectory))?.isDirectory()) throw new BackupError('CONFIG_DIR_MISSING', 'The directory to check does not exist.');
  const previous = process.env.TAKT_CONFIG_DIR;
  process.env.TAKT_CONFIG_DIR = await realpath(configDirectory);
  try {
    const takt = await importTakt(taktRoot);
    const result = { config: 'readable', providers: {} };
    try {
      takt.loadConfig();
    } catch (error) {
      // TAKT's own message can quote configuration values, so only the kind of failure is reported.
      result.config = `unreadable (${describeFailure(error).code})`;
    }
    for (const provider of takt.providers) {
      const installed = await lstatOrUndefined(join(configDirectory, provider, 'sdk')) !== undefined;
      result.providers[provider] = installed ? (await takt.inspectProvider(provider)).state : 'absent';
    }
    result.ok = result.config === 'readable' && !Object.values(result.providers).includes('missing');
    return result;
  } finally {
    if (previous === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previous;
  }
}

const USAGE = `Usage:
  shared-takt-backup.mjs backup  --dest <dir> [--source <dir>] [--keep <n>] [--accept-removed]
  shared-takt-backup.mjs verify  --dest <dir> [--generation <name>]
  shared-takt-backup.mjs restore --dest <dir> --to <empty dir> [--generation <name>]
  shared-takt-backup.mjs check   --config-dir <restored dir> [--takt <built TAKT checkout>]

--source defaults to TAKT_CONFIG_DIR, then ~/.takt. --generation defaults to the newest one.
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
        source: resolve(options.source ?? env.TAKT_CONFIG_DIR ?? join(homedir(), '.takt')),
        dest: resolve(required(options, 'dest')),
        keep: options.keep === undefined ? DEFAULT_KEEP : Number(options.keep),
        acceptRemoved: options.acceptRemoved === true,
        now: now(),
      });
      stdout.write(summaryLine('backup', summary));
      if (summary.totals.externalLinks > 0) stdout.write(`note: ${summary.totals.externalLinks} symbolic link(s) point outside the config directory; their targets are not in the backup\n`);
      return 0;
    }
    if (command === 'verify') {
      stdout.write(summaryLine('verify', await verifyGeneration({ dest: resolve(required(options, 'dest')), generation: options.generation })));
      return 0;
    }
    if (command === 'restore') {
      const summary = await restoreGeneration({ dest: resolve(required(options, 'dest')), generation: options.generation, to: resolve(required(options, 'to')) });
      stdout.write(summaryLine('restore', summary));
      return 0;
    }
    if (command === 'check') {
      const result = await checkRestoredConfigDirectory({
        configDirectory: resolve(required(options, 'config-dir')),
        taktRoot: resolve(options.takt ?? fileURLToPath(new URL('..', import.meta.url))),
      });
      stdout.write(`config: ${result.config}\n`);
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
  process.exitCode = await main(process.argv.slice(2));
}

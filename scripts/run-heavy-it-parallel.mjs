import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveHeavyItTargets } from './heavy-it-guard.mjs';
import { terminateLeftoverTurnProcesses } from './leftover-turn-processes.mjs';
import { resolveNpmInvocation } from './npm-invocation.mjs';
import { isolateUserDirectoriesForTestRun, ISOLATION_ROOT_ENV } from './test-user-isolation.mjs';

const vitestPath = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const configPath = fileURLToPath(new URL('../vitest.config.it.heavy.parallel.ts', import.meta.url));
const vitestArgs = ['run', '--config', configPath, ...process.argv.slice(2)];

function run(executable, args) {
  const result = spawnSync(executable, args, { stdio: 'inherit' });
  if (result.error !== undefined) {
    throw result.error;
  }
  return result.status ?? 1;
}

await resolveHeavyItTargets(vitestArgs);

// npm's pre hook cannot see the file arguments passed to the main script.
// A lowercase empty string can represent an explicit --ignore-scripts=false.
const ignoreScripts = process.env.npm_config_ignore_scripts ?? process.env.NPM_CONFIG_IGNORE_SCRIPTS;
if (ignoreScripts !== 'true') {
  const npm = resolveNpmInvocation(process.execPath, process.env.npm_execpath);
  const code = run(npm.executable, [...npm.args, 'run', 'test:deepseek-harness:types']);
  if (code !== 0) {
    process.exit(code);
  }
}

// Low 2 (#177 rereview): never inherit an isolation root from an outer run.
// Sharing one root would widen the leftover scan to that outer run's scope and
// revive the cross-run false positives the isolation exists to prevent, so a
// fresh root is created for this run below.
if (process.env[ISOLATION_ROOT_ENV] !== undefined) {
  console.error(`[takt] Ignoring inherited ${ISOLATION_ROOT_ENV}; creating a fresh isolation root for this heavy IT run.`);
  delete process.env[ISOLATION_ROOT_ENV];
}
const isolationRoot = isolateUserDirectoriesForTestRun();

process.exitCode = run(process.execPath, [vitestPath, ...vitestArgs]);

const leftovers = await terminateLeftoverTurnProcesses(fileURLToPath(new URL('..', import.meta.url)), { isolationRoot });
if (leftovers.length > 0) {
  console.error(`[takt] Heavy IT left ${leftovers.length} daemon turn process(es) running; they were terminated:`);
  for (const { pid, cwd, kind, pgid } of leftovers) {
    const scope = kind === undefined ? '' : ` kind ${kind} pgid ${pgid}`;
    console.error(`  pid ${pid} (cwd ${cwd})${scope}`);
  }
  process.exitCode = 1;
}
try { rmSync(isolationRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* the isolation exit handler retries */ }

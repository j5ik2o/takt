/**
 * `takt run` in a real child process keeps the task it claimed when the tasks.yaml.lock release
 * after the claim fails once (#169, 試験の10). Before the fix the release error stopped the claim:
 * the run ended as failed and the task stayed running.
 *
 * The failure is injected without touching production code (再レビュー 低-5): the child starts with
 * `node --import <preload>`, and the preload replaces `fs.unlinkSync` so that the first unlink of
 * `tasks.yaml.lock` after tasks.yaml holds a running task throws EIO. `syncBuiltinESMExports()`
 * makes the named import in file-lock.ts see the replacement. Lowering directory permissions is not
 * used: the write (rename) and the acquisition (link) would fail first.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const cliEntry = join(repositoryRoot, 'src', 'app', 'cli', 'index.ts');
const workflow = join(repositoryRoot, 'e2e', 'fixtures', 'workflows', 'mock-single-step.yaml');
const tsxUrl = pathToFileURL(require.resolve('tsx/esm')).href;

const PRELOAD = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const unlinkSync = fs.unlinkSync;
let failed = false;
fs.unlinkSync = function (path, ...rest) {
  const target = String(path);
  if (!failed && target.endsWith('tasks.yaml.lock')) {
    let saved = '';
    try { saved = fs.readFileSync(target.slice(0, -'.lock'.length), 'utf8'); } catch { /* not written yet */ }
    if (/status: running/.test(saved)) {
      failed = true;
      throw Object.assign(new Error("EIO: i/o error, unlink '" + target + "'"), { code: 'EIO', errno: -5, syscall: 'unlink', path: target });
    }
  }
  return unlinkSync.call(this, path, ...rest);
};
syncBuiltinESMExports();
`;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('runs the claimed task and ends normally when the tasks.yaml.lock release after the claim fails once', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'takt-claim-release-run-')));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, '.takt'), { recursive: true });
  writeFileSync(join(dir, '.takt', 'config.yaml'), 'language: en\nprovider: mock\n', 'utf-8');
  writeFileSync(join(dir, '.takt', 'tasks.yaml'), [
    'tasks:',
    '  - name: claimed-task',
    '    status: pending',
    '    content: "Do the work"',
    `    workflow: "${workflow}"`,
    `    created_at: "${new Date().toISOString()}"`,
    '    started_at: null',
    '    completed_at: null',
  ].join('\n'), 'utf-8');
  const scenario = join(dir, 'scenario.json');
  writeFileSync(scenario, JSON.stringify([{ status: 'done', content: 'Task completed.' }]), 'utf-8');
  const preload = join(dir, 'fail-release-once.mjs');
  writeFileSync(preload, PRELOAD, 'utf-8');

  const child = spawnSync(process.execPath, [
    '--import', tsxUrl, '--import', pathToFileURL(preload).href, cliEntry, 'run', '--provider', 'mock',
  ], {
    cwd: dir, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, TAKT_NO_TTY: '1', TAKT_MOCK_SCENARIO: scenario },
  });
  const output = `${child.stdout}\n${child.stderr}`;

  expect(child.error).toBeUndefined();
  expect({ status: child.status, output }).toMatchObject({ status: 0 });
  expect(output).toContain('releasing a lock afterwards failed');
  const saved = parseYaml(readFileSync(join(dir, '.takt', 'tasks.yaml'), 'utf-8')) as { tasks: { name: string; status: string }[] };
  expect(saved.tasks.map((task) => [task.name, task.status])).toEqual([['claimed-task', 'completed']]);
  // The lock left by the failed release was removed by this process's next acquisition.
  expect(existsSync(join(dir, '.takt', 'tasks.yaml.lock'))).toBe(false);
}, 150_000);

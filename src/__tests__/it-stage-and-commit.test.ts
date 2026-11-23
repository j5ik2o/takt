/**
 * Integration test for stageAndCommit and .takt/.gitignore semantics
 *
 * Tests that gitignored files are NOT included in commits.
 * Regression test for c89ac4c where `git add -f .takt/runs/` caused
 * gitignored report files to be committed.
 *
 * Also verifies that .takt/.gitignore patterns correctly track facet directories
 * (workflows, personas, policies, knowledge, instructions, output-contracts)
 * while ignoring runtime directories (tasks, logs, runs, completed, .runtime).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn as spawnPty } from 'node-pty';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { stageAndCommit } from '../infra/task/git.js';
import { buildSafeGitEnvironment } from '../infra/task/git-environment.js';
import { getProjectWorkflowsDir, getProjectFacetDir } from '../infra/config/paths.js';
import { VALID_FACET_TYPES, parseFacetType } from '../features/config/facetTypes.js';
import { ensureWorktreeTaktRuntimeProtection } from '../infra/task/projectLocalTaktSync.js';

const dotgitignorePath = join(__dirname, '..', '..', 'builtins', 'project', 'dotgitignore');

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `takt-stage-commit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });

  execFileSync('git', ['init'], { cwd: testDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });

  // Initial commit
  writeFileSync(join(testDir, 'README.md'), '# Test');
  execFileSync('git', ['add', '.'], { cwd: testDir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

function isFixtureProcessRunning(pidFile: string): boolean {
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const state = execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' }).split('\n')
    .map((line) => line.trim().split(/\s+/u)).find(([value]) => Number(value) === pid)?.[1];
  return state !== undefined && !state.startsWith('Z');
}

describe('stageAndCommit', () => {
  it.skipIf(process.platform === 'win32')('can commit unsigned changes from a terminal without node-pty', async () => {
    const root = join(import.meta.dirname, '..', '..');
    const gitModule = pathToFileURL(join(root, 'src/infra/task/git.ts')).href;
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: testDir });
    writeFileSync(join(testDir, 'unsigned.txt'), 'unsigned content\n');
    const child = spawnPty(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { registerHooks } from 'node:module';
      import { stageAndCommit } from ${JSON.stringify(gitModule)};
      registerHooks({
        resolve(specifier, context, next) {
          if (specifier === 'node-pty') throw Object.assign(new Error('optional add-on absent'), { code: 'ERR_MODULE_NOT_FOUND' });
          return next(specifier, context);
        },
      });
      await stageAndCommit(${JSON.stringify(testDir)}, 'Unsigned fixture', {}, new AbortController().signal);
    `], { cwd: root });
    let output = '';
    child.onData((chunk) => { output += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Unsigned commit fixture timed out: ${output}`));
      }, 15_000);
      child.onExit(({ exitCode, signal }) => {
        clearTimeout(timer);
        if (exitCode === 0 && !signal) resolve();
        else reject(new Error(`Unsigned commit fixture exited (${exitCode}, ${signal}): ${output}`));
      });
    });
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: testDir, encoding: 'utf8' });
    expect(subject.trim()).toBe('Unsigned fixture');
  });

  it.skipIf(process.platform === 'win32').each(['complete', 'interrupt', 'redirected with a reparented hook child'] as const)(
    'keeps the controlling terminal for a signed commit (%s)',
    async (mode) => {
      const signer = join(testDir, '.git', 'fixture-signer');
      const signerPid = join(testDir, '.git', 'fixture-signer-pid');
      const redirected = mode === 'redirected with a reparented hook child';
      const childPidFile = join(testDir, '.git', 'fixture-hook-child');
      const redirectedLog = join(testDir, '.git', 'redirected.log');
      if (redirected) {
        const helper = join(testDir, '.git', 'fixture-hook-helper.cjs');
        writeFileSync(helper, `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const code = "process.on('SIGHUP', () => undefined); process.on('SIGINT', () => undefined); "
  + "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000);";
const child = spawn(process.execPath, ['-e', code, process.env.TAKT_TEST_HOOK_CHILD], { stdio: 'ignore' });
writeFileSync(process.env.TAKT_TEST_HOOK_CHILD + '-parent', String(process.pid));
child.unref();
`);
        const hook = join(testDir, '.git', 'hooks', 'pre-commit');
        mkdirSync(dirname(hook), { recursive: true });
        writeFileSync(hook, `#!/bin/sh
"$TAKT_TEST_NODE" "$TAKT_TEST_HOOK_HELPER" || exit 1
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  test -s "$TAKT_TEST_HOOK_CHILD" && exit 0
  sleep 0.1
done
exit 1
`);
        chmodSync(hook, 0o755);
      }
      writeFileSync(signer, `#!/bin/sh
echo "$$" > "$TAKT_TEST_SIGNER_PID"
test -c "$GPG_TTY" || exit 1
printf 'Fixture signer ready\\n' >/dev/tty || exit 1
IFS= read -r answer </dev/tty || exit 1
test "$answer" = fixture || exit 1
cat >/dev/null
printf '[GNUPG:] SIG_CREATED D 1 2 00 0 fixture\\n' >&2
printf '%s\\n' '-----BEGIN PGP SIGNATURE-----' 'fixture' '-----END PGP SIGNATURE-----'
`);
      chmodSync(signer, 0o755);
      const git = (args: string[]): string => execFileSync('git', args, { cwd: testDir, encoding: 'utf8' });
      git(['config', 'commit.gpgsign', 'true']);
      git(['config', 'gpg.format', 'openpgp']);
      git(['config', 'gpg.program', signer]);
      writeFileSync(join(testDir, 'signed.txt'), 'signed content\n');
      const root = join(import.meta.dirname, '..', '..');
      const source = (path: string): string => JSON.stringify(pathToFileURL(join(root, 'src', 'infra', 'task', path)).href);
      const args = ['--import', 'tsx', '--input-type=module', '-e', `
        import { existsSync, readFileSync } from 'node:fs';
        import { execFileSync } from 'node:child_process';
        import { stageAndCommit } from ${source('git.ts')};
        import { registerCacciaCloneGit } from ${source('caccia-git-processes.ts')};
        const clone = ${JSON.stringify(testDir)};
        const release = registerCacciaCloneGit(clone);
        const controller = new AbortController();
        process.once('SIGINT', () => controller.abort());
        try {
          const commit = await stageAndCommit(clone, 'Signed fixture', { allowGitHooks: ${redirected} }, controller.signal);
          if (${redirected}) {
            if ([process.stdin, process.stdout, process.stderr].some((stream) => stream.isTTY)) {
              throw new Error('Fixture expected redirected standard streams');
            }
            const file = process.env.TAKT_TEST_HOOK_CHILD;
            if (!existsSync(file)) throw new Error('Hook did not start a child');
            const pid = Number(readFileSync(file, 'utf8'));
            const parent = Number(readFileSync(file + '-parent', 'utf8'));
            const [ppid, state] = execFileSync('ps', ['-o', 'ppid=,stat=', '-p', String(pid)],
              { encoding: 'utf8' }).trim().split(/\\s+/);
            if (!state || state.startsWith('Z') || Number(ppid) === parent) {
              throw new Error('Hook child must survive and be reparented before cleanup');
            }
          }
          console.log('fixture commit ' + commit);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          console.log('fixture interrupted');
        } finally {
          release();
        }
      `];
      const child = spawnPty(redirected ? '/bin/sh' : process.execPath,
        // Keep the outer PTY's slave open on Linux while redirecting all three standard fds.
        redirected ? ['-c', 'exec "$@" 3<>/dev/tty </dev/null >"$TAKT_TEST_REDIRECT_LOG" 2>&1', 'fixture', process.execPath, ...args] : args, {
        cwd: root,
        env: { ...process.env, GPG_TTY: '/not-the-inner-pty', TAKT_TEST_SIGNER_PID: signerPid, TAKT_TEST_NODE: process.execPath,
          TAKT_TEST_HOOK_HELPER: join(testDir, '.git', 'fixture-hook-helper.cjs'), TAKT_TEST_HOOK_CHILD: childPidFile,
          TAKT_TEST_REDIRECT_LOG: redirectedLog },
      });
      let output = '';
      let responded = false;
      const listener = child.onData((chunk) => {
        output += chunk;
        if (!responded && output.includes('Fixture signer ready')) {
          responded = true;
          child.write(mode === 'interrupt' ? '\x03' : 'fixture\r');
        }
      });
      const exit = await new Promise<{ exitCode: number; signal?: number }>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Signed commit fixture timed out: ${output}`));
        }, 15_000);
        child.onExit((event) => {
          clearTimeout(timer);
          resolve(event);
        });
      }).finally(() => listener.dispose());
      if (redirected && existsSync(redirectedLog)) output += readFileSync(redirectedLog, 'utf8');
      expect(exit.signal || 0, output).toBe(0);
      expect(exit.exitCode, output).toBe(0);
      expect(responded, output).toBe(true);
      if (mode !== 'interrupt') {
        expect(git(['cat-file', '-p', 'HEAD'])).toContain('gpgsig -----BEGIN PGP SIGNATURE-----');
        expect(output).toMatch(/fixture commit [0-9a-f]+/u);
        if (redirected) expect(isFixtureProcessRunning(childPidFile)).toBe(false);
      } else {
        expect(output).toContain('fixture interrupted');
        expect(git(['log', '-1', '--format=%s']).trim()).toBe('Initial commit');
        expect(isFixtureProcessRunning(signerPid)).toBe(false);
      }
    },
  );

  it('should not commit gitignored .takt/runs/ files', async () => {
    // Setup: .takt/ is gitignored
    writeFileSync(join(testDir, '.gitignore'), '.takt/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'Add gitignore'], { cwd: testDir });

    // Create .takt/runs/ with a report file
    mkdirSync(join(testDir, '.takt', 'runs', 'test-report', 'reports'), { recursive: true });
    writeFileSync(join(testDir, '.takt', 'runs', 'test-report', 'reports', '00-plan.md'), '# Plan');

    // Also create a tracked file change to ensure commit happens
    writeFileSync(join(testDir, 'src.ts'), 'export const x = 1;');

    const hash = await stageAndCommit(testDir, 'test commit');
    expect(hash).toBeDefined();

    // Verify .takt/runs/ is NOT in the commit
    const committedFiles = execFileSync('git', ['diff-tree', '--no-commit-id', '-r', '--name-only', 'HEAD'], {
      cwd: testDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    expect(committedFiles).toContain('src.ts');
    expect(committedFiles).not.toContain('.takt/runs/');
  });

  it('should commit normally when no gitignored files exist', async () => {
    writeFileSync(join(testDir, 'app.ts'), 'console.log("hello");');

    const hash = await stageAndCommit(testDir, 'add app');
    expect(hash).toBeDefined();

    const committedFiles = execFileSync('git', ['diff-tree', '--no-commit-id', '-r', '--name-only', 'HEAD'], {
      cwd: testDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    expect(committedFiles).toBe('app.ts');
  });

  it('should use the cwd repository when inherited Git repository variables point to a decoy', async () => {
    const decoyDir = mkdtempSync(join(tmpdir(), 'takt-stage-commit-decoy-'));
    try {
      execFileSync('git', ['init'], { cwd: decoyDir });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: decoyDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: decoyDir });
      writeFileSync(join(decoyDir, 'README.md'), '# Decoy');
      execFileSync('git', ['add', '.'], { cwd: decoyDir });
      execFileSync('git', ['commit', '-m', 'Decoy baseline'], { cwd: decoyDir });
      const decoyHead = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: decoyDir,
        encoding: 'utf-8',
      }).trim();

      execFileSync('git', ['config', '--local', 'filter.observer.clean', 'false'], { cwd: testDir });
      execFileSync('git', ['config', '--local', 'filter.observer.required', 'true'], { cwd: testDir });
      writeFileSync(join(testDir, '.gitattributes'), 'app.ts filter=observer\n');
      writeFileSync(join(testDir, 'app.ts'), 'export const target = true;');

      const decoyGitDir = join(decoyDir, '.git');
      vi.stubEnv('GIT_DIR', decoyGitDir);
      vi.stubEnv('GIT_WORK_TREE', decoyDir);
      vi.stubEnv('GIT_COMMON_DIR', decoyGitDir);
      vi.stubEnv('GIT_INDEX_FILE', join(decoyGitDir, 'index'));

      let hash: string | undefined;
      try {
        hash = await stageAndCommit(testDir, 'commit target repository');
      } finally {
        vi.unstubAllEnvs();
      }

      expect(hash).toBeDefined();
      expect(execFileSync('git', ['show', '--format=', '--name-only', 'HEAD'], {
        cwd: testDir,
        encoding: 'utf-8',
      })).toContain('app.ts');
      expect(execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: decoyDir,
        encoding: 'utf-8',
      }).trim()).toBe(decoyHead);
    } finally {
      rmSync(decoyDir, { recursive: true, force: true });
    }
  });

  it('should commit successfully when inherited indexed Git config is incomplete', async () => {
    writeFileSync(join(testDir, 'app.ts'), 'export const complete = true;');
    vi.stubEnv('GIT_CONFIG_COUNT', '3');
    vi.stubEnv('GIT_CONFIG_KEY_2', undefined);
    vi.stubEnv('GIT_CONFIG_VALUE_2', undefined);

    const hash = await stageAndCommit(testDir, 'ignore incomplete inherited config');

    expect(hash).toBeDefined();
  });

  it('should return only generated command config pairs when inherited keys use mixed case', async () => {
    const globalConfig = join(testDir, 'global-git-config');
    const systemConfig = join(testDir, 'system-git-config');
    writeFileSync(globalConfig, '');
    writeFileSync(systemConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_SYSTEM', systemConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('gIt_CoNfIg', join(testDir, 'stale-config'));
    vi.stubEnv('gIt_CoNfIg_CoUnT', '43');
    vi.stubEnv('gIt_CoNfIg_PaRaMeTeRs', "'unsafe.key=value'");
    vi.stubEnv('gIt_CoNfIg_KeY_42', 'unsafe.key');
    vi.stubEnv('gIt_CoNfIg_VaLuE_42', 'unsafe-value');

    const environment = await buildSafeGitEnvironment(testDir, { allowGitFilters: true });
    const commandConfigKeys = Object.keys(environment)
      .filter((key) => /^GIT_CONFIG(?:$|_COUNT$|_PARAMETERS$|_(?:KEY|VALUE)_)/iu.test(key))
      .sort();

    expect(commandConfigKeys).toEqual([
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
    ]);
    expect(environment).toMatchObject({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: systemConfig,
    });
    expect(environment.GIT_CONFIG_VALUE_0).toBeDefined();
  });

  it('should commit .takt/.gitignore while leaving runtime artifacts uncommitted', async () => {
    const dotgitignore = readFileSync(dotgitignorePath, 'utf-8');
    mkdirSync(join(testDir, '.takt', '.runtime', 'tmp'), { recursive: true });
    mkdirSync(join(testDir, '.takt', 'runs', 'test-run', 'reports'), { recursive: true });
    writeFileSync(join(testDir, '.takt', '.gitignore'), dotgitignore, 'utf-8');
    writeFileSync(join(testDir, '.takt', '.runtime', 'tmp', 'cache.txt'), 'cache', 'utf-8');
    writeFileSync(join(testDir, '.takt', 'runs', 'test-run', 'reports', 'test-report.md'), '# Report', 'utf-8');
    writeFileSync(join(testDir, 'src.ts'), 'export const x = 1;', 'utf-8');

    const hash = await stageAndCommit(testDir, 'add worktree gitignore');
    expect(hash).toBeDefined();

    const committedFiles = execFileSync('git', ['diff-tree', '--no-commit-id', '-r', '--name-only', 'HEAD'], {
      cwd: testDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim().split('\n').filter(Boolean).sort();

    expect(committedFiles).toContain('.takt/.gitignore');
    expect(committedFiles).toContain('src.ts');
    expect(committedFiles).not.toContain('.takt/.runtime/tmp/cache.txt');
    expect(committedFiles).not.toContain('.takt/runs/test-run/reports/test-report.md');
  });

  it('should return undefined when there are no changes', async () => {
    const hash = await stageAndCommit(testDir, 'empty');
    expect(hash).toBeUndefined();
  });
});

describe('dotgitignore patterns', () => {
  function gitTrackedFiles(cwd: string): string[] {
    const output = execFileSync('git', ['ls-files', '.takt/'], { cwd, encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean).sort();
  }

  beforeEach(() => {
    // Copy actual dotgitignore as .takt/.gitignore
    const taktDir = join(testDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    const content = readFileSync(dotgitignorePath, 'utf-8');
    writeFileSync(join(taktDir, '.gitignore'), content);
  });

  it('should track config.yaml', () => {
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'language: ja\n');
    execFileSync('git', ['add', '.takt/'], { cwd: testDir });

    const tracked = gitTrackedFiles(testDir);
    expect(tracked).toContain('.takt/config.yaml');
  });

  it('should track facet directories', () => {
    // workflows directory
    const workflowsDir = getProjectWorkflowsDir(testDir);
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'test.md'), '# workflows');

    // facet type directories — derived from VALID_FACET_TYPES
    for (const singular of VALID_FACET_TYPES) {
      const facetType = parseFacetType(singular)!;
      const facetDir = getProjectFacetDir(testDir, facetType);
      mkdirSync(facetDir, { recursive: true });
      writeFileSync(join(facetDir, 'test.md'), `# ${facetType}`);
    }

    execFileSync('git', ['add', '.takt/'], { cwd: testDir });
    const tracked = gitTrackedFiles(testDir);

    // Assert workflows tracked
    expect(tracked).toContain('.takt/workflows/test.md');

    // Assert all facet types tracked
    for (const singular of VALID_FACET_TYPES) {
      const facetType = parseFacetType(singular)!;
      expect(tracked).toContain(`.takt/facets/${facetType}/test.md`);
    }
  });

  it('should track nested files in facet directories', () => {
    const subDir = join(getProjectWorkflowsDir(testDir), 'sub');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'nested.yaml'), 'name: test');

    execFileSync('git', ['add', '.takt/'], { cwd: testDir });
    const tracked = gitTrackedFiles(testDir);

    expect(tracked).toContain('.takt/workflows/sub/nested.yaml');
  });

  it('should ignore runtime directories', () => {
    const runtimeDirs = ['tasks', 'completed', 'logs', 'runs', '.runtime'];
    for (const dir of runtimeDirs) {
      mkdirSync(join(testDir, '.takt', dir), { recursive: true });
      writeFileSync(join(testDir, '.takt', dir, 'data.json'), '{}');
    }

    execFileSync('git', ['add', '.takt/'], { cwd: testDir });
    const tracked = gitTrackedFiles(testDir);

    for (const dir of runtimeDirs) {
      const runtimeFiles = tracked.filter(f => f.startsWith(`.takt/${dir}/`));
      expect(runtimeFiles).toEqual([]);
    }
  });

  it('should preserve run logs from git clean after tracked .takt/.gitignore is removed', () => {
    execFileSync('git', ['add', '.takt/.gitignore'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'Track takt gitignore'], { cwd: testDir });
    ensureWorktreeTaktRuntimeProtection(testDir);

    const logPath = join(testDir, '.takt', 'runs', 'active-run', 'logs', 'session.jsonl');
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, '{"type":"workflow_start"}\n', 'utf-8');

    execFileSync('git', ['rm', '.takt/.gitignore'], { cwd: testDir });
    execFileSync('git', ['clean', '-fd'], { cwd: testDir });

    expect(existsSync(join(testDir, '.takt', '.gitignore'))).toBe(false);
    expect(readFileSync(logPath, 'utf-8')).toBe('{"type":"workflow_start"}\n');
    const ignoreSource = execFileSync('git', ['check-ignore', '-v', '.takt/runs/active-run/logs/session.jsonl'], {
      cwd: testDir,
      encoding: 'utf-8',
    });
    expect(ignoreSource).toContain('.git/info/exclude');
  });

  it('should skip git exclude protection when the worktree has no .git', () => {
    const noGitDir = join(testDir, 'no-git-worktree');
    mkdirSync(noGitDir, { recursive: true });

    expect(() => ensureWorktreeTaktRuntimeProtection(noGitDir)).not.toThrow();

    expect(existsSync(join(noGitDir, '.takt', '.gitignore'))).toBe(true);
    expect(existsSync(join(noGitDir, '.git'))).toBe(false);
    const parentExclude = join(testDir, '.git', 'info', 'exclude');
    const parentExcludeContent = existsSync(parentExclude) ? readFileSync(parentExclude, 'utf-8') : '';
    expect(parentExcludeContent).not.toContain('/.takt/runs/');
  });
});

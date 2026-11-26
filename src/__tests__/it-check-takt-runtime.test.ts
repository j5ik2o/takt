/**
 * scripts/check-takt-runtime.sh: the pre-run check that `takt` on PATH is the fork build a project expects.
 *
 * Every case builds a fake install under tmp; the real ~/local/takt-custom is never read.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/check-takt-runtime.sh', import.meta.url));
const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';

let base: string;
let link: string;

function schemaModule(projectKeys: string[], globalKeys: string[] = []): string {
  const shape = (keys: string[]) => `{ shape: { ${keys.map((key) => `${key}: {}`).join(', ')} } }`;
  return `export const ProjectConfigSchema = ${shape(projectKeys)};\nexport const GlobalConfigSchema = ${shape(globalKeys)};\n`;
}

function install(name: string, schema: string, deployed: string): string {
  const dir = join(base, name);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'dist', 'core', 'models'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'takt'), '#!/bin/sh\n');
  chmodSync(join(dir, 'bin', 'takt'), 0o755);
  writeFileSync(join(dir, 'dist', 'core', 'models', 'config-schemas.js'), schema);
  writeFileSync(join(dir, 'DEPLOYED_FROM_COMMIT'), `${deployed}\n`);
  return dir;
}

function run(pathDirs: string[], ...args: string[]): { status: number | null; output: string } {
  const result = spawnSync('/bin/sh', [script, '--root', link, ...args], {
    encoding: 'utf8',
    env: { HOME: base, PATH: [...pathDirs, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe.skipIf(process.platform === 'win32')('check-takt-runtime.sh', () => {
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'takt-check-runtime-'));
    link = join(base, 'takt-custom');
    install('takt-custom-abc1234', schemaModule(['task_finish_hook'], ['claude_cli_path']), COMMIT);
    symlinkSync('takt-custom-abc1234', link);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('passes when PATH resolves takt through the link and the build knows the key', () => {
    const result = run([join(link, 'bin')]);

    expect(result.output).not.toContain('NG:');
    expect(result.status).toBe(0);
  });

  it('fails and names both paths when PATH resolves takt to another install', () => {
    const other = install('mise-takt', schemaModule([]), COMMIT);

    const result = run([join(other, 'bin'), join(link, 'bin')]);

    expect(result.status).toBe(1);
    expect(result.output).toContain(`NG: takt on PATH is ${join(other, 'bin', 'takt')}`);
  });

  it('fails when the build does not know a required key', () => {
    const result = run([join(link, 'bin')], '--key', 'finish_hook');

    expect(result.status).toBe(1);
    expect(result.output).toContain('does not accept project key finish_hook');
  });

  it('fails for a key the build knows only in the global config', () => {
    const result = run([join(link, 'bin')], '--key', 'claude_cli_path');

    expect(result.status).toBe(1);
    expect(result.output).toContain('does not accept project key claude_cli_path');
  });

  it('fails when DEPLOYED_FROM_COMMIT does not match the versioned directory name', () => {
    writeFileSync(join(base, 'takt-custom-abc1234', 'DEPLOYED_FROM_COMMIT'), '9999999\n');

    const result = run([join(link, 'bin')]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('does not match directory');
  });

  it.each(['task_.*', '*'])('fails for --key %s, which matches the build keys only as a pattern', (key) => {
    writeFileSync(join(base, 'task_finish_hook'), '');

    const result = spawnSync('/bin/sh', [script, '--root', link, '--key', key], {
      cwd: base,
      encoding: 'utf8',
      env: { HOME: base, PATH: [join(link, 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) },
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(`does not accept project key ${key}`);
  });

  describe('--contains', () => {
    let repo: string;
    let deployed: string;
    let ancestor: string;
    let unrelated: string;

    function git(...args: string[]): string {
      const result = spawnSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: {
          HOME: base,
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.com',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.com',
        },
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    }

    beforeEach(() => {
      repo = join(base, 'repo');
      mkdirSync(repo);
      git('init', '-q', '-b', 'main');
      git('commit', '-q', '--allow-empty', '-m', 'ancestor');
      ancestor = git('rev-parse', 'HEAD');
      git('commit', '-q', '--allow-empty', '-m', 'deployed');
      deployed = git('rev-parse', 'HEAD');
      git('checkout', '-q', '--orphan', 'other');
      git('commit', '-q', '--allow-empty', '-m', 'unrelated');
      unrelated = git('rev-parse', 'HEAD');
      const dir = join(base, `takt-custom-${deployed.slice(0, 7)}`);
      install(`takt-custom-${deployed.slice(0, 7)}`, schemaModule(['task_finish_hook']), deployed);
      rmSync(link);
      symlinkSync(dir, link);
    });

    it('passes when the deployed commit contains the commit', () => {
      const result = run([join(link, 'bin')], '--repo', repo, '--contains', ancestor);

      expect(result.output).toContain(`ok: ${deployed} contains ${ancestor}`);
      expect(result.status).toBe(0);
    });

    it('fails when the deployed commit does not contain the commit', () => {
      const result = run([join(link, 'bin')], '--repo', repo, '--contains', unrelated);

      expect(result.status).toBe(1);
      expect(result.output).toContain(`NG: ${deployed} does not contain ${unrelated}`);
    });
  });

  it('rejects --contains without --repo as a usage error', () => {
    expect(run([join(link, 'bin')], '--contains', COMMIT).status).toBe(2);
  });
});

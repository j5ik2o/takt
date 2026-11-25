/**
 * scripts/check-takt-runtime.sh: the pre-run check that `takt` on PATH is the fork build a project expects.
 *
 * Every case builds a fake install under tmp; the real ~/local/takt-custom is never read.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/check-takt-runtime.sh', import.meta.url));
const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';

let base: string;
let link: string;

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
    env: { HOME: base, PATH: [...pathDirs, '/usr/bin', '/bin'].join(delimiter) },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe.skipIf(process.platform === 'win32')('check-takt-runtime.sh', () => {
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'takt-check-runtime-'));
    link = join(base, 'takt-custom');
    install('takt-custom-abc1234', '  task_finish_hook: TaskFinishHookConfigSchema.optional(),\n', COMMIT);
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
    const other = install('mise-takt', '', COMMIT);

    const result = run([join(other, 'bin'), join(link, 'bin')]);

    expect(result.status).toBe(1);
    expect(result.output).toContain(`NG: takt on PATH is ${join(other, 'bin', 'takt')}`);
  });

  it('fails when the build does not know a required key', () => {
    const result = run([join(link, 'bin')], '--key', 'finish_hook');

    expect(result.status).toBe(1);
    expect(result.output).toContain('does not know finish_hook');
  });

  it('fails when DEPLOYED_FROM_COMMIT does not match the versioned directory name', () => {
    writeFileSync(join(base, 'takt-custom-abc1234', 'DEPLOYED_FROM_COMMIT'), '9999999\n');

    const result = run([join(link, 'bin')]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('does not match directory');
  });

  it('rejects --contains without --repo as a usage error', () => {
    expect(run([join(link, 'bin')], '--contains', COMMIT).status).toBe(2);
  });
});

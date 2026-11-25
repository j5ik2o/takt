import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Simulate takt installed with npx or a plain npm install: its own node_modules has no Claude SDK.
const isolation = vi.hoisted(() => ({ managedRoot: '' }));
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  const createRequire: typeof actual.createRequire = (origin) => {
    const require = actual.createRequire(origin);
    const originPath = String(origin).replace(/^file:\/\//u, '');
    if (isolation.managedRoot !== '' && originPath.startsWith(isolation.managedRoot)) return require;
    const resolve = ((request: string, options?: { paths?: string[] }) => {
      if (request.startsWith('@anthropic-ai/claude-agent-sdk')) {
        throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
      }
      return require.resolve(request, options);
    }) as NodeJS.RequireResolve;
    resolve.paths = require.resolve.paths;
    return Object.assign(require, { resolve });
  };
  return { ...actual, createRequire, default: { ...actual, createRequire } };
});

import { installManagedSdk } from '../infra/managed-providers/package.js';
import { assertClaudeSdkRuntime } from '../infra/claude/sdk-runtime.js';

let directory: string;
let npm: string;
let marker: string;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'takt-sdk-precheck-')));
  // test-setup.ts gives each test its own config root; the managed SDK goes under it.
  isolation.managedRoot = `${process.env.TAKT_CONFIG_DIR!}${sep}`;
  npm = join(directory, 'npm.cjs');
  marker = join(directory, 'cli-was-run');
  const binary = join(directory, 'claude');
  vi.stubEnv('TAKT_TEST_FAKE_CLAUDE', binary);
  await writeFile(binary, `#!/bin/sh\n: > ${JSON.stringify(marker)}\necho "--tools --strict-mcp-config --json-schema"\n`, { mode: 0o755 });
  await writeFile(npm, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const name = '@anthropic-ai/claude-agent-sdk';
const sdk = path.join('node_modules', name);
fs.mkdirSync(sdk, { recursive: true });
fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name, version: manifest.dependencies[name], type: 'module', exports: './index.js' }));
fs.writeFileSync(path.join(sdk, 'index.js'), 'export function query() {}\\nexport class AbortError extends Error {}\\n');
const suffix = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? '-musl' : '';
const native = path.join('node_modules', '@anthropic-ai', 'claude-agent-sdk-' + process.platform + '-' + process.arch + suffix);
fs.mkdirSync(native, { recursive: true });
fs.copyFileSync(process.env.TAKT_TEST_FAKE_CLAUDE, path.join(native, 'claude'));
fs.chmodSync(path.join(native, 'claude'), 0o755);
`, { mode: 0o755 });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  isolation.managedRoot = '';
  await rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('Claude SDK preflight with a takt-managed SDK', () => {
  it('inspects the CLI bundled with the SDK from takt install claude-sdk without claude_cli_path', async () => {
    await installManagedSdk('claude-sdk', { npmPath: npm });

    await expect(assertClaudeSdkRuntime({ tools: ['Read'], strictMcpConfig: true })).resolves.toBeUndefined();
    expect(existsSync(marker)).toBe(true);
  });

  it('asks for takt install claude-sdk when the SDK is not installed and claude_cli_path is not set', async () => {
    await expect(assertClaudeSdkRuntime({})).rejects.toThrow('Run `takt install claude-sdk`.');
    expect(existsSync(marker)).toBe(false);
  });
});

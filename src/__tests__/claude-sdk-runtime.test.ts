import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const doubles = vi.hoisted(() => ({ execFile: vi.fn(), resolve: vi.fn(), exists: vi.fn(), inspect: vi.fn(), origins: [] as string[] }));
vi.mock('../infra/managed-providers/package.js', () => ({ inspectManagedProvider: doubles.inspect }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFile: doubles.execFile,
}));
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  const createRequire = (origin: string) => {
    if (!origin.startsWith(join('/managed', 'sdk'))) return actual.createRequire(origin);
    doubles.origins.push(origin);
    return { resolve: doubles.resolve };
  };
  return { ...actual, createRequire, default: { ...actual, createRequire } };
});
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(), existsSync: doubles.exists,
}));

import { assertClaudeSdkRuntime } from '../infra/claude/sdk-runtime.js';

describe('Claude SDK runtime preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.origins.length = 0;
    doubles.inspect.mockReset().mockResolvedValue({ state: 'ready', directory: '/managed/sdk' });
    doubles.resolve.mockReset().mockReturnValue('/sdk/claude');
    doubles.exists.mockReset().mockReturnValue(true);
    doubles.execFile.mockReset().mockImplementation((_command, _args, _options, callback) => {
      callback(null, '--tools --strict-mcp-config --json-schema', '');
    });
  });

  it('inspects the native executable bundled with the takt-managed SDK when no CLI override is configured', async () => {
    await assertClaudeSdkRuntime({ cwd: '/repo', tools: ['Read'], strictMcpConfig: true });
    expect(doubles.origins).toEqual([join('/managed/sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json')]);
    expect(doubles.resolve).toHaveBeenCalledWith(expect.stringContaining('@anthropic-ai/claude-agent-sdk-'));
    expect(doubles.execFile).toHaveBeenCalledWith('/sdk/claude', ['--help'], expect.objectContaining({ cwd: '/repo' }), expect.any(Function));
    expect(doubles.inspect.mock.invocationCallOrder[0]).toBeLessThan(doubles.execFile.mock.invocationCallOrder[0]!);
  });

  it('rejects missing optional native packages before launching a process', async () => {
    doubles.resolve.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' });
    });
    await expect(assertClaudeSdkRuntime({})).rejects.toThrow('claude_cli_path');
    expect(doubles.execFile).not.toHaveBeenCalled();
  });

  it('asks for takt install claude-sdk when the managed SDK is missing', async () => {
    doubles.inspect.mockResolvedValue({ state: 'missing' });
    await expect(assertClaudeSdkRuntime({})).rejects.toThrow('Run `takt install claude-sdk`.');
    expect(doubles.execFile).not.toHaveBeenCalled();
  });

  it('keeps the cause when the managed SDK link is broken', async () => {
    const cause = new Error('Managed current generation is not a link.');
    doubles.inspect.mockResolvedValue({ state: 'missing', cause });
    await expect(assertClaudeSdkRuntime({})).rejects.toMatchObject({ message: expect.stringContaining('takt install claude-sdk'), cause });
    expect(doubles.execFile).not.toHaveBeenCalled();
  });

  it('does not run a modified managed CLI before the integrity check rejects it', async () => {
    const cause = new Error('Managed SDK integrity check failed.');
    doubles.inspect.mockResolvedValue({ state: 'missing', cause });
    await expect(assertClaudeSdkRuntime({ tools: ['Read'] })).rejects.toMatchObject({
      message: expect.stringContaining('failed an integrity check'), cause,
    });
    expect(doubles.execFile).not.toHaveBeenCalled();
  });

  it('accepts a stale installation that passed its integrity check, as the query does', async () => {
    doubles.inspect.mockResolvedValue({ state: 'stale', directory: '/managed/sdk' });
    await expect(assertClaudeSdkRuntime({})).resolves.toBeUndefined();
    expect(doubles.execFile).toHaveBeenCalledOnce();
  });

  it('runs a configured JavaScript CLI with Node and the resolved environment', async () => {
    await assertClaudeSdkRuntime({ pathToClaudeCodeExecutable: '/custom/cli.mjs', cwd: '/repo', env: { PATH: '/custom/bin' } });
    expect(doubles.inspect).not.toHaveBeenCalled();
    expect(doubles.resolve).not.toHaveBeenCalled();
    expect(doubles.execFile).toHaveBeenCalledWith(process.execPath, ['/custom/cli.mjs', '--help'], expect.objectContaining({ cwd: '/repo', env: { PATH: '/custom/bin' } }), expect.any(Function));
  });

  it.each(['--tools', '--strict-mcp-config', '--json-schema'])('rejects a CLI missing the required %s option', async (flag) => {
    doubles.execFile.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(null, ['--tools', '--strict-mcp-config', '--json-schema'].filter((option) => option !== flag).join(' '), '');
    });
    await expect(assertClaudeSdkRuntime({
      pathToClaudeCodeExecutable: '/custom/claude', tools: ['Read'], strictMcpConfig: true,
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    })).rejects.toThrow(flag);
  });

  it('does not require restriction flags for an unrestricted call', async () => {
    doubles.execFile.mockImplementationOnce((_command, _args, _options, callback) => callback(null, 'help', ''));
    await expect(assertClaudeSdkRuntime({ pathToClaudeCodeExecutable: '/custom/claude' })).resolves.toBeUndefined();
  });

  it('propagates a failed help probe', async () => {
    const failure = new Error('cannot execute');
    doubles.execFile.mockImplementationOnce((_command, _args, _options, callback) => callback(failure, '', ''));
    await expect(assertClaudeSdkRuntime({ pathToClaudeCodeExecutable: '/custom/claude' })).rejects.toMatchObject({ cause: failure });
  });

  it('does not launch a help probe when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(assertClaudeSdkRuntime({}, controller.signal)).rejects.toBe(controller.signal.reason);

    expect(doubles.execFile).not.toHaveBeenCalled();
    expect(doubles.inspect).not.toHaveBeenCalled();
    expect(doubles.resolve).not.toHaveBeenCalled();
  });
});

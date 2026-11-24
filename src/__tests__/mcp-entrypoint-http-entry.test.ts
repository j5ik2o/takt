import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectTaktMcpServerToHttp } from '../app/mcp/index.js';

describe('takt-mcp resident HTTP entrypoint', () => {
  let argvBackup: string[];

  beforeEach(() => {
    argvBackup = [...process.argv];
  });

  afterEach(() => {
    process.argv = argvBackup;
    vi.unstubAllEnvs();
  });

  function captureStartup(): { lines: string[]; ready: Promise<void>; shutdown: () => void; exits: number[] } {
    const lines: string[] = [];
    const exits: number[] = [];
    let shutdown: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      void connectTaktMcpServerToHttp({
        writeStartup: (line) => { lines.push(line); resolve(); },
        onSignal: (handler) => { shutdown = handler; },
        exit: (code) => { exits.push(code); },
      });
    });
    return { lines, ready, shutdown: () => { shutdown?.(); }, exits };
  }

  async function listTools(url: string, authorization: string): Promise<string[]> {
    const client = new Client({ name: 'resident-entrypoint-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization } } });
    try {
      await client.connect(transport);
      return (await client.listTools()).tools.map(({ name }) => name);
    } finally {
      try { await client.close(); } finally { await transport.close(); }
    }
  }

  it('binds the resident listener on 127.0.0.1 and serves a client with the printed bearer token', async () => {
    process.argv = [...argvBackup.slice(0, 2), '--http', '--http-port', '0'];
    const startup = captureStartup();
    await startup.ready;
    try {
      const output = startup.lines.join('');
      const url = /MCP HTTP listening on (\S+)/u.exec(output)?.[1];
      const authorization = /Authorization: (Bearer [0-9a-f]{64})/u.exec(output)?.[1];
      expect(url).toBeDefined();
      expect(authorization).toBeDefined();
      expect(new URL(url!).hostname).toBe('127.0.0.1');
      expect(await listTools(url!, authorization!)).toContain('takt_list_tasks');
    } finally {
      startup.shutdown();
    }
    await vi.waitFor(() => { expect(startup.exits).toEqual([0]); });
  });

  it('hides a caller-supplied token from the startup output while still accepting it', async () => {
    process.argv = [...argvBackup.slice(0, 2), '--http', '--http-port', '0', '--http-token', 'supplied-secret-token'];
    const startup = captureStartup();
    await startup.ready;
    try {
      const output = startup.lines.join('');
      expect(output).toContain('Authorization: Bearer ********');
      expect(output).not.toContain('supplied-secret-token');
      const url = /MCP HTTP listening on (\S+)/u.exec(output)?.[1];
      expect(url).toBeDefined();
      expect(await listTools(url!, 'Bearer supplied-secret-token')).toContain('takt_list_tasks');
    } finally {
      startup.shutdown();
    }
  });

  it('does not open an HTTP listener when --http is absent', async () => {
    process.argv = [...argvBackup.slice(0, 2)];
    const stdio = vi.fn(async () => {});
    const lines: string[] = [];
    await connectTaktMcpServerToHttp({ connectStdio: stdio, writeStartup: (line) => { lines.push(line); } });
    expect(stdio).toHaveBeenCalledOnce();
    expect(lines.join('')).not.toContain('MCP HTTP listening on');
  });

  it.each(['-h', '--help'])('writes %s help to stderr so the stdio protocol stream stays clean', async (flag) => {
    process.argv = [...argvBackup.slice(0, 2), '--tool-set', 'read-only', flag];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await connectTaktMcpServerToHttp();
      expect(stdout).not.toHaveBeenCalled();
      const usage = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(usage).toContain('Usage: takt-mcp');
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

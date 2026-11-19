import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaktMcpServer } from '../app/mcp/server.js';
import type { TaktMcpHttpConnection } from '../infra/mcp/serverHttpTransport.js';
import { startTaktMcpHttpConnection } from '../infra/mcp/serverHttpTransport.js';
import { firstTextContent } from './helpers/mcp-content.js';

describe('takt-mcp HTTP transport integration', () => {
  let cwd: string;
  let connection: TaktMcpHttpConnection | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-http-'));
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'branch_name_strategy: romaji\nprovider: mock\n', 'utf-8');
  });

  afterEach(async () => {
    if (connection !== undefined) await connection.dispose();
    connection = undefined;
    rmSync(cwd, { recursive: true, force: true });
  });

  async function serve(): Promise<TaktMcpHttpConnection> {
    connection = await startTaktMcpHttpConnection({
      createServer: () => createTaktMcpServer({}, { toolSet: 'all', allowedProjectRoot: cwd }),
      host: '127.0.0.1', port: 0,
    });
    return connection;
  }

  async function clientFor(target: TaktMcpHttpConnection, headers: Record<string, string> = { authorization: target.authorization }): Promise<Client> {
    const client = new Client({ name: 'takt-mcp-http-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(target.url), { requestInit: { headers } });
    await client.connect(transport);
    return client;
  }

  it('Given the HTTP server, When a loopback client lists tasks, Then a persistent listener on 127.0.0.1 answers the MCP protocol', async () => {
    const target = await serve();
    expect(new URL(target.url).hostname).toBe('127.0.0.1');
    expect(target.authorization).toMatch(/^Bearer [0-9a-f]{64}$/u);

    const client = await clientFor(target);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['takt_list_tasks']));
      const result = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd } });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(result.content)).tasks).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('Given the same listener, When two clients connect, Then both share one resident server and a closed client leaves the other working', async () => {
    const target = await serve();
    const first = await clientFor(target);
    const second = await clientFor(target);
    try {
      expect((await first.listTools()).tools.map((tool) => tool.name)).toContain('takt_list_tasks');
      expect((await second.listTools()).tools.map((tool) => tool.name)).toContain('takt_list_tasks');

      const enqueued = await first.callTool({ name: 'takt_enqueue_task', arguments: {
        cwd, task: 'enqueue through http', workflow: 'default', autoPr: false,
      } });
      expect(enqueued.isError, firstTextContent(enqueued.content)).toBeUndefined();
    } finally {
      await second.close();
    }
    const afterPeerClose = await first.callTool({ name: 'takt_list_tasks', arguments: { cwd } });
    expect(afterPeerClose.isError).toBeUndefined();
    expect(JSON.parse(firstTextContent(afterPeerClose.content)).tasks).toHaveLength(1);
    await first.close();
  });

  it('Given the loopback listener, When a request lacks or misstates the bearer token, Then it is rejected with 403', async () => {
    const target = await serve();

    const missing = await fetch(target.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(missing.status).toBe(403);

    const wrong = await fetch(target.url, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: 'Bearer ' + '0'.repeat(64),
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(wrong.status).toBe(403);
  });

  it('Given the loopback listener, When a request targets a path other than the root, Then it is rejected with 404', async () => {
    const target = await serve();
    const other = new URL('other', target.url);
    const response = await fetch(other, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: target.authorization,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(response.status).toBe(404);
  });

  it('Given a disposed server, When a client retries, Then the listener is closed so the connection is refused or the call fails', async () => {
    const target = await serve();
    const client = await clientFor(target);
    await client.close();
    await target.dispose();
    connection = undefined;
    await expect(fetch(target.url, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: target.authorization,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).rejects.toThrow();
  });
});

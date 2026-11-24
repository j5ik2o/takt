import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaktMcpServer } from '../app/mcp/server.js';
import { startLocalMcpConnection, type LocalMcpConnection } from '../features/mcp/localConnection.js';
import { startManagerMcpConnection } from '../features/manager/managerMcpConnection.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

describe('shared MCP HTTP transport', () => {
  let cwd: string;

  beforeEach(() => {
    const root = join(process.cwd(), '.tmp');
    mkdirSync(root, { recursive: true });
    cwd = realpathSync(mkdtempSync(join(root, 'mcp-http-shared-')));
    initializeGitFixture(cwd, []);
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\n');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('passes the requesting message and the live connection object to the local server factory', async () => {
    const seen: IncomingMessage[] = [];
    let factoryCount = 0;
    let sawLiveConnection: Promise<void> | undefined;
    const connection = await startLocalMcpConnection((request, localConnection) => {
      factoryCount += 1;
      seen.push(request);
      if (sawLiveConnection === undefined) sawLiveConnection = localConnection.assertConnected();
      return createTaktMcpServer({}, { toolSet: 'all', allowedProjectRoot: cwd });
    });
    try {
      const client = new Client({ name: 'factory-request-test', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(connection.config.url), { requestInit: { headers: connection.config.headers } });
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools.map(({ name }) => name)).toContain('takt_list_tasks');
      } finally {
        try { await client.close(); } finally { await transport.close(); }
      }
      expect(factoryCount).toBe(1);
      expect(seen[0]!.headers.authorization).toBe(connection.config.headers!.authorization);
      await expect(sawLiveConnection!).resolves.toBeUndefined();
      await expect(connection.assertConnected()).resolves.toBeUndefined();
    } finally {
      await connection.dispose();
    }
  });

  it('answers 400 and registers no session when the local server factory throws', async () => {
    const connection = await startLocalMcpConnection(() => { throw new Error('factory failed'); });
    try {
      const first = await post(connection.config.url, connection.config.headers!, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
      expect(first).toBe(400);
      const second = await post(connection.config.url, connection.config.headers!, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize' }));
      expect(second).toBe(400);
    } finally {
      await connection.dispose();
    }
  });

  it('derives the local endpoint from the shared listener address with a generated bearer token', async () => {
    const connection = await startLocalMcpConnection(() => createTaktMcpServer({}, { toolSet: 'all', allowedProjectRoot: cwd }));
    try {
      expect(connection.config.type).toBe('http');
      expect(connection.config.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
      expect(connection.config.headers?.authorization).toMatch(/^Bearer [0-9a-f]{64}$/u);
    } finally {
      await connection.dispose();
    }
  });

  it('rejects requests and fails assertConnected on the same connection after invalidation', async () => {
    const connection = await startManagerMcpConnection(cwd);
    const client = new Client({ name: 'invalidate-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(connection.config.url), { requestInit: { headers: connection.config.headers } });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain('takt_pause_goal');
      connection.invalidate();
      await expect(client.listTools()).rejects.toThrow();
      await expect(connection.assertConnected()).rejects.toThrow();
    } finally {
      try { await client.close(); } finally { try { await transport.close(); } finally { await connection.dispose(); } }
    }
  });

  it('withholds the bearer token from the answer to an unauthenticated request', async () => {
    const connection = await startManagerMcpConnection(cwd);
    try {
      const token = connection.config.headers?.authorization;
      const response = await fetch(connection.config.url, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + '0'.repeat(64) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(token).toBeDefined();
      expect(body).not.toContain(token!.slice('Bearer '.length));
    } finally {
      await connection.dispose();
    }
  });

  it('does not let a local connection entrypoint choose the listener port or token', () => {
    expect(startLocalMcpConnection.length).toBe(1);
  });

  it('routes the local entrypoint through the shared infra transport without the resident variant', async () => {
    const infra = await import('../infra/mcp/serverHttpTransport.js');
    const localSpy = vi.spyOn(infra, 'startLocalMcpHttpConnection');
    const residentSpy = vi.spyOn(infra, 'startTaktMcpHttpConnection');
    const connection = await startLocalMcpConnection(() => createTaktMcpServer({}, { toolSet: 'all', allowedProjectRoot: cwd }));
    try {
      expect(localSpy).toHaveBeenCalledOnce();
      expect(residentSpy).not.toHaveBeenCalled();
      expect(localSpy.mock.calls[0]![0].createServer).toEqual(expect.any(Function));
    } finally {
      await connection.dispose();
      localSpy.mockRestore();
      residentSpy.mockRestore();
    }
  });
});

function post(url: string, headers: Record<string, string>, body: string): Promise<number> {
  return fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body })
    .then(async (response) => { await response.text(); return response.status; });
}

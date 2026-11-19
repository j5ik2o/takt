import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface TaktMcpHttpConnection {
  readonly url: string;
  readonly authorization: string;
  dispose(): Promise<void>;
}

export interface StartTaktMcpHttpConnectionOptions {
  readonly createServer: () => McpServer;
  readonly host: string;
  readonly port: number;
  readonly token?: string;
}

interface TaktMcpHttpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export async function startTaktMcpHttpConnection(
  options: StartTaktMcpHttpConnectionOptions,
): Promise<TaktMcpHttpConnection> {
  const authorization = `Bearer ${options.token ?? randomBytes(32).toString('hex')}`;
  const expected = Buffer.from(authorization);
  const sessions = new Map<string, TaktMcpHttpSession>();
  let active = true;
  const closeSession = async (session: TaktMcpHttpSession): Promise<void> => {
    try { await session.server.close(); }
    finally { await session.transport.close(); }
  };
  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (!active || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      req.resume(); res.writeHead(403); res.end(); return;
    }
    if (req.url !== '/') { req.resume(); res.writeHead(404); res.end(); return; }
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId !== undefined) {
      const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (session === undefined) { req.resume(); res.writeHead(404); res.end(); return; }
      await session.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') { req.resume(); res.writeHead(400); res.end(); return; }
    const id = randomUUID();
    if (sessions.has(id)) { req.resume(); res.writeHead(409); res.end(); return; }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableJsonResponse: true,
      onsessionclosed: () => { sessions.delete(id); },
    });
    const server = options.createServer();
    const session = { server, transport };
    sessions.set(id, session);
    let connected = false;
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
      connected = transport.sessionId !== undefined;
    } finally {
      if (!connected || !active) {
        sessions.delete(id);
        await closeSession(session);
      }
    }
  };
  const listener = createHttpServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      // SDK や通信例外に含まれ得る認証情報を応答へ渡さない。
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const dispose = async (): Promise<void> => {
    active = false;
    const results = await Promise.allSettled([...sessions.values()].map(closeSession));
    sessions.clear();
    listener.closeAllConnections();
    const closed = await Promise.allSettled([new Promise<void>((resolve, reject) => {
      if (!listener.listening) { resolve(); return; }
      listener.close((error) => error ? reject(error) : resolve());
    })]);
    const failures = [...results, ...closed].filter((result) => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), 'Takt MCP HTTP cleanup failed');
  };
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(options.port, options.host, () => { listener.removeListener('error', reject); resolve(); });
    });
    const address = listener.address();
    if (address === null || typeof address === 'string') throw new Error('Takt MCP HTTP endpoint has no TCP address');
    return { url: `http://${options.host}:${address.port}/`, authorization, dispose };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Takt MCP HTTP startup and cleanup failed'); }
    throw error;
  }
}

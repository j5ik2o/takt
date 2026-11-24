import type { IncomingMessage } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpHttpServerConfig } from '../../core/models/workflow-provider-options.js';
import { startLocalMcpHttpConnection } from '../../infra/mcp/serverHttpTransport.js';

export interface LocalMcpConnection {
  assertConnected(): Promise<void>;
}

export async function startLocalMcpConnection(createServer: (request: IncomingMessage, connection: LocalMcpConnection) => McpServer) {
  const connection = await startLocalMcpHttpConnection({ createServer });
  const config: McpHttpServerConfig = {
    type: 'http', url: connection.url,
    headers: { authorization: connection.authorization },
  };
  return { assertConnected: connection.assertConnected, config, invalidate: connection.invalidate, dispose: connection.dispose };
}

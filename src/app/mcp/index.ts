#!/usr/bin/env node

import '../environment.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTaktMcpServer } from './server.js';
import { isDirectEntrypoint } from '../../shared/utils/entrypoint.js';
import { startTaktMcpHttpConnection, type TaktMcpHttpConnection } from '../../infra/mcp/serverHttpTransport.js';

import { MANAGER_ASSIGNMENT_ENV, managerAssignmentSchema } from '../../features/manager/assignment.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';

export type TaktMcpToolSet = 'all' | 'read-only' | 'manager';

export interface ConnectTaktMcpServerToHttpOptions {
  readonly connectStdio?: () => Promise<void>;
  readonly writeStartup?: (line: string) => void;
  readonly writeHelp?: (line: string) => void;
  readonly onSignal?: (handler: () => void) => void;
  readonly exit?: (code: number) => void;
}

interface TaktMcpServerSettingsOptions {
  readonly toolSet: TaktMcpToolSet;
  readonly includeReferenceMarkers: boolean;
}

interface TaktMcpHttpCliOptions {
  readonly port: number;
  readonly token?: string;
}

function resolveToolSet(argv: readonly string[]): TaktMcpToolSet {
  const index = argv.indexOf('--tool-set');
  if (index === -1) {
    return 'all';
  }
  const value = argv[index + 1];
  if (value === 'all' || value === 'read-only' || value === 'manager') {
    return value;
  }
  throw new Error('--tool-set must be "all", "read-only" or "manager"');
}

function shouldIncludeReferenceMarkers(argv: readonly string[]): boolean {
  return argv.includes('--include-reference-markers');
}

function resolveHttpPort(argv: readonly string[]): number {
  const index = argv.indexOf('--http-port');
  if (index === -1) {
    return 0;
  }
  const value = argv[index + 1];
  const port = value === undefined ? Number.NaN : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('--http-port must be an integer between 0 and 65535');
  }
  return port;
}

function resolveHttpToken(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--http-token');
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error('--http-token requires a non-empty value');
  }
  return value;
}

async function createServerOptions(options: TaktMcpServerSettingsOptions) {
  const rawAssignment = process.env[MANAGER_ASSIGNMENT_ENV];
  const managerAssignment = options.toolSet !== 'manager' ? undefined
    : rawAssignment === undefined
      ? { kind: 'repository' as const, repositoryDirectory: await resolveGitRepositoryDirectory(process.cwd()) }
      : managerAssignmentSchema.parse(JSON.parse(rawAssignment));
  return {
    toolSet: options.toolSet, managerAssignment,
    includeReferenceMarkers: options.includeReferenceMarkers,
  };
}

export async function connectTaktMcpServerToStdio(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = await createServerOptions({
    toolSet: resolveToolSet(argv),
    includeReferenceMarkers: shouldIncludeReferenceMarkers(argv),
  });
  const server = createTaktMcpServer({}, options);
  await server.connect(new StdioServerTransport());
}

const TAKT_MCP_USAGE = [
  'Usage: takt-mcp [--tool-set all|read-only|manager] [--include-reference-markers] [--http [--http-port N] [--http-token TOKEN]]',
  '',
  'Without --http, takt-mcp serves the Model Context Protocol over stdio.',
  'With --http, takt-mcp listens for Streamable HTTP on 127.0.0.1 only.',
  '  --http-port N     TCP port to bind on 127.0.0.1 (default 0: OS-assigned).',
  '  --http-token TOK  Bearer token clients must send; generated and printed when omitted.',
  '',
].join('\n');

// 常駐 HTTP の listener とセッションはプロセス終了まで生存するため、signal で確実に
// 一度だけ dispose し、二重 signal でも多重実行しないようガードする。
function registerShutdown(
  connection: TaktMcpHttpConnection,
  onSignal: (handler: () => void) => void,
  exit: (code: number) => void,
): void {
  let shuttingDown = false;
  onSignal(() => {
    if (shuttingDown) return;
    shuttingDown = true;
    connection.dispose()
      .then(() => exit(0))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        exit(1);
      });
  });
}

export async function connectTaktMcpServerToHttp(
  input: ConnectTaktMcpServerToHttpOptions = {},
): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    // MCP の stdio では stdout がプロトコル専用のため、ヘルプは stderr へ出す。
    (input.writeHelp ?? ((line: string) => { process.stderr.write(line); }))(TAKT_MCP_USAGE);
    return;
  }
  if (!argv.includes('--http')) {
    await (input.connectStdio ?? connectTaktMcpServerToStdio)();
    return;
  }
  const httpOptions: TaktMcpHttpCliOptions = {
    port: resolveHttpPort(argv),
    token: resolveHttpToken(argv),
  };
  const serverOptions = await createServerOptions({
    toolSet: resolveToolSet(argv),
    includeReferenceMarkers: shouldIncludeReferenceMarkers(argv),
  });
  const connection = await startTaktMcpHttpConnection({
    createServer: () => createTaktMcpServer({}, serverOptions),
    host: '127.0.0.1',
    port: httpOptions.port,
    ...(httpOptions.token === undefined ? {} : { token: httpOptions.token }),
  });
  const writeStartup = input.writeStartup ?? ((line: string) => { process.stderr.write(line); });
  const authorizationForDisplay = httpOptions.token === undefined ? connection.authorization : 'Bearer ********';
  writeStartup(`MCP HTTP listening on ${connection.url}\nAuthorization: ${authorizationForDisplay}\n`);
  const onSignal = input.onSignal ?? ((handler: () => void) => {
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
  });
  const exit = input.exit ?? ((code: number) => { process.exit(code); });
  registerShutdown(connection, onSignal, exit);
}

if (isDirectEntrypoint(import.meta.url)) {
  connectTaktMcpServerToHttp().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

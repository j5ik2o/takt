import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  connect: vi.fn(),
  connectStdio: vi.fn(),
  http: vi.fn(),
  pool: vi.fn(),
  resolveRepository: vi.fn(),
  stdioTransport: vi.fn(),
  writeStdout: vi.fn(),
}));

// A real listener would make the unit test depend on the host network. The HTTP
// start helper is replaced so this file observes only the entrypoint wiring.
vi.mock('../infra/mcp/serverHttpTransport.js', () => ({ startTaktMcpHttpConnection: doubles.http }));
vi.mock('../app/mcp/server.js', () => ({ createTaktMcpServer: doubles.pool }));
vi.mock('../infra/task/repositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: doubles.resolveRepository }));
vi.mock('../shared/utils/entrypoint.js', () => ({ isDirectEntrypoint: () => false }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: doubles.stdioTransport }));

import { connectTaktMcpServerToHttp, connectTaktMcpServerToStdio } from '../app/mcp/index.js';

function createdServer() {
  return { connect: doubles.connect };
}

function httpConnection(url = 'http://127.0.0.1:41234/') {
  return {
    url,
    authorization: 'Bearer ' + 'a'.repeat(64),
    dispose: vi.fn(async () => {}),
  };
}

describe('takt-mcp HTTP entrypoint flag', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    doubles.pool.mockImplementation(() => createdServer());
    doubles.connect.mockResolvedValue(undefined);
    doubles.http.mockImplementation(async () => httpConnection());
    doubles.resolveRepository.mockResolvedValue('/repository');
    doubles.stdioTransport.mockImplementation(function StdioServerTransport() { return { kind: 'stdio' }; });
    process.argv = ['node', 'takt-mcp'];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('starts the stdio transport and never the HTTP listener when --http is absent', async () => {
    process.argv.push('--tool-set', 'all');

    await connectTaktMcpServerToHttp({ connectStdio: connectTaktMcpServerToStdio, writeStartup: doubles.writeStdout });

    expect(doubles.http).not.toHaveBeenCalled();
    expect(doubles.pool).toHaveBeenCalledOnce();
    expect(doubles.connect).toHaveBeenCalledOnce();
    expect(doubles.writeStdout).not.toHaveBeenCalled();
  });

  it('reuses the stdio connector when --http is absent so stdio stays the default transport', async () => {
    await connectTaktMcpServerToHttp({ connectStdio: doubles.connectStdio, writeStartup: doubles.writeStdout });

    expect(doubles.connectStdio).toHaveBeenCalledOnce();
    expect(doubles.http).not.toHaveBeenCalled();
    expect(doubles.pool).not.toHaveBeenCalled();
  });

  it('serves over HTTP on the loopback address and skips the stdio transport when --http is present', async () => {
    process.argv.push('--http');

    await connectTaktMcpServerToHttp({ connectStdio: doubles.connectStdio, writeStartup: doubles.writeStdout });

    expect(doubles.connectStdio).not.toHaveBeenCalled();
    expect(doubles.stdioTransport).not.toHaveBeenCalled();
    expect(doubles.http).toHaveBeenCalledOnce();
    expect(doubles.http.mock.calls[0]?.[0]).toMatchObject({ port: 0 });
    expect(doubles.writeStdout).toHaveBeenCalledOnce();
  });

  it('binds only the loopback host and forwards requested port and tool-set options to the HTTP server', async () => {
    process.argv.push('--http', '--http-port', '7000', '--tool-set', 'read-only', '--include-reference-markers');

    await connectTaktMcpServerToHttp({ connectStdio: doubles.connectStdio, writeStartup: doubles.writeStdout });

    expect(doubles.http).toHaveBeenCalledOnce();
    const options = doubles.http.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).toMatchObject({ host: '127.0.0.1', port: 7000 });
    const createServer = options.createServer as () => unknown;
    createServer();
    expect(doubles.pool).toHaveBeenCalledWith({}, expect.objectContaining({
      toolSet: 'read-only', includeReferenceMarkers: true,
    }));
  });

  it('passes the provided authentication token to the HTTP server instead of generating one', async () => {
    process.argv.push('--http', '--http-token', 'injected-token');

    await connectTaktMcpServerToHttp({ connectStdio: doubles.connectStdio, writeStartup: doubles.writeStdout });

    expect(doubles.http).toHaveBeenCalledOnce();
    expect(doubles.http.mock.calls[0]?.[0]).toMatchObject({ token: 'injected-token' });
  });

  it('reports the bound URL and the connection Bearer token so a client can authenticate', async () => {
    process.argv.push('--http');
    const lines: string[] = [];
    doubles.writeStdout.mockImplementation((line: string) => lines.push(line));
    doubles.http.mockImplementation(async () => httpConnection('http://127.0.0.1:55999/'));

    await connectTaktMcpServerToHttp({ connectStdio: doubles.connectStdio, writeStartup: doubles.writeStdout });

    const printed = lines.join('\n');
    expect(printed).toContain('http://127.0.0.1:55999/');
    expect(printed).toContain('Bearer ' + 'a'.repeat(64));
  });

  it('does not print the connection Bearer <redacted> when the token was provided with --http-token', async () => {
    process.argv.push('--http', '--http-token', 'injected-token');
    const lines: string[] = [];
    doubles.writeStdout.mockImplementation((line: string) => lines.push(line));
    doubles.http.mockImplementation(async () => httpConnection('http://127.0.0.1:55999/'));

    await connectTaktMcpServerToHttp({ connectStdio: doubles.connectStdio, writeStartup: doubles.writeStdout });

    const printed = lines.join('\n');
    expect(printed).toContain('http://127.0.0.1:55999/');
    expect(printed).not.toContain('Bearer ' + 'a'.repeat(64));
    expect(printed).not.toContain('injected-token');
  });

  it('rejects an --http-port value that is not a TCP port before starting the server', async () => {
    process.argv.push('--http', '--http-port', 'not-a-port');

    await expect(connectTaktMcpServerToHttp({ connectStdio: doubles.connectStdio, writeStartup: doubles.writeStdout }))
      .rejects.toThrow(/http-port/u);
    expect(doubles.http).not.toHaveBeenCalled();
    expect(doubles.connectStdio).not.toHaveBeenCalled();
  });

  it.each(['--help', '-h'])('prints usage for %s without connecting stdio or listening', async (flag) => {
    process.argv.push(flag);
    const lines: string[] = [];

    await connectTaktMcpServerToHttp({
      connectStdio: doubles.connectStdio,
      writeStartup: doubles.writeStdout,
      writeHelp: (line) => lines.push(line),
    });

    const printed = lines.join('\n');
    expect(printed).toContain('--http');
    expect(printed).toContain('--http-port');
    expect(printed).toContain('--http-token');
    expect(printed).toContain('127.0.0.1');
    expect(doubles.connectStdio).not.toHaveBeenCalled();
    expect(doubles.http).not.toHaveBeenCalled();
    expect(doubles.pool).not.toHaveBeenCalled();
    expect(doubles.writeStdout).not.toHaveBeenCalled();
  });

  it('disposes the HTTP connection exactly once and exits after a shutdown signal', async () => {
    process.argv.push('--http');
    let registered: (() => void) | undefined;
    const onSignal = (handler: () => void) => { registered = handler; };
    const exit = vi.fn();
    const connection = httpConnection();
    doubles.http.mockImplementation(async () => connection);

    await connectTaktMcpServerToHttp({ connectStdio: doubles.connectStdio, writeStartup: doubles.writeStdout, onSignal, exit });

    expect(registered).toBeTypeOf('function');
    expect(connection.dispose).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    registered!();
    registered!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(connection.dispose).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('exits with a non-zero code after a shutdown signal even when dispose rejects', async () => {
    process.argv.push('--http');
    let registered: (() => void) | undefined;
    const onSignal = (handler: () => void) => { registered = handler; };
    const exit = vi.fn();
    const connection = httpConnection();
    connection.dispose.mockImplementation(async () => { throw new Error('cleanup failed'); });
    doubles.http.mockImplementation(async () => connection);

    await connectTaktMcpServerToHttp({ connectStdio: doubles.connectStdio, writeStartup: doubles.writeStdout, onSignal, exit });

    registered!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(connection.dispose).toHaveBeenCalledOnce();
  });
});

import { firstTextContent } from './helpers/mcp-content.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { TSX_ESM_LOADER } from './helpers/typescript-source.js';

const SOURCE_STDIO_ENTRYPOINT_RUNNER = 'src/__tests__/helpers/mcp-source-stdio-entrypoint.ts';
const SOURCE_ENTRYPOINT = 'src/app/mcp/index.ts';


describe('MCP stdio entrypoint integration', () => {
  it('Given the source MCP entrypoint, When a stdio MCP client lists and calls tools, Then stdout remains valid MCP protocol', async () => {
    const cwd = mkdtempSync(join(process.cwd(), '.tmp-takt-mcp-stdio-'));
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'branch_name_strategy: romaji\nprovider: mock\n', 'utf-8');
    const client = new Client({ name: 'takt-mcp-stdio-test-client', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        TSX_ESM_LOADER,
        SOURCE_STDIO_ENTRYPOINT_RUNNER,
      ],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        // Keep the spawned MCP server hermetic: without this it falls back to
        // the operator's real ~/.takt/config.yaml.
        ...(process.env.TAKT_CONFIG_DIR !== undefined
          ? { TAKT_CONFIG_DIR: process.env.TAKT_CONFIG_DIR }
          : {}),
      },
      stderr: 'pipe',
    });
    const stderrChunks: Buffer[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const historyDescription = tools.tools.find((tool) => tool.name === 'takt_list_recent_messages')?.description;
      expect(historyDescription).toMatch(/human, manager, director and unknown speakers/u);
      expect(historyDescription).toMatch(/unknown means author information is absent from legacy records/u);
      const result = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd,
          task: 'Enqueue through the stdio MCP server',
          workflow: 'default',
          autoPr: false,
        },
      });

      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'takt_enqueue_task',
        'takt_list_tasks',
        'takt_get_run',
        'takt_tell_run',
        'takt_send_message',
        'takt_list_recent_messages',
      ]));
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(result.content))).toEqual(expect.objectContaining({
        tasksFile: join(cwd, '.takt', 'tasks.yaml'),
        workflow: 'default',
      }));
      const listed = await client.callTool({
        name: 'takt_list_tasks',
        arguments: { cwd },
      });
      expect(listed.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(listed.content))).toEqual(expect.objectContaining({
        tasks: expect.arrayContaining([
          expect.objectContaining({
            status: 'pending',
            workflow: 'default',
          }),
        ]),
      }));
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      expect(stderr).not.toMatch(/(?:^|\n)(?:Error|TypeError|ReferenceError|SyntaxError):/u);
      expect(stderr).not.toMatch(/(?:^|\n)\s+at\s+/u);
    } finally {
      await client.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // The runner above overrides process.argv[1] before importing the entrypoint,
  // and the unit test mocks isDirectEntrypoint. Neither reaches the real
  // `if (isDirectEntrypoint(...))` branch that picks stdio when --http is absent,
  // so a broken stdio dispatch there would go unnoticed. This case runs the
  // source entrypoint directly so argv[1] resolves to the module path itself.
  it('Given the real entrypoint run directly without --http, When stdio lists tools, Then tools answer and no HTTP listener starts', async () => {
    const cwd = mkdtempSync(join(process.cwd(), '.tmp-takt-mcp-direct-'));
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'branch_name_strategy: romaji\nprovider: mock\n', 'utf-8');
    const client = new Client({ name: 'takt-mcp-direct-test-client', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', TSX_ESM_LOADER, SOURCE_ENTRYPOINT],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        ...(process.env.TAKT_CONFIG_DIR !== undefined
          ? { TAKT_CONFIG_DIR: process.env.TAKT_CONFIG_DIR }
          : {}),
      },
      stderr: 'pipe',
    });
    const stderrChunks: Buffer[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'takt_enqueue_task',
        'takt_list_tasks',
      ]));
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      expect(stderr).not.toContain('MCP HTTP listening on');
    } finally {
      await client.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

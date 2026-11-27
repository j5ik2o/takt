/**
 * #171 (review 1): the finish hook runs in the same process as the `takt-mcp` stdio server, where
 * stdout carries the JSON-RPC stream. A hook notice must never put a byte on stdout.
 *
 * The real source entrypoint is loaded in a forked child, so `process.stdout` stays the child's
 * stdout pipe. A test-only preload replaces `process.stdout.write` in the child and records every
 * write (offset, size, and whether the text is protocol JSON), and every write that carries a
 * finish-hook notice together with the tool call the client sent just before it. `console.log`
 * throws in the child, so a notice cannot slip into the stream unnoticed.
 *
 * The parent speaks JSON-RPC to the child (initialize, tools/list, then two tools/call requests for
 * a project that has a saved terminal task and a hook command that cannot start) and then asserts
 * both sides of the stream: the child wrote nothing but the four protocol responses, and the client
 * saw no stray line between them.
 *
 * The fixture saves a terminal task and configures the finish hook, so as soon as an MCP tool calls
 * the hook the stray bytes are recorded and this case goes red. No MCP tool calls the hook today, so
 * the same saved state's in-process contract is asserted by
 * src/__tests__/task-finish-hook-notice.test.ts. Git is not involved: the hook only reads the saved
 * state and fails to spawn a command that is not there.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TSX_ESM_LOADER } from './helpers/typescript-source.js';

const MISSING_HOOK_COMMAND = path.join(os.tmpdir(), 'takt-171-finish-hook-command-that-does-not-exist');

/**
 * Loaded in the child before the server. Every stdout write is recorded; `console.log` throws.
 * `TAKT_171_STDOUT_RECORD` is where the notice entries and the protocol record are written.
 */
const PRELOAD_SOURCE = `
const fs = require('node:fs');
const recordFile = process.env.TAKT_171_STDOUT_RECORD;
const original = process.stdout.write.bind(process.stdout);
const pending = new Map();
let offset = 0;
const isToolsCall = (value) => value !== null && typeof value === 'object' && value.method === 'tools/call';
const isProtocolMessage = (value) => value !== null && typeof value === 'object'
  && (value.result !== undefined || value.error !== undefined);
fs.appendFileSync(recordFile, JSON.stringify({ kind: 'loaded' }) + '\\n');
process.stdout.write = function (chunk, encoding, callback) {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
  let protocol = false;
  try {
    const message = JSON.parse(text);
    protocol = isProtocolMessage(message);
    if (isToolsCall(message)) pending.set(String(message.id), message);
    else if (message !== null && typeof message === 'object'
      && typeof message.id === 'string' && message.id.startsWith('171-')) pending.delete(message.id);
  } catch {
    // A partial or non-protocol write.
  }
  fs.appendFileSync(recordFile, JSON.stringify({
    kind: 'write', at: offset, bytes: Buffer.byteLength(text), protocol,
  }) + '\\n');
  offset += Buffer.byteLength(text);
  const noticeAt = text.indexOf('Task finish hook');
  if (noticeAt !== -1) {
    fs.appendFileSync(recordFile, JSON.stringify({
      kind: 'notice',
      request: pending.size === 0 ? null : [...pending.values()].pop(),
      offset: offset + noticeAt,
      text: text.slice(0, 4096),
    }) + '\\n');
  }
  return original(chunk, encoding, callback);
};
const refuse = (name) => function () {
  throw new Error('the 171 preload refuses console.' + name + ' in the MCP stdio server');
};
console.log = refuse('log');
console.info = refuse('info');
`;

/** A record of one stdout write in the child, or of a notice inside one. */
type RecordedEntry =
  | { kind: 'loaded' }
  | { kind: 'write'; at: number; bytes: number; protocol: boolean }
  | { kind: 'notice'; request: { method?: string; params?: { name?: string } } | null; offset: number; text: string };

interface JsonRpcResponse {
  id: string;
  result?: { tools?: { name: string }[]; isError?: boolean };
  error?: { message?: string };
}

/** A minimal stdio MCP client for the child: newline-delimited JSON-RPC over stdin and stdout. */
class ChildMcpClient {
  private buffer = '';
  private readonly pending = new Map<string, (message: JsonRpcResponse) => void>();
  private readonly closed: Promise<void>;
  readonly strayLines: string[] = [];

  constructor(private readonly child: ReturnType<typeof fork>) {
    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (chunk: string) => this.receive(chunk));
    this.closed = new Promise((resolve) => {
      child.on('close', () => resolve());
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() === '') continue;
      try {
        const message = JSON.parse(line) as JsonRpcResponse;
        const resolve = this.pending.get(message.id);
        if (resolve === undefined) {
          this.strayLines.push(line);
          continue;
        }
        this.pending.delete(message.id);
        resolve(message);
      } catch {
        this.strayLines.push(line);
      }
    }
  }

  request(method: string, params: unknown, id: string, timeoutMs = 30_000): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no response to ${method} (${id}) within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  async close(): Promise<void> {
    this.child.stdin!.end();
    await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }
}

const tempDirs = new Set<string>();

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.add(dir);
  return dir;
}

function makeProject(): string {
  const dir = makeTempDir('takt-171-mcp-');
  fs.mkdirSync(path.join(dir, '.takt'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.takt', 'config.yaml'), stringifyYaml({
    language: 'en',
    provider: 'mock',
    task_finish_hook: { command: [MISSING_HOOK_COMMAND], timeout_ms: 100 },
  }), 'utf-8');
  invalidateAllResolvedConfigCache();
  return dir;
}

/**
 * Saves a task as `completed` without an execution, as publishing a `pr_failed` task does. A read of
 * the saved states with the hook configured calls the hook for it, because no execution in this
 * process stamped the state.
 */
function saveCompletedTask(project: string): void {
  const runner = new TaskRunner(project);
  const task = runner.addTask('Do the work', { workflow: 'default' });
  runner.prFailTask({
    task,
    success: true,
    response: 'PR creation failed',
    executionLog: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:00.000Z',
  }, 'gh: not authenticated');
  runner.completePublishedTask(task.name, 'https://example.invalid/pull/1', 'b'.repeat(40));
}

function readRecords(file: string): RecordedEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').trim().split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RecordedEntry);
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  invalidateAllResolvedConfigCache();
});

describe('task finish hook notice over MCP stdio (#171)', () => {
  it('Given a saved terminal task whose finish hook cannot start, When the stdio server reports it, Then no notice byte reaches stdout', async () => {
    expect(fs.existsSync(MISSING_HOOK_COMMAND)).toBe(false);
    const project = makeProject();
    saveCompletedTask(project);
    const preloadDirectory = makeTempDir('takt-171-mcp-preload-');
    const preload = path.join(preloadDirectory, 'preload.cjs');
    const recordFile = path.join(preloadDirectory, 'stdout-record.jsonl');
    fs.writeFileSync(preload, PRELOAD_SOURCE, 'utf-8');

    // The entrypoint is loaded in a forked child so that its stdout is the child's pipe and the
    // preload can replace `process.stdout.write` there. `takt-mcp` runs the same module the same way.
    const entrypoint = path.resolve(process.cwd(), 'src/app/mcp/index.ts');
    const child = fork(entrypoint, [], {
      cwd: project,
      execArgv: ['--import', TSX_ESM_LOADER, '--require', path.resolve(preload)],
      silent: true,
      env: {
        ...process.env,
        TAKT_171_STDOUT_RECORD: recordFile,
      },
    });
    const stderrChunks: string[] = [];
    child.stderr!.setEncoding('utf-8');
    child.stderr!.on('data', (chunk: string) => stderrChunks.push(chunk));
    const client = new ChildMcpClient(child);

    try {
      const initialized = await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'takt-171-finish-hook-mcp-client', version: '1.0.0' },
      }, '171-0');
      expect(initialized.error).toBeUndefined();
      client.notify('notifications/initialized');

      const tools = await client.request('tools/list', {}, '171-1');
      expect(tools.error).toBeUndefined();
      expect(tools.result?.tools?.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['takt_list_tasks', 'takt_publish_pr_failed_goal_task']),
      );

      const listed = await client.request('tools/call', {
        name: 'takt_list_tasks',
        arguments: { cwd: project },
      }, '171-2');
      expect(listed.error).toBeUndefined();
      expect(listed.result?.isError).toBeUndefined();
      // A second request on the same stream: a notice written between two responses breaks both.
      const again = await client.request('tools/call', {
        name: 'takt_list_tasks',
        arguments: { cwd: project },
      }, '171-3');
      expect(again.error).toBeUndefined();
      expect(again.result?.isError).toBeUndefined();
    } finally {
      await client.close();
    }

    const records = readRecords(recordFile);
    expect(records[0]).toEqual({ kind: 'loaded' });
    const onStdout = records.filter((entry): entry is Extract<RecordedEntry, { kind: 'notice' }> =>
      entry.kind === 'notice');
    const where = onStdout.map((entry) =>
      `request ${JSON.stringify(entry.request)} wrote a notice at byte ${String(entry.offset)}`);
    expect(onStdout, where.join('\n')).toEqual([]);

    // The child wrote only protocol responses, and the client answered every request from them.
    const writes = records.filter((entry): entry is Extract<RecordedEntry, { kind: 'write' }> =>
      entry.kind === 'write');
    expect(writes.map((entry) => entry.protocol), 'every stdout write must be a protocol response').toEqual(
      writes.map(() => true),
    );
    // Four requests were answered, so silence on the stream is not what made the check above pass.
    expect(writes).toHaveLength(4);
    expect(client.strayLines).toEqual([]);
    // No tool reached the hook, so nothing was due on stderr either. That the notice itself goes to
    // stderr is asserted for the same saved state by src/__tests__/task-finish-hook-notice.test.ts.
    expect(stderrChunks.join('')).not.toContain('Task finish hook');
  }, 120_000);
});

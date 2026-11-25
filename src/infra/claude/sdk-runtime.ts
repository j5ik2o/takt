import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { resolveManagedGeneration } from '../managed-providers/generation.js';
import { managedPackageRoot } from '../managed-providers/package.js';

// Look where the query loads the SDK from: the installation made by `takt install claude-sdk`.
// The query verifies that installation's integrity when it loads it, so this only locates it.
async function resolveBundledCli(): Promise<string> {
  const missing = 'Claude SDK is not installed. Run `takt install claude-sdk`.';
  let directory: string | undefined;
  try {
    directory = await resolveManagedGeneration(managedPackageRoot('claude-sdk'), { platform: process.platform });
  } catch (cause) {
    throw new Error(missing, { cause });
  }
  if (directory === undefined) throw new Error(missing);
  const sdkRequire = createRequire(join(directory, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'));
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform === 'android' ? 'linux' : process.platform}-${process.arch}`;
  const report = (process.platform === 'linux' ? process.report?.getReport() : undefined) as
    { header: { glibcVersionRuntime?: string } } | undefined;
  const musl = report !== undefined && report.header.glibcVersionRuntime === undefined;
  const packages = process.platform === 'android' ? [`${base}-android`]
    : process.platform === 'linux' ? (musl ? [`${base}-musl`, base] : [base, `${base}-musl`])
    : [base];
  // Match the SDK's optional native-package selection without starting a query.
  for (const name of packages) {
    let path: string;
    try {
      path = sdkRequire.resolve(`${name}/claude${process.platform === 'win32' ? '.exe' : ''}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') continue;
      throw error;
    }
    if (existsSync(path)) return path;
  }
  throw new Error('Claude SDK native CLI is missing. Run `takt install claude-sdk --force`, or configure claude_cli_path.');
}

export async function assertClaudeSdkRuntime(options: Options, abortSignal?: AbortSignal): Promise<void> {
  abortSignal?.throwIfAborted();
  const path = options.pathToClaudeCodeExecutable || await resolveBundledCli();
  const isScript = ['.js', '.mjs', '.tsx', '.ts', '.jsx'].some((extension) => path.endsWith(extension));
  const help = await new Promise<string>((resolve, reject) => {
    execFile(isScript ? process.execPath : path, [...(isScript ? [path] : []), '--help'], {
      cwd: options.cwd,
      env: options.env,
      signal: abortSignal,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error('Cannot inspect Claude SDK CLI before startup', { cause: error }));
      else resolve(`${stdout}\n${stderr}`);
    });
  });
  const flags = [
    ...(options.tools !== undefined ? ['--tools'] : []),
    ...(options.strictMcpConfig === true ? ['--strict-mcp-config'] : []),
    ...(options.outputFormat !== undefined ? ['--json-schema'] : []),
  ];
  for (const flag of flags) {
    if (!help.includes(flag)) throw new Error(`Claude SDK CLI does not support required option ${flag}`);
  }
}

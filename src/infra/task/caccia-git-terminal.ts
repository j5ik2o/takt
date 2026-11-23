import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { ReadStream } from 'node:tty';
import type { IPty } from 'node-pty';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { trackCacciaCloneGit } from './caccia-git-processes.js';
import { TASK_EXECUTION_ABORTED_MESSAGE } from './clone-errors.js';

const log = createLogger('caccia-git-terminal');

function openControllingTerminal(): number | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    return openSync('/dev/tty', constants.O_RDWR | constants.O_NOCTTY);
  } catch (error) {
    if (error instanceof Error && 'code' in error
      && (error.code === 'ENXIO' || error.code === 'ENODEV' || error.code === 'ENOENT')) return undefined;
    throw error;
  }
}

/** Give a terminal commit an owned process group while relaying its signing prompts. */
export async function tryCacciaTerminalCommit(
  cwd: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal,
): Promise<boolean> {
  const fd = openControllingTerminal();
  if (fd === undefined) return false;
  let input: ReadStream | undefined;
  let pty: IPty;
  try {
    const { spawn } = await import('node-pty').catch((error: unknown) => {
      throw new Error('Caccia terminal commits require the optional node-pty dependency', { cause: error });
    });
    if (signal.aborted) throw new Error(TASK_EXECUTION_ABORTED_MESSAGE);
    input = new ReadStream(fd);
    // forkpty owns the session. exec preserves its leader PID, and GPG can
    // pass the inner terminal's actual device path to its agent.
    pty = spawn('/bin/sh', ['-c', 'GPG_TTY=$(tty) || exit 1; export GPG_TTY; exec git "$@"',
      'caccia-git', ...args], { cwd, env, name: process.env.TERM ?? 'xterm' });
  } catch (error) {
    if (input === undefined) closeSync(fd);
    else input.destroy();
    throw error;
  }
  await relayCommitTerminal(cwd, fd, input, pty, signal);
  return true;
}

function relayCommitTerminal(cwd: string, fd: number, input: ReadStream, pty: IPty, signal: AbortSignal): Promise<void> {
  const sendSignal = trackCacciaCloneGit(cwd, pty.pid, (name) => pty.kill(name),
    (onExit) => { pty.onExit(onExit); }) ?? ((name) => pty.kill(name));
  const changeRawMode = process.stdin.isRaw !== true;
  const restoreTerminal = (): void => {
    if (changeRawMode) input.setRawMode(false);
    input.destroy();
  };
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      process.removeListener('exit', restoreTerminal);
      output.dispose();
      restoreTerminal();
      if (error === undefined) resolve();
      else reject(error);
    };
    const terminate = (name: NodeJS.Signals): void => {
      if (finished) return;
      try {
        sendSignal(name);
      } catch (error) {
        log.warn('Could not signal terminal Git process', { signal: name, error: getErrorMessage(error) });
      }
    };
    const abort = (): void => {
      terminate('SIGINT');
      finish(new Error(TASK_EXECUTION_ABORTED_MESSAGE));
    };
    const terminalError = (error: Error): void => {
      terminate('SIGKILL');
      finish(error);
    };
    const output = pty.onData((data) => {
      try {
        writeSync(fd, data);
      } catch (error) {
        terminalError(new Error('Could not write to the Caccia controlling terminal', { cause: error }));
      }
    });
    pty.onExit(({ exitCode, signal: signalNumber }) => finish(exitCode === 0 && !signalNumber ? undefined
      : Object.assign(new Error(signalNumber ? `git commit stopped by signal ${signalNumber}`
        : `git commit exited with code ${exitCode}`), { status: exitCode })));
    input.on('error', terminalError);
    input.once('end', () => terminalError(new Error('Caccia controlling terminal closed')));
    process.once('exit', restoreTerminal);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    if (changeRawMode) input.setRawMode(true);
    if (finished) return;
    input.on('data', (data: Buffer) => {
      try {
        if (data.includes(3)) process.kill(process.pid, 'SIGINT');
        else pty.write(data);
      } catch (error) {
        terminalError(new Error('Could not read from the Caccia controlling terminal', { cause: error }));
      }
    });
  });
}

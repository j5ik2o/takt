/**
 * Properties 1-6 of docs/design/task-finish-hook-notice-loss.md (#171), written before the
 * implementation. No input is excluded: the arbitrary outcomes include timeouts, broken reads,
 * non-terminal states, config failures, control characters and known secret shapes.
 *
 * The reads are a fake `TaskRunner`, the config and the CLI context are module doubles, and the
 * 250 ms retry wait runs on fake timers. The notice is observed on stderr; stdout must stay empty
 * of it (the stdio MCP transport owns stdout for JSON-RPC).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import fc from 'fast-check';
import type { TaskRunner, TaskState } from '../infra/task/index.js';

import { scaledMs } from '../../scripts/test-time-factor.mjs';

const configState = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'missing' | 'unreadable' }));

vi.mock('../infra/config/project/projectConfig.js', async (original) => ({
  ...(await original<typeof import('../infra/config/project/projectConfig.js')>()),
  loadProjectConfig: () => {
    if (configState.mode === 'unreadable') {
      throw new Error('Configuration error: failed to parse /project/.takt/config.yaml');
    }
    return {
      taskFinishHook: configState.mode === 'missing'
        ? undefined
        : { command: ['hook-command'], timeoutMs: 100 },
    };
  },
}));

const bounded = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../shared/utils/bounded-command-runner.js', async (original) => ({
  ...(await original<typeof import('../shared/utils/bounded-command-runner.js')>()),
  runBoundedCommand: bounded.run,
}));

const cli = vi.hoisted(() => ({
  initGlobalDirs: vi.fn(async () => undefined),
  initProjectDirs: vi.fn(),
  initGitProvider: vi.fn(),
  prepareRuntimeAssignmentInvocation: vi.fn(),
  initializeRuntimeAssignmentInvocation: vi.fn(),
  isVerboseMode: vi.fn(() => false),
  resolveConfigValues: vi.fn(() => ({ logging: undefined, minimalOutput: false })),
  initDebugLogger: vi.fn(),
  setVerboseConsole: vi.fn(),
}));

vi.mock('../infra/config/global/initialization.js', async (original) => ({
  ...(await original<typeof import('../infra/config/global/initialization.js')>()),
  initGlobalDirs: cli.initGlobalDirs,
  initProjectDirs: cli.initProjectDirs,
}));
vi.mock('../infra/config/runtime-provider/invocation.js', async (original) => ({
  ...(await original<typeof import('../infra/config/runtime-provider/invocation.js')>()),
  prepareRuntimeAssignmentInvocation: cli.prepareRuntimeAssignmentInvocation,
  initializeRuntimeAssignmentInvocation: cli.initializeRuntimeAssignmentInvocation,
}));
vi.mock('../infra/config/project/resolvedSettings.js', async (original) => ({
  ...(await original<typeof import('../infra/config/project/resolvedSettings.js')>()),
  isVerboseMode: cli.isVerboseMode,
}));
vi.mock('../infra/config/resolveConfigValue.js', async (original) => ({
  ...(await original<typeof import('../infra/config/resolveConfigValue.js')>()),
  resolveConfigValues: cli.resolveConfigValues,
}));
vi.mock('../infra/git/index.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  initGitProvider: cli.initGitProvider,
}));
vi.mock('../shared/utils/debug.js', async (original) => ({
  ...(await original<typeof import('../shared/utils/debug.js')>()),
  initDebugLogger: cli.initDebugLogger,
  setVerboseConsole: cli.setVerboseConsole,
}));

import { getCliExecutionContext, initializeCliExecutionContext } from '../app/cli/initialization.js';
import { setQuietMode } from '../shared/context.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitive-text.js';
import { sanitizeTerminalText } from '../shared/utils/text.js';
import {
  runTaskFinishHooks,
  runTaskFinishHooksForStates,
  withTaskFinishHook,
} from '../features/tasks/execute/taskFinishHook.js';

const NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 120;
})();
const SEED = Number.parseInt(process.env.TAKT_PBT_SEED ?? '', 10);
const runs = { numRuns: NUM_RUNS, ...(Number.isInteger(SEED) ? { seed: SEED } : {}) };
const TIMEOUT = scaledMs(60_000);

const okCommandResult = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  aborted: false,
  outputLimitExceeded: false,
};

const SECRETS = [
  'sk-Zq24Zqabcdefgh',
  'https://user:Zq24Zqpassword@example.invalid/repo.git',
  'Authorization: Bearer Zq24Zqbearertoken',
];
const brokenRead = (): Error => new Error(`Invalid tasks.yaml: ${SECRETS.join(' ')}`);
const timedOutRead = (): Error => new Error('File lock: timed out waiting for lock: /project/.takt/tasks.yaml.lock');

function state(name: string, status: TaskState['status'], completedAt?: string): TaskState {
  return {
    name,
    kind: status,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    filePath: `/project/.takt/tasks/${name}.yaml`,
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

type ReadOutcome = 'timeout' | 'broken' | 'ok' | 'notTerminal';
type ConfigMode = 'ok' | 'missing' | 'unreadable';

const terminalState = (): TaskState => state('task-0', 'completed', '2026-01-02T00:00:00.000Z');
const runningState = (): TaskState => state('task-0', 'running');

/** A `TaskRunner` whose reads follow the outcome list; the last outcome repeats. */
function fakeRunner(outcomes: readonly ReadOutcome[]): { runner: TaskRunner; reads: ReturnType<typeof vi.fn> } {
  let index = 0;
  const reads = vi.fn((): TaskState[] => {
    const outcome = outcomes[Math.min(index, outcomes.length - 1)]!;
    index += 1;
    if (outcome === 'timeout') throw timedOutRead();
    if (outcome === 'broken') throw brokenRead();
    return [outcome === 'ok' ? terminalState() : runningState()];
  });
  return { runner: { listTaskStateItems: reads } as unknown as TaskRunner, reads };
}

let stderrChunks: string[] = [];
let stdoutChunks: string[] = [];

function resetMocks(): void {
  stderrChunks = [];
  stdoutChunks = [];
  bounded.run.mockReset();
  bounded.run.mockResolvedValue(okCommandResult);
}

async function runWithFakeTimers<T>(start: () => Promise<T>): Promise<T> {
  const promise = start();
  await vi.advanceTimersByTimeAsync(1_000);
  return promise;
}

/** The task-finish-hook notices that reached stderr. Other stderr writes are ignored. */
function warnMessages(): string[] {
  return stderrChunks.join('').split('\n').filter((line) => line.includes('Task finish hook'));
}

function expectNoStdoutNotice(): void {
  expect(stdoutChunks.join('')).not.toContain('Task finish hook');
}

function hookNames(): string[] {
  return bounded.run.mock.calls.map(
    (call) => (call[0] as { env: NodeJS.ProcessEnv }).env.TAKT_FINISH_TASK_NAME!,
  );
}

const outcomeArb = fc.constantFrom<ReadOutcome>('timeout', 'broken', 'ok', 'notTerminal');
const configArb = fc.constantFrom<ConfigMode>('ok', 'missing', 'unreadable');
const pathArb = fc.constantFrom<'named' | 'states'>('named', 'states');

/** What the design says a named read does: one retry for a timeout, none for a broken read. */
function expectedNamedRead(outcomes: readonly ReadOutcome[], config: ConfigMode): {
  reads: number;
  hook: number;
  notices: number;
  loss: boolean;
} {
  if (config === 'missing') return { reads: 0, hook: 0, notices: 0, loss: false };
  if (config === 'unreadable') return { reads: 0, hook: 0, notices: 1, loss: true };
  let attempts = 0;
  let loss = false;
  let terminal = false;
  for (;;) {
    attempts += 1;
    const outcome = outcomes[Math.min(attempts - 1, outcomes.length - 1)]!;
    if (outcome === 'ok') {
      terminal = true;
      break;
    }
    if (outcome === 'notTerminal') break;
    if (outcome === 'timeout' && attempts < 2) continue;
    loss = true;
    break;
  }
  return { reads: attempts, hook: terminal ? 1 : 0, notices: loss ? 1 : 0, loss };
}

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdoutChunks.push(args.map((arg) => String(arg)).join(' '));
  });
  resetMocks();
  configState.mode = 'ok';
  setQuietMode(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setQuietMode(false);
});

describe('task finish hook notice properties (#171)', () => {
  it('1. keeps reads at two attempts, the hook at most one, and warns once only when the hook is lost', async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(fc.asyncProperty(
        fc.array(outcomeArb, { minLength: 1, maxLength: 4 }),
        configArb,
        pathArb,
        async (outcomes, config, path) => {
          resetMocks();
          configState.mode = config;
          const terminal = state('task-0', 'completed', '2026-01-02T00:00:00.000Z');
          let reads: ReturnType<typeof vi.fn>;
          let runner: TaskRunner;

          if (path === 'states') {
            reads = vi.fn();
            runner = { listTaskStateItems: reads } as unknown as TaskRunner;
            await runTaskFinishHooksForStates('/project', [terminal]);
          } else {
            const fake = fakeRunner(outcomes);
            reads = fake.reads;
            runner = fake.runner;
            await runWithFakeTimers(() => runTaskFinishHooks('/project', runner, ['task-0']));
          }

          const expected = path === 'states'
            ? config === 'ok'
              ? { reads: 0, hook: 1, notices: 0, loss: false }
              : config === 'missing'
                ? { reads: 0, hook: 0, notices: 0, loss: false }
                : { reads: 0, hook: 0, notices: 1, loss: true }
            : expectedNamedRead(outcomes, config);

          expect(reads.mock.calls.length, `${path} ${config} ${outcomes.join(',')}`).toBe(expected.reads);
          expect(reads.mock.calls.length).toBeLessThanOrEqual(2);
          expect(bounded.run.mock.calls.length).toBe(expected.hook);
          expect(bounded.run.mock.calls.length).toBeLessThanOrEqual(1);
          expect(warnMessages()).toHaveLength(expected.notices);
          expect(warnMessages().length).toBeLessThanOrEqual(1);
          if (expected.loss) {
            expect(bounded.run).not.toHaveBeenCalled();
            expect(warnMessages()).toHaveLength(1);
          } else {
            expect(warnMessages()).toHaveLength(0);
            expectNoStdoutNotice();
          }

          if (path === 'named' && outcomes[0] === 'broken' && config === 'ok') {
            expect(reads).toHaveBeenCalledTimes(1);
          }
          if (config === 'missing') expect(reads).not.toHaveBeenCalled();
          if (path === 'named' && config === 'ok' && outcomes[0] === 'notTerminal') {
            expect(bounded.run).not.toHaveBeenCalled();
            expect(warnMessages()).toHaveLength(0);
          }
        },
      ), runs);
    } finally {
      vi.useRealTimers();
    }
  }, TIMEOUT);

  it('2. warns once per call with sanitised names, the reason sanitised, and a correct first-10 tail', async () => {
    const nameArb = fc.oneof(
      fc.string({ maxLength: 24 }),
      fc.constantFrom(
        'task\nwith newline',
        '\u001b[31mansi\u001b[0m',
        '"quoted" name',
        '日本語のタスク',
        'a'.repeat(200),
      ),
    );
    const namesArb = fc.oneof(
      fc.array(nameArb, { maxLength: 13 }),
      fc.integer({ min: 11, max: 14 }).map((count) =>
        Array.from({ length: count }, (_, index) => `task-${index}`)),
    );

    await fc.assert(fc.asyncProperty(namesArb, async (names) => {
      resetMocks();
      configState.mode = 'ok';
      const { runner } = fakeRunner(['broken']);

      await runTaskFinishHooks('/project', runner, names);

      const uniqueNames = [...new Set(names.map(sanitizeTerminalText))];
      // The composed message also goes through sanitizeSensitiveText, so a name that looks like a
      // secret is shown masked; that masking is allowed and expected.
      const shownNames = uniqueNames.map((name) => sanitizeSensitiveText(name));
      const expectedNotices = names.length === 0 ? 0 : 1;
      expect(warnMessages().length, JSON.stringify(names)).toBe(expectedNotices);
      expect(bounded.run).not.toHaveBeenCalled();
      if (expectedNotices === 0) {
        expectNoStdoutNotice();
        return;
      }

      const message = warnMessages()[0]!;
      if (uniqueNames.length <= 10) {
        for (const name of shownNames) expect(message).toContain(name);
      } else {
        for (const name of shownNames.slice(0, 10)) expect(message).toContain(name);
        expect(message).toContain(`and ${uniqueNames.length - 10} more`);
      }
      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
      expect(message).not.toContain('\u001b');
      for (const secret of SECRETS) expect(message).not.toContain(secret);
    }), runs);
  }, TIMEOUT);

  it('3. leaves the handed-over states and the saved task record unchanged, and runs each task at most once', async () => {
    const statusArb = fc.constantFrom<TaskState['status']>(
      'pending', 'running', 'completed', 'failed', 'exceeded', 'pr_failed',
    );
    const statesArb = fc.array(
      fc.record({ status: statusArb, completed: fc.boolean() }),
      { maxLength: 5 },
    ).map((items) => items.map((item, index) =>
      state(`task-${index}`, item.status,
        item.completed ? '2026-01-02T00:00:00.000Z' : undefined)));
    const readOutcomeArb = fc.constantFrom<'ok' | 'broken' | 'timeout'>('ok', 'broken', 'timeout');
    const terminalStatuses = new Set(['completed', 'failed', 'exceeded', 'pr_failed']);

    vi.useFakeTimers();
    try {
      await fc.assert(fc.asyncProperty(statesArb, readOutcomeArb, async (states, readOutcome) => {
        resetMocks();
        configState.mode = 'ok';
        const before = JSON.parse(JSON.stringify(states)) as TaskState[];

        await runTaskFinishHooksForStates('/project', states);

        expect(states).toEqual(before);
        const names = hookNames();
        expect(new Set(names).size).toBe(names.length);
        for (const name of names) {
          const matching = states.find((item) => item.name === name)!;
          expect(terminalStatuses.has(matching.status)).toBe(true);
        }

        // The named path re-reads; a broken or timed-out read leaves the states alone too.
        resetMocks();
        const saved = JSON.stringify(states);
        const reads = vi.fn((): TaskState[] => {
          if (readOutcome === 'ok') return states;
          throw readOutcome === 'broken' ? brokenRead() : timedOutRead();
        });
        const runner = { listTaskStateItems: reads } as unknown as TaskRunner;
        await runWithFakeTimers(() =>
          runTaskFinishHooks('/project', runner, states.map((item) => item.name)));

        expect(states).toEqual(before);
        expect(JSON.stringify(states)).toBe(saved);
        const namedHookNames = hookNames();
        expect(new Set(namedHookNames).size).toBe(namedHookNames.length);
        for (const name of namedHookNames) {
          const matching = states.find((item) => item.name === name)!;
          expect(terminalStatuses.has(matching.status)).toBe(true);
        }
      }), runs);
    } finally {
      vi.useRealTimers();
    }
  }, TIMEOUT);

  it('4. waits at most one 250 ms step, and only for a timed-out read', async () => {
    const cases = ['named-timeout', 'execution-timeout', 'config-unreadable', 'pre-read', 'for-states'] as const;

    vi.useFakeTimers();
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      await fc.assert(fc.asyncProperty(fc.constantFrom(...cases), async (testCase) => {
        resetMocks();
        configState.mode = 'ok';
        timerSpy.mockClear();

        switch (testCase) {
          case 'named-timeout': {
            const { runner, reads } = fakeRunner(['timeout']);
            await runWithFakeTimers(() => runTaskFinishHooks('/project', runner, ['task-0']));
            expect(reads).toHaveBeenCalledTimes(2);
            expect(bounded.run).not.toHaveBeenCalled();
            expect(warnMessages()).toHaveLength(1);
            break;
          }
          case 'execution-timeout': {
            const { runner, reads } = fakeRunner(['ok', 'timeout']);
            await runWithFakeTimers(() => withTaskFinishHook('/project', runner, 'task-0', async () => undefined));
            expect(reads).toHaveBeenCalledTimes(3);
            expect(bounded.run).not.toHaveBeenCalled();
            expect(warnMessages()).toHaveLength(1);
            break;
          }
          case 'config-unreadable': {
            configState.mode = 'unreadable';
            const { runner, reads } = fakeRunner(['ok']);
            await runTaskFinishHooks('/project', runner, ['task-0']);
            expect(reads).not.toHaveBeenCalled();
            expect(warnMessages()).toHaveLength(1);
            break;
          }
          case 'pre-read': {
            const { runner, reads } = fakeRunner(['timeout', 'notTerminal']);
            await withTaskFinishHook('/project', runner, 'task-0', async () => undefined);
            expect(reads).toHaveBeenCalledTimes(2);
            expect(bounded.run).not.toHaveBeenCalled();
            expect(warnMessages()).toHaveLength(0);
            expectNoStdoutNotice();
            break;
          }
          case 'for-states': {
            configState.mode = 'unreadable';
            await runTaskFinishHooksForStates('/project', [terminalState()]);
            expect(warnMessages()).toHaveLength(1);
            break;
          }
        }

        const retryWaits = timerSpy.mock.calls.filter((call) => call[1] === 250);
        const retriesExpected = testCase === 'named-timeout' || testCase === 'execution-timeout' ? 1 : 0;
        expect(retryWaits.length, testCase).toBe(retriesExpected);
      }), runs);
    } finally {
      timerSpy.mockRestore();
      vi.useRealTimers();
    }
  }, TIMEOUT);

  it('5. at-least-once only when the pre-read failed and the post-read is terminal; a failed post-read warns unless no hook is configured', async () => {
    const preArb = fc.constantFrom<'ok' | 'fail'>('ok', 'fail');
    const postArb = fc.constantFrom<'terminal' | 'nonTerminal' | 'fail'>('terminal', 'nonTerminal', 'fail');
    const sameStampArb = fc.boolean();

    vi.useFakeTimers();
    try {
      await fc.assert(fc.asyncProperty(preArb, postArb, sameStampArb, configArb, async (pre, post, sameStamp, config) => {
        resetMocks();
        configState.mode = config;
        const stamps = {
          before: '2026-01-02T00:00:00.000Z',
          after: sameStamp ? '2026-01-02T00:00:00.000Z' : '2026-01-03T00:00:00.000Z',
        };
        const steps: TaskState[][] = [];
        if (pre === 'fail') {
          steps.push([]);
        } else {
          steps.push([state('task-0', 'completed', stamps.before)]);
        }
        if (post === 'terminal') {
          steps.push([state('task-0', 'completed', stamps.after)]);
        } else if (post === 'nonTerminal') {
          steps.push([state('task-0', 'running')]);
        } else {
          steps.push([]);
        }

        let index = 0;
        const reads = vi.fn((): TaskState[] => {
          const step = steps[Math.min(index, steps.length - 1)]!;
          index += 1;
          if (step.length === 0) throw timedOutRead();
          return step;
        });
        const runner = { listTaskStateItems: reads } as unknown as TaskRunner;

        await runWithFakeTimers(() => withTaskFinishHook('/project', runner, 'task-0', async () => undefined));

        const reachedConfig = post === 'terminal' && (pre === 'fail' || !sameStamp);
        const hookExpected = reachedConfig && config === 'ok' ? 1 : 0;
        let noticeExpected = 0;
        // A failed post-read is reported only when a hook may exist. A missing configuration is a
        // known "no hook", so there is nothing to lose; unreadable configuration is unknown, so it
        // is reported.
        if (post === 'fail') noticeExpected = config === 'missing' ? 0 : 1;
        else if (reachedConfig && config === 'unreadable') noticeExpected = 1;
        else if (reachedConfig && config === 'ok' && pre === 'fail') noticeExpected = 1;

        expect(bounded.run.mock.calls.length, `${pre} ${post} ${String(sameStamp)} ${config}`).toBe(hookExpected);
        expect(warnMessages().length).toBe(noticeExpected);
        expect(warnMessages().length).toBeLessThanOrEqual(1);
        if (noticeExpected === 0) expectNoStdoutNotice();
        expect(bounded.run.mock.calls.length).toBeLessThanOrEqual(1);
      }), runs);
    } finally {
      vi.useRealTimers();
    }
  }, TIMEOUT);

  it('6. warns once in every quiet/pipeline combination', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/project');

    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (quiet, pipeline) => {
      resetMocks();
      configState.mode = 'ok';
      const program = { opts: () => ({ pipeline, quiet: false }) } as unknown as Command;
      await initializeCliExecutionContext(program, '171-pbt');
      expect(getCliExecutionContext().pipelineMode).toBe(pipeline);
      setQuietMode(quiet);
      const { runner } = fakeRunner(['broken']);

      await runTaskFinishHooks('/project', runner, ['task-0']);

      expect(warnMessages().length, `quiet=${String(quiet)} pipeline=${String(pipeline)}`).toBe(1);
      expectNoStdoutNotice();
      expect(bounded.run).not.toHaveBeenCalled();
    }), runs);
  }, TIMEOUT);
});

import { describe, expect, it, vi } from 'vitest';
import {
  readTestTimeFactor,
  scaledMs,
  scaleWaitForOptions,
  testTimeFactor,
  withScaledWaitFor,
  type WaitFor,
  type WaitForOptions,
} from '../../scripts/test-time-factor.mjs';

/** Timers may fire a little early relative to performance.now(). */
const TIMER_SLACK_MS = 20;

async function rejection(run: () => Promise<unknown>): Promise<{ error: unknown; elapsedMs: number }> {
  const startedAt = performance.now();
  try {
    await run();
  } catch (error) {
    return { error, elapsedMs: performance.now() - startedAt };
  }
  throw new Error('expected the wait to be rejected');
}

function recordingWaitFor(): { waitFor: WaitFor; received: Array<WaitForOptions | undefined> } {
  const received: Array<WaitForOptions | undefined> = [];
  const waitFor: WaitFor = async (callback, options) => {
    received.push(options);
    return callback();
  };
  return { waitFor, received };
}

describe('TEST_TIME_FACTOR', () => {
  it.each([
    [undefined, 1],
    ['', 1],
    ['1', 1],
    ['2', 2],
    ['1.5', 1.5],
    ['0.5', 0.5],
  ])('reads %j as %d', (raw, expected) => {
    expect(readTestTimeFactor({ TEST_TIME_FACTOR: raw })).toBe(expected);
  });

  it.each(['2x', 'abc', '0', '-1', 'NaN', 'Infinity', ' '])('rejects %j instead of falling back to 1', (raw) => {
    expect(() => readTestTimeFactor({ TEST_TIME_FACTOR: raw }))
      .toThrow(`TEST_TIME_FACTOR must be a positive number, got ${JSON.stringify(raw)}`);
  });

  it('multiplies a duration and rounds up to a whole millisecond', () => {
    expect(scaledMs(120_000, 1)).toBe(120_000);
    expect(scaledMs(10_000, 2)).toBe(20_000);
    expect(scaledMs(1_000, 1.5)).toBe(1_500);
    expect(scaledMs(5, 0.5)).toBe(3);
    expect(scaledMs(10_000)).toBe(Math.ceil(10_000 * testTimeFactor));
  });
});

describe('vi.waitFor deadline scaling', () => {
  const callForms: Array<[string, WaitForOptions | undefined]> = [
    ['an explicit timeout in milliseconds', 200],
    ['an explicit timeout in options', { timeout: 200, interval: 20 }],
    ['no options', undefined],
    ['only an interval', { interval: 10 }],
  ];

  it.each(callForms)('passes a call with %s to Vitest untouched at factor 1', async (_form, options) => {
    const { waitFor, received } = recordingWaitFor();

    await withScaledWaitFor(waitFor, 1)(() => 'done', options);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(options);
  });

  it.each([
    ['an explicit timeout in milliseconds', 200, 2, 400],
    ['an explicit timeout in options', { timeout: 300, interval: 5 }, 1.5, { timeout: 450, interval: 5 }],
    ['no options', undefined, 2, { timeout: 2000 }],
    ['only an interval', { interval: 10 }, 2, { timeout: 2000, interval: 10 }],
    ['a factor below 1', 200, 0.5, 100],
  ] as Array<[string, WaitForOptions | undefined, number, WaitForOptions]>)(
    'scales the deadline and keeps the interval for a call with %s',
    (_form, options, factor, expected) => {
      expect(scaleWaitForOptions(options, factor)).toEqual(expected);
    },
  );

  // Both sides run through the vi.waitFor of this run, so the comparison holds
  // at any TEST_TIME_FACTOR the suite itself is started with.
  it.each([
    ['an explicit timeout', 150, 150],
    ['no options', undefined, 1000],
    ['only an interval', { interval: 10 }, 1000],
  ] as Array<[string, WaitForOptions | undefined, number]>)(
    'keeps the deadline and the error of a failing wait with %s at factor 1',
    async (_form, options, writtenTimeoutMs) => {
      const native = vi.waitFor.bind(vi) as WaitFor;
      const wrapped = withScaledWaitFor(native, 1);
      const notYet = new Error('condition is not met yet');
      const failing = (): never => { throw notYet; };

      const [expected, actual] = await Promise.all([
        rejection(() => native(failing, options)),
        rejection(() => wrapped(failing, options)),
      ]);

      expect(actual.error).toBe(notYet);
      expect(expected.error).toBe(notYet);
      const deadlineMs = scaledMs(writtenTimeoutMs) - TIMER_SLACK_MS;
      expect(expected.elapsedMs).toBeGreaterThanOrEqual(deadlineMs);
      expect(actual.elapsedMs).toBeGreaterThanOrEqual(deadlineMs);
    },
  );

  it('keeps the timeout error of a wait that never settles at factor 1', async () => {
    const native = vi.waitFor.bind(vi) as WaitFor;
    const neverSettles = (): Promise<never> => new Promise<never>(() => {});

    const expected = await rejection(() => native(neverSettles, 100));
    const actual = await rejection(() => withScaledWaitFor(native, 1)(neverSettles, 100));

    expect(expected.error).toBeInstanceOf(Error);
    expect(actual.error).toBeInstanceOf(Error);
    expect((actual.error as Error).message).toBe((expected.error as Error).message);
    expect((actual.error as Error).message).toBe('Timed out in waitFor!');
  });

  it('lets a condition that needs more polls than the written deadline allows pass at a larger factor', async () => {
    const native = vi.waitFor.bind(vi) as WaitFor;
    // True on the 5th poll: about 200ms at the 50ms interval, past a 100ms deadline.
    const metOnFifthPoll = (): (() => number) => {
      let polls = 0;
      return () => {
        polls += 1;
        if (polls < 5) throw new Error(`poll ${polls}`);
        return polls;
      };
    };

    await expect(withScaledWaitFor(native, 1)(metOnFifthPoll(), { timeout: 100, interval: 50 })).rejects.toThrow(/^poll \d$/);
    await expect(withScaledWaitFor(native, 50)(metOnFifthPoll(), { timeout: 100, interval: 50 })).resolves.toBe(5);
  });

  it('applies the factor of this run to the default deadline of vi.waitFor', async () => {
    const { elapsedMs } = await rejection(() => vi.waitFor(() => { throw new Error('never'); }));

    expect(elapsedMs).toBeGreaterThanOrEqual(scaledMs(1000) - TIMER_SLACK_MS);
  });
});

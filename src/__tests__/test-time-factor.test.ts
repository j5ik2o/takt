import { describe, expect, it, vi } from 'vitest';
import {
  annotateWaitForTimeout,
  readTestTimeFactor,
  scaledMs,
  scaleWaitForOptions,
  testTimeFactor,
  waitForExpirySuffix,
  withScaledWaitFor,
  writtenWaitForTimeoutMs,
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

/** What the wrap in test-setup.ts adds at the factor this run was started with. */
function deadlineSuffix(writtenMs: number): string {
  return waitForExpirySuffix({ writtenMs, factor: testTimeFactor });
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

describe('the deadline a vi.waitFor call wrote', () => {
  it.each([
    ['no options', undefined, 1000],
    ['only an interval', { interval: 10 }, 1000],
    ['a timeout in options', { timeout: 250, interval: 10 }, 250],
    ['a timeout in milliseconds', 250, 250],
  ] as Array<[string, WaitForOptions | undefined, number]>)('reads %s as %d', (_form, options, expected) => {
    expect(writtenWaitForTimeoutMs(options)).toBe(expected);
  });

  it('names the written deadline and the factor on the error of an expired wait', () => {
    const expired = new Error('Timed out in waitFor!');
    const stack = expired.stack;

    const annotated = annotateWaitForTimeout(expired, { writtenMs: 1000, factor: 2 });

    expect(annotated).toBe(expired);
    expect(expired.message).toBe(
      'Timed out in waitFor! (vi.waitFor waited 2000ms: written 1000ms x TEST_TIME_FACTOR=2)',
    );
    // The report keeps the stack of the error itself, so it points at the test.
    expect(expired.stack).toBe(stack);
  });

  it('leaves a rejection that is not an Error alone', () => {
    expect(annotateWaitForTimeout('not an error', { writtenMs: 100, factor: 3 })).toBe('not an error');
  });

  it('annotates the rejection of a scaled wait with the deadline the test wrote', async () => {
    const notYet = new Error('condition is not met yet');
    const waitFor: WaitFor = async () => {
      throw notYet;
    };

    await expect(withScaledWaitFor(waitFor, 2)(() => 'never', 250)).rejects.toThrow(
      'condition is not met yet (vi.waitFor waited 500ms: written 250ms x TEST_TIME_FACTOR=2)',
    );
    expect(notYet.message).toBe(
      'condition is not met yet (vi.waitFor waited 500ms: written 250ms x TEST_TIME_FACTOR=2)',
    );
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

  it('returns the implementation itself at factor 1', () => {
    const { waitFor } = recordingWaitFor();

    expect(withScaledWaitFor(waitFor, 1)).toBe(waitFor);
  });

  // Both the superseded error and the report use the vi.waitFor of this run, so
  // these hold at any TEST_TIME_FACTOR the suite itself is started with.
  it.each([
    ['an explicit timeout', 150, 150],
    ['no options', undefined, 1000],
    ['only an interval', { interval: 10 }, 1000],
  ] as Array<[string, WaitForOptions | undefined, number]>)(
    'keeps the deadline of a failing wait with %s and names it in the error',
    async (_form, options, writtenMs) => {
      const notYet = new Error('condition is not met yet');

      const { error, elapsedMs } = await rejection(() =>
        vi.waitFor(() => {
          throw notYet;
        }, options),
      );

      expect(error).toBe(notYet);
      expect(notYet.message).toBe(`condition is not met yet${deadlineSuffix(writtenMs)}`);
      expect(elapsedMs).toBeGreaterThanOrEqual(scaledMs(writtenMs) - TIMER_SLACK_MS);
    },
  );

  it('keeps the timeout error of a wait that never settles and names the deadline', async () => {
    const neverSettles = (): Promise<never> => new Promise<never>(() => {});

    const { error } = await rejection(() => vi.waitFor(neverSettles, 100));

    expect((error as Error).message).toBe(`Timed out in waitFor!${deadlineSuffix(100)}`);
  });

  it('lets a condition that needs more polls than the written deadline allows pass at a larger factor', async () => {
    // True on the 8th poll: about 700ms at the 100ms interval, past a 200ms deadline.
    const metOnEighthPoll = (): (() => number) => {
      let polls = 0;
      return () => {
        polls += 1;
        if (polls < 8) throw new Error(`poll ${polls}`);
        return polls;
      };
    };

    await expect(
      withScaledWaitFor(vi.waitFor.bind(vi) as WaitFor, 1)(metOnEighthPoll(), { timeout: 200, interval: 100 }),
    ).rejects.toThrow(/^poll \d/);
    await expect(
      withScaledWaitFor(vi.waitFor.bind(vi) as WaitFor, 50)(metOnEighthPoll(), { timeout: 200, interval: 100 }),
    ).resolves.toBe(8);
  });

  it('applies the factor of this run to the default deadline of vi.waitFor', async () => {
    const { elapsedMs } = await rejection(() => vi.waitFor(() => { throw new Error('never'); }));

    expect(elapsedMs).toBeGreaterThanOrEqual(scaledMs(1000) - TIMER_SLACK_MS);
  });
});

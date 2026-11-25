/**
 * TEST_TIME_FACTOR multiplies the time limits of a test run. Default: 1.
 *
 * A loaded or slow machine sets a factor above 1 so that load-dependent limits
 * (Vitest's test, hook, and teardown timeouts, and the `vi.waitFor` deadline)
 * stretch together instead of being edited one by one. A factor never repairs
 * a missing wait or a race: those fail at any factor.
 */

/** `vi.waitFor` waits this long when a call gives no timeout (Vitest's default). */
const WAIT_FOR_DEFAULT_TIMEOUT_MS = 1000;

/**
 * Unset and empty mean 1. Anything that is not a positive finite number is an
 * error: a mistyped `TEST_TIME_FACTOR=2x` must not silently run unscaled.
 */
export function readTestTimeFactor(env = process.env) {
  const raw = env.TEST_TIME_FACTOR;
  if (raw === undefined || raw === '') return 1;
  const factor = Number(raw);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`TEST_TIME_FACTOR must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return factor;
}

export const testTimeFactor = readTestTimeFactor();

export function scaledMs(ms, factor = testTimeFactor) {
  return Math.ceil(ms * factor);
}

/**
 * Scale the deadline of a `vi.waitFor` call, including the default one. The
 * polling interval stays as written. A factor of 1 returns the argument itself,
 * so the call reaches Vitest exactly as the test wrote it.
 */
export function scaleWaitForOptions(options, factor = testTimeFactor) {
  if (factor === 1) return options;
  if (typeof options === 'number') return scaledMs(options, factor);
  return { ...options, timeout: scaledMs(options?.timeout ?? WAIT_FOR_DEFAULT_TIMEOUT_MS, factor) };
}

/** Wrap a `vi.waitFor` implementation so every call's deadline is scaled. */
export function withScaledWaitFor(waitFor, factor = testTimeFactor) {
  return (callback, options) => waitFor(callback, scaleWaitForOptions(options, factor));
}

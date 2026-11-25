/**
 * TEST_TIME_FACTOR multiplies the time limits of a test run. Default: 1.
 *
 * A loaded or slow machine sets a factor above 1 so that load-dependent limits
 * (Vitest's test, hook, and teardown timeouts, and the `vi.waitFor` deadline)
 * stretch together instead of being edited one by one. A factor never repairs
 * a missing wait or a race: those fail at any factor.
 */

/** The variable that carries the factor. */
const ENV_NAME = 'TEST_TIME_FACTOR';

/** `vi.waitFor` waits this long when a call gives no timeout (Vitest's default). */
const WAIT_FOR_DEFAULT_TIMEOUT_MS = 1000;

/**
 * Unset and empty mean 1. Anything that is not a positive finite number is an
 * error: a mistyped `TEST_TIME_FACTOR=2x` must not silently run unscaled.
 */
export function readTestTimeFactor(env = process.env) {
  const raw = env[ENV_NAME];
  if (raw === undefined || raw === '') return 1;
  const factor = Number(raw);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`${ENV_NAME} must be a positive number, got ${JSON.stringify(raw)}`);
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
export function scaleWaitForOptions(options, factor) {
  if (factor === 1) return options;
  if (typeof options === 'number') return scaledMs(options, factor);
  return { ...options, timeout: scaledMs(options?.timeout ?? WAIT_FOR_DEFAULT_TIMEOUT_MS, factor) };
}

/** The deadline a `vi.waitFor` call was written with, before scaling. */
export function writtenWaitForTimeoutMs(options) {
  return typeof options === 'number' ? options : (options?.timeout ?? WAIT_FOR_DEFAULT_TIMEOUT_MS);
}

/**
 * What a scaled wait adds to the report of an expiry: the deadline the test
 * wrote next to the one the factor made, so `Timed out in waitFor!` after 2s
 * reads against the 1s in the test. Empty at factor 1, where nothing is wrapped.
 */
export function waitForExpirySuffix({ writtenMs, factor }) {
  if (factor === 1) return '';
  return ` (vi.waitFor waited ${scaledMs(writtenMs, factor)}ms: written ${writtenMs}ms x ${ENV_NAME}=${factor})`;
}

/**
 * Name the written deadline and the factor on a wait that ran out of time.
 * Vitest rejects a `waitFor` only when its deadline passes, so every rejection
 * of a scaled wait is an expiry. The error the test threw is left as it was. The
 * report gets a copy that keeps its prototype and its own fields — an assertion
 * error keeps `expected`, `actual`, and the diff — with the deadline appended to
 * the message and the stack frames left pointing at the test line.
 */
export function annotateWaitForTimeout(error, { writtenMs, factor }) {
  if (!(error instanceof Error)) return error;
  // Node keeps `stack` as an own accessor that reads the original error, so the
  // copy takes the frames as text instead of taking that accessor.
  // The copy defines its own message and stack, so a frozen error still gets one.
  const message = `${error.message}${waitForExpirySuffix({ writtenMs, factor })}`;
  const ownText = (value) => ({ value, writable: true, enumerable: false, configurable: true });
  const descriptors = Object.getOwnPropertyDescriptors(error);
  delete descriptors.stack;
  descriptors.message = ownText(message);
  if (error.stack !== undefined) descriptors.stack = ownText(error.stack.replace(error.message, message));
  return Object.create(Object.getPrototypeOf(error), descriptors);
}

/** Wrap a `vi.waitFor` implementation so every call's deadline is scaled. */
export function withScaledWaitFor(waitFor, factor = testTimeFactor) {
  if (factor === 1) return waitFor;
  return async (callback, options) => {
    const writtenMs = writtenWaitForTimeoutMs(options);
    try {
      return await waitFor(callback, scaleWaitForOptions(options, factor));
    } catch (error) {
      throw annotateWaitForTimeout(error, { writtenMs, factor });
    }
  };
}

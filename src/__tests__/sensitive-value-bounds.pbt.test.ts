import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeToolResultText, toolResultSensitiveValues } from '../shared/tool-activity/sanitize.js';
import { SensitiveTextStreamBuffer } from '../shared/utils/sensitive-stream.js';
import {
  BoundedSensitiveValues,
  MAX_TRACKED_SENSITIVE_SINGLE_VALUE_BYTES,
  MAX_TRACKED_SENSITIVE_VALUES,
  createBoundedSensitiveValues,
} from '../shared/utils/sensitive-value.js';
import * as legacyStream from './helpers/legacy-sensitive-stream.js';
import * as legacyValue from './helpers/legacy-sensitive-value.js';
import { chunksOf, leakText } from './helpers/sensitive-text-arbitraries.js';

// Design 3, D4: the legacy bound of BoundedSensitiveValues keeps exactly what the previous
// BoundedSensitiveValues (337062193) kept, in the same order and with the same counts, for the same
// sources, whatever the new bound does. Sources include runs that fill the limits, runs that only
// fill the new bound, bounded sources, and strings the new bound saw first (design 1.2, N1).

const NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 400;
})();
const SEED = Number.parseInt(process.env.TAKT_PBT_SEED ?? '', 10);
const runs = { numRuns: Math.max(50, Math.ceil(NUM_RUNS / 4)), ...(Number.isInteger(SEED) ? { seed: SEED } : {}) };
const TIMEOUT = Math.max(120_000, NUM_RUNS * 200);

/**
 * Values only the new collection finds: assignments inside a quoted value. The previous collection
 * tracks the quoted value as one value and looks only for headers inside it; the new one reads
 * every assignment inside it.
 */
const newOnlyText = (count: number, tag: string): string =>
  'token="' + Array.from({ length: count }, (_, index) => `password=${tag}${index}x`).join(' ') + '"';

type Operation =
  | { readonly kind: 'source'; readonly source: unknown }
  | { readonly kind: 'bounded'; readonly operations: readonly Operation[] };

const smallSource: fc.Arbitrary<unknown> = leakText.chain((text) => fc.constantFrom<unknown>(
  text,
  { password: text },
  { headers: { cookie: text } },
  { env: { GITHUB_TOKEN: text } },
  [[text], { note: text }],
));

const largeSource: fc.Arbitrary<unknown> = fc.oneof(
  // Over 1,024 values.
  fc.nat(99).map((tag) => ({ token: Array.from({ length: MAX_TRACKED_SENSITIVE_VALUES + 20 }, (_, index) => `v${tag}-${index}`) })),
  // Over 1 MiB in total.
  fc.nat(99).map((tag) => ({ token: Array.from({ length: 70 }, (_, index) => `${tag}-${index}-`.padEnd(15 * 1024, 'x')) })),
  // One value over 16 KiB, then a small one.
  fc.nat(99).map((tag) => ({ password: [`${tag}`.padEnd(MAX_TRACKED_SENSITIVE_SINGLE_VALUE_BYTES + 1, 'y'), `small${tag}`] })),
  // Only the new bound fills up.
  fc.nat(99).map((tag) => newOnlyText(MAX_TRACKED_SENSITIVE_VALUES + 10, `n${tag}-`)),
  // Strings the new bound sees first, then the legacy path tracks them by key.
  fc.nat(99).map((tag) => ({ first: newOnlyText(5, `s${tag}-`), then: { password: Array.from({ length: 5 }, (_, index) => `s${tag}-${index}x`) } })),
);

const operation: fc.Arbitrary<Operation> = fc.letrec<{ operation: Operation }>((tie) => ({
  operation: fc.oneof(
    { weight: 6, arbitrary: smallSource.map((source) => ({ kind: 'source' as const, source })) },
    { weight: 2, arbitrary: largeSource.map((source) => ({ kind: 'source' as const, source })) },
    { weight: 1, arbitrary: fc.array(tie('operation'), { maxLength: 2, depthIdentifier: 'operation' }).map((operations) => ({ kind: 'bounded' as const, operations })) },
  ),
})).operation;

/** Runs `operations` on both implementations; a bounded operation builds a source from its own operations. */
function run(operations: readonly Operation[]): { current: BoundedSensitiveValues; previous: legacyValue.BoundedSensitiveValues } {
  const current = createBoundedSensitiveValues();
  const previous = legacyValue.createBoundedSensitiveValues();
  for (const step of operations) {
    if (step.kind === 'source') {
      current.collect(step.source);
      previous.collect(step.source);
    } else {
      const inner = run(step.operations);
      current.collect(inner.current);
      previous.collect(inner.previous);
    }
  }
  return { current, previous };
}

function expectSameLegacyBound(current: BoundedSensitiveValues, previous: legacyValue.BoundedSensitiveValues): void {
  expect([...current.legacyValues]).toEqual([...previous.values]);
  expect(current.legacyExhausted).toBe(previous.exhausted);
  expect(current.legacyBound.skippedValueCount).toBe(previous.skippedValueCount);
  expect(current.legacyBound.skippedValueBytes).toBe(previous.skippedValueBytes);
  expect(current.legacyBound.truncatedSourceCount).toBe(previous.truncatedSourceCount);
  expect(current.legacyBound.storedValueBytes).toBe(previous.storedValueBytes);
  expect(current.legacyBound.hasUntrackedValues).toBe(previous.hasUntrackedValues);
  for (const value of current.legacyValues) expect(current.values.has(value)).toBe(true);
}

describe('bounded sensitive values: the legacy bound is the previous bound (#151, D4)', () => {
  it('keeps the same values, order and counts for the same sources', () => {
    fc.assert(fc.property(fc.array(operation, { minLength: 1, maxLength: 6 }), (operations) => {
      const { current, previous } = run(operations);
      expectSameLegacyBound(current, previous);
    }), runs);
  }, TIMEOUT);

  it('keeps the legacy bound as before when only the new bound is full', () => {
    const current = createBoundedSensitiveValues();
    const previous = legacyValue.createBoundedSensitiveValues();
    const filler = newOnlyText(MAX_TRACKED_SENSITIVE_VALUES + 10, 'f');
    for (const source of [filler, 'TOKEN=Zq1Zq', { password: 'Zq2Zq' }, 'https://u:Zq3Zq@host']) {
      current.collect(source);
      previous.collect(source);
    }
    expect(current.newExhausted).toBe(true);
    expect(current.legacyExhausted).toBe(false);
    expectSameLegacyBound(current, previous);
    expect(current.legacyValues.has('Zq1Zq')).toBe(true);

    // A bounded source whose new bound is full: its legacy bound is copied, its full mark is not.
    const copied = createBoundedSensitiveValues();
    const copiedPrevious = legacyValue.createBoundedSensitiveValues();
    copied.collect(current);
    copiedPrevious.collect(previous);
    copied.collect('password=Zq4Zq');
    copiedPrevious.collect('password=Zq4Zq');
    expect(copied.legacyExhausted).toBe(false);
    expect(copied.newExhausted).toBe(true);
    expectSameLegacyBound(copied, copiedPrevious);
  });

  it('puts a string in the legacy bound when the legacy path brings it after the new bound kept it', () => {
    const current = createBoundedSensitiveValues();
    const previous = legacyValue.createBoundedSensitiveValues();
    for (const source of [newOnlyText(3, 'q'), { password: ['q0x', 'q1x'] }]) {
      current.collect(source);
      previous.collect(source);
    }
    expect(current.newBound.values.has('q0x')).toBe(true);
    expect(current.legacyValues.has('q0x')).toBe(true);
    expectSameLegacyBound(current, previous);
  });

  it('repacks the stream values by origin', () => {
    fc.assert(fc.property(leakText.chain((text) => chunksOf(text)), (chunks) => {
      const current = new SensitiveTextStreamBuffer();
      const previous = new legacyStream.SensitiveTextStreamBuffer();
      for (const chunk of chunks) {
        current.write(chunk, undefined);
        previous.write(chunk, undefined);
      }
      current.preview(undefined);
      previous.preview(undefined);
      current.flush(undefined);
      previous.flush(undefined);
      expectSameLegacyBound(current.sensitiveValues, previous.sensitiveValues);
    }), runs);
  }, TIMEOUT);

  it('repacks the normalized tool result values by origin', () => {
    fc.assert(fc.property(smallSource, (source) => {
      const current = toolResultSensitiveValues(source);
      const previous = legacyValue.createBoundedSensitiveValues();
      previous.collect(source);
      previous.collect({ token: [...previous.values].map((value) => normalizeToolResultText(value)) });
      expectSameLegacyBound(current, previous);
    }), runs);
  }, TIMEOUT);
});

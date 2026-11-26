import fc from 'fast-check';
import { scaledMs } from '../../scripts/test-time-factor.mjs';
import { describe, expect, it } from 'vitest';
import * as frozen from '../shared/utils/sensitive-text-legacy.js';
import { legacySequentialRanges } from '../shared/utils/sensitive-text-legacy-trace.js';
import * as legacy from './helpers/legacy-sensitive-text.js';
import { leakText, markersIn, stageCollisionText } from './helpers/sensitive-text-arbitraries.js';

// Design 3, F: the frozen copy in the product (sensitive-text-legacy.ts, curl read linearly) and the
// trace (sensitive-text-legacy-trace.ts) against 337062193 itself (helpers/legacy-sensitive-text.ts).
// TAKT_PBT_FIDELITY_RUNS sets the F2 run count (25,000 for the mutation check of design 10, N4).

const NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 400;
})();
const F2_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_FIDELITY_RUNS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NUM_RUNS;
})();
const SEED = Number.parseInt(process.env.TAKT_PBT_SEED ?? '', 10);
const seed = Number.isInteger(SEED) ? { seed: SEED } : {};
const TIMEOUT = scaledMs(Math.max(120_000, Math.max(NUM_RUNS, F2_RUNS) * 20));

const collected = (collect: (text: string, values: Set<string>) => void, text: string): string[] => {
  const values = new Set<string>();
  collect(text, values);
  return [...values];
};

function expectTraceMatchesDisplay(text: string): void {
  const trace = legacySequentialRanges(text, []);
  const display = legacy.sanitizeSensitiveText(text);
  expect(trace.view, JSON.stringify(text)).toBe(display);
  const masked = legacy.maskSensitiveRanges(text, trace.ranges);
  for (const marker of markersIn(text)) expect(masked.includes(marker), `${marker} in ${JSON.stringify(text)}`).toBe(display.includes(marker));
}

describe('frozen copy and trace fidelity (#151)', () => {
  it('F1: the frozen copy finds what 337062193 finds', () => {
    fc.assert(fc.property(fc.oneof(leakText, stageCollisionText), (text) => {
      expect(frozen.sanitizeSensitiveText(text)).toBe(legacy.sanitizeSensitiveText(text));
      expect(frozen.sensitiveTextRanges(text, new Set())).toEqual(legacy.sensitiveTextRanges(text, new Set()));
      expect(collected(frozen.collectEmbeddedSensitiveValues, text)).toEqual(collected(legacy.collectEmbeddedSensitiveValues, text));
    }), { numRuns: NUM_RUNS, ...seed });
  }, TIMEOUT);

  it('F2: the trace ends with the string the previous display returned', () => {
    fc.assert(fc.property(leakText, expectTraceMatchesDisplay), { numRuns: F2_RUNS, ...seed });
  }, TIMEOUT);

  it('F2: the trace ends with the previous display where two steps collide', () => {
    fc.assert(fc.property(stageCollisionText, expectTraceMatchesDisplay), { numRuns: F2_RUNS, ...seed });
  }, TIMEOUT);

  it('F3: the trace from the known values ends with the previous composition', () => {
    fc.assert(fc.property(fc.oneof(leakText, stageCollisionText), (text) => {
      const values = new Set(collected(legacy.collectEmbeddedSensitiveValues, text));
      const trace = legacySequentialRanges(text, frozen.knownValueRanges(text, values));
      const composed = legacy.sanitizeTextWithValues(text, values);
      expect(trace.view, JSON.stringify(text)).toBe(composed);
      const masked = legacy.maskSensitiveRanges(text, trace.ranges);
      for (const marker of markersIn(text)) expect(masked.includes(marker), `${marker} in ${JSON.stringify(text)}`).toBe(composed.includes(marker));
    }), { numRuns: NUM_RUNS, ...seed });
  }, TIMEOUT);

  it.each([
    ['token=""--password=x'],
    ['Authorization: Bearer\t\tx'],
    ['Authorization: Bearer '],
    ["token=''?token=a"],
    ['cookie=[REDACTED]'],
  ])('F2 on %j: zero-width insertions and header whitespace', (text) => {
    expectTraceMatchesDisplay(text);
  });
});

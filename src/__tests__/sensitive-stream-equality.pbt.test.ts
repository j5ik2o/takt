import fc from 'fast-check';
import { scaledMs } from '../../scripts/test-time-factor.mjs';
import { describe, expect, it } from 'vitest';
import { responseBoundaryRanges } from '../infra/deepseek-harness/client.js';
import { createStreamTrackingState, trackOpenCodeTextBytes } from '../infra/opencode/OpenCodeStreamHandler.js';
import {
  createLegacySensitiveTextStreamBuffer, createLegacySensitiveTextStreamRedactor, type SensitiveTextStreamBufferLike,
} from '../shared/utils/sensitive-stream.js';
import { createBoundedSensitiveValues, type BoundedSensitiveValues } from '../shared/utils/sensitive-value.js';
import { legacyResponseBoundaryRanges } from './helpers/legacy-deepseek-boundary.js';
import * as legacyStream from './helpers/legacy-sensitive-stream.js';
import * as legacyValue from './helpers/legacy-sensitive-value.js';
import { chunksOf, leakText, markersIn } from './helpers/sensitive-text-arbitraries.js';

// #151 (design 3 "stream equality", 7.1, 11): the inner-only stream is the previous stream. The
// same operations on the inner-only stream and on the copy of 337062193's stream give the same
// results: commits, redactor output, previews, and the legacy bound of the tracked values. In 2a,
// OpenCode (and DeepSeek, see deepseek-harness-client.test.ts) still build the inner-only stream, so
// their stream output does not change by a character (R9-1).

const NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 400;
})();
const SEED = Number.parseInt(process.env.TAKT_PBT_SEED ?? '', 10);
const runs = { numRuns: NUM_RUNS, ...(Number.isInteger(SEED) ? { seed: SEED } : {}) };
const TIMEOUT = scaledMs(Math.max(120_000, NUM_RUNS * 200));

/** A source as the callers pass it; `bounded` is another stream's tracked values (OpenCode, DeepSeek). */
type SourceSpec =
  | { readonly kind: 'none' }
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'bounded'; readonly texts: readonly string[] };

type Operation =
  | { readonly kind: 'write'; readonly text: string; readonly source: SourceSpec; readonly substrings: readonly string[] }
  | { readonly kind: 'preview'; readonly source: SourceSpec }
  | { readonly kind: 'flush'; readonly source: SourceSpec; readonly substrings: readonly string[] };

const sourceSpec: fc.Arbitrary<SourceSpec> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<SourceSpec>({ kind: 'none' }) },
  { weight: 2, arbitrary: leakText.chain((text) => fc.constantFrom<SourceSpec>(
    { kind: 'value', value: text },
    { kind: 'value', value: { password: text } },
    { kind: 'value', value: { headers: { cookie: text } } },
  )) },
  { weight: 1, arbitrary: fc.array(leakText, { minLength: 1, maxLength: 2 }).map((texts): SourceSpec => ({ kind: 'bounded', texts })) },
);

const substrings: fc.Arbitrary<string[]> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<string[]>([]) },
  { weight: 1, arbitrary: leakText.map((text) => markersIn(text).map((marker) => `${marker}x`)) },
);

const operations: fc.Arbitrary<Operation[]> = leakText
  .chain((text) => fc.tuple(chunksOf(text), fc.array(fc.tuple(sourceSpec, substrings, fc.boolean()), { minLength: 4, maxLength: 4 }), sourceSpec, substrings))
  .map(([chunks, extras, flushSource, flushSubstrings]) => {
    const steps: Operation[] = [];
    chunks.forEach((text, index) => {
      const [source, values, preview] = extras[index % extras.length]!;
      steps.push({ kind: 'write', text, source, substrings: values });
      if (preview) steps.push({ kind: 'preview', source });
    });
    steps.push({ kind: 'flush', source: flushSource, substrings: flushSubstrings });
    return steps;
  });

function currentSource(spec: SourceSpec): unknown {
  if (spec.kind === 'none') return undefined;
  if (spec.kind === 'value') return spec.value;
  const values = createBoundedSensitiveValues();
  for (const text of spec.texts) values.collect(text);
  return values;
}

function previousSource(spec: SourceSpec): unknown {
  if (spec.kind === 'none') return undefined;
  if (spec.kind === 'value') return spec.value;
  const values = legacyValue.createBoundedSensitiveValues();
  for (const text of spec.texts) values.collect(text);
  return values;
}

function expectSameTracking(current: BoundedSensitiveValues, previous: legacyValue.BoundedSensitiveValues): void {
  expect([...current.legacyValues]).toEqual([...previous.values]);
  expect(current.legacyExhausted).toBe(previous.exhausted);
  expect(current.legacyBound.skippedValueCount).toBe(previous.skippedValueCount);
  expect(current.legacyBound.skippedValueBytes).toBe(previous.skippedValueBytes);
  expect(current.legacyBound.truncatedSourceCount).toBe(previous.truncatedSourceCount);
  expect(current.legacyBound.hasUntrackedValues).toBe(previous.hasUntrackedValues);
}

function expectSameStream(current: SensitiveTextStreamBufferLike, steps: readonly Operation[]): void {
  const previous = new legacyStream.SensitiveTextStreamBuffer();
  for (const step of steps) {
    if (step.kind === 'write') {
      expect(current.write(step.text, currentSource(step.source), step.substrings))
        .toEqual(previous.write(step.text, previousSource(step.source), step.substrings));
    } else if (step.kind === 'preview') {
      expect(current.preview(currentSource(step.source))).toBe(previous.preview(previousSource(step.source)));
    } else {
      expect(current.flush(currentSource(step.source), step.substrings))
        .toEqual(previous.flush(previousSource(step.source), step.substrings));
    }
    expectSameTracking(current.sensitiveValues, previous.sensitiveValues);
  }
}

describe('the inner-only stream is the previous stream (#151)', () => {
  it('createLegacySensitiveTextStreamBuffer: the same commits, previews and tracked values', () => {
    fc.assert(fc.property(operations, (steps) => expectSameStream(createLegacySensitiveTextStreamBuffer(), steps)), runs);
  }, TIMEOUT);

  // 2a (R9-1): OpenCode's response buffer is the inner-only stream, also after the tracking limit resets it.
  it('OpenCode response buffer: the same commits, previews and tracked values as 337062193', () => {
    fc.assert(fc.property(operations, fc.boolean(), (steps, exhausted) => {
      const state = createStreamTrackingState({ textByteLimit: 0, reasoningByteLimit: 0, idLimit: 1 });
      if (exhausted) trackOpenCodeTextBytes(state, 'x');
      expectSameStream(state.responseBuffer, steps);
    }), runs);
  }, TIMEOUT);

  it('createLegacySensitiveTextStreamRedactor: the same output and previews', () => {
    fc.assert(fc.property(operations, (steps) => {
      const current = createLegacySensitiveTextStreamRedactor();
      const previous = legacyStream.createSensitiveTextStreamRedactor();
      for (const step of steps) {
        if (step.kind === 'write') expect(current.write(step.text, currentSource(step.source))).toBe(previous.write(step.text, previousSource(step.source)));
        else if (step.kind === 'preview') expect(current.preview(currentSource(step.source))).toBe(previous.preview(previousSource(step.source)));
        else expect(current.flush(currentSource(step.source))).toBe(previous.flush(previousSource(step.source)));
      }
      expectSameTracking(current.sensitiveValues, previous.sensitiveValues);
    }), runs);
  }, TIMEOUT);

  it('DeepSeek tool-call boundary: the same ranges as 337062193', () => {
    const boundaryCase = leakText.chain((text) => fc.tuple(
      fc.constant(text),
      fc.nat(text.length),
      fc.array(leakText, { maxLength: 2 }),
      fc.oneof(fc.constant<Record<string, string>>({}), leakText.map((value) => ({ apiKey: markersIn(value)[0] ?? value }))),
    ));
    fc.assert(fc.property(boundaryCase, ([text, cut, tracked, knownSecrets]) => {
      const current = createBoundedSensitiveValues();
      const previous = legacyValue.createBoundedSensitiveValues();
      for (const source of tracked) {
        current.collect(source);
        previous.collect(source);
      }
      const boundaryText = text.slice(0, cut);
      const next = text.slice(cut);
      expect(responseBoundaryRanges(boundaryText, next, current.legacyValues, knownSecrets))
        .toEqual(legacyResponseBoundaryRanges(boundaryText, next, previous.values, knownSecrets));
    }), runs);
  }, TIMEOUT);
});

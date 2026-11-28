import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { scaledMs } from '../../scripts/test-time-factor.mjs';
import { describe, expect, it } from 'vitest';
import {
  createLegacySensitiveTextStreamBuffer, createLegacySensitiveTextStreamRedactor, createSensitiveTextStreamRedactor,
  SensitiveTextStreamBuffer, type SensitiveTextCommit, type SensitiveTextStreamBufferLike, type SensitiveTextStreamRedactor,
} from '../shared/utils/sensitive-stream.js';
import { classifyToolResult } from '../shared/tool-activity/result.js';
import {
  maskSensitiveRanges, previousSensitiveTextRanges, REDACTED_VALUE, sensitiveTextRanges, type SensitiveRange,
} from '../shared/utils/sensitive-text.js';
import { createBoundedSensitiveValues, type BoundedSensitiveValues } from '../shared/utils/sensitive-value.js';
import * as legacyStream from './helpers/legacy-sensitive-stream.js';
import * as legacyValue from './helpers/legacy-sensitive-value.js';
import { leakText, markersIn } from './helpers/sensitive-text-arbitraries.js';
import {
  driveRunningResult, driveToolActivityDisplay, laterOutputs, streamedForDisplay, unseenMarkers, legacyUnitBoundaries, moreMarkers, NEW_ONLY_OPEN_LINES, streamCuts, TOOL_PATHS, type ToolRun,
} from './helpers/sensitive-stream-drivers.js';

// #151 2a (design 3 "stream paths, second PR", 7.1, 8): the new stream hides at least what the
// inner-only stream hides. The inner-only stream is the first PR's stream (the equality property
// ties it to 337062193), so the new stream leaks no more than the previous stream. No inputs are
// excluded; narrowing a property goes to the marshal (PBT decision).

const NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 400;
})();
const SEED = Number.parseInt(process.env.TAKT_PBT_SEED ?? '', 10);
const runs = { numRuns: NUM_RUNS, ...(Number.isInteger(SEED) ? { seed: SEED } : {}) };
const TIMEOUT = scaledMs(Math.max(180_000, NUM_RUNS * 400));
const MAX_PENDING = 10_000;
const EXTRA_MARKER = /Z[xy]\d+Z[xy]/gu;

// ---------------------------------------------------------------------------------------------
// Sources as the callers pass them.

type SourceSpec =
  | { readonly kind: 'none' }
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'bounded'; readonly texts: readonly string[] }
  /** Another stream's own tracked values (OpenCode, DeepSeek). */
  | { readonly kind: 'peer'; readonly texts: readonly string[] }
  /** Tracked values whose new bound is full, and whose legacy bound is full (design 1.2 N1, 7.1 (s3)). */
  | { readonly kind: 'newFull' }
  | { readonly kind: 'legacyFull' };

const FULL = Array.from({ length: 1_030 }, (_, index) => `full-value-${index}`);

const sourceSpec: fc.Arbitrary<SourceSpec> = fc.oneof(
  { weight: 8, arbitrary: fc.constant<SourceSpec>({ kind: 'none' }) },
  { weight: 3, arbitrary: leakText.chain((text) => fc.constantFrom<SourceSpec>(
    { kind: 'value', value: text },
    { kind: 'value', value: { password: text } },
    { kind: 'value', value: { headers: { cookie: text } } },
    { kind: 'value', value: { token: markersIn(text) } },
  )) },
  { weight: 2, arbitrary: fc.array(leakText, { minLength: 1, maxLength: 2 }).map((texts): SourceSpec => ({ kind: 'bounded', texts })) },
  { weight: 2, arbitrary: fc.array(leakText, { minLength: 1, maxLength: 2 }).map((texts): SourceSpec => ({ kind: 'peer', texts })) },
  { weight: 1, arbitrary: fc.constantFrom<SourceSpec>({ kind: 'newFull' }, { kind: 'legacyFull' }) },
);

function currentSource(spec: SourceSpec): unknown {
  if (spec.kind === 'none') return undefined;
  if (spec.kind === 'value') return spec.value;
  const values = createBoundedSensitiveValues();
  if (spec.kind === 'bounded') for (const text of spec.texts) values.collect(text);
  if (spec.kind === 'newFull') values.collectNewOnly({ token: FULL });
  if (spec.kind === 'legacyFull') values.collect({ token: FULL });
  if (spec.kind === 'peer') {
    const peer = new SensitiveTextStreamBuffer();
    for (const text of spec.texts) peer.write(text, undefined);
    peer.flush(undefined);
    return peer.sensitiveValues;
  }
  return values;
}

/** The same source for 337062193's stream: new-only values do not exist there. */
function previousSource(spec: SourceSpec): unknown {
  if (spec.kind === 'none') return undefined;
  if (spec.kind === 'value') return spec.value;
  const values = legacyValue.createBoundedSensitiveValues();
  if (spec.kind === 'bounded') for (const text of spec.texts) values.collect(text);
  if (spec.kind === 'legacyFull') values.collect({ token: FULL });
  if (spec.kind === 'peer') {
    const peer = new legacyStream.SensitiveTextStreamBuffer();
    for (const text of spec.texts) peer.write(text, undefined);
    peer.flush(undefined);
    return peer.sensitiveValues;
  }
  return values;
}

function expectSameLegacyBound(next: BoundedSensitiveValues, inner: BoundedSensitiveValues): void {
  expect([...next.legacyValues]).toEqual([...inner.legacyValues]);
  expect(next.legacyExhausted).toBe(inner.legacyExhausted);
  expect(next.legacyBound.skippedValueCount).toBe(inner.legacyBound.skippedValueCount);
  expect(next.legacyBound.skippedValueBytes).toBe(inner.legacyBound.skippedValueBytes);
  expect(next.legacyBound.truncatedSourceCount).toBe(inner.legacyBound.truncatedSourceCount);
  expect(next.legacyBound.hasUntrackedValues).toBe(inner.legacyBound.hasUntrackedValues);
}

function expectSameAsPrevious(next: BoundedSensitiveValues, previous: legacyValue.BoundedSensitiveValues): void {
  expect([...next.legacyValues]).toEqual([...previous.values]);
  expect(next.legacyExhausted).toBe(previous.exhausted);
  expect(next.legacyBound.skippedValueCount).toBe(previous.skippedValueCount);
  expect(next.legacyBound.skippedValueBytes).toBe(previous.skippedValueBytes);
  expect(next.legacyBound.truncatedSourceCount).toBe(previous.truncatedSourceCount);
  expect(next.legacyBound.hasUntrackedValues).toBe(previous.hasUntrackedValues);
}

// ---------------------------------------------------------------------------------------------
// Texts. Every leak form, lines only the new reading keeps open across a newline (they make the
// outer hold span writes), and A3's long inputs past the 10,000 character cap.

const heldText: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...NEW_ONLY_OPEN_LINES), leakText, fc.constantFrom("Zq5Zq' rest\n", 'Zq5Zq" rest\n', ''), fc.oneof(fc.constant(''), leakText))
  .map(([open, middle, close, rest]) => open + middle + '\n' + close + rest);

const longText: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...NEW_ONLY_OPEN_LINES), fc.integer({ min: 8, max: 12 }), fc.constantFrom('token=Zq5Zq\n', 'token="Zq5Zq\n', ''), leakText)
  .map(([open, lines, tail, rest]) => open + ('p'.repeat(999) + '\n').repeat(lines) + tail + rest);

const streamText: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: leakText },
  { weight: 3, arbitrary: heldText },
  { weight: 1, arbitrary: longText },
);

// ---------------------------------------------------------------------------------------------
// The buffer stage (design 3 "the general property of the buffer stage", R7-4, R9-3, R9-5, R10-2).

type BufferOp =
  | { readonly kind: 'write'; readonly text: string; readonly source: SourceSpec; readonly substrings: readonly string[]; readonly extra: readonly SensitiveRange[] }
  | { readonly kind: 'preview'; readonly source: SourceSpec }
  | { readonly kind: 'flush'; readonly source: SourceSpec; readonly substrings: readonly string[] };

/** The fourth argument: none, a range anywhere in the chunk, or a marker it covers (across a newline when `straddles`). */
type ExtraSpec = { readonly kind: 'none' } | { readonly kind: 'range'; readonly a: number; readonly b: number } | { readonly kind: 'marker'; readonly at: number; readonly straddles: boolean };

const extraSpec: fc.Arbitrary<ExtraSpec> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<ExtraSpec>({ kind: 'none' }) },
  { weight: 1, arbitrary: fc.tuple(fc.nat(), fc.nat()).map(([a, b]): ExtraSpec => ({ kind: 'range', a, b })) },
  { weight: 2, arbitrary: fc.tuple(fc.nat(), fc.boolean()).map(([at, straddles]): ExtraSpec => ({ kind: 'marker', at, straddles })) },
);

const substringValues = (text: string): fc.Arbitrary<string[]> => fc.oneof(
  { weight: 3, arbitrary: fc.constant<string[]>([]) },
  { weight: 1, arbitrary: fc.constant(markersIn(text)) },
);

const bufferOps: fc.Arbitrary<BufferOp[]> = streamText
  .chain((text) => streamCuts(text).chain((chunks) => fc.tuple(
    fc.constant(chunks),
    fc.array(fc.tuple(sourceSpec, substringValues(text), fc.boolean(), extraSpec), { minLength: chunks.length, maxLength: chunks.length }),
    sourceSpec,
    substringValues(text),
  )))
  .map(([chunks, extras, flushSource, flushSubstrings]) => {
    const steps: BufferOp[] = [];
    chunks.forEach((chunk, index) => {
      const [source, substrings, preview, extra] = extras[index]!;
      let text = chunk;
      let ranges: SensitiveRange[] = [];
      if (extra.kind === 'range' && chunk.length > 0) {
        const a = extra.a % chunk.length;
        const b = a + 1 + (extra.b % (chunk.length - a));
        ranges = [{ start: a, end: b }];
      } else if (extra.kind === 'marker') {
        const at = extra.at % (chunk.length + 1);
        const marker = `Zx${index}Zx` + (extra.straddles ? `\nZy${index}Zy` : '');
        text = chunk.slice(0, at) + marker + chunk.slice(at);
        ranges = [{ start: at, end: at + marker.length }];
      }
      steps.push({ kind: 'write', text, source, substrings, extra: ranges });
      if (preview) steps.push({ kind: 'preview', source });
    });
    steps.push({ kind: 'flush', source: flushSource, substrings: flushSubstrings });
    return steps;
  });

/** What one side committed: the text, its masked form, and the positions it hid in the written text. */
class Committed {
  text = '';
  masked = '';
  readonly ends: number[] = [];
  private readonly hidden: Array<readonly [number, number]> = [];

  add(commit: SensitiveTextCommit): void {
    for (const range of commit.ranges) this.hidden.push([this.text.length + range.start, this.text.length + range.end]);
    this.masked += maskSensitiveRanges(commit.text, commit.ranges);
    this.text += commit.text;
    if (commit.text !== '') this.ends.push(this.text.length);
  }

  hiddenPositions(): Uint8Array {
    const positions = new Uint8Array(this.text.length);
    for (const [start, end] of this.hidden) positions.fill(1, start, end);
    return positions;
  }
}

interface BufferRun {
  readonly written: string;
  readonly next: Committed;
  readonly inner: Committed;
  readonly previousBoundaries: Set<number>;
  /** Positions passed as the fourth argument, in the written text. */
  readonly extra: readonly number[];
  readonly previews: ReadonlyArray<{ readonly next: string; readonly inner: string; readonly nextShown: string; readonly innerShown: string }>;
  readonly pendingAfterWrite: readonly number[];
}

/** Runs the same operations on the new stream, the inner-only stream and 337062193's stream, checking the legacy bound at each step. */
function runBuffer(steps: readonly BufferOp[]): BufferRun {
  const nextBuffer = new SensitiveTextStreamBuffer();
  const innerBuffer: SensitiveTextStreamBufferLike = createLegacySensitiveTextStreamBuffer();
  const previousBuffer = new legacyStream.SensitiveTextStreamBuffer();
  const previous = legacyUnitBoundaries(previousBuffer);
  const next = new Committed();
  const inner = new Committed();
  let written = '';
  const extra: number[] = [];
  const previews: Array<{ next: string; inner: string; nextShown: string; innerShown: string }> = [];
  const pendingAfterWrite: number[] = [];
  for (const step of steps) {
    if (step.kind === 'write') {
      for (const range of step.extra) for (let at = range.start; at < range.end; at++) extra.push(written.length + at);
      next.add(nextBuffer.write(step.text, currentSource(step.source), step.substrings, step.extra));
      inner.add(innerBuffer.write(step.text, currentSource(step.source), step.substrings));
      previousBuffer.write(step.text, previousSource(step.source), step.substrings);
      written += step.text;
      // Point 5 (R9-2): with no PEM block open, the outer hold and the inner pending tail stay within the cap.
      if (!previous.inPem()) pendingAfterWrite.push(written.length - next.text.length);
    } else if (step.kind === 'preview') {
      const nextPreview = nextBuffer.preview(currentSource(step.source));
      const innerPreview = innerBuffer.preview(currentSource(step.source));
      previousBuffer.preview(previousSource(step.source));
      previews.push({ next: nextPreview, inner: innerPreview, nextShown: next.masked + nextPreview, innerShown: inner.masked + innerPreview });
    } else {
      next.add(nextBuffer.flush(currentSource(step.source), step.substrings));
      inner.add(innerBuffer.flush(currentSource(step.source), step.substrings));
      previousBuffer.flush(previousSource(step.source), step.substrings);
    }
    // Point 4: the outer puts nothing into the legacy bound, so it is the inner-only stream's, and 337062193's.
    expectSameLegacyBound(nextBuffer.sensitiveValues, innerBuffer.sensitiveValues);
    expectSameAsPrevious(nextBuffer.sensitiveValues, previousBuffer.sensitiveValues);
  }
  return { written, next, inner, previousBoundaries: previous.boundaries, extra, previews, pendingAfterWrite };
}

function expectBufferProperties(run: BufferRun): void {
  expect(run.next.text).toBe(run.written);
  expect(run.inner.text).toBe(run.written);
  // Point 1: every cut of the new stream is a cut of the previous stream.
  for (const end of run.next.ends) expect(run.previousBoundaries.has(end), `cut at ${end}`).toBe(true);
  // Point 2: what the inner-only stream hid, and what the fourth argument named, the new stream hides.
  const nextHidden = run.next.hiddenPositions();
  const innerHidden = run.inner.hiddenPositions();
  for (let at = 0; at < innerHidden.length; at++) if (innerHidden[at] === 1) expect(nextHidden[at], `position ${at}`).toBe(1);
  for (const at of run.extra) expect(nextHidden[at], `fourth argument at ${at}`).toBe(1);
  expect(run.next.masked.match(EXTRA_MARKER) ?? []).toEqual([]);
  // Point 3: at each time, committed output and preview show no marker more often than the previous stream did then.
  for (const preview of run.previews) {
    expect(moreMarkers(preview.nextShown, preview.innerShown)).toEqual([]);
    expect(preview.next.match(EXTRA_MARKER) ?? []).toEqual([]);
  }
  // Point 5.
  for (const pending of run.pendingAfterWrite) expect(pending).toBeLessThanOrEqual(MAX_PENDING);
}

// R12-4: operations on which a commit that applies neither the units' previous ranges (s1) nor their
// trace (s2) leaves a position the previous stream hid unhidden (found by the mutant in
// `sensitive-stream-union.mutants.mjs`). The property runs them first.
const BUFFER_EXAMPLES: BufferOp[][] = [
  [{"kind": "write", "text": "?tok", "source": {"kind": "peer", "texts": ["https://proxy-authorization:a@h Authorization: Basic Zq0Zq"]}, "substrings": [], "extra": []}, {"kind": "write", "text": "en=''", "source": {"kind": "value", "value": "https://token:p@host-uZq0Zq\nhttps://user:pa,Zq900Zq@host"}, "substrings": ["Zq136Zq", "Zq43Zq", "Zq5Zq"], "extra": [{"start": 0, "end": 1}]}, {"kind": "write", "text": "Zx2Zx\"\n[TOKEN=Zq136Zq|#🔑286)\n", "source": {"kind": "value", "value": "--user=\":\nZq0Zq\"--user=\":Zq0Zq\"\nhttps://user:pa,Zq900Zq@host"}, "substrings": [], "extra": [{"start": 0, "end": 5}]}, {"kind": "write", "text": "Zx3Zx\",\"[https://proxy-authorization:a@h Authorization", "source": {"kind": "none"}, "substrings": ["Zq136Zq", "Zq43Zq", "Zq5Zq"], "extra": [{"start": 0, "end": 5}]}, {"kind": "write", "text": ": Basic \"gq3\\Zq43Zq", "source": {"kind": "newFull"}, "substrings": [], "extra": [{"start": 0, "end": 1}]}, {"kind": "write", "text": "@@@@@@@@ -u-u\n\nZq5Zq\" rest\n", "source": {"kind": "none"}, "substrings": ["Zq136Zq", "Zq43Zq", "Zq5Zq"], "extra": [{"start": 0, "end": 1}]}, {"kind": "flush", "source": {"kind": "peer", "texts": ["--token Zq0Zq\nhttps://user:pa,Zq900Zq@host"]}, "substrings": []}],
];

describe('#151 2a: the buffer stage hides at least what the inner-only stream hides', () => {
  it('cuts, ranges, the fourth argument, previews, the legacy bound and the held length (R7-4, R9-3, R9-5)', () => {
    fc.assert(fc.property(bufferOps, (steps) => expectBufferProperties(runBuffer(steps))),
      { ...runs, examples: BUFFER_EXAMPLES.map((steps) => [steps] as [BufferOp[]]) });
  }, TIMEOUT);

  // R10-2: a unit that the inner pending tail carries across writes gets the third argument of the
  // write that completes it, as before; the outer hold keeps the third argument per held unit only.
  it('a third argument across the inner pending tail is what the previous stream used (R10-2)', () => {
    const steps: BufferOp[] = [
      { kind: 'write', text: 'pre Zs1Zs mid', source: { kind: 'none' }, substrings: ['Zs1Zs'], extra: [] },
      { kind: 'write', text: ' Zs2Zs end\n', source: { kind: 'none' }, substrings: ['Zs2Zs'], extra: [] },
      { kind: 'flush', source: { kind: 'none' }, substrings: [] },
    ];
    const run = runBuffer(steps);
    expectBufferProperties(run);
    expect(run.next.masked).toBe(run.inner.masked);
    expect(run.next.masked).toBe('pre Zs1Zs mid [REDACTED] end\n');
  });
});

// ---------------------------------------------------------------------------------------------
// The tool paths (design 3 "D2-stream", "D3-stream"): daemon toolTurn, ToolActivityDisplay, runningResult.

const toolInput: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({}) },
  { weight: 1, arbitrary: leakText.map((text) => ({ command: text })) },
  { weight: 1, arbitrary: leakText.map((text) => ({ token: markersIn(text)[0] ?? text })) },
  { weight: 1, arbitrary: leakText.map((text) => ({ password: text })) },
);

function toolRunOf(input: Record<string, unknown>, chunks: readonly string[]): fc.Arbitrary<ToolRun> {
  return fc.array(fc.boolean(), { minLength: chunks.length, maxLength: chunks.length }).map((previews) => ({ input, chunks, previews }));
}

const d2Runs: fc.Arbitrary<ToolRun> = fc.tuple(toolInput, streamText)
  .chain(([input, text]) => streamCuts(text).chain((chunks) => toolRunOf(input, chunks)));

const d3Runs: fc.Arbitrary<ToolRun> = leakText
  .filter((text) => markersIn(text).length > 0)
  .chain((source) => fc.tuple(
    fc.constant(source),
    fc.constantFrom(...markersIn(source)).chain((marker) => fc.constantFrom(...laterOutputs(source, marker))),
    fc.oneof(fc.constant({}), fc.constant({ command: source })),
  ))
  .chain(([source, later, input]) => fc.tuple(streamCuts(source), streamCuts(later))
    .chain(([first, second]) => toolRunOf(input, [...first, '\n', ...second])));

function expectNoMoreMarkers(name: string, run: ToolRun, drive: (run: ToolRun, createRedactor?: () => SensitiveTextStreamRedactor) => ReturnType<typeof driveRunningResult>): void {
  const next = drive(run);
  const inner = drive(run, createLegacySensitiveTextStreamRedactor);
  expect(next.moments.length, name).toBe(inner.moments.length);
  next.moments.forEach((shown, at) => expect(moreMarkers(shown, inner.moments[at]!), `${name} at ${at}`).toEqual([]));
  expect(moreMarkers(next.committed, inner.committed), name).toEqual([]);
  if (next.sensitiveValues !== undefined && inner.sensitiveValues !== undefined) expectSameLegacyBound(next.sensitiveValues, inner.sensitiveValues);
}

// R12-4 (design 13th edition): runs on which a stream whose preview does not apply the inner tail's
// previous ranges (`legacyMerged` and its trace) shows a marker the previous stream hid. Found by the
// mutant in `sensitive-stream-union.mutants.mjs`; every display test runs them first, so the display
// tests catch that mutant on every run, not only on a lucky seed.
const DISPLAY_EXAMPLES: ToolRun[] = [
  {"input": {"token": "'1f5i45c7ba2\u001b89w1bgp66\";"}, "chunks": ["TOKEN=Zq560Zq&&bk1h5s', 'https://token:p@host;cookie=q5se;j2w1m1'yZq337Zq", "g20v0gg161v3h=#\r\n&[-u a:b--password --password ||@@\r\nZq134Zq0', ''--user=\\\"#'516j4m\\\":}787}ojp40wp[Zq760Zq1i738o1#🔑\\\" \"ghp_Zq326Zqabcdefgh\t\nhttps://TOKEN:p@HOST-uuser:Zq110Zq"], "previews": [true, false]},
  {"input": {}, "chunks": ["\"redis:", "//:Zq138Zqj", "@host/repo.git'[-u:|1y}Zq686Zq", ": [-u a:b--password --password \nZq226Zq=", "\n", "later output", ":", " Zq226Zq end"], "previews": [false, false, true, false, false, false, false, false]},
  {"input": {"password": "\"--user=\": Zq142Zq🔑v705o041z8t9k997 \" "}, "chunks": ["'redis:", "//b8v5782352oy", "0hee8:", "Zq461Zq@h:", "5432/db;\"[\"https", ":", "//loc", "alhost:Zq906Zq\",\"ops", "@example.test\"]\""], "previews": [false, false, false, false, false, false, false, true, false]},
  {"input": {}, "chunks": ["https", "://set-cookie", ":", "a@h Set-Cookie: s=Zq26Zq'http:", "//u", ":Zq44Zqa;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;a;Zq144Zq@host@TOKEN=token :&password=", "\" \"]01n6d🔑éZq52Zq<249rqt0nb495;[sk-Zq423Zqabcdefgh@'https://set-cookie:a@host,Cookie: 5'\\`q3edZq671Zq", "'", "\n", "echoed https://set-cookie:a@h Set-Cookie: s=Zq26Zq"], "previews": [false, false, false, false, false, false, true, false, false, false]},
];

// ToolActivityDisplay (design 3, 13th edition; the marshal's decision, 2026-11-27, strengthened after
// design review 12, R12-3). The display prints its stream's output with a line and byte cap and aligns
// a printed preview with the later commit by their common prefix (`unprinted`). Neither is redaction,
// and neither is monotone in what the stream hides, so the display is not compared with the previous
// display after the cap. Instead, at each time t:
//
//   (i)   count_m(newStream.views[t]) ≤ count_m(innerStream.views[t]) for every marker m, where
//         views[t] is what the stream committed by t plus its preview at t, the stream getting the
//         tool's output the way the display feeds it (normalized, a preview where the display reads
//         one, a flush at the end), with no display in between;
//   (ii)  markers(what the new display printed up to t) ⊆ markers(innerStream outputs up to t);
//   (iii) every row the new display printed at t is a substring of newStream.views[t'] for some
//         t' ≤ t: the display prints only what its own stream returned.
//
// Narrowed, by name: (a) a marker the previous display did not print only because its cap stopped
// it is not counted as hidden, and (b) printing an occurrence again is not counted. Not allowed (the
// review's (c)): showing, at another place, an occurrence the previous stream hid because the
// previous stream showed the same marker somewhere else. (iii) fails then, since the row is not what
// the stream returned; (i) fails when the stream itself shows it.
function rowsOf(shown: string): string[] {
  return shown === '' ? [] : shown.split('\n');
}

/** Rows printed by each time that are not a substring of what the stream returned by then (iii). */
function rowsNotFromTheStream(moments: readonly string[], views: readonly string[]): string[] {
  const unexplained: string[] = [];
  let printed = 0;
  moments.forEach((shown, at) => {
    const rows = rowsOf(shown);
    for (const row of rows.slice(printed)) {
      if (!views.slice(0, at + 1).some((view) => view.includes(row))) unexplained.push(row);
    }
    printed = rows.length;
  });
  return unexplained;
}

function expectDisplayShowsOnlyWhatTheInnerStreamShowed(name: string, run: ToolRun, mode: 'compact' | 'expanded'): void {
  const next = driveToolActivityDisplay(run, mode);
  const inner = driveToolActivityDisplay(run, mode, createLegacySensitiveTextStreamRedactor);
  const nextStream = streamedForDisplay(run, createSensitiveTextStreamRedactor, mode);
  expect(next.moments.length, name).toBe(inner.moments.length);
  nextStream.views.forEach((view, at) => expect(moreMarkers(view, inner.views![at]!), `${name} (i) at ${at}`).toEqual([]));
  next.moments.forEach((shown, at) => expect(unseenMarkers(shown, inner.streamed![at]!), `${name} (ii) at ${at}`).toEqual([]));
  // A structured (JSON) result is printed from its projection, not from the stream (`[structured
  // output omitted]` and the projected text); (iii) is about the rows the stream feeds.
  if (classifyToolResult(run.chunks.join('')).kind === 'text') {
    expect(rowsNotFromTheStream(next.moments, nextStream.views), `${name} (iii)`).toEqual([]);
  }
}

// The review's (c): a display that prints the second row unhidden passes (ii), since the previous
// stream shows `Zq7Zq` on the first row, and fails (iii).
it('(iii) catches a display that prints a row its stream hid (R12-3)', () => {
  const run: ToolRun = { input: {}, chunks: ['echo Zq7Zq\n', 'token=Zq7Zqsecretpart\n'], previews: [false, false] };
  const stream = streamedForDisplay(run, createLegacySensitiveTextStreamRedactor, 'compact');
  expect(stream.views.at(-1)).toBe('echo Zq7Zq\ntoken=[REDACTED]\n');
  const regressed = ['echo Zq7Zq', 'echo Zq7Zq\ntoken=Zq7Zqsecretpart', 'echo Zq7Zq\ntoken=Zq7Zqsecretpart'];
  expect(unseenMarkers(regressed.at(-1)!, stream.streamed.at(-1)!)).toEqual([]);
  expect(rowsNotFromTheStream(regressed, stream.views)).toEqual(['token=Zq7Zqsecretpart']);
});

describe('#151 2a: the tool paths show no marker more than the inner-only stream (D2-stream, D3-stream, D4)', () => {
  for (const mode of ['compact', 'expanded'] as const) {
    const name = `ToolActivityDisplay (${mode})`;
    it(`${name}: D2-stream`, () => {
      fc.assert(fc.property(d2Runs, (run) => expectDisplayShowsOnlyWhatTheInnerStreamShowed(name, run, mode)),
        { ...runs, examples: DISPLAY_EXAMPLES.map((run) => [run] as [ToolRun]) });
    }, TIMEOUT);

    it(`${name}: D3-stream (the source, then a later output)`, () => {
      fc.assert(fc.property(d3Runs, (run) => expectDisplayShowsOnlyWhatTheInnerStreamShowed(name, run, mode)),
        { ...runs, examples: DISPLAY_EXAMPLES.map((run) => [run] as [ToolRun]) });
    }, TIMEOUT);
  }

  // toolTurn and runningResult have no cap and no alignment: compared after the path, by count, at each time.
  for (const [name, drive] of TOOL_PATHS.filter(([path]) => !path.startsWith('ToolActivityDisplay'))) {
    it(`${name}: D2-stream`, () => {
      fc.assert(fc.property(d2Runs, (run) => expectNoMoreMarkers(name, run, drive)), runs);
    }, TIMEOUT);

    it(`${name}: D3-stream (the source, then a later output)`, () => {
      fc.assert(fc.property(d3Runs, (run) => expectNoMoreMarkers(name, run, drive)), runs);
    }, TIMEOUT);
  }

  it('the redactor: D3-stream, previews and the legacy bound', () => {
    fc.assert(fc.property(d3Runs, sourceSpec, (run, spec) => {
      const next = createSensitiveTextStreamRedactor();
      const inner = createLegacySensitiveTextStreamRedactor();
      let nextShown = '';
      let innerShown = '';
      run.chunks.forEach((chunk, index) => {
        nextShown += next.write(chunk, currentSource(spec));
        innerShown += inner.write(chunk, currentSource(spec));
        if (run.previews[index] === true) {
          expect(moreMarkers(nextShown + next.preview(currentSource(spec)), innerShown + inner.preview(currentSource(spec)))).toEqual([]);
        }
        expectSameLegacyBound(next.sensitiveValues, inner.sensitiveValues);
      });
      nextShown += next.flush(currentSource(spec));
      innerShown += inner.flush(currentSource(spec));
      expect(moreMarkers(nextShown, innerShown)).toEqual([]);
      expectSameLegacyBound(next.sensitiveValues, inner.sensitiveValues);
    }), runs);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------------------------
// Fixed examples (design 8, "inputs that can break the stream", A1–A8). Markers are made up.

/** The new redactor's output for `chunks`, with a preview after each write. */
function redacted(chunks: readonly string[], source: unknown = undefined): { output: string; previews: string[] } {
  const redactor = createSensitiveTextStreamRedactor();
  const previews: string[] = [];
  let output = '';
  for (const chunk of chunks) {
    output += redactor.write(chunk, source);
    previews.push(redactor.preview(source));
  }
  return { output: output + redactor.flush(source), previews };
}

function expectHiddenEverywhere(chunks: readonly string[], secrets: readonly string[]): void {
  const { output, previews } = redacted(chunks);
  for (const secret of secrets) {
    expect(output, 'redactor').not.toContain(secret);
    for (const preview of previews) expect(preview, 'preview').not.toContain(secret);
    for (const [name, drive] of TOOL_PATHS) {
      const shown = drive({ input: {}, chunks, previews: chunks.map(() => true) });
      expect(shown.committed, name).not.toContain(secret);
      for (const moment of shown.moments) expect(moment, name).not.toContain(secret);
    }
  }
}

const writes = (...texts: string[]): BufferOp[] => [
  ...texts.map((text): BufferOp => ({ kind: 'write', text, source: { kind: 'none' }, substrings: [], extra: [] })),
  { kind: 'flush', source: { kind: 'none' }, substrings: [] },
];

describe('#151 2a fixed examples (design 8)', () => {
  it.each([
    [['tok', 'en=Zq1Zq\n'], 'Zq1Zq'],
    [['Authori', 'zation: Bearer Zq2Zq\n'], 'Zq2Zq'],
    [['?to', "ken=' 'Zq4Zq\n"], 'Zq4Zq'],
    [['--pass', 'word', ' Zq6Zq\n'], 'Zq6Zq'],
  ])('A1 a key cut by a chunk: %j', (chunks, secret) => {
    expectHiddenEverywhere(chunks, [secret]);
    expectBufferProperties(runBuffer(writes(...chunks)));
  });

  it.each([
    [['password="a', 'b"Zq3Zq\n'], 'Zq3Zq'],
    [["token=''", '"Zq7Zq"\n'], 'Zq7Zq'],
    [['--password=\\" ', '\\"Zq0Zq\n'], 'Zq0Zq'],
    [['token="Zq8Zq\n', 'plain line\n'], 'Zq8Zq'],
    [["--password=''a'\n", "Zq5Zq' rest\n"], 'Zq5Zq'],
  ])('A2 a quote cut by a chunk: %j', (chunks, secret) => {
    expectHiddenEverywhere(chunks, [secret]);
    expectBufferProperties(runBuffer(writes(...chunks)));
  });

  // Design 7.1 preview step 4: the new guard runs over the whole shown text, held units included,
  // so a line inside a quote only the new reading keeps open is not shown before the quote closes.
  it.each([
    [["--password=''a'\n", 'Zq57Zq'], 'Zq57Zq'],
    [["--password=''a'\n", 'Zq57Zq more\n'], 'Zq57Zq'],
    [["?token=''\"\n", 'Zq59Zq x'], 'Zq59Zq'],
  ])('A2 the preview hides a value only the new reading keeps open: %j', (chunks, secret) => {
    const redactor = createSensitiveTextStreamRedactor();
    for (const chunk of chunks) {
      redactor.write(chunk, undefined);
      expect(redactor.preview(undefined)).not.toContain(secret);
    }
  });

  it('A3 (i) the cap is crossed inside `token=Zq5Zq`: the new stream cuts at the last previous boundary', () => {
    const head = "--password=''a'\n" + ('p'.repeat(99) + '\n').repeat(100) + 'token=Zq';
    const run = runBuffer(writes(head, '5Zq\n'));
    expectBufferProperties(run);
    expect(run.next.masked).not.toContain('Zq5Zq');
    expect(run.next.masked).not.toMatch(/(?<!Zq)5Zq/u);
  });

  // R12-1 (design 13th edition 7.1, rules 3a and 3b): a forced cut at the cap falls at the last
  // previous boundary where the new reading of the held run is closed, before the open new value,
  // not at the end of the held run. 10,000 plain characters, then a quote only the new reading keeps
  // open, in one write: cutting at the end of the held run would read `Zq6Zq more` on its own.
  it.each([
    ['in one write', [('p'.repeat(99) + '\n').repeat(100) + "--password=''a'\n" + 'Zq6Zq more\n' + "end' x\n"]],
    ['the plain lines first', [('p'.repeat(99) + '\n').repeat(100), "--password=''a'\n" + 'Zq6Zq more\n' + "end' x\n"]],
    ['one line per write', [...(('p'.repeat(99) + '\n').repeat(100) + "--password=''a'\n" + 'Zq6Zq more\n' + "end' x\n").split(/(?<=\n)/u)]],
  ])('A3 (iv) a cut at the cap keeps a new value whole, %s (R12-1)', (_name, chunks) => {
    const run = runBuffer(writes(...chunks));
    expectBufferProperties(run);
    expect(run.next.masked).not.toContain('Zq6Zq');
    expectHiddenEverywhere(chunks, ['Zq6Zq']);
  });

  // 14th edition, point 2 (design 7.1, rules 3a and 3b): at the cap the held run is cut non-forced at
  // the last boundary where the new reading is closed, and the rest is forced only while it is still
  // over the cap. The open line below is under the cap after that cut, so it stays held. A stream
  // that forces every held unit at the cap, or that forces the rest after the non-forced cut, commits
  // the open line in this write.
  it('A3 (v) at the cap the cut is non-forced at the last closed boundary and the rest under it stays held', () => {
    const plain = ('p'.repeat(99) + '\n').repeat(100);
    const commit = new SensitiveTextStreamBuffer().write(plain + "--password=''a'\n", undefined);
    expect(commit.text).toBe(plain);
    expect(commit.text.length).toBe(10_000);
  });

  // 14th edition, point 2 (design 7.1, rules 3a and 3b): the rest is forced only when it is still over
  // the cap. Here the open new value itself is longer than the cap after the non-forced cut, so the
  // remaining held run is committed under force (the documented last resort, 9.3) and the write ends
  // with nothing pending.
  it('A3 (vi) the rest after the non-forced cut is forced while it is still over the cap', () => {
    const plain = ('p'.repeat(99) + '\n').repeat(100);
    const commit = new SensitiveTextStreamBuffer().write(plain + "--password=''a'\n" + 'q'.repeat(10_020) + '\n', undefined);
    expect(commit.text.startsWith(plain)).toBe(true);
    expect(commit.text.length).toBeGreaterThan(plain.length);
    expect(commit.text).not.toContain('q');
  });

  it('A3 (ii) 20,000 plain characters in one write after a 200 character hold', () => {
    const held = "--password=''a'\n" + 'q'.repeat(183) + '\n';
    expectBufferProperties(runBuffer(writes(held, ('p'.repeat(99) + '\n').repeat(200))));
  });

  it('A3 (iii) one previous unit longer than 10,000 characters is committed in the write that brings it', () => {
    const unit = 'token="' + ('v'.repeat(99) + '\n').repeat(110) + 'Zq5Zq"\n';
    const run = runBuffer(writes("--password=''a'\n", unit));
    expectBufferProperties(run);
    expect(run.pendingAfterWrite.at(-1)).toBe(0);
    expect(run.next.masked).not.toContain('Zq5Zq');
  });

  it('A4 a value only the new reading found in one stream is tracked by the next stream', () => {
    const first = createSensitiveTextStreamRedactor();
    first.write("TOKEN=apikey: ?token=' 'Zq44Zq\n", undefined);
    first.flush(undefined);
    const sources = createBoundedSensitiveValues();
    sources.collect(first.sensitiveValues);
    const second = createSensitiveTextStreamRedactor();
    expect(second.write('echoed Zq44Zq\n', sources) + second.flush(sources)).toBe(`echoed ${REDACTED_VALUE}\n`);
    // The copy does not put the new stream's values into the legacy bound (D4).
    const previous = legacyStream.createSensitiveTextStreamRedactor();
    previous.write("TOKEN=apikey: ?token=' 'Zq44Zq\n", undefined);
    previous.flush(undefined);
    const previousSources = legacyValue.createBoundedSensitiveValues();
    previousSources.collect(previous.sensitiveValues);
    expectSameAsPrevious(sources, previousSources);
    // runningResult collects the input into its stream and then writes.
    const shown = driveRunningResult({ input: { token: 'Zq45Zq' }, chunks: ['echoed Zq4', '5Zq\n'], previews: [true, true] });
    for (const moment of shown.moments) expect(moment).not.toContain('Zq45Zq');
  });

  it('A5 a source that arrives while the new stream holds a line hides it, and the legacy bound stays the previous one', () => {
    const steps: BufferOp[] = [
      { kind: 'write', text: "--password=''a'\npassword: Zq9Zq\necho Zq9Zq\n", source: { kind: 'none' }, substrings: [], extra: [] },
      { kind: 'preview', source: { kind: 'value', value: { token: 'Zq9Zq' } } },
      { kind: 'write', text: "' end\n", source: { kind: 'value', value: { token: 'Zq9Zq' } }, substrings: [], extra: [] },
      { kind: 'flush', source: { kind: 'none' }, substrings: [] },
    ];
    const run = runBuffer(steps);
    expectBufferProperties(run);
    expect(run.next.masked).not.toContain('Zq9Zq');
  });

  // The previous preview keeps the last 8 KiB of the masked pending text. The new reading hides a
  // long secret at the end, so the new masked text is shorter: a window taken over it would reach
  // `Zq60Zq` at the left, which the previous preview cut off (design 7.1 `cutOrig`, R10-1).
  const A6_LINE = 'Zq60Zq ' + 'a'.repeat(6_000) + " --password=''a'" + 'Zq61Zq' + 'b'.repeat(2_994);

  it.each([
    ['the inner pending tail only', [A6_LINE]],
    ['after a held line', ["--password=''a'\n", A6_LINE]],
  ])('A6 the preview window, %s', (_name, chunks) => {
    const redactor = createSensitiveTextStreamRedactor();
    for (const chunk of chunks) redactor.write(chunk, undefined);
    const preview = redactor.preview(undefined);
    expect(preview).not.toContain('Zq60Zq');
    expect(preview).not.toContain('Zq61Zq');
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(8 * 1024);
    const steps: BufferOp[] = [
      ...chunks.map((text): BufferOp => ({ kind: 'write', text, source: { kind: 'none' }, substrings: [], extra: [] })),
      { kind: 'preview', source: { kind: 'none' } },
      { kind: 'preview', source: { kind: 'value', value: { token: 'Zq60Zq' } } },
      { kind: 'flush', source: { kind: 'none' }, substrings: [] },
    ];
    expectBufferProperties(runBuffer(steps));
  });

  // R10-1: the previous preview cut off the left of a 9,000 character inner pending tail. The new
  // reading hides all of that tail (the quote the held line opened never closes), so nothing the
  // previous preview cut off can show, and the window reaches back into the held line, which the
  // previous stream had already committed.
  it('A6 the preview window reaches the held line when everything the previous preview cut off is hidden (R10-1)', () => {
    const redactor = createSensitiveTextStreamRedactor();
    redactor.write("visible held text --password=''a'\n", undefined);
    redactor.write('a'.repeat(9_000), undefined);
    const preview = redactor.preview(undefined);
    expect(preview).toContain('visible held text');
    expect(preview).not.toContain('aaaa');
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(8 * 1024);
  });

  it('A7 (ii) third and fourth arguments of earlier writes survive a hold over several writes (R9-3)', () => {
    const first = "--password=''a'\nfirst Zx1Zx Zs1Zs\n";
    const second = "second Zx2Zx Zs2Zs' end\n";
    const steps: BufferOp[] = [
      { kind: 'write', text: first, source: { kind: 'none' }, substrings: ['Zs1Zs'], extra: [{ start: first.indexOf('Zx1Zx'), end: first.indexOf('Zx1Zx') + 5 }] },
      { kind: 'preview', source: { kind: 'none' } },
      { kind: 'write', text: second, source: { kind: 'none' }, substrings: ['Zs2Zs'], extra: [{ start: second.indexOf('Zx2Zx'), end: second.indexOf('Zx2Zx') + 5 }] },
      { kind: 'flush', source: { kind: 'none' }, substrings: [] },
    ];
    const run = runBuffer(steps);
    expectBufferProperties(run);
    for (const secret of ['Zx1Zx', 'Zx2Zx', 'Zs1Zs', 'Zs2Zs']) expect(run.next.masked).not.toContain(secret);
  });

  it('A8 a PEM block whose end is cut by a chunk, after a line the new reading holds', () => {
    const chunks = ["--password=''a'\n", '-----BEGIN RSA PRIVATE KEY-----\ntoken: Zq80Zq\nMIIBzq\n-----EN', 'D RSA PRIVATE KEY-----\nafter\n'];
    expectHiddenEverywhere(chunks, ['Zq80Zq', 'MIIBzq']);
    expectBufferProperties(runBuffer(writes(...chunks)));
  });

  it('A8 an open PEM block past 10,000 characters: the held line is committed and the preview shows no key', () => {
    const held = "--password=''a'\nheld line\n";
    const pem = '-----BEGIN RSA PRIVATE KEY-----\n' + 'MIIB'.repeat(2_600);
    const buffer = new SensitiveTextStreamBuffer();
    const first = buffer.write(held, undefined);
    const second = buffer.write(pem, undefined);
    expect(first.text + second.text).toBe(held);
    const preview = buffer.preview(undefined);
    expect(preview.endsWith(REDACTED_VALUE)).toBe(true);
    expect(preview).not.toContain('MIIB');
  });
});

// ---------------------------------------------------------------------------------------------
// 14th edition, point 1 (design 7.1, line 719): the outer hold-back guard reads the new reading (a)
// alone. The union (`sensitiveTextRanges`, which also carries the previous display's trace (b) and
// the previous range path (c)) would still hold a URL whose host the new reading has closed. A guard
// built by adding (b) and (c) holds the run below, so this test fails then.

describe('#151 2a: the outer guard is the new reading (a) alone (14th edition)', () => {
  const QUOTES = ['', '"', "'", '\\"', '@'] as const;
  const holdsAtTheEnd = (read: (text: string) => readonly SensitiveRange[], text: string): boolean =>
    QUOTES.some((quote) => read(text + 'x' + quote).some((range) => range.end > text.length));

  it('newReadingRanges (a) is closed where the union still holds the URL', async () => {
    const module = await import('../shared/utils/sensitive-text.js') as unknown as {
      newReadingRanges?: (text: string) => readonly SensitiveRange[];
    };
    expect(module.newReadingRanges, 'newReadingRanges is exported (design 7.1)').toBeTypeOf('function');
    const text = 'https://cookie:a@host ';
    expect(holdsAtTheEnd(module.newReadingRanges!, text), 'the new reading (a)').toBe(false);
    expect(holdsAtTheEnd((value) => sensitiveTextRanges(value, new Set()), text), 'the union ((a), (b), (c))').toBe(true);
  });

  // The outer hold is built from the new reading (a), not from the previous range path (c): this line
  // is closed to the copy's range path (and to the first PR's `pendingSensitiveValueRanges`), but the
  // new reading keeps the quote after `a` open, so the outer stream must hold the line.
  it('the outer hold keeps a line the new reading keeps open and the previous range path closes', () => {
    const line = "--password=''a'\n";
    expect(QUOTES.some((quote) => previousSensitiveTextRanges(line + 'x' + quote)
      .some((range) => range.end > line.length)), 'the previous range path (c)').toBe(false);
    expect(new SensitiveTextStreamBuffer().write(line, undefined).text).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// 14th edition, point 3 (design 7, line 34): an open PEM block is `inPemBlock`; the design does not
// name it `pemLabel`. The name is what the rules 3a/3b and preview read, so the source must say it.

describe('#151 2a: an open PEM block is inPemBlock (14th edition)', () => {
  it('sensitive-stream.ts names the open PEM state inPemBlock and does not use pemLabel', () => {
    const source = readFileSync(new URL('../shared/utils/sensitive-stream.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/\binPemBlock\b/u);
    expect(source).not.toMatch(/\bpemLabel\b/u);
  });
});

// ---------------------------------------------------------------------------------------------
// 14th edition, point 5 (design 7.2): the model has nine invariants, and `unionSafety` is their
// conjunction, not a tenth entry; it has eight mutations, `capCutAtHeldEnd` among them, and each
// broken model has a witness test.

const UNION_SPEC = new URL('../../specs/quint/sensitive-stream-buffer/sensitiveStreamUnion.qnt', import.meta.url);
const UNION_TEST_SPEC = new URL('../../specs/quint/sensitive-stream-buffer/sensitiveStreamUnion_test.qnt', import.meta.url);

describe('#151 2a: the Quint model states nine invariants and eight mutations (14th edition)', () => {
  it('unionSafety is the conjunction of the nine invariants, not a tenth entry', () => {
    const source = readFileSync(UNION_SPEC, 'utf8');
    const marker = 'val unionSafety =';
    const start = source.indexOf(marker);
    expect(start, marker).toBeGreaterThanOrEqual(0);
    const lines: string[] = [];
    for (const raw of source.slice(start + marker.length).split('\n')) {
      const line = raw.trim();
      if (line === '}') break;
      if (line !== '') lines.push(line);
    }
    const names = lines.flatMap((line) => [...line.matchAll(/\b([A-Za-z][A-Za-z0-9]*)\b/gu)]
      .map((match) => match[1]!)).filter((name) => name !== 'and');
    expect(names).toEqual([
      'capCutsOutsideNewValues', 'conservation', 'boundedPending', 'boundariesSubset', 'unitHidesLegacy',
      'unitHidesLegacyDisplay', 'unitHidesExtra', 'noSplitNew', 'noSplitLegacy',
    ]);
    expect(names).not.toContain('unionSafety');
  });

  it('there are eight mutations, including capCutAtHeldEnd, each with a witness test', () => {
    const source = readFileSync(UNION_SPEC, 'utf8');
    const block = source.slice(source.indexOf('const mutation: str'), source.indexOf('val ALPHABET'));
    const mutations = [...block.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!).filter((name) => name !== 'none');
    expect(mutations).toEqual([
      'cutAtWriteEnd', 'rereadJoined', 'noNewGuard', 'newGuardOnly',
      'dropHeldHidden', 'dropDisplayTrace', 'dropEarlierExtra', 'capCutAtHeldEnd',
    ]);
    const tests = readFileSync(UNION_TEST_SPEC, 'utf8');
    for (const mutation of mutations) expect(tests, mutation).toContain(`run ${mutation}WitnessTest`);
  });
});

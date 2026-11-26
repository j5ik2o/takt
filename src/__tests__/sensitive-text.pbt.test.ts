import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import counterexamples from '../../test/fixtures/sensitive-text-redaction-counterexamples.json' with { type: 'json' };
import { Phase1ExecutionLog } from '../core/workflow/phase1-execution-log.js';
import { normalizeToolResultText, sanitizeNormalizedToolResultText, toolResultSensitiveValues } from '../shared/tool-activity/sanitize.js';
import { createSensitiveTextStreamRedactor } from '../shared/utils/sensitive-stream.js';
import { legacySequentialRanges } from '../shared/utils/sensitive-text-legacy-trace.js';
import {
  maskSensitiveRanges,
  sanitizeSensitiveText,
  sanitizeTextWithValues,
  sensitiveTextRanges,
} from '../shared/utils/sensitive-text.js';
import {
  collectSensitiveStringValues,
  createBoundedSensitiveValues,
  sanitizeSensitiveTextWithKnownValues,
  sanitizeSensitiveValueWithKnownValues,
} from '../shared/utils/sensitive-value.js';
import * as legacy from './helpers/legacy-sensitive-text.js';
import * as legacyStream from './helpers/legacy-sensitive-stream.js';
import * as legacyValue from './helpers/legacy-sensitive-value.js';
import {
  CURL_USER_AT_LINE_END,
  OVERMASK_FORMS,
  afterCurlUserAtLineEnd,
  chunksOf,
  contextDocument,
  leakText,
  markersIn,
  plainLine,
  plainText,
  referenceText,
} from './helpers/sensitive-text-arbitraries.js';
import { referenceRanges } from './helpers/sensitive-text-reference.js';
import { trackedValuesOf } from './helpers/sensitive-text-tracked.js';

// Properties of #151 (design section 3). Nothing is excluded: every marker the previous
// implementation (337062193, the copies in helpers/) hid must stay hidden on every path.
// TAKT_PBT_NUM_RUNS and TAKT_PBT_SEED set the run count and seed for the release check;
// TAKT_PBT_REPORT=1 prints how many inputs, markers and later outputs were checked.

const NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 400;
})();
const SEED = Number.parseInt(process.env.TAKT_PBT_SEED ?? '', 10);
const runs = { numRuns: NUM_RUNS, ...(Number.isInteger(SEED) ? { seed: SEED } : {}) };
const TIMEOUT = Math.max(120_000, NUM_RUNS * 200);
const NO_VALUES: ReadonlySet<string> = new Set();

const counts = { inputs: 0, markers: 0, laterOutputs: 0 };
afterAll(() => {
  if (process.env.TAKT_PBT_REPORT === '1') console.log(`[pbt] ${JSON.stringify({ runs, ...counts })}`);
});

// The previous phase 1 log: Phase1ExecutionLog of 337062193 with its redaction imports pointed at
// the frozen copies, and its display (normalizeProviderEventValue) running the previous display.
type ReportLog = new () => Pick<Phase1ExecutionLog, 'recordEvent' | 'toReportInput'>;
let LegacyPhase1ExecutionLog: ReportLog;
beforeAll(async () => {
  vi.resetModules();
  vi.doMock('../shared/utils/sensitiveText.js', () => import('./helpers/legacy-sensitive-text.js'));
  ({ Phase1ExecutionLog: LegacyPhase1ExecutionLog } = await import('./helpers/legacy-phase1-execution-log.js'));
  vi.doUnmock('../shared/utils/sensitiveText.js');
  vi.resetModules();
});

function phase1Report(chunks: readonly string[], Log: ReportLog = Phase1ExecutionLog): string {
  const log = new Log();
  for (const text of chunks) log.recordEvent({ type: 'text', data: { text } });
  return log.toReportInput();
}

/** The text the phase 1 log keeps for one text event. */
function phase1Text(text: string): string {
  const line = phase1Report([text]).split('\n')[0]!;
  return (JSON.parse(line) as { event: { data: { text: string } } }).event.data.text;
}

const rangeOutput = (text: string, values: ReadonlySet<string> = NO_VALUES): string =>
  maskSensitiveRanges(text, sensitiveTextRanges(text, values));
const legacyRangeOutput = (text: string, values: ReadonlySet<string> = new Set()): string =>
  legacy.maskSensitiveRanges(text, legacy.sensitiveTextRanges(text, values));

/** Later outputs that print part of `text` around `marker` on their own, plus `text` and its lines. */
function laterOutputs(text: string, marker: string): string[] {
  const outputs = new Set<string>([marker, `echoed ${marker}`, text, ...text.split(/\r?\n/u)]);
  for (const separator of [/\s+/u, /[;&|]/, /[,"'`]/, /@/, /[:=]/, /[\s;&|,"'`]/u]) {
    for (const piece of text.split(separator)) {
      if (piece.includes(marker)) outputs.add(`echoed ${piece}`);
    }
  }
  return [...outputs].filter((output) => output.includes(marker));
}

/** Source shapes for the tracking paths (design 3, D3). */
function sourcesOf(text: string): unknown[] {
  return [text, { password: text }, { headers: { cookie: text } }, { env: { GITHUB_TOKEN: text } }, [[text], { note: [text] }]];
}

/** Values tracked from another source (finding 8 (5)): parts of the words that hold a marker. */
function otherSourceValues(text: string): string[] {
  const values = new Set<string>();
  for (const word of text.split(/[\s"'`,;]+/u)) {
    for (const marker of markersIn(word)) {
      const end = word.indexOf(marker) + marker.length;
      values.add(word.slice(0, end));
      values.add(word.slice(Math.max(0, end - marker.length - 2)));
    }
  }
  return [...values];
}

function streamOutputs(
  create: () => { write(text: string, source: unknown): string; flush(source: unknown): string; preview(source: unknown): string },
  sourceChunks: readonly string[],
  laterChunks: readonly string[],
): { source: string; later: string; preview: string } {
  const redactor = create();
  let source = '';
  for (const chunk of sourceChunks) source += redactor.write(chunk, undefined);
  const preview = redactor.preview(undefined);
  source += redactor.flush(undefined);
  let later = '';
  for (const chunk of laterChunks) later += redactor.write(chunk, undefined);
  later += redactor.flush(undefined);
  return { source, later, preview };
}

function legacyToolResultValues(source: unknown): legacyValue.BoundedSensitiveValues {
  const known = legacyValue.createBoundedSensitiveValues();
  known.collect(source);
  known.collect({ token: [...known.values].map((value) => normalizeToolResultText(value)) });
  return known;
}

describe('sensitive text redaction properties (#151)', () => {
  // The phase 1 log gets the text in 1 to 4 stream fragments (6th review, R6-2).
  it('D1, D2: hides on screen, in ranges and in the phase 1 log what the previous display or range path hid', () => {
    fc.assert(fc.property(leakText.chain((text) => fc.tuple(fc.constant(text), chunksOf(text))), ([text, fragments]) => {
      counts.inputs += 1;
      const display = sanitizeSensitiveText(text);
      const ranges = rangeOutput(text);
      const report = phase1Report(fragments);
      const legacyDisplay = legacy.sanitizeSensitiveText(text);
      const legacyRanges = legacyRangeOutput(text);
      const legacyReport = phase1Report(fragments, LegacyPhase1ExecutionLog);
      for (const marker of markersIn(text)) {
        counts.markers += 1;
        if (!legacyDisplay.includes(marker) || !legacyRanges.includes(marker)) {
          expect(display, `display of ${JSON.stringify(text)}`).not.toContain(marker);
        }
        if (!legacyRanges.includes(marker)) expect(ranges, `ranges of ${JSON.stringify(text)}`).not.toContain(marker);
        if (!legacyReport.includes(marker)) expect(report, `phase 1 of ${JSON.stringify(fragments)}`).not.toContain(marker);
      }
    }), runs);
  }, TIMEOUT);

  it('D3: hides in later output what the previous tracking hid, for every source shape', () => {
    fc.assert(fc.property(leakText, (text) => {
      const markers = markersIn(text);
      if (markers.length === 0) return;
      for (const source of [...sourcesOf(text), { token: otherSourceValues(text) }]) {
        const known = collectSensitiveStringValues(source);
        const legacyKnown = legacyValue.collectSensitiveStringValues(source);
        const bounded = createBoundedSensitiveValues();
        bounded.collect(source);
        const legacyBounded = legacyValue.createBoundedSensitiveValues();
        legacyBounded.collect(source);
        const toolValues = toolResultSensitiveValues(source);
        const legacyToolValues = legacyToolResultValues(source);
        for (const marker of markers) {
          for (const later of laterOutputs(text, marker)) {
            counts.laterOutputs += 1;
            const where = `${JSON.stringify(later)} after ${JSON.stringify(source)}`;
            if (!legacyValue.sanitizeSensitiveTextWithKnownValues(later, source).includes(marker)) {
              expect(sanitizeSensitiveTextWithKnownValues(later, source), where).not.toContain(marker);
            }
            if (!JSON.stringify(legacyValue.sanitizeSensitiveValueWithKnownValues({ out: later }, source)).includes(marker)) {
              expect(JSON.stringify(sanitizeSensitiveValueWithKnownValues({ out: later }, source)), where).not.toContain(marker);
            }
            if (!legacyRangeOutput(later, legacyKnown.values).includes(marker)) {
              expect(rangeOutput(later, known.values), where).not.toContain(marker);
            }
            if (!legacyValue.sanitizeSensitiveTextWithKnownValues(later, legacyBounded).includes(marker)) {
              expect(sanitizeSensitiveTextWithKnownValues(later, bounded), `bounded ${where}`).not.toContain(marker);
            }
            const normalizedMarker = normalizeToolResultText(marker);
            if (!legacyValue.sanitizeSensitiveTextWithKnownValues(normalizeToolResultText(later), legacyToolValues).includes(normalizedMarker)) {
              expect(sanitizeNormalizedToolResultText(later, toolValues), `tool result ${where}`).not.toContain(normalizedMarker);
            }
          }
        }
      }
    }), runs);
  }, TIMEOUT);

  it('D3: hides in streamed output, and in its preview, what the previous stream hid', () => {
    const streamCase = leakText.chain((text) => fc.tuple(
      fc.constant(text),
      chunksOf(text),
      fc.constantFrom(text, ...markersIn(text).flatMap((marker) => laterOutputs(text, marker)))
        .chain((later) => fc.tuple(fc.constant(later), chunksOf(later))),
    ));
    fc.assert(fc.property(streamCase, ([text, sourceChunks, [later, laterChunks]]) => {
      const current = streamOutputs(createSensitiveTextStreamRedactor, sourceChunks, laterChunks);
      const previous = streamOutputs(legacyStream.createSensitiveTextStreamRedactor, sourceChunks, laterChunks);
      const where = `${JSON.stringify(sourceChunks)} then ${JSON.stringify(laterChunks)}`;
      for (const marker of markersIn(text + later)) {
        if (!previous.source.includes(marker)) expect(current.source, where).not.toContain(marker);
        if (!previous.later.includes(marker)) expect(current.later, where).not.toContain(marker);
        if (!previous.preview.includes(marker)) expect(current.preview, `preview ${where}`).not.toContain(marker);
      }
    }), runs);
  }, TIMEOUT);

  // The stream paths are the previous stream in the first PR (design 11); their L is in the second.
  it('L: never leaks a well-formed credential, on screen, in the phase 1 log or in later output', () => {
    fc.assert(fc.property(contextDocument, fc.constantFrom('\n', '\r\n'), (lines, newline) => {
      const text = lines.map((line) => line.text).join(newline);
      const markers = markersIn(text);
      for (const output of [sanitizeSensitiveText(text), rangeOutput(text), phase1Report([text])]) {
        for (const marker of markers) expect(output, JSON.stringify(text)).not.toContain(marker);
      }
      for (const echo of lines.flatMap((line) => line.echoes)) {
        for (const later of [`echoed ${echo}`, echo, `later output: ${echo} end`]) {
          for (const output of [
            sanitizeSensitiveTextWithKnownValues(later, { command: text }),
            sanitizeTextWithValues(later, trackedValuesOf(text)),
            phase1Report([text + '\n', later]),
          ]) {
            for (const marker of markersIn(echo)) expect(output, `${JSON.stringify(later)} after ${JSON.stringify(text)}`).not.toContain(marker);
          }
        }
      }
    }), runs);
  }, TIMEOUT);

  it('I: leaves text without credentials unchanged on every path', () => {
    fc.assert(fc.property(plainText, (text) => {
      for (const output of [
        sanitizeSensitiveText(text),
        rangeOutput(text),
        sanitizeTextWithValues(text, trackedValuesOf(text)),
        sanitizeSensitiveTextWithKnownValues(text, { command: text }),
        phase1Text(text),
      ]) {
        expect(output, JSON.stringify(text)).toBe(text);
      }
    }), runs);
  }, TIMEOUT);

  it('K: masks each known over-masked form to its fixed output, and leaves the plain lines around it', () => {
    const form = fc.constantFrom(...OVERMASK_FORMS, [CURL_USER_AT_LINE_END, CURL_USER_AT_LINE_END] as const);
    fc.assert(fc.property(plainLine, form, plainLine, (before, [input, output], after) => {
      const text = `${before}\n${input}\n${after}`;
      const next = input === CURL_USER_AT_LINE_END ? afterCurlUserAtLineEnd(after) : after;
      const expected = `${before}\n${output}\n${next}`;
      expect(sanitizeSensitiveText(text), JSON.stringify(text)).toBe(expected);
      expect(rangeOutput(text), JSON.stringify(text)).toBe(expected);
      // The phase 1 log also hides every other occurrence of a value it collected (as before), so
      // it is checked on the form alone.
      expect(phase1Text(input), JSON.stringify(input)).toBe(output);
    }), runs);
  }, TIMEOUT);

  it('R: agrees with the reference scanner plus the previous ranges', () => {
    fc.assert(fc.property(referenceText, (text) => {
      const expected = maskSensitiveRanges(text, [
        ...referenceRanges(text),
        ...legacySequentialRanges(text, []).ranges,
        ...legacy.sensitiveTextRanges(text, new Set()),
      ]);
      expect(sanitizeSensitiveText(text), JSON.stringify(text)).toBe(expected);
    }), runs);
  }, TIMEOUT);

  it('O: changes nothing outside the credential lines but the known over-masked forms', () => {
    const overmasked = new Map<string, string>(OVERMASK_FORMS);
    fc.assert(fc.property(contextDocument, (lines) => {
      const text = lines.map((line) => line.text).join('\n');
      const outputLines = sanitizeSensitiveText(text).split('\n');
      const expectedLines = lines.flatMap((line) => {
        const expected = line.plain ? overmasked.get(line.text) ?? line.text : undefined;
        return (expected ?? line.text).split('\n').map((part) => (expected === undefined ? undefined : part));
      });
      expect(outputLines).toHaveLength(expectedLines.length);
      expectedLines.forEach((expected, index) => {
        if (expected !== undefined) expect(outputLines[index], JSON.stringify(text)).toBe(expected);
      });
    }), runs);
  }, TIMEOUT);

  // Tracking more values in `all` never shows a marker again. Adding to `legacy` gives no such
  // promise: a value hidden first can hide a key and stop a chain, which the previous
  // implementation did as well.
  it('M: tracking more values in all keeps hidden what was hidden', () => {
    fc.assert(fc.property(leakText, fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }), (text, extra) => {
      const tracked = trackedValuesOf(text);
      const more = { all: new Set([...tracked.all, ...extra, ...otherSourceValues(text)]), legacy: tracked.legacy };
      for (const marker of markersIn(text)) {
        for (const later of laterOutputs(text, marker)) {
          if (!sanitizeTextWithValues(later, tracked).includes(marker)) {
            expect(sanitizeTextWithValues(later, more), JSON.stringify(later)).not.toContain(marker);
          }
        }
      }
    }), runs);
  }, TIMEOUT);
});

describe('sensitive text redaction counterexamples', () => {
  it.each(counterexamples.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const outputs = [sanitizeSensitiveText(entry.input), rangeOutput(entry.input)];
    const values = trackedValuesOf(entry.input);
    if ('expected' in entry && typeof entry.expected === 'string') {
      for (const output of outputs) expect(output).toBe(entry.expected);
    }
    for (const marker of markersIn(entry.input)) {
      if ('readable' in entry && Array.isArray(entry.readable) && entry.readable.includes(marker)) continue;
      for (const output of outputs) expect(output).not.toContain(marker);
      for (const later of laterOutputs(entry.input, marker)) {
        if (!legacyValue.sanitizeSensitiveTextWithKnownValues(later, entry.input).includes(marker)) {
          expect(sanitizeTextWithValues(later, values)).not.toContain(marker);
        }
      }
    }
    if ('later' in entry && typeof entry.later === 'string') {
      expect(sanitizeTextWithValues(entry.later, values)).not.toMatch(/Zq\d+Zq/);
    }
  });
});

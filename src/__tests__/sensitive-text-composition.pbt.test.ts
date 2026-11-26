import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { scaledMs } from '../../scripts/test-time-factor.mjs';
import { afterAll, describe, expect, it } from 'vitest';
import { sanitizeKnownSecrets } from '../infra/deepseek-harness/client.js';
import { sanitizeOpenCodeToolInput } from '../infra/opencode/tool-input-sanitizer.js';
import * as current from '../shared/utils/sensitive-text.js';
import * as currentValue from '../shared/utils/sensitive-value.js';
import * as legacy from './helpers/legacy-sensitive-text.js';
import * as legacyValue from './helpers/legacy-sensitive-value.js';
import { leakText, markersIn } from './helpers/sensitive-text-arbitraries.js';

// Design 3, D2 for the other compositions (6th review, R6-1): paths that mask text that another
// redaction already masked. Each property runs the path once with the frozen copies of 337062193
// and once with the current code, and asks that a marker the previous path hid stays hidden. The
// composing code is the same as in 337062193 (git diff shows no change in these lines):
// - OpenCode attempt log (attempt-runner.ts): display over known-value masking of an error.
// - OpenCode tool input (OpenCodeStreamHandler.ts emitToolUse): known-value masking of a value
//   that the tool input sanitizer already masked string by string.
// - Phase 1 log items (phase1-execution-log.ts toReportInput): display over provider events that
//   OpenCode or DeepSeek already masked.
// The DeepSeek tool-call boundary (client.ts writeResponseRedactedChunks) is part of the stream,
// which the first PR keeps equal to the previous stream: sensitive-stream-equality.pbt.test.ts.

const NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 400;
})();
const SEED = Number.parseInt(process.env.TAKT_PBT_SEED ?? '', 10);
const runs = { numRuns: NUM_RUNS, ...(Number.isInteger(SEED) ? { seed: SEED } : {}) };
const TIMEOUT = scaledMs(Math.max(120_000, NUM_RUNS * 200));

const counts = { inputs: 0, markers: 0 };
afterAll(() => {
  if (process.env.TAKT_PBT_REPORT === '1') console.log(`[pbt composition] ${JSON.stringify({ runs, ...counts })}`);
});

interface Library {
  readonly sanitizeSensitiveText: (text: string) => string;
  readonly sanitizeSensitiveTextWithKnownValues: (text: string, source: unknown) => string;
  readonly sanitizeSensitiveValueWithKnownValues: (value: unknown, source: unknown) => unknown;
  readonly sanitizeSensitiveValueWithStringReplacer: typeof currentValue.sanitizeSensitiveValueWithStringReplacer;
  readonly sensitiveTextRanges: (text: string, values: ReadonlySet<string>) => current.SensitiveRange[];
  readonly substringSensitiveRanges: (text: string, values: Iterable<string>) => current.SensitiveRange[];
  readonly maskSensitiveRanges: (text: string, ranges: readonly current.SensitiveRange[]) => string;
  readonly createBoundedSensitiveValues: () => { values: ReadonlySet<string>; collect(source: unknown): void };
}

const CURRENT: Library = {
  ...current,
  ...currentValue,
};
const PREVIOUS: Library = {
  ...legacy,
  ...legacyValue,
  sanitizeSensitiveValueWithStringReplacer: legacyValue.sanitizeSensitiveValueWithStringReplacer as Library['sanitizeSensitiveValueWithStringReplacer'],
};

/** The display that the phase 1 log runs over every string of a provider event. */
function logged(lib: Library, value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' ? lib.sanitizeSensitiveText(item) : item));
}

function expectNoNewLeak(text: string, previous: string, next: string, where: string): void {
  counts.inputs += 1;
  for (const marker of markersIn(text)) {
    counts.markers += 1;
    if (!previous.includes(marker)) expect(next, where).not.toContain(marker);
  }
}

/** A tool input, and an error or event text that may print part of it. */
const toolCase = fc.tuple(leakText, leakText, fc.constantFrom('command', 'url', 'note')).map(([input, echo, key]) => ({
  input: { [key]: input } as Record<string, unknown>,
  text: echo + '\n' + input,
}));

// OpenCode's tool input sanitizer for a tool without content keys: every string through the
// shared redaction with the values found in the input itself.
const sanitizeToolInput = (lib: Library, input: Record<string, unknown>): unknown =>
  lib.sanitizeSensitiveValueWithStringReplacer(input, () => undefined);

describe('compositions of two redactions stay at least as strong as before (#151, D2)', () => {
  // The OpenCode attempt log (attempt-runner.ts logs sanitizeSensitiveText(maskedError)), and the
  // phase 1 log over the same error downstream, over tool results and attempt result errors: a
  // display over the known-value masking (design 1.1, 7th review R7-1).
  it('a display over the known-value masking: OpenCode attempt log, tool results and errors in the phase 1 log', () => {
    fc.assert(fc.property(toolCase, ({ input, text }) => {
      const previous = legacy.sanitizeSensitiveText(legacyValue.sanitizeSensitiveTextWithKnownValues(text, input));
      const next = current.sanitizeSensitiveText(currentValue.sanitizeSensitiveTextWithKnownValues(text, input));
      expectNoNewLeak(text, previous, next, JSON.stringify({ text, input }));
      // The error passed downstream is not weaker than before either.
      expectNoNewLeak(text, legacyValue.sanitizeSensitiveTextWithKnownValues(text, input), currentValue.sanitizeSensitiveTextWithKnownValues(text, input), `downstream ${JSON.stringify({ text, input })}`);
    }), runs);
  }, TIMEOUT);

  it('OpenCode tool input: known-value masking over the tool input sanitizer, and the phase 1 log over it', () => {
    fc.assert(fc.property(toolCase, ({ input, text }) => {
      const sources = { input, text };
      // OpenCodeStreamHandler.emitToolUse: before, two maskings in a row; now one pass.
      const previous = PREVIOUS.sanitizeSensitiveValueWithKnownValues(sanitizeToolInput(PREVIOUS, input), sources);
      const next = currentValue.sanitizeSensitiveValueWithStringReplacerAndKnownValues(input, () => undefined, sources);
      const where = JSON.stringify({ input, text });
      expectNoNewLeak(JSON.stringify(input), JSON.stringify(previous), JSON.stringify(next), where);
      expectNoNewLeak(JSON.stringify(input), logged(PREVIOUS, previous), logged(CURRENT, next), `logged ${where}`);
    }), runs);
  }, TIMEOUT);

  it('Phase 1 log items: display over a DeepSeek event masked with the known secrets and ranges', () => {
    fc.assert(fc.property(toolCase, fc.boolean(), ({ input, text }, withSecret) => {
      const knownSecrets: Record<string, string> = withSecret ? { apiKey: markersIn(text)[0] ?? 'Zq999Zq' } : {};
      const event = { text, input };
      const run = (lib: Library): unknown => {
        const known = lib.createBoundedSensitiveValues();
        known.collect({ token: Object.values(knownSecrets) });
        known.collect(event);
        // client.ts: the current side calls sanitizeKnownSecrets itself; the previous side is its
        // 337062193 body (ranges with the known values and the configured secrets).
        if (lib === CURRENT) {
          const tracked = known as unknown as current.TrackedSensitiveValues;
          return lib.sanitizeSensitiveValueWithStringReplacer(event, (value) => ({ value: sanitizeKnownSecrets(value, knownSecrets, tracked) }));
        }
        return lib.sanitizeSensitiveValueWithStringReplacer(event, (value) => ({
          value: lib.maskSensitiveRanges(value, [
            ...lib.sensitiveTextRanges(value, known.values),
            ...lib.substringSensitiveRanges(value, Object.values(knownSecrets)),
          ]),
        }));
      };
      const previous = run(PREVIOUS);
      const next = run(CURRENT);
      const where = JSON.stringify(event);
      expectNoNewLeak(where, JSON.stringify(previous), JSON.stringify(next), where);
      expectNoNewLeak(where, logged(PREVIOUS, previous), logged(CURRENT, next), `logged ${where}`);
    }), runs);
  }, TIMEOUT);
});

// Counterexamples the properties above found, by the fix that closed them (6th review, R6-1).
// Each previous composition hid the marker; the current path must too.
describe('composition counterexamples (#151)', () => {
  // Closed by the new reading: a quoted value and the characters glued to it are one shell word.
  // One display of the previous implementation showed the secret in all of these; for the option
  // forms, only a second display hid it (the counterexamples), the assignment forms it never hid.
  it.each([
    ["--password=''Zq0Zq"],
    ["--password='a'Zq0Zq"],
    ["TOKEN=apikey: --password=''04grl7b@@00Zq0Zq["],
    // The option read with a space: only the option glue closes it (the `=` forms are also quoted assignments).
    ["--password ''Zq0Zq"],
    ['--token "a"Zq0Zq'],
    ['token=""Zq3Zq x'],
    ["token=''Zq2Zq"],
    ["token :--password=''Zq0Zq"],
    // A quoted part right after the quoted value is the same word (7th review, R7-2).
    [`token=''"Zq7Zq"`],
    [`token="a"'Zq7Zq' x`],
  ])('glued to a quoted value: %j', (text) => {
    expect(legacy.sanitizeSensitiveText(text)).toMatch(/Zq\d+Zq/u);
    expect(current.sanitizeSensitiveText(text)).not.toMatch(/Zq\d+Zq/u);
  });

  // Closed by running the previous display twice in (d), so a display over the output is covered.
  it.each([
    [{ command: 'ghp_Zq0Zqabcdefgh' }, "token:token :--password=''Zq0Zqhttps://token:p@host;cookie=q5se;Zq0Zqg20v0gg161v3h=#\r\n\nghp_Zq0Zqabcdefgh"],
    [{ command: 'https://u:authorization:p@h\nauthorization=Zq0Zq--user=":Zq0Zq"' }, 'https://u:cookie:p@h cookie=,"Zq1Zq@https://example.test/p?token=Zq0Zq&x=1\nhttps://u:authorization:p@h\nauthorization=Zq0Zq--user=":Zq0Zq"'],
  ])('OpenCode attempt log of %j', (input, text) => {
    const previous = legacy.sanitizeSensitiveText(legacyValue.sanitizeSensitiveTextWithKnownValues(text, input));
    const next = current.sanitizeSensitiveText(currentValue.sanitizeSensitiveTextWithKnownValues(text, input));
    for (const marker of markersIn(text)) if (!previous.includes(marker)) expect(next).not.toContain(marker);
  });

  // Closed by masking the OpenCode tool input in one pass with both sources (OpenCodeStreamHandler.ts).
  it.each([
    [
      { command: "TOKEN=apikey: --password=''Zq0Zqhttps://token:p@host;cookie=q5se;Zq0Zqg20v0gg161v3h=#\r\n" },
      "Cookie: sid=Zq0Zq,; \nTOKEN=apikey: --password=''Zq0Zqhttps://token:p@host;cookie=q5se;Zq0Zqg20v0gg161v3h=#\r\n",
    ],
    [
      { command: "TOKEN=apikey: ?token=' 'Zq0Zq 'https://token:p@host;cookie=q5se;,Zq1Zqg20v0gg161v3h=#\r\nhttps://proxy-authorization:a@h Authorization: Basic Zq0Zq" },
      "https://user:pa,Zq900Zq@hosthttps://token:p@host-uZq0Zq\nTOKEN=apikey: ?token=' 'Zq0Zq 'https://token:p@host;cookie=q5se;,Zq1Zqg20v0gg161v3h=#\r\nhttps://proxy-authorization:a@h Authorization: Basic Zq0Zq",
    ],
  ])('OpenCode tool input %j', (input, text) => {
    const sources = { input, text };
    const previous = legacyValue.sanitizeSensitiveValueWithKnownValues(sanitizeToolInput(PREVIOUS, input), sources);
    const next = currentValue.sanitizeSensitiveValueWithStringReplacerAndKnownValues(input, () => undefined, sources);
    for (const marker of markersIn(JSON.stringify(input))) {
      if (!JSON.stringify(previous).includes(marker)) expect(JSON.stringify(next)).not.toContain(marker);
      if (!logged(PREVIOUS, previous).includes(marker)) expect(logged(CURRENT, next)).not.toContain(marker);
    }
  });

  // Closed by the previous display over the previous masking in DeepSeek's sanitizeKnownSecrets.
  it.each([
    [{ command: "token:token :--password=''Zq0Zq" }, "https://user:pa,Zq900Zq@hosthttps://:Zq1Zq@host\ntoken:token :--password=''Zq0Zq"],
    [{ command: "https://token:p@host;sk-Zq0Zqabcdefgh&x1://u:@lh691Zq0Zq(?rs527r0@host'[" }, "https://user:pa,Zq900Zq@hostTOKEN=apikey: ?token=' 'Zq0Zqhttps://cookie:a@host Cookie: 0'Zq0Zqghp_Zq0Zqabcdefgh\nhttps://token:p@host;sk-Zq0Zqabcdefgh&x1://u:@lh691Zq0Zq(?rs527r0@host'["],
  ])('DeepSeek event %j, then the phase 1 log', (input, text) => {
    const event = { text, input };
    const previousKnown = legacyValue.createBoundedSensitiveValues();
    previousKnown.collect(event);
    const previous = logged(PREVIOUS, legacyValue.sanitizeSensitiveValueWithStringReplacer(event, (value) => ({
      value: legacy.maskSensitiveRanges(value, legacy.sensitiveTextRanges(value, previousKnown.values)),
    })));
    const currentKnown = currentValue.createBoundedSensitiveValues();
    currentKnown.collect(event);
    const next = logged(CURRENT, currentValue.sanitizeSensitiveValueWithStringReplacer(event, (value) => ({
      value: sanitizeKnownSecrets(value, {}, currentKnown),
    })));
    for (const marker of markersIn(text)) if (!previous.includes(marker)) expect(next).not.toContain(marker);
  });
});

// A tool content descriptor is masked with the known values, as the previous second masking did
// (review of #165): a known value equal to the descriptor's sha256 stays hidden.
it('masks a tool content descriptor with the known values', () => {
  const sha256 = createHash('sha256').update('file body').digest('hex').slice(0, 12);
  const masked = sanitizeOpenCodeToolInput({ content: 'file body' }, 'write', { source: { token: sha256 } });
  expect(JSON.stringify(masked)).not.toContain(sha256);
});

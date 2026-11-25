import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import counterexamples from '../../test/fixtures/sensitive-text-redaction-counterexamples.json' with { type: 'json' };
import { Phase1ExecutionLog } from '../core/workflow/phase1-execution-log.js';
import {
  REDACTED_VALUE,
  collectEmbeddedSensitiveValues,
  isSensitiveKeyName,
  maskSensitiveRanges,
  sanitizeSensitiveText,
  sanitizeTextWithValues,
  sensitiveTextRanges,
} from '../shared/utils/sensitive-text.js';
import { sanitizeSensitiveTextWithKnownValues } from '../shared/utils/sensitive-value.js';
import * as legacy from './helpers/legacy-sensitive-text.js';
import {
  REVIEW_FORMS,
  chaosText,
  lineDocument,
  markersIn,
  plainText,
  referenceText,
} from './helpers/sensitive-text-arbitraries.js';

const NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 400;
})();
const runs = { numRuns: NUM_RUNS };

const chaosWithReviewForms = fc.oneof(
  { weight: 4, arbitrary: chaosText },
  { weight: 1, arbitrary: fc.tuple(fc.constantFrom(...REVIEW_FORMS), chaosText).map(([form, rest]) => form + rest) },
  { weight: 1, arbitrary: fc.tuple(chaosText, fc.constantFrom(...REVIEW_FORMS)).map(([rest, form]) => rest + '\n' + form) },
);

function displayOutputs(text: string): string[] {
  return [sanitizeSensitiveText(text), maskSensitiveRanges(text, sensitiveTextRanges(text, new Set()))];
}

function legacyDisplayOutputs(text: string): string[] {
  return [legacy.sanitizeSensitiveText(text), legacy.maskSensitiveRanges(text, legacy.sensitiveTextRanges(text, new Set()))];
}

function collected(text: string, collect: (text: string, values: Set<string>) => void): Set<string> {
  const values = new Set<string>();
  collect(text, values);
  return values;
}

/** Later outputs that print part of `text` around `marker` on their own. */
function laterOutputs(text: string, marker: string): string[] {
  const outputs = new Set<string>([marker, `echoed ${marker}`]);
  for (const separator of [/\s+/u, /[;&|]/, /[,"'`]/, /@/, /[:=]/, /[\s;&|,"'`]/u]) {
    for (const piece of text.split(separator)) {
      if (piece.includes(marker)) outputs.add(`echoed ${piece}`);
    }
  }
  return [...outputs];
}

// Two documented narrowings, where the previous implementation hid text that is not a secret.
// 1. A URL that starts right after a quote ends at that quote's list item boundary (`","`), so
//    `["https://:443","ops@example.test"]` stays readable. A password that itself contains
//    `","` after an opening quote is no longer read through it.
function crossesQuotedListItem(text: string): boolean {
  return /["'][A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s@]*["']\s*,\s*["']/u.test(text);
}

// 2. A URL user named like a key (`https://token:pw@host/path`) is not an assignment, so its
//    "value" no longer hides the host and the path. What the previous implementation hid only
//    because of that reading is found by renaming such users and asking it again.
function withoutKeyUsers(text: string): string {
  return text.replace(/:\/\/([A-Za-z0-9_.-]+)(?=:)/g, (_match, user: string) =>
    '://' + (isSensitiveKeyName(user) ? user.replace(/[aeiou]/gi, '0') : user));
}

// What the previous implementation hid in a later output: what its patterns find in that output,
// and every occurrence of a value it tracked. Its composition also re-ran the patterns over the
// output with the known values already replaced, which can chain a pattern across a replaced
// value (`?token=[REDACTED]"https://:x` hides `x`); tracking more values can then hide the key
// and stop the chain, so that extra is not something a larger set of tracked values can keep.
function legacyHidesLater(later: string, values: ReadonlySet<string>, marker: string): boolean {
  return !legacy.sanitizeSensitiveText(later).includes(marker)
    || !legacy.maskSensitiveRanges(later, legacy.sensitiveTextRanges(later, values)).includes(marker);
}

function phase1Report(chunks: readonly string[]): string {
  const log = new Phase1ExecutionLog();
  for (const text of chunks) log.recordEvent({ type: 'text', data: { text } });
  return log.toReportInput();
}

// ---------------------------------------------------------------------------
// Reference: a character scanner for URL userinfo and unquoted assignments. It is written from
// the description of the two forms, not from the patterns in sensitive-text.ts.
// ---------------------------------------------------------------------------

const isKeyChar = (char: string | undefined): boolean => char !== undefined && /^[A-Za-z0-9_.-]$/.test(char);
const isSpace = (char: string | undefined): boolean => char === ' ' || char === '\n' || char === '\t' || char === '\r';
const KEY_WORDS = ['apikey', 'api_key', 'api-key', 'token', 'password', 'secret'];
const endsUserOrPasswordHead = (char: string | undefined): boolean => char === undefined || '/?#@'.includes(char) || isSpace(char);
const endsTail = (char: string | undefined): boolean => char === undefined || '/?#"\'`,<>()[]{}'.includes(char) || isSpace(char);
const endsAssignedValue = (char: string | undefined): boolean => char === undefined || '"\'[{,}]'.includes(char) || isSpace(char);

/** The last `@` at or after `from` before the tail ends, or -1. */
function lastAtInTail(text: string, from: number): number {
  let last = -1;
  for (let index = from; !endsTail(text[index]); index++) if (text[index] === '@') last = index;
  return last;
}

function referenceUserinfos(text: string): Array<{ start: number; end: number }> {
  const userinfos: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < text.length) {
    if (!text.startsWith('://', index) || !/[A-Za-z]/.test(text[index - 1] ?? '')) {
      index += 1;
      continue;
    }
    const start = index + 3;
    let cursor = start;
    while (!endsUserOrPasswordHead(text[cursor]) && text[cursor] !== ':') cursor += 1;
    if (text[cursor] !== ':') {
      index += 1;
      continue;
    }
    const passwordStart = cursor + 1;
    let end = -1;
    // One leading `@` belongs to the password; the head after it runs up to the next `@`.
    const headStart = text[passwordStart] === '@' ? passwordStart + 1 : passwordStart;
    if (headStart > passwordStart && text[headStart] === '@') {
      const later = lastAtInTail(text, headStart + 1);
      end = later >= 0 ? later : headStart;
    } else {
      cursor = headStart;
      while (!endsUserOrPasswordHead(text[cursor])) cursor += 1;
      if (cursor > headStart && text[cursor] === '@') {
        const later = lastAtInTail(text, cursor + 1);
        end = later >= 0 ? later : cursor;
      }
    }
    if (end < 0) {
      index += 1;
      continue;
    }
    let schemeStart = index;
    while (/[A-Za-z0-9+.-]/.test(text[schemeStart - 1] ?? '')) schemeStart -= 1;
    const quote = text[schemeStart - 1];
    const head = text.slice(start, text.indexOf('@', start));
    let crossesItem = false;
    for (let at = 0; at < head.length && (quote === '"' || quote === "'"); at++) {
      if (head[at] !== quote) continue;
      let next = at + 1;
      while (isSpace(head[next])) next += 1;
      if (head[next] !== ',') continue;
      next += 1;
      while (isSpace(head[next])) next += 1;
      if (head[next] === quote) crossesItem = true;
    }
    if (!crossesItem) userinfos.push({ start, end });
    index = end + 1;
  }
  return userinfos;
}

function referenceAssignments(text: string, userinfoStarts: ReadonlySet<number>): Array<{ start: number; end: number }> {
  const values: Array<{ start: number; end: number }> = [];
  for (let keyStart = 0; keyStart < text.length; keyStart++) {
    if (!isKeyChar(text[keyStart]) || isKeyChar(text[keyStart - 1])) continue;
    let keyEnd = keyStart;
    while (isKeyChar(text[keyEnd])) keyEnd += 1;
    const key = text.slice(keyStart, keyEnd).toLowerCase();
    if (!KEY_WORDS.some((word) => key.includes(word)) || userinfoStarts.has(keyStart)) continue;
    let cursor = keyEnd;
    while (isSpace(text[cursor])) cursor += 1;
    if (text[cursor] !== ':' && text[cursor] !== '=') continue;
    cursor += 1;
    while (isSpace(text[cursor])) cursor += 1;
    const start = cursor;
    while (!endsAssignedValue(text[cursor])) cursor += 1;
    if (cursor > start) values.push({ start, end: cursor });
  }
  return values;
}

function referenceSanitize(text: string): string {
  const userinfos = referenceUserinfos(text);
  const hidden = new Array<boolean>(text.length).fill(false);
  const ranges = [...userinfos, ...referenceAssignments(text, new Set(userinfos.map((userinfo) => userinfo.start)))];
  for (const { start, end } of ranges) for (let index = start; index < end; index++) hidden[index] = true;
  let output = '';
  for (let index = 0; index < text.length; index++) {
    if (!hidden[index]) output += text[index];
    else if (!hidden[index - 1]) output += REDACTED_VALUE;
  }
  return output;
}

describe('sensitive text redaction properties', () => {
  it('hides every secret the previous implementation hid, on screen and in later output', () => {
    fc.assert(fc.property(chaosWithReviewForms, (text) => {
      if (crossesQuotedListItem(text)) return;
      const renamed = withoutKeyUsers(text);
      const outputs = displayOutputs(text);
      const legacyOutputs = [...legacyDisplayOutputs(text), ...legacyDisplayOutputs(renamed)];
      const values = collected(text, collectEmbeddedSensitiveValues);
      const legacyValues = collected(text, legacy.collectEmbeddedSensitiveValues);
      const renamedLegacyValues = collected(renamed, legacy.collectEmbeddedSensitiveValues);
      for (const marker of markersIn(text)) {
        const hiddenBefore = (output: string): boolean => !output.includes(marker);
        if (hiddenBefore(legacyOutputs[0]!) && hiddenBefore(legacyOutputs[2]!)
          || hiddenBefore(legacyOutputs[1]!) && hiddenBefore(legacyOutputs[3]!)) {
          for (const output of outputs) expect(output, `display of ${JSON.stringify(text)}`).not.toContain(marker);
        }
        for (const later of laterOutputs(text, marker)) {
          if (legacyHidesLater(later, legacyValues, marker)
            && legacyHidesLater(withoutKeyUsers(later), renamedLegacyValues, marker)) {
            expect(sanitizeTextWithValues(later, values), `later ${JSON.stringify(later)} of ${JSON.stringify(text)}`).not.toContain(marker);
          }
        }
      }
    }), runs);
  });

  it('never leaks a well-formed credential, on screen, in later output or in the phase 1 log', () => {
    fc.assert(fc.property(lineDocument, fc.constantFrom('\n', '\r\n'), (lines, newline) => {
      const text = lines.map((line) => line.text).join(newline);
      const echoes = lines.flatMap((line) => line.echoes);
      for (const output of [...displayOutputs(text), phase1Report([text])]) {
        for (const marker of markersIn(text)) expect(output, JSON.stringify(text)).not.toContain(marker);
      }
      for (const echo of echoes) {
        const later = `echoed ${echo}\n`;
        for (const output of [sanitizeSensitiveTextWithKnownValues(later, { command: text }), phase1Report([text + '\n', later])]) {
          for (const marker of markersIn(echo)) expect(output, `${JSON.stringify(echo)} after ${JSON.stringify(text)}`).not.toContain(marker);
        }
      }
    }), runs);
  });

  it('leaves text without credentials unchanged', () => {
    fc.assert(fc.property(plainText, (text) => {
      for (const output of [...displayOutputs(text), sanitizeTextWithValues(text, collected(text, collectEmbeddedSensitiveValues))]) {
        expect(output).toBe(text);
      }
    }), runs);
  });

  it('agrees with the reference scanner on URL userinfo and unquoted assignments', () => {
    fc.assert(fc.property(referenceText, (text) => {
      expect(sanitizeSensitiveText(text), JSON.stringify(text)).toBe(referenceSanitize(text));
    }), runs);
  });

  it('changes nothing outside the credential lines', () => {
    fc.assert(fc.property(lineDocument, (lines) => {
      const text = lines.map((line) => line.text).join('\n');
      const outputLines = sanitizeSensitiveText(text).split('\n');
      expect(outputLines).toHaveLength(lines.length);
      lines.forEach((line, index) => {
        if (line.plain) expect(outputLines[index], JSON.stringify(text)).toBe(line.text);
      });
    }), runs);
  });
});

describe('sensitive text redaction counterexamples', () => {
  it.each(counterexamples.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const outputs = displayOutputs(entry.input);
    const values = collected(entry.input, collectEmbeddedSensitiveValues);
    if ('expected' in entry && typeof entry.expected === 'string') {
      for (const output of outputs) expect(output).toBe(entry.expected);
    }
    for (const marker of markersIn(entry.input)) {
      if ('readable' in entry && Array.isArray(entry.readable) && entry.readable.includes(marker)) continue;
      for (const output of outputs) expect(output).not.toContain(marker);
      for (const later of laterOutputs(entry.input, marker)) {
        if (legacyHidesLater(later, collected(entry.input, legacy.collectEmbeddedSensitiveValues), marker)) {
          expect(sanitizeTextWithValues(later, values)).not.toContain(marker);
        }
      }
    }
    if ('later' in entry && typeof entry.later === 'string') {
      expect(sanitizeTextWithValues(entry.later, values)).not.toMatch(/Zq\d+Zq/);
    }
  });
});

import fc from 'fast-check';
import { scaledMs } from '../../scripts/test-time-factor.mjs';
import { describe, expect, it } from 'vitest';
import { Phase1ExecutionLog } from '../core/workflow/phase1-execution-log.js';
import { maskSensitiveRanges, sanitizeSensitiveText, sanitizeTextWithValues, sensitiveTextRanges } from '../shared/utils/sensitive-text.js';
import { sanitizeSensitiveTextWithKnownValues } from '../shared/utils/sensitive-value.js';
import {
  KNOWN_LEAK_FAMILIES,
  knownLeakDocument,
  markersIn,
  plainLine,
  urlCommaAfterAtFragment,
  urlCommaAfterHostFragment,
} from './helpers/sensitive-text-arbitraries.js';
import { trackedValuesOf } from './helpers/sensitive-text-tracked.js';

// #175 (takt-175 DESIGN.md): the four families of leaks since before #151. Nothing is excluded:
// every secret of every generated line stays hidden on every path but the stream. The stream is the
// previous stream until the second PR of #151, whose L-stream property takes these families over.
// TAKT_PBT_NUM_RUNS and TAKT_PBT_SEED set the run count and seed, as in sensitive-text.pbt.test.ts.

const NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 400;
})();
const SEED = Number.parseInt(process.env.TAKT_PBT_SEED ?? '', 10);
const runs = { numRuns: NUM_RUNS, ...(Number.isInteger(SEED) ? { seed: SEED } : {}) };
const TIMEOUT = scaledMs(Math.max(120_000, NUM_RUNS * 200));

function phase1Report(chunks: readonly string[]): string {
  const log = new Phase1ExecutionLog();
  for (const text of chunks) log.recordEvent({ type: 'text', data: { text } });
  return log.toReportInput();
}

const rangeOutput = (text: string): string => maskSensitiveRanges(text, sensitiveTextRanges(text, new Set()));

describe('#175 known leak families', () => {
  it.each(KNOWN_LEAK_FAMILIES.map(([name, fragment]) => [name, fragment] as const))('%s: hides every secret on screen, in ranges, in the phase 1 log and in later output', (_name, fragment) => {
    fc.assert(fc.property(knownLeakDocument(fragment), fc.constantFrom('\n', '\r\n'), (lines, newline) => {
      const text = lines.map((line) => line.text).join(newline);
      const secrets = [...new Set(lines.flatMap((line) => line.echoes.flatMap(markersIn)))];
      for (const [path, output] of [['display', sanitizeSensitiveText(text)], ['ranges', rangeOutput(text)], ['phase1', phase1Report([text])]] as const) {
        for (const secret of secrets) expect(output, `${path} of ${JSON.stringify(text)}`).not.toContain(secret);
      }
      for (const echo of lines.flatMap((line) => line.echoes)) {
        for (const later of [`echoed ${echo}`, echo, `later output: ${echo} end`]) {
          for (const [path, output] of [
            ['known', sanitizeSensitiveTextWithKnownValues(later, text)],
            ['knownCommand', sanitizeSensitiveTextWithKnownValues(later, { command: text })],
            ['tracked', sanitizeTextWithValues(later, trackedValuesOf(text))],
            ['phase1', phase1Report([text + '\n', later])],
          ] as const) {
            for (const secret of markersIn(echo)) {
              expect(output, `${path}: ${JSON.stringify(later)} after ${JSON.stringify(text)}`).not.toContain(secret);
            }
          }
        }
      }
    }), runs);
  }, TIMEOUT);

  // Over-masking bounds of family 1: the URL shows its host, and an address after a host stays.
  it('show a URL of family 1 as its scheme, [REDACTED] and its host, and keep the lines around it', () => {
    fc.assert(fc.property(plainLine, fc.oneof(urlCommaAfterAtFragment, urlCommaAfterHostFragment), plainLine, (before, fragment, after) => {
      const text = `${before}\n${fragment.text}\n${after}`;
      const expected = `${before}\n${fragment.expected}\n${after}`;
      expect(sanitizeSensitiveText(text), JSON.stringify(text)).toBe(expected);
      expect(rangeOutput(text), JSON.stringify(text)).toBe(expected);
    }), runs);
  }, TIMEOUT);
});

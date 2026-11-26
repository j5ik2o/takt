// The tool-call boundary masking of 337062193's src/infra/deepseek-harness/client.ts
// (knownContinuationRanges and the masking part of writeResponseRedactedChunks), copied, with the
// redaction imports pointed at the frozen copies. The baseline of the stream equality property
// (#151, design 3). Only the context object is replaced by its two fields.
import { sensitiveTextRanges, substringSensitiveRanges } from './legacy-sensitive-text.js';

function knownContinuationRanges(boundary: string, text: string, values: ReadonlySet<string>) {
  const ranges: { start: number; end: number }[] = [];
  let complete = false;
  for (const value of values) {
    for (let split = 1; split < value.length; split += 1) {
      if (!boundary.endsWith(value.slice(0, split))) continue;
      const remainder = value.slice(split);
      const length = text.startsWith(remainder)
        ? remainder.length
        : remainder.startsWith(text) ? text.length : 0;
      if (length > 0) ranges.push({ start: 0, end: length });
      if (text.startsWith(remainder)) complete = true;
    }
  }
  return { ranges, complete };
}

/** The ranges writeResponseRedactedChunks masked in `text`, and whether the continuation completed. */
export function legacyResponseBoundaryRanges(
  toolBoundaryText: string,
  text: string,
  trackedValues: ReadonlySet<string>,
  knownSecrets: Record<string, string>,
): { ranges: Array<{ start: number; end: number }>; complete: boolean } {
  const combined = toolBoundaryText + text;
  const boundary = toolBoundaryText.length;
  const values = new Set(Object.values(knownSecrets));
  for (const value of trackedValues) values.add(value);
  const knownRanges = substringSensitiveRanges(combined, values);
  // Do not join a capitalized natural-language sentence to the earlier assignment. Short credential
  // fragments still need the generic pattern check, including when the next chunk completes them.
  const startsNaturalLanguage = /^[A-Z]/u.test(text) && /\s/u.test(text);
  const candidateRanges = startsNaturalLanguage ? [] : sensitiveTextRanges(combined, new Set());
  const boundaryRanges = [...knownRanges, ...candidateRanges]
    .filter((range) => range.end > boundary)
    .map((range) => ({
      start: Math.max(0, range.start - boundary),
      end: Math.min(text.length, range.end - boundary),
    }));
  const continuation = knownContinuationRanges(toolBoundaryText, text, values);
  const ranges = [...boundaryRanges, ...continuation.ranges];
  return { ranges, complete: continuation.complete };
}

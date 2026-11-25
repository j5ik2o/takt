import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import counterexamplesFixture from '../../test/fixtures/sensitive-text-redaction-counterexamples.json' with { type: 'json' };
import { Phase1ExecutionLog } from '../core/workflow/phase1-execution-log.js';
import {
  REDACTED_VALUE,
  collectEmbeddedSensitiveValues,
  maskSensitiveRanges,
  sanitizeTextWithValues,
  sensitiveTextRanges,
  type SensitiveRange,
} from '../shared/utils/sensitive-text.js';
import {
  sanitizeSensitiveText,
  sanitizeSensitiveTextWithKnownValues,
} from '../shared/utils/sensitiveText.js';

const PBT_NUM_RUNS = (() => {
  const override = process.env.TAKT_PBT_NUM_RUNS;
  if (override !== undefined) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return process.env.CI ? 100 : 1000;
})();

const PBT_MAX_QUOTED_DEPTH = 4;

// ---------------------------------------------------------------------------
// Naive brute-force reference oracle (intentionally slow, simple, and obvious)
// ---------------------------------------------------------------------------

const ORACLE_KEY_CHAR = String.raw`[A-Za-z0-9_.-]`;
const ORACLE_KEY_WORD = String.raw`api[_-]?key|token|password|secret|credentials?|access[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key`;
const ORACLE_KEY = String.raw`(?=${ORACLE_KEY_CHAR}*(?:${ORACLE_KEY_WORD}))${ORACLE_KEY_CHAR}+`;
const ORACLE_HEADER_KEY = String.raw`(?:proxy[_-]?)?authorization|(?:set[_-]?)?cookies?|session[_-]?id`;
const ORACLE_TEXT_KEY = String.raw`(?:${ORACLE_KEY}|${ORACLE_HEADER_KEY})`;
const ORACLE_BARE_KEY = String.raw`(?<!${ORACLE_KEY_CHAR})(?:(?=(?:${ORACLE_HEADER_KEY})\b)${ORACLE_KEY_CHAR})*(?!(?:${ORACLE_HEADER_KEY})\b)${ORACLE_KEY}`;
const ORACLE_ASSIGNMENT_KEY = String.raw`(?:["'](?:${ORACLE_TEXT_KEY})["']|\\"(?:${ORACLE_TEXT_KEY})\\"|${ORACLE_BARE_KEY})`;
const ORACLE_QUOTED_VALUE = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
const ORACLE_JSON_QUOTED_VALUE = String.raw`\\"(?:[^"\\]|\\{4}|\\{1,3}[^"\\]|\\{3}")*\\"`;

const ORACLE_QUOTED_ASSIGNMENT = new RegExp(
  String.raw`(${ORACLE_ASSIGNMENT_KEY}\s*[:=]\s*)(${ORACLE_JSON_QUOTED_VALUE}|${ORACLE_QUOTED_VALUE})`,
  'gi',
);
const ORACLE_BARE_ASSIGNMENT_STICKY = new RegExp(
  String.raw`(${ORACLE_ASSIGNMENT_KEY}\s*[:=]\s*["']?)(?!\\")([^"'[{,\s}\]]+)(["']?)`,
  'yi',
);
const ORACLE_HEADER_BARE_STICKY = new RegExp(
  String.raw`((?:${ORACLE_HEADER_KEY})\s*=\s*["']?)([^"';,\s}\]]+)(["']?)`,
  'yi',
);
const ORACLE_HEADER_COLON_STICKY = new RegExp(
  String.raw`((?:session[_-]?id)\s*:\s*["']?)([^"';,\s}\]]+)(["']?)`,
  'yi',
);
const ORACLE_OPTION_STICKY = new RegExp(
  String.raw`((?<!-)--(?:${ORACLE_KEY})(?:=|\s+))(${ORACLE_QUOTED_VALUE}|[^\s]+)`,
  'yi',
);
const ORACLE_QUERY_STICKY = /([?&](?:api[_-]?key|key|token|password|secret|sig|(?:x-amz-)?signature)=)([^&\s]+)/yi;
const ORACLE_BEARER_CHAR = String.raw`[A-Za-z0-9._~+/=-]`;
const ORACLE_BARE_BEARER_STICKY = new RegExp(
  String.raw`(\b[Bb]earer\s+)((?=${ORACLE_BEARER_CHAR}*\d|${ORACLE_BEARER_CHAR}{20})${ORACLE_BEARER_CHAR}{8,})`,
  'y',
);
const ORACLE_CURL_VALUE = [
  String.raw`(?<=\\")(?!\+)[^":]*:[^"]*?(?=\\")`,
  String.raw`"(?!\+)[^":]*:[^"]*"`,
  String.raw`'(?!\+)[^':]*:[^']*'`,
  String.raw`(?<!\\")(?![+"']|\\")[^\s:]*:[^\s]*`,
].join('|');
const ORACLE_CURL_EQUALS_STICKY = new RegExp(
  String.raw`(\B--(?:proxy-)?user=)(?:\\")?(${ORACLE_CURL_VALUE})(?:\\")?`,
  'yi',
);
const ORACLE_CURL_SPACE_STICKY = new RegExp(
  String.raw`(\B(?:-u|--(?:proxy-)?user)\s+)(?:\\")?(${ORACLE_CURL_VALUE})(?:\\")?`,
  'yi',
);
const ORACLE_CURL_COMPACT_STICKY = new RegExp(
  String.raw`(^|\s)(-u)(?:\\")?(${ORACLE_CURL_VALUE})(?:\\")?`,
  'yi',
);
const ORACLE_HTTP_HEADER_STICKY = /\b(Authorization|(?:Set-)?Cookie)\s*:\s*/yi;
const ORACLE_KNOWN_TOKEN = new RegExp(
  String.raw`\b(?:${[
    String.raw`sk-[A-Za-z0-9_-]{8,}`,
    String.raw`gh[pousr]_[A-Za-z0-9_]{8,}`,
    String.raw`github_pat_[A-Za-z0-9_]{20,}`,
    String.raw`xox[baprs]-[A-Za-z0-9-]{8,}`,
    String.raw`xapp-[A-Za-z0-9-]{8,}`,
    String.raw`glpat-[A-Za-z0-9_-]{16,}`,
    String.raw`hf_[A-Za-z0-9]{20,}`,
    String.raw`AIza[A-Za-z0-9_-]{30,}`,
    String.raw`A[KS]IA[A-Z0-9]{16}`,
    String.raw`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
  ].join('|')})\b`,
  'g',
);
const ORACLE_PEM = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g;
const ORACLE_URL_DELIM = /[/?#\s"'`,<>()[\]{}]/;
const ORACLE_SCHEME_RUN = /[A-Za-z0-9+.-]/;

function oracleInRanges(pos: number, ranges: readonly SensitiveRange[]): boolean {
  return ranges.some((range) => range.start <= pos && pos < range.end);
}

function oracleMergeRanges(ranges: readonly SensitiveRange[]): SensitiveRange[] {
  const valid = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SensitiveRange[] = [];
  for (const range of valid) {
    const prev = merged.at(-1);
    if (prev !== undefined && range.start <= prev.end) {
      if (range.end > prev.end) {
        merged[merged.length - 1] = { start: prev.start, end: range.end };
      }
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

function oracleStripQuotes(value: string): string {
  if (value.length >= 4 && value.startsWith('\\"') && value.endsWith('\\"')) {
    return value.slice(2, -2);
  }
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first) {
    return value.slice(1, -1);
  }
  return value;
}

function oracleHasValidSchemeBefore(text: string, schemeEnd: number): boolean {
  let cursor = schemeEnd;
  let sawLetter = false;
  while (cursor > 0 && ORACLE_SCHEME_RUN.test(text[cursor - 1]!)) {
    cursor -= 1;
    if (/[A-Za-z]/.test(text[cursor]!)) {
      sawLetter = true;
    }
  }
  return sawLetter;
}

function oracleFirstTrailingAssignment(segment: string): number {
  const patterns: readonly RegExp[] = [
    ORACLE_BARE_ASSIGNMENT_STICKY,
    ORACLE_HEADER_BARE_STICKY,
    ORACLE_HEADER_COLON_STICKY,
    ORACLE_OPTION_STICKY,
    ORACLE_QUERY_STICKY,
    ORACLE_CURL_EQUALS_STICKY,
    ORACLE_HTTP_HEADER_STICKY,
  ];
  for (let pos = 0; pos < segment.length; pos += 1) {
    for (const pattern of patterns) {
      const matcher = new RegExp(pattern.source, pattern.flags);
      matcher.lastIndex = pos;
      if (matcher.exec(segment) !== null) {
        return pos;
      }
    }
  }
  return -1;
}

function oracleCollectUrlUserinfo(
  text: string,
  quotedExclusions: readonly SensitiveRange[],
): { valueRanges: SensitiveRange[]; exclusions: SensitiveRange[] } {
  const valueRanges: SensitiveRange[] = [];
  const exclusions: SensitiveRange[] = [];
  let pos = 0;
  while (pos <= text.length - 3) {
    if (text.startsWith('://', pos) && !oracleInRanges(pos, quotedExclusions) && oracleHasValidSchemeBefore(text, pos)) {
      const start = pos + 3;
      let authorityEnd = start;
      while (authorityEnd < text.length && !ORACLE_URL_DELIM.test(text[authorityEnd]!)) {
        authorityEnd += 1;
      }
      const authority = text.slice(start, authorityEnd);
      const colonRel = authority.indexOf(':');
      const lastAtRel = authority.lastIndexOf('@');
      // Userinfo requires a colon followed by a non-empty password and a closing `@`,
      // and no `@` before the colon.
      if (
        colonRel >= 0
        && lastAtRel > colonRel + 1
        && authority.indexOf('@') > colonRel
      ) {
        const colon = start + colonRel;
        const rawEnd = start + lastAtRel;
        const firstValidAt = text.indexOf('@', colon + 2);
        let end = rawEnd;
        if (firstValidAt >= 0 && firstValidAt < rawEnd) {
          const trailingIndex = oracleFirstTrailingAssignment(text.slice(firstValidAt + 1, authorityEnd));
          if (trailingIndex >= 0 && firstValidAt + 1 + trailingIndex < rawEnd) {
            end = text.lastIndexOf('@', firstValidAt + trailingIndex);
          }
        }
        valueRanges.push({ start, end });
        exclusions.push(text[colon + 1] === '@' ? { start, end: colon + 1 } : { start, end: end + 1 });
        pos = rawEnd + 1;
        continue;
      }
    }
    pos += 1;
  }
  return { valueRanges, exclusions };
}

function oracleScanStickyOutside(
  text: string,
  stickyPattern: RegExp,
  exclusions: readonly SensitiveRange[],
  extract: (match: RegExpExecArray) => { maskStart: number; maskEnd: number; captured: string },
): Array<{ maskStart: number; maskEnd: number; captured: string }> {
  const results: Array<{ maskStart: number; maskEnd: number; captured: string }> = [];
  const matcher = new RegExp(stickyPattern.source, stickyPattern.flags);
  let pos = 0;
  while (pos < text.length) {
    if (oracleInRanges(pos, exclusions)) {
      pos += 1;
      continue;
    }
    matcher.lastIndex = pos;
    const match = matcher.exec(text);
    if (match === null) {
      pos += 1;
      continue;
    }
    results.push(extract(match));
    pos = Math.max(pos + 1, matcher.lastIndex);
  }
  return results;
}

function oracleHttpHeaderValueEnd(
  text: string,
  start: number,
  shellQuote: "'" | '"' | '\\"' | undefined,
): number {
  let valueQuote: string | undefined;
  let previousNonSpace: string | undefined;
  let cursor = start;
  while (cursor < text.length) {
    const ch = text[cursor]!;
    if (ch === '\r' || ch === '\n') break;
    if (shellQuote === '\\"' && ch === '\\') {
      let slashEnd = cursor + 1;
      while (text[slashEnd] === '\\') slashEnd += 1;
      if (text[slashEnd] === '"' && (slashEnd - cursor) % 4 === 1) return slashEnd - 1;
      cursor = slashEnd;
      if (text[cursor] === '"') cursor += 1;
      continue;
    }
    if (ch === '\\' && shellQuote !== "'" && text[cursor + 1] !== '\r' && text[cursor + 1] !== '\n') {
      cursor = Math.min(cursor + 2, text.length);
      continue;
    }
    if (shellQuote !== undefined) {
      if (ch === shellQuote || (shellQuote === '\\"' && ch === '"')) break;
    } else if (valueQuote !== undefined) {
      if (ch === valueQuote) valueQuote = undefined;
    } else if (ch === '"' || ch === "'") {
      if (cursor !== start && previousNonSpace !== '=') break;
      valueQuote = ch;
    }
    if (ch !== ' ' && ch !== '\t') previousNonSpace = ch;
    cursor += 1;
  }
  return cursor;
}

function oracleCollectHttpHeaders(
  text: string,
  exclusions: readonly SensitiveRange[],
): Array<{ start: number; credentialStart: number; end: number }> {
  const results: Array<{ start: number; credentialStart: number; end: number }> = [];
  const headerMatcher = new RegExp(ORACLE_HTTP_HEADER_STICKY.source, ORACLE_HTTP_HEADER_STICKY.flags);
  const authScheme = /([A-Za-z]+)[ \t]+/y;
  let pos = 0;
  while (pos < text.length) {
    if (oracleInRanges(pos, exclusions)) {
      pos += 1;
      continue;
    }
    headerMatcher.lastIndex = pos;
    const match = headerMatcher.exec(text);
    if (match === null) {
      pos += 1;
      continue;
    }
    const start = headerMatcher.lastIndex;
    authScheme.lastIndex = start;
    const scheme = match[1]!.toLowerCase() === 'authorization' ? authScheme.exec(text) : null;
    const credentialStart = scheme === null ? start : authScheme.lastIndex;
    const enclosingQuote = text[match.index - 1];
    const shellQuote = enclosingQuote === '"' && text[match.index - 2] === '\\'
      ? '\\"'
      : enclosingQuote === '"' || enclosingQuote === "'" ? enclosingQuote : undefined;
    const end = oracleHttpHeaderValueEnd(text, credentialStart, shellQuote);
    if (end > start) {
      results.push({ start, credentialStart, end });
    }
    pos = Math.max(pos + 1, end);
  }
  return results;
}

function oracleAddSensitiveValue(values: Set<string>, rawValue: string): void {
  const value = oracleStripQuotes(rawValue.trim());
  if (value.length === 0) return;
  for (const line of value.split(/\r?\n/u)) {
    if (line.length > 0) values.add(line);
  }
  const auth = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
  if (auth?.[1]) {
    values.add(auth[1]);
  }
}

function oracleAddCredentialComponents(values: Set<string>, rawValue: string): void {
  const value = oracleStripQuotes(rawValue.trim());
  const auth = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
  if (auth?.[1]) values.add(auth[1]);
  const sep = value.indexOf(':');
  if (sep >= 0 && sep + 1 < value.length) {
    values.add(value.slice(sep + 1));
  }
  for (const cookie of value.split(';')) {
    const eq = cookie.indexOf('=');
    const cookieVal = eq >= 0 ? cookie.slice(eq + 1).trim() : '';
    if (cookieVal.length > 0) values.add(cookieVal);
  }
}

function oracleCollectKnownValues(text: string): Set<string> {
  const values = new Set<string>();
  const queue: Array<{ current: string; depth: number }> = [{ current: text, depth: 0 }];
  for (let i = 0; i < queue.length; i += 1) {
    const { current, depth } = queue[i]!;
    for (const match of current.matchAll(ORACLE_PEM)) {
      oracleAddSensitiveValue(values, match[0]);
    }
    const quotedExclusions: SensitiveRange[] = [];
    for (const match of current.matchAll(ORACLE_QUOTED_ASSIGNMENT)) {
      const rawValue = match[2]!;
      quotedExclusions.push({ start: match.index, end: match.index + match[0].length });
      oracleAddSensitiveValue(values, rawValue);
      const inner = oracleStripQuotes(rawValue);
      if (depth < PBT_MAX_QUOTED_DEPTH && inner.length > 0 && inner.length < current.length) {
        queue.push({ current: inner, depth: depth + 1 });
      }
    }
    const urlUserinfo = oracleCollectUrlUserinfo(current, quotedExclusions);
    const exclusions = oracleMergeRanges([...quotedExclusions, ...urlUserinfo.exclusions]);

    for (const [pattern, splitShellDelimiters] of [
      [ORACLE_BARE_ASSIGNMENT_STICKY, true],
      [ORACLE_HEADER_BARE_STICKY, false],
      [ORACLE_HEADER_COLON_STICKY, false],
      [ORACLE_OPTION_STICKY, false],
      [ORACLE_QUERY_STICKY, false],
      [ORACLE_BARE_BEARER_STICKY, false],
    ] as const) {
      for (const m of oracleScanStickyOutside(current, pattern, exclusions, (match) => ({
        maskStart: match.index + match[1]!.length,
        maskEnd: match.index + match[1]!.length + match[2]!.length,
        captured: match[2]!,
      }))) {
        oracleAddSensitiveValue(values, m.captured);
        if (splitShellDelimiters && /[;&|]/.test(m.captured)) {
          const segments = m.captured.split(/[;&|]+/);
          const head = segments[0];
          if (head !== undefined && head.length > 0) {
            oracleAddSensitiveValue(values, head);
          }
          if (depth < PBT_MAX_QUOTED_DEPTH) {
            for (let segIndex = 1; segIndex < segments.length; segIndex += 1) {
              const segment = segments[segIndex]!;
              if (segment.length > 0) {
                queue.push({ current: segment, depth: depth + 1 });
              }
            }
          }
        }
      }
    }
    for (const match of current.matchAll(ORACLE_KNOWN_TOKEN)) {
      oracleAddSensitiveValue(values, match[0]);
    }
    for (const header of oracleCollectHttpHeaders(current, exclusions)) {
      const val = current.slice(header.start, header.end);
      oracleAddSensitiveValue(values, val);
      oracleAddCredentialComponents(values, val);
    }
    for (const { start, end } of urlUserinfo.valueRanges) {
      const userinfo = current.slice(start, end);
      const sep = userinfo.indexOf(':');
      const firstValidAt = sep >= 0 ? userinfo.indexOf('@', sep + 2) : -1;
      if (firstValidAt < 0) {
        oracleAddSensitiveValue(values, userinfo);
        oracleAddCredentialComponents(values, userinfo);
      } else {
        oracleAddSensitiveValue(values, userinfo.slice(0, firstValidAt));
        oracleAddCredentialComponents(values, userinfo.slice(0, firstValidAt));
        const password = userinfo.slice(sep + 1);
        if (password.length > 0) values.add(password);
        oracleAddSensitiveValue(values, userinfo);
      }
    }
    for (const m of oracleScanStickyOutside(current, ORACLE_CURL_EQUALS_STICKY, exclusions, (match) => ({
      maskStart: match.index + match[1]!.length,
      maskEnd: match.index + match[0].length,
      captured: match[2]!,
    }))) {
      oracleAddSensitiveValue(values, m.captured);
      oracleAddCredentialComponents(values, m.captured);
    }
    for (const m of oracleScanStickyOutside(current, ORACLE_CURL_SPACE_STICKY, exclusions, (match) => ({
      maskStart: match.index + match[1]!.length,
      maskEnd: match.index + match[0].length,
      captured: match[2]!,
    }))) {
      oracleAddSensitiveValue(values, m.captured);
      oracleAddCredentialComponents(values, m.captured);
    }
    for (const m of oracleScanStickyOutside(current, ORACLE_CURL_COMPACT_STICKY, exclusions, (match) => ({
      maskStart: match.index + match[1]!.length + match[2]!.length,
      maskEnd: match.index + match[0].length,
      captured: match[3]!,
    }))) {
      oracleAddSensitiveValue(values, m.captured);
      oracleAddCredentialComponents(values, m.captured);
    }
  }
  return values;
}

function oracleSanitize(text: string, knownValues: ReadonlySet<string>): string {
  if (!text) return text;
  const ranges: SensitiveRange[] = [];
  const quotedExclusions: SensitiveRange[] = [];
  for (const match of text.matchAll(ORACLE_QUOTED_ASSIGNMENT)) {
    const rawValue = match[2]!;
    const quoteWidth = rawValue.startsWith('\\"') ? 2 : 1;
    ranges.push({
      start: match.index + match[1]!.length + quoteWidth,
      end: match.index + match[0].length - quoteWidth,
    });
    quotedExclusions.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  const urlUserinfo = oracleCollectUrlUserinfo(text, quotedExclusions);
  for (const range of urlUserinfo.valueRanges) ranges.push(range);
  const exclusions = oracleMergeRanges([...quotedExclusions, ...urlUserinfo.exclusions]);

  for (const pattern of [
    ORACLE_BARE_ASSIGNMENT_STICKY,
    ORACLE_HEADER_BARE_STICKY,
    ORACLE_HEADER_COLON_STICKY,
    ORACLE_OPTION_STICKY,
    ORACLE_QUERY_STICKY,
    ORACLE_BARE_BEARER_STICKY,
  ]) {
    for (const m of oracleScanStickyOutside(text, pattern, exclusions, (match) => ({
      maskStart: match.index + match[1]!.length,
      maskEnd: match.index + match[1]!.length + match[2]!.length,
      captured: match[2]!,
    }))) {
      ranges.push({ start: m.maskStart, end: m.maskEnd });
    }
  }
  for (const header of oracleCollectHttpHeaders(text, exclusions)) {
    ranges.push({ start: header.credentialStart, end: header.end });
  }
  for (const m of oracleScanStickyOutside(text, ORACLE_CURL_EQUALS_STICKY, exclusions, (match) => ({
    maskStart: match.index + match[1]!.length,
    maskEnd: match.index + match[0].length,
    captured: match[2]!,
  }))) {
    ranges.push({ start: m.maskStart, end: m.maskEnd });
  }
  for (const m of oracleScanStickyOutside(text, ORACLE_CURL_SPACE_STICKY, exclusions, (match) => ({
    maskStart: match.index + match[1]!.length,
    maskEnd: match.index + match[0].length,
    captured: match[2]!,
  }))) {
    ranges.push({ start: m.maskStart, end: m.maskEnd });
  }
  for (const m of oracleScanStickyOutside(text, ORACLE_CURL_COMPACT_STICKY, exclusions, (match) => ({
    maskStart: match.index + match[1]!.length + match[2]!.length,
    maskEnd: match.index + match[0].length,
    captured: match[3]!,
  }))) {
    ranges.push({ start: m.maskStart, end: m.maskEnd });
  }
  for (const pattern of [ORACLE_KNOWN_TOKEN, ORACLE_PEM]) {
    for (const match of text.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  for (const value of knownValues) {
    if (value.length === 0) continue;
    if (value.length >= 4) {
      let searchFrom = 0;
      while (searchFrom <= text.length - value.length) {
        const idx = text.indexOf(value, searchFrom);
        if (idx < 0) break;
        ranges.push({ start: idx, end: idx + value.length });
        searchFrom = idx + 1;
      }
    } else {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const bounded = new RegExp(
        String.raw`(?<![\p{L}\p{N}_])${escaped}(?![\p{L}\p{N}_])`,
        'gu',
      );
      for (const match of text.matchAll(bounded)) {
        ranges.push({ start: match.index, end: match.index + value.length });
      }
    }
  }

  const merged = oracleMergeRanges(ranges);
  if (merged.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const range of merged) {
    parts.push(text.slice(cursor, range.start), REDACTED_VALUE);
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

// ---------------------------------------------------------------------------
// fast-check Arbitraries (built with shrink-friendly combinators)
// ---------------------------------------------------------------------------

const delimiterArb = fc.constantFrom(';', ',', '&', '|', ' ', '\n');
const schemeArb = fc.constantFrom('http', 'https', 'redis', 'postgres', 'amqp');
const hostArb = fc.constantFrom('host', 'db.internal', 'api.example.test', 'host2:8443', 'cache');
const sensitiveKeyArb = fc.constantFrom(
  'TOKEN',
  'token',
  'PASSWORD',
  'SECRET',
  'CREDENTIALS',
  'API_KEY',
  'access_token',
);
const benignKeyArb = fc.constantFrom('host', 'region', 'mode', 'env', 'owner', 'note', 'path');

// Distinct non-empty secret fragments that never contain whitespace or quotes.
const secretBodyArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_.-]{5,18}$/);
const symbolSecretArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_!%+=@.-]{5,18}$/).filter(
  (s) => !s.endsWith('@') && !s.includes('://'),
);
const usernameArb = fc.oneof(
  fc.constant(''),
  fc.constantFrom('alice', 'user', 'token', 'password', 'secret', 'api_key'),
  fc.stringMatching(/^[a-z]{1,8}$/),
  fc.stringMatching(/^[a-z]{20,40}$/),
);

interface CredentialPiece {
  readonly fragment: string;
  readonly secrets: readonly string[];
}

const urlCredentialPieceArb: fc.Arbitrary<CredentialPiece> = fc.oneof(
  // Standard or empty-username URL userinfo
  fc.record({
    scheme: schemeArb,
    user: usernameArb,
    pass: secretBodyArb,
    host: hostArb,
  }).map(({ scheme, user, pass, host }) => ({
    fragment: `${scheme}://${user}:${pass}@${host}`,
    secrets: [pass],
  })),
  // Leading-@ password in URL userinfo
  fc.record({
    scheme: schemeArb,
    user: usernameArb,
    passBody: secretBodyArb,
    host: hostArb,
  }).map(({ scheme, user, passBody, host }) => {
    const pass = `@${passBody}`;
    return {
      fragment: `${scheme}://${user}:${pass}@${host}`,
      secrets: [pass],
    };
  }),
  // Password containing symbols (including unencoded `@`)
  fc.record({
    scheme: schemeArb,
    user: usernameArb,
    left: secretBodyArb,
    right: secretBodyArb,
    host: hostArb,
  }).map(({ scheme, user, left, right, host }) => {
    const pass = `${left}@${right}`;
    return {
      fragment: `${scheme}://${user}:${pass}@${host}`,
      secrets: [pass],
    };
  }),
);

const assignmentCredentialPieceArb: fc.Arbitrary<CredentialPiece> = fc.oneof(
  // Bare assignment (no quotes)
  fc.record({
    key: sensitiveKeyArb,
    op: fc.constantFrom('=', ':'),
    val: symbolSecretArb,
  }).map(({ key, op, val }) => ({
    fragment: `${key}${op}${val}`,
    secrets: [val],
  })),
  // Double-quoted assignment
  fc.record({
    key: sensitiveKeyArb,
    op: fc.constantFrom('=', ':'),
    val: symbolSecretArb,
  }).map(({ key, op, val }) => ({
    fragment: `${key}${op}"${val}"`,
    secrets: [val],
  })),
  // Single-quoted assignment
  fc.record({
    key: sensitiveKeyArb,
    op: fc.constantFrom('=', ':'),
    val: symbolSecretArb,
  }).map(({ key, op, val }) => ({
    fragment: `${key}${op}'${val}'`,
    secrets: [val],
  })),
  // Quoted assignment containing a URL with credentials
  fc.record({
    key: sensitiveKeyArb,
    quote: fc.constantFrom('"', "'", '\\"'),
    scheme: schemeArb,
    user: usernameArb,
    pass: secretBodyArb,
    host: hostArb,
  }).map(({ key, quote, scheme, user, pass, host }) => ({
    fragment: `${key}=${quote}${scheme}://${user}:${pass}@${host}${quote}`,
    secrets: [pass, `${scheme}://${user}:${pass}@${host}`],
  })),
  // Unquoted assignment containing a URL with credentials
  fc.record({
    key: sensitiveKeyArb,
    scheme: schemeArb,
    user: usernameArb,
    pass: secretBodyArb,
    host: hostArb,
  }).map(({ key, scheme, user, pass, host }) => ({
    fragment: `${key}=${scheme}://${user}:${pass}@${host}`,
    secrets: [pass, `${scheme}://${user}:${pass}@${host}`],
  })),
);

const benignNonValuePieceArb: fc.Arbitrary<string> = fc.oneof(
  // Empty-username port URL + email in JSON array / comma / space forms
  fc.record({
    scheme: schemeArb,
    port: fc.integer({ min: 80, max: 65535 }),
    emailUser: fc.constantFrom('ops', 'admin', 'team', 'alerts'),
    domain: fc.constantFrom('example.test', 'corp.local', 'mail.invalid'),
    format: fc.constantFrom('json-array', 'comma', 'space'),
  }).map(({ scheme, port, emailUser, domain, format }) => {
    const url = `${scheme}://:${port}`;
    const email = `${emailUser}@${domain}`;
    if (format === 'json-array') return `["${url}","${email}"]`;
    if (format === 'comma') return `${url},${email}`;
    return `${url} ${email}`;
  }),
  // Quoted non-sensitive values
  fc.record({
    key: benignKeyArb,
    quote: fc.constantFrom('"', "'"),
    value: fc.constantFrom(
      'plain value',
      'https://host:443/path',
      'ops@example.test',
      'Bearer documentation',
      '127.0.0.1:8080',
      'a,b;c',
    ),
  }).map(({ key, quote, value }) => `${key}=${quote}${value}${quote}`),
  // Plain URLs without userinfo (always close authority with `/` or no port when followed by shell delimiters)
  fc.record({
    scheme: schemeArb,
    host: fc.constantFrom('host', 'db.internal', 'api.example.test', 'cache'),
    path: fc.constantFrom('', '/v1/status', '/health?ok=1'),
  }).map(({ scheme, host, path }) => `${scheme}://${host}${path}`),
  fc.record({
    scheme: schemeArb,
    host: fc.constantFrom('host2:8443', 'localhost:3000'),
    path: fc.constantFrom('/', '/v1/status', '/health?ok=1'),
  }).map(({ scheme, host, path }) => `${scheme}://${host}${path}`),
  // Plain prose / identifiers
  fc.constantFrom(
    'status=ok',
    'region=ap-northeast-1',
    'Bearer authentication',
    'ops@example.test',
    '["https://a","b:c@d"]',
    'count=42',
  ),
);

const mixedPieceArb: fc.Arbitrary<string> = fc.oneof(
  urlCredentialPieceArb.map((p) => p.fragment),
  assignmentCredentialPieceArb.map((p) => p.fragment),
  benignNonValuePieceArb,
  // Semi-structured edge pieces with `;`, `@`, quotes, headers, curl options
  fc.constantFrom(
    'https://token:p@host;TOKEN=left@RIGHT_SECRET',
    'https://alice:LEFT;token=RIGHT@host',
    'https://user:@host;TOKEN=left@RIGHT_SECRET',
    'Authorization: Bearer tok12345678',
    'Cookie: sid=cookie_val_123; theme=dark',
    'curl -u alice:curlpass123 https://example.test',
    'https://example.test/api?api_key=qsecret123&ok=1',
  ),
);

const mixedDocumentArb: fc.Arbitrary<string> = fc.record({
  pieces: fc.array(mixedPieceArb, { minLength: 1, maxLength: 6 }),
  delimiters: fc.array(delimiterArb, { minLength: 6, maxLength: 6 }),
  reappearFirst: fc.boolean(),
}).map(({ pieces, delimiters, reappearFirst }) => {
  const parts: string[] = [];
  for (let i = 0; i < pieces.length; i += 1) {
    if (i > 0) parts.push(delimiters[i - 1]!);
    parts.push(pieces[i]!);
  }
  if (reappearFirst && pieces[0] !== undefined) {
    parts.push(' ', pieces[0]);
  }
  return parts.join('');
});

const adversarialAtomArb: fc.Arbitrary<string> = fc.constantFrom(
  'https://',
  'http://',
  'redis://',
  'token',
  'TOKEN',
  'secret',
  'CREDENTIALS',
  'Authorization: ',
  'Cookie: ',
  'Bearer ',
  '-u ',
  '--user=',
  ':',
  '=',
  '@',
  ';',
  ',',
  '&',
  '|',
  '"',
  "'",
  '\\"',
  '[',
  ']',
  '{',
  '}',
  ' ',
  '/',
  '?',
  'a',
  'p',
  '1234',
  'host',
);

const adversarialTokenStreamArb: fc.Arbitrary<string> = fc.array(adversarialAtomArb, {
  minLength: 1,
  maxLength: 24,
}).map((tokens) => tokens.join(''));

const mixedOrAdversarialArb: fc.Arbitrary<string> = fc.oneof(
  mixedDocumentArb,
  adversarialTokenStreamArb,
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sensitiveText property-based tests (fast-check)', () => {
  describe('counterexample fixtures (test/fixtures/sensitive-text-redaction-counterexamples.json)', () => {
    it.each(counterexamplesFixture.cases)(
      'replays fixture $id ($category)',
      (fixture) => {
        const sanitized = sanitizeSensitiveText(fixture.input);
        expect(sanitized).toBe(fixture.expectedSanitized);
        expect(sanitized).toBe(oracleSanitize(fixture.input, new Set()));
        expect(maskSensitiveRanges(fixture.input, sensitiveTextRanges(fixture.input, new Set()))).toBe(
          fixture.expectedSanitized,
        );
        if (fixture.expectUnchanged) {
          expect(sanitized).toBe(fixture.input);
        }
        for (const secret of fixture.secrets) {
          expect(sanitized).not.toContain(secret);
        }
        for (const followUp of fixture.followUpOutputs) {
          expect(
            sanitizeSensitiveTextWithKnownValues(followUp.output, { command: fixture.input }),
          ).toBe(followUp.expected);
          const log = new Phase1ExecutionLog();
          log.recordEvent({ type: 'text', data: { text: `${fixture.input}\n` } });
          log.recordEvent({ type: 'text', data: { text: `${followUp.output}\n` } });
          const report = log.toReportInput();
          for (const secret of fixture.secrets) {
            expect(report).not.toContain(secret);
          }
        }
      },
    );
  });

  // Property 1: No leakage in immediate output or follow-up outputs (including Phase1ExecutionLog)
  it(`Property 1 (no leakage): hides all credential secrets in immediate and follow-up outputs (${PBT_NUM_RUNS} runs)`, () => {
    const scenarioArb = fc.record({
      credentials: fc.array(fc.oneof(urlCredentialPieceArb, assignmentCredentialPieceArb), {
        minLength: 1,
        maxLength: 3,
      }),
      prefixPieces: fc.array(benignNonValuePieceArb, { minLength: 0, maxLength: 2 }),
      suffixPieces: fc.array(benignNonValuePieceArb, { minLength: 0, maxLength: 2 }),
      sepBetween: fc.array(fc.constantFrom(' ', '\n', ';', ',', '&', '|'), { minLength: 3, maxLength: 3 }),
      sepBefore: fc.constantFrom(' ', '\n', ';', ','),
      sepAfter: fc.constantFrom(' ', '\n', ';', ','),
      followUpPrefix: fc.constantFrom('echoed ', 'retry failed: ', 'value='),
      followUpSuffix: fc.constantFrom('', ' done', '; ok=true'),
    });

    fc.assert(
      fc.property(scenarioArb, ({
        credentials,
        prefixPieces,
        suffixPieces,
        sepBetween,
        sepBefore,
        sepAfter,
        followUpPrefix,
        followUpSuffix,
      }) => {
        const prefix = prefixPieces.length > 0 ? `${prefixPieces.join(sepBefore)}${sepBefore}` : '';
        const suffix = suffixPieces.length > 0 ? `${sepAfter}${suffixPieces.join(sepAfter)}` : '';
        const bodyParts: string[] = [];
        for (let i = 0; i < credentials.length; i += 1) {
          if (i > 0) bodyParts.push(sepBetween[i - 1]!);
          bodyParts.push(credentials[i]!.fragment);
        }
        const input = `${prefix}${bodyParts.join('')}${suffix}`;

        const sanitized = sanitizeSensitiveText(input);
        for (const credential of credentials) {
          for (const secret of credential.secrets) {
            expect(sanitized).not.toContain(secret);

            const followUp = `${followUpPrefix}${secret}${followUpSuffix}`;
            const sanitizedFollowUp = sanitizeSensitiveTextWithKnownValues(followUp, { command: input });
            expect(sanitizedFollowUp).not.toContain(secret);

            const log = new Phase1ExecutionLog();
            log.recordEvent({ type: 'text', data: { text: `${input}\n` } });
            log.recordEvent({ type: 'text', data: { text: `${followUp}\n` } });
            expect(log.toReportInput()).not.toContain(secret);
          }
        }
      }),
      { numRuns: PBT_NUM_RUNS },
    );
  });

  // Property 2: No false positives — credential-free inputs are returned unchanged
  it(`Property 2 (no false positives): leaves credential-free inputs completely unchanged (${PBT_NUM_RUNS} runs)`, () => {
    const benignDocArb = fc.record({
      pieces: fc.array(benignNonValuePieceArb, { minLength: 1, maxLength: 6 }),
      delimiters: fc.array(delimiterArb, { minLength: 6, maxLength: 6 }),
    }).map(({ pieces, delimiters }) => {
      const parts: string[] = [];
      for (let i = 0; i < pieces.length; i += 1) {
        if (i > 0) parts.push(delimiters[i - 1]!);
        parts.push(pieces[i]!);
      }
      return parts.join('');
    });

    fc.assert(
      fc.property(benignDocArb, (input) => {
        expect(sanitizeSensitiveText(input)).toBe(input);
        expect(sensitiveTextRanges(input, new Set())).toEqual([]);
      }),
      { numRuns: PBT_NUM_RUNS },
    );
  });

  // Property 3: Exact equivalence with the naive brute-force range-union reference oracle
  it(`Property 3 (oracle equivalence): matches naive brute-force union-redaction oracle on mixed inputs (${PBT_NUM_RUNS} runs)`, () => {
    const knownSecretArb = fc.array(
      fc.stringMatching(/^[A-Za-z0-9_-]{4,12}$/),
      { minLength: 0, maxLength: 3 },
    );

    fc.assert(
      fc.property(
        mixedOrAdversarialArb,
        mixedOrAdversarialArb,
        knownSecretArb,
        (input, followUpBase, extraKnown) => {
          // Direct sanitization equivalence
          expect(sanitizeSensitiveText(input)).toBe(oracleSanitize(input, new Set()));

          // Explicit known-values sanitization equivalence
          const knownSet = new Set(extraKnown);
          expect(sanitizeTextWithValues(input, knownSet)).toBe(oracleSanitize(input, knownSet));

          // Collected known-values parity + follow-up redaction equivalence
          const prodCollected = new Set<string>();
          collectEmbeddedSensitiveValues(input, prodCollected);
          const oracleCollected = oracleCollectKnownValues(input);
          expect([...prodCollected].sort()).toEqual([...oracleCollected].sort());

          const echoedValues = [...oracleCollected].slice(0, 3).join(' ');
          const followUp = echoedValues.length > 0 ? `${followUpBase} ${echoedValues}` : followUpBase;
          expect(sanitizeTextWithValues(followUp, prodCollected)).toBe(
            oracleSanitize(followUp, oracleCollected),
          );
        },
      ),
      { numRuns: PBT_NUM_RUNS },
    );
  });

  // Property 4: Characters outside merged redaction ranges are untouched byte-for-byte,
  // and explicitly preserved non-credential segments around credentials survive intact.
  it(`Property 4 (outside ranges unchanged): preserves every character outside merged redaction spans (${PBT_NUM_RUNS} runs)`, () => {
    const knownSecretArb = fc.array(
      fc.stringMatching(/^[A-Za-z0-9_-]{4,12}$/),
      { minLength: 0, maxLength: 3 },
    );

    fc.assert(
      fc.property(mixedOrAdversarialArb, knownSecretArb, (input, extraKnown) => {
        const known = new Set(extraKnown);
        const rawRanges = sensitiveTextRanges(input, known);
        // Validate every raw range before merging so inverted endpoints (end < start)
        // or out-of-bounds indices are caught even if merging drops zero-width spans.
        for (const range of rawRanges) {
          expect(range.start).toBeGreaterThanOrEqual(0);
          expect(range.end).toBeLessThanOrEqual(input.length);
          expect(range.end).toBeGreaterThanOrEqual(range.start);
        }
        const merged = oracleMergeRanges(rawRanges);
        const output = sanitizeTextWithValues(input, known);

        // Every merged range must be strictly non-empty and within input bounds.
        for (const range of merged) {
          expect(range.start).toBeGreaterThanOrEqual(0);
          expect(range.end).toBeLessThanOrEqual(input.length);
          expect(range.end).toBeGreaterThan(range.start);
        }

        // Rebuilding output from the untouched slices outside `merged` plus `[REDACTED]`
        // for each merged span must reproduce `output` character-for-character.
        let cursor = 0;
        let outCursor = 0;
        for (const range of merged) {
          const outsideSlice = input.slice(cursor, range.start);
          expect(output.slice(outCursor, outCursor + outsideSlice.length)).toBe(outsideSlice);
          outCursor += outsideSlice.length;
          expect(output.slice(outCursor, outCursor + REDACTED_VALUE.length)).toBe(REDACTED_VALUE);
          outCursor += REDACTED_VALUE.length;
          cursor = range.end;
        }
        const trailingSlice = input.slice(cursor);
        expect(output.slice(outCursor)).toBe(trailingSlice);
      }),
      { numRuns: PBT_NUM_RUNS },
    );

    // Input-anchored preservation check: independently specified non-credential text
    // surrounding credentials (including delimiter + next field right after a URL or
    // quoted assignment) must remain intact in the output (catches over-redaction).
    const anchoredArb = fc.record({
      prefix: fc.constantFrom('status=ok ', 'region=ap-northeast-1, ', '["https://:443","ops@example.test"] '),
      credential: fc.oneof(urlCredentialPieceArb, assignmentCredentialPieceArb),
      suffix: fc.constantFrom(' done=true', ', note="plain value"', ' ["https://host:443","admin@example.test"]'),
    });

    fc.assert(
      fc.property(anchoredArb, ({ prefix, credential, suffix }) => {
        const input = `${prefix}${credential.fragment}${suffix}`;
        const output = sanitizeSensitiveText(input);
        expect(output.startsWith(prefix)).toBe(true);
        expect(output.endsWith(suffix)).toBe(true);
        for (const secret of credential.secrets) {
          expect(output).not.toContain(secret);
        }
      }),
      { numRuns: PBT_NUM_RUNS },
    );

    const trailingFieldArb = fc.record({
      credential: fc.oneof(
        urlCredentialPieceArb,
        fc.record({
          key: sensitiveKeyArb,
          quote: fc.constantFrom('"', "'"),
          val: secretBodyArb,
        }).map(({ key, quote, val }) => ({
          fragment: `${key}=${quote}${val}${quote}`,
          secrets: [val],
        })),
      ),
      trailing: fc.constantFrom(';owner=ops', ',status=ok', '&mode=fast', '|cat'),
    });

    fc.assert(
      fc.property(trailingFieldArb, ({ credential, trailing }) => {
        const input = `${credential.fragment}${trailing}`;
        const output = sanitizeSensitiveText(input);
        expect(output.endsWith(trailing)).toBe(true);
        for (const secret of credential.secrets) {
          expect(output).not.toContain(secret);
        }
      }),
      { numRuns: PBT_NUM_RUNS },
    );
  });
});

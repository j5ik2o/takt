export const REDACTED_VALUE = '[REDACTED]';

const SENSITIVE_KEY_CHAR_PATTERN = String.raw`[A-Za-z0-9_.-]`;
const SENSITIVE_KEY_WORD_PATTERN = String.raw`api[_-]?key|token|password|secret|credentials?|access[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key`;
// A sensitive key is a maximal run of key characters that contains a sensitive
// key word. A key can only end where the run ends (every follower — quote,
// `:`/`=`, whitespace — is a non-key character), so the atomic lookahead
// locates the key word in a single pass and `+` then consumes the whole run.
// The previous form (`chars* keyword chars*`) re-scanned the remainder of a
// run from every backtracking position, which made sanitization O(n^2) on
// long uniform runs (~5s for 64KB of base64-like output).
const SENSITIVE_KEY_PATTERN = String.raw`(?=${SENSITIVE_KEY_CHAR_PATTERN}*(?:${SENSITIVE_KEY_WORD_PATTERN}))${SENSITIVE_KEY_CHAR_PATTERN}+`;
const SENSITIVE_HEADER_KEY_PATTERN = String.raw`(?:proxy[_-]?)?authorization|(?:set[_-]?)?cookies?|session[_-]?id`;
const SENSITIVE_TEXT_KEY_PATTERN = String.raw`(?:${SENSITIVE_KEY_PATTERN}|${SENSITIVE_HEADER_KEY_PATTERN})`;
// Bare (unquoted) assignment keys anchor to the start of a key-character run:
// a match can never start mid-run (the leading `chars*` of the original
// pattern always absorbed the run prefix), so rejecting mid-run start
// positions with the lookbehind is behavior-preserving and stops the engine
// from re-attempting every interior position of a long run. The skip loop
// preserves the original handling of runs that begin with a header key
// (e.g. `authorization-token=v`): header-key prefixes are consumed character
// by character until the header exclusion no longer blocks the key.
const SENSITIVE_BARE_ASSIGNMENT_KEY_PATTERN = String.raw`(?<!${SENSITIVE_KEY_CHAR_PATTERN})(?:(?=(?:${SENSITIVE_HEADER_KEY_PATTERN})\b)${SENSITIVE_KEY_CHAR_PATTERN})*(?!(?:${SENSITIVE_HEADER_KEY_PATTERN})\b)${SENSITIVE_KEY_PATTERN}`;
// `\"key\"` is a key of JSON that was serialized into a string once more (an SDK error
// that embeds response headers or a body).
const SENSITIVE_ASSIGNMENT_KEY_PATTERN = String.raw`(?:["'](?:${SENSITIVE_TEXT_KEY_PATTERN})["']|\\"(?:${SENSITIVE_TEXT_KEY_PATTERN})\\"|${SENSITIVE_BARE_ASSIGNMENT_KEY_PATTERN})`;
const SENSITIVE_KEY_NAME_REGEX = new RegExp(
  String.raw`^${SENSITIVE_TEXT_KEY_PATTERN}$`,
  'i',
);
const SENSITIVE_QUOTED_VALUE_PATTERN = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
// JSON doubles shell backslashes: runs of 4n+3 before a quote stay inside
// the value, while 4n+1 closes it. The alternatives consume disjoint runs.
const JSON_ESCAPED_QUOTED_VALUE_PATTERN = String.raw`\\"(?:[^"\\]|\\{4}|\\{1,3}[^"\\]|\\{3}")*\\"`;
const SENSITIVE_ASSIGNMENT_QUOTED_VALUE_REGEX = new RegExp(
  String.raw`(${SENSITIVE_ASSIGNMENT_KEY_PATTERN}\s*[:=]\s*)(${JSON_ESCAPED_QUOTED_VALUE_PATTERN}|${SENSITIVE_QUOTED_VALUE_PATTERN})`,
  'gi',
);
// The patterns below are split into a prefix (key and separator) and a value that runs up to a
// stop character. Every pattern reads the original text, and its scan restarts at the start of
// the value it just found, so a key inside another value is still found: in
// `token:\npassword: secret`, the `password` value is not hidden behind the `token` value.
// The value end is looked up with a cursor that only moves forward, which keeps a run of keys
// inside one long value (`token=token=…`) linear.
const SENSITIVE_ASSIGNMENT_PREFIX_REGEX = new RegExp(
  String.raw`${SENSITIVE_ASSIGNMENT_KEY_PATTERN}\s*[:=]\s*["']?`,
  'gi',
);
const ASSIGNMENT_VALUE_STOP_REGEX = /["'[{,\s}\]]/g;
const SENSITIVE_HEADER_ASSIGNMENT_PREFIX_REGEX = new RegExp(
  String.raw`(?:${SENSITIVE_HEADER_KEY_PATTERN})\s*=\s*["']?`,
  'gi',
);
const SENSITIVE_HEADER_COLON_PREFIX_REGEX = /session[_-]?id\s*:\s*["']?/gi;
const HEADER_ASSIGNMENT_VALUE_STOP_REGEX = /["';,\s}\]]/g;
// `(?<!-)` skips `--` start positions preceded by another `-`: such a match
// could only exist if the attempt one character earlier (also `--`) had
// already failed, and that failure implies this one fails too. This keeps
// long `-` runs (separator lines) linear instead of quadratic.
const SENSITIVE_OPTION_PREFIX_REGEX = new RegExp(
  String.raw`(?<!-)--(?:${SENSITIVE_KEY_PATTERN})(?:=|\s+)`,
  'gi',
);
const WHITESPACE_REGEX = /\s/g;
const SENSITIVE_QUERY_PREFIX_REGEX = /[?&](?:api[_-]?key|key|token|password|secret|sig|(?:x-amz-)?signature)=/gi;
const QUERY_VALUE_STOP_REGEX = /[&\s]/g;
// A shell statement can follow an unquoted value without a space (`TOKEN=secret;echo`).
const SHELL_SEPARATOR_REGEX = /[;&|]/;
const HTTP_HEADER_PREFIX_REGEX = /\b(Authorization|(?:Set-)?Cookie)\s*:\s*/gi;
// `user:password@` after a URL scheme. The match starts at `://` and the lookbehind then
// checks that a scheme ends there, so each scheme-like run is read once, from its own `://`.
// Starting at the scheme instead rescans the rest of a run of letters and hyphens from every
// letter after a `-` (quadratic). The lookbehind only asks for a letter somewhere in the run
// of scheme characters, so `1-http://`, `9http://` and `_http://` all count.
// The user ends at the first colon and may be empty (`redis://:password@host`): trying each
// colon as the separator rescans the rest of a colon-separated run every time.
// The password is non-empty, may start with `@`, and runs to the last `@` of the authority so
// unencoded `@` characters in it stay hidden. Up to the first `@` after its first character,
// the user and the password may hold any character but `/?#`, whitespace and `@`
// (`https://u:pa,ss@host` and `https://u:@pa,ss@host` are hidden).
// Past the first `@` a single character class (not a repeated group) keeps long `@` runs in
// bounded regexp stack and stops at quotes, commas and brackets, keeping the host and a later
// address readable in `"https://user:pass@host","admin@example.test"`.
const URL_USERINFO_CREDENTIALS_REGEX = /(:\/\/)(?<=[A-Za-z][0-9+.-]*:\/\/)([^/?#\s@:]*:(?:@?[^/?#\s@]+(?:@[^/?#\s"'`,<>()[\]{}]*)?|@[^/?#\s"'`,<>()[\]{}]*))@/g;
const URL_SCHEME_CHAR_REGEX = /[A-Za-z0-9+.-]/;
// A URL inside a quoted list item ends at the item: in `["https://localhost:443","ops@example.test"]`
// the `","` between the items is not part of a password.
const QUOTED_LIST_BOUNDARY_REGEXES: Readonly<Record<string, RegExp>> = {
  '"': /"\s*,\s*"/,
  "'": /'\s*,\s*'/,
};
const CURL_USER_EQUALS_PREFIX_REGEX = /\B--(?:proxy-)?user=/gi;
const CURL_USER_SPACE_PREFIX_REGEX = /\B(?:-u|--(?:proxy-)?user)\s+/gi;
const CURL_SHORT_USER_COMPACT_PREFIX_REGEX = /(?:^|(?<=\s))-u/gi;
// A bearer credential with no header name in front of it. The value needs a digit or 20
// characters, so that prose such as "Bearer authentication" stays readable.
const BEARER_VALUE_PATTERN = String.raw`[A-Za-z0-9._~+/=-]`;
const BARE_BEARER_VALUE_REGEX = new RegExp(
  String.raw`(\b[Bb]earer\s+)((?=${BEARER_VALUE_PATTERN}*\d|${BEARER_VALUE_PATTERN}{20})${BEARER_VALUE_PATTERN}{8,})`,
  'g',
);
const KNOWN_TOKEN_REGEX = new RegExp(
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
    // A JSON web token starts only at the start of a run of its own characters. Without the
    // lookbehind, every `eyJ` after a `-` restarts a scan of the rest of the run (quadratic).
    String.raw`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
  ].join('|')})\b`,
  'g',
);
const PEM_PRIVATE_KEY_REGEX = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g;

export interface SensitiveRange {
  readonly start: number;
  readonly end: number;
}

interface HttpHeaderValue {
  start: number;
  credentialStart: number;
  end: number;
  scheme: string | undefined;
}

/** A value found after a key; `start`/`end` is what display hides, `value*` what is tracked. */
interface KeyedValue {
  readonly keyStart: number;
  readonly start: number;
  readonly end: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface CurlUserValue {
  readonly end: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

/** Everything that looks like a credential in one text, all positions on that text. */
interface SensitiveMatches {
  readonly whole: SensitiveRange[];
  readonly quoted: KeyedValue[];
  readonly userinfos: SensitiveRange[];
  readonly headers: HttpHeaderValue[];
  readonly assignments: KeyedValue[];
  readonly headerAssignments: KeyedValue[];
  readonly options: KeyedValue[];
  readonly queries: KeyedValue[];
  readonly bearers: KeyedValue[];
  readonly curlUsers: KeyedValue[];
}

type ShellHeaderQuote = "'" | '"' | '\\"';

/** First index at or after `from` that matches the one-character `pattern`, or the text length. */
function forwardFinder(text: string, pattern: RegExp): (from: number) => number {
  const matcher = new RegExp(pattern.source, 'g');
  let checkedFrom = Number.POSITIVE_INFINITY;
  let found = text.length;
  return (from) => {
    if (from >= checkedFrom && from <= found) return found;
    matcher.lastIndex = from;
    const match = matcher.exec(text);
    checkedFrom = from;
    found = match === null ? text.length : match.index;
    return found;
  };
}

function findSensitiveMatches(text: string): SensitiveMatches {
  const userinfos = urlUserinfos(text);
  // A key that is the user of a URL (`https://token:secret@host`) is not an assignment: the
  // URL already hides its password, and reading it as `token:<value>` would hide the host.
  const userinfoStarts = new Set(userinfos.map((userinfo) => userinfo.start));
  const notUser = (value: { keyStart: number }): boolean => !userinfoStarts.has(value.keyStart);
  const quoted = quotedAssignments(text).filter(notUser);
  return {
    whole: [...wholeMatches(text, PEM_PRIVATE_KEY_REGEX), ...wholeMatches(text, KNOWN_TOKEN_REGEX)],
    quoted,
    userinfos,
    headers: [...httpHeaderValues(text)].filter(notUser),
    // Bare matches inside a quoted assignment would extend past its closing `\"`
    // (e.g. `token=\"x-secret==\"` yields `=\`), and masking ranges would then eat the escape.
    assignments: bareAssignments(text).filter((assignment) => notUser(assignment) && !insideAny(quoted, assignment.keyStart)),
    headerAssignments: [...headerAssignments(text), ...sessionIdColonValues(text)].filter(notUser),
    options: [...optionValues(text)],
    queries: queryValues(text),
    bearers: bearerValues(text),
    curlUsers: [
      ...curlUserValues(text, CURL_USER_EQUALS_PREFIX_REGEX),
      ...curlUserValues(text, CURL_USER_SPACE_PREFIX_REGEX),
      ...curlUserValues(text, CURL_SHORT_USER_COMPACT_PREFIX_REGEX),
    ],
  };
}

function wholeMatches(text: string, pattern: RegExp): SensitiveRange[] {
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

function quotedAssignments(text: string): KeyedValue[] {
  return [...text.matchAll(SENSITIVE_ASSIGNMENT_QUOTED_VALUE_REGEX)].map((match) => {
    const valueStart = match.index + match[1]!.length;
    const valueEnd = match.index + match[0].length;
    const quoteWidth = match[2]!.startsWith('\\"') ? 2 : 1;
    return { keyStart: match.index, start: valueStart + quoteWidth, end: valueEnd - quoteWidth, valueStart, valueEnd };
  });
}

const bareAssignments = (text: string): KeyedValue[] =>
  [...keyedValues(text, SENSITIVE_ASSIGNMENT_PREFIX_REGEX, ASSIGNMENT_VALUE_STOP_REGEX, true)];
const headerAssignments = (text: string): KeyedValue[] =>
  [...keyedValues(text, SENSITIVE_HEADER_ASSIGNMENT_PREFIX_REGEX, HEADER_ASSIGNMENT_VALUE_STOP_REGEX, false)];
const sessionIdColonValues = (text: string): KeyedValue[] =>
  [...keyedValues(text, SENSITIVE_HEADER_COLON_PREFIX_REGEX, HEADER_ASSIGNMENT_VALUE_STOP_REGEX, false)];
const queryValues = (text: string): KeyedValue[] =>
  [...keyedValues(text, SENSITIVE_QUERY_PREFIX_REGEX, QUERY_VALUE_STOP_REGEX, false)];

function bearerValues(text: string): KeyedValue[] {
  return [...text.matchAll(BARE_BEARER_VALUE_REGEX)].map((match) => {
    const start = match.index + match[1]!.length;
    const end = start + match[2]!.length;
    return { keyStart: match.index, start, end, valueStart: start, valueEnd: end };
  });
}

/** `keyStart` lies inside one of the ordered, disjoint `values`. */
function insideAny(values: readonly KeyedValue[], keyStart: number): boolean {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = values[middle]!;
    if (keyStart < value.keyStart) high = middle - 1;
    else if (keyStart >= value.valueEnd) low = middle + 1;
    else return true;
  }
  return false;
}

function* keyedValues(
  text: string,
  prefix: RegExp,
  stop: RegExp,
  rejectEscapedQuote: boolean,
): Generator<KeyedValue> {
  const prefixes = new RegExp(prefix.source, prefix.flags);
  const stopAt = forwardFinder(text, stop);
  for (let match = prefixes.exec(text); match !== null; match = prefixes.exec(text)) {
    const start = match.index + match[0].length;
    const end = rejectEscapedQuote && text.startsWith('\\"', start) ? start : stopAt(start);
    if (end === start) {
      prefixes.lastIndex = match.index + 1;
      continue;
    }
    yield { keyStart: match.index, start, end, valueStart: start, valueEnd: end };
    prefixes.lastIndex = start;
  }
}

function* optionValues(text: string): Generator<KeyedValue> {
  const prefixes = new RegExp(SENSITIVE_OPTION_PREFIX_REGEX.source, SENSITIVE_OPTION_PREFIX_REGEX.flags);
  const quotedValue = new RegExp(SENSITIVE_QUOTED_VALUE_PATTERN, 'y');
  const whitespaceAt = forwardFinder(text, WHITESPACE_REGEX);
  for (let match = prefixes.exec(text); match !== null; match = prefixes.exec(text)) {
    const start = match.index + match[0].length;
    quotedValue.lastIndex = start;
    const quoted = quotedValue.exec(text);
    const end = quoted === null ? whitespaceAt(start) : start + quoted[0].length;
    if (end === start) {
      prefixes.lastIndex = match.index + 1;
      continue;
    }
    yield { keyStart: match.index, start, end, valueStart: start, valueEnd: end };
    prefixes.lastIndex = start;
  }
}

function urlUserinfos(text: string): SensitiveRange[] {
  const userinfos: SensitiveRange[] = [];
  for (const match of text.matchAll(URL_USERINFO_CREDENTIALS_REGEX)) {
    const start = match.index + match[1]!.length;
    const end = match.index + match[0].length - 1;
    if (!crossesQuotedListItem(text, match.index, start, end)) userinfos.push({ start, end });
  }
  return userinfos;
}

function crossesQuotedListItem(text: string, schemeEnd: number, start: number, end: number): boolean {
  let schemeStart = schemeEnd;
  while (schemeStart > 0 && URL_SCHEME_CHAR_REGEX.test(text[schemeStart - 1]!)) schemeStart -= 1;
  const boundary = QUOTED_LIST_BOUNDARY_REGEXES[text[schemeStart - 1] ?? ''];
  if (boundary === undefined) return false;
  const firstAt = text.indexOf('@', start);
  return boundary.test(text.slice(start, firstAt < 0 || firstAt > end ? end : firstAt));
}

// curl's user option, `--user=user:password`, `-u user:password`, `-uuser:password`, with the
// value bare, quoted, or inside an escaped JSON string (`\"user:password\"`). The value is read
// by hand instead of with one pattern: a pattern that looks for the colon rescans the rest of a
// colon-less run from every `--user=` in it (quadratic on `--user=a;--user=a;…`).
function curlUserValues(text: string, prefix: RegExp): KeyedValue[] {
  const values: KeyedValue[] = [];
  const prefixes = new RegExp(prefix.source, prefix.flags);
  const readValue = curlUserValueReader(text);
  for (let match = prefixes.exec(text); match !== null; match = prefixes.exec(text)) {
    const start = match.index + match[0].length;
    const value = readValue(start);
    if (value === undefined) {
      prefixes.lastIndex = match.index + 1;
      continue;
    }
    values.push({ keyStart: match.index, start, end: value.end, valueStart: value.valueStart, valueEnd: value.valueEnd });
    prefixes.lastIndex = value.end;
  }
  return values;
}

function curlUserValueReader(text: string): (start: number) => CurlUserValue | undefined {
  const escapedQuoteOrColon = forwardFinder(text, /[":]/);
  const escapedClosingQuote = forwardFinder(text, /"/);
  const doubleQuoteOrColon = forwardFinder(text, /[":]/);
  const doubleClosingQuote = forwardFinder(text, /"/);
  const singleQuoteOrColon = forwardFinder(text, /[':]/);
  const singleClosingQuote = forwardFinder(text, /'/);
  const bareWhitespaceOrColon = forwardFinder(text, /[\s:]/);
  const bareWhitespace = forwardFinder(text, /\s/);
  const withEscapedQuote = (end: number): number => text.startsWith('\\"', end) ? end + 2 : end;
  const quoted = (
    start: number,
    quote: string,
    quoteOrColon: (from: number) => number,
    closingQuote: (from: number) => number,
  ): CurlUserValue | undefined => {
    if (text[start] !== quote || text[start + 1] === '+') return undefined;
    const colon = quoteOrColon(start + 1);
    if (text[colon] !== ':') return undefined;
    const close = closingQuote(colon + 1);
    if (close === text.length) return undefined;
    return { end: withEscapedQuote(close + 1), valueStart: start, valueEnd: close + 1 };
  };
  return (start) => {
    if (text.startsWith('\\"', start)) {
      const valueStart = start + 2;
      if (text[valueStart] !== '+') {
        const colon = escapedQuoteOrColon(valueStart);
        const close = text[colon] === ':' ? escapedClosingQuote(colon + 1) : text.length;
        if (close < text.length && text[close - 1] === '\\') {
          return { end: close + 1, valueStart, valueEnd: close - 1 };
        }
      }
      return quoted(valueStart, '"', doubleQuoteOrColon, doubleClosingQuote)
        ?? quoted(valueStart, "'", singleQuoteOrColon, singleClosingQuote);
    }
    const first = text[start];
    if (first === '"') return quoted(start, '"', doubleQuoteOrColon, doubleClosingQuote);
    if (first === "'") return quoted(start, "'", singleQuoteOrColon, singleClosingQuote);
    if (first === '+') return undefined;
    const colon = bareWhitespaceOrColon(start);
    if (text[colon] !== ':') return undefined;
    const end = bareWhitespace(colon + 1);
    return { end, valueStart: start, valueEnd: end };
  };
}

function* httpHeaderValues(text: string): Generator<HttpHeaderValue & { keyStart: number }> {
  const headers = new RegExp(HTTP_HEADER_PREFIX_REGEX.source, HTTP_HEADER_PREFIX_REGEX.flags);
  const quotedAssignments = text.matchAll(SENSITIVE_ASSIGNMENT_QUOTED_VALUE_REGEX);
  let quotedAssignment = quotedAssignments.next().value;
  const authScheme = /([A-Za-z]+)[ \t]+/y;
  for (let match = headers.exec(text); match !== null; match = headers.exec(text)) {
    while (quotedAssignment !== undefined && quotedAssignment.index + quotedAssignment[0].length <= match.index) {
      quotedAssignment = quotedAssignments.next().value;
    }
    if (quotedAssignment !== undefined && quotedAssignment.index <= match.index) {
      // Quoted assignments use the same boundary as display redaction.
      headers.lastIndex = quotedAssignment.index + quotedAssignment[0].length;
      continue;
    }
    const start = headers.lastIndex;
    authScheme.lastIndex = start;
    const scheme = match[1]!.toLowerCase() === 'authorization' ? authScheme.exec(text) : null;
    const credentialStart = scheme === null ? start : authScheme.lastIndex;
    const enclosingQuote = text[match.index - 1];
    const shellQuote = enclosingQuote === '"' && text[match.index - 2] === '\\'
      ? '\\"'
      : enclosingQuote === '"' || enclosingQuote === "'" ? enclosingQuote : undefined;
    const end = httpHeaderValueEnd(text, credentialStart, shellQuote);
    if (end > start) {
      yield { keyStart: match.index, start, credentialStart, end, scheme: scheme?.[1] };
    }
    // Consumed values can contain header-like text; never restart a scan inside them.
    headers.lastIndex = end;
  }
}

function httpHeaderValueEnd(text: string, start: number, shellQuote: ShellHeaderQuote | undefined): number {
  let valueQuote: string | undefined;
  let previousNonSpace: string | undefined;
  let cursor = start;
  while (cursor < text.length) {
    const char = text[cursor]!;
    if (char === '\r' || char === '\n') break;
    if (shellQuote === '\\"' && char === '\\') {
      let slashEnd = cursor + 1;
      while (text[slashEnd] === '\\') slashEnd += 1;
      // JSON doubles shell backslashes and adds one before a quote.
      if (text[slashEnd] === '"' && (slashEnd - cursor) % 4 === 1) return slashEnd - 1;
      cursor = slashEnd;
      if (text[cursor] === '"') cursor += 1;
      continue;
    }
    if (char === '\\' && shellQuote !== "'" && text[cursor + 1] !== '\r' && text[cursor + 1] !== '\n') {
      cursor = Math.min(cursor + 2, text.length);
      continue;
    }
    if (shellQuote !== undefined) {
      if (char === shellQuote || (shellQuote === '\\"' && char === '"')) break;
    } else if (valueQuote !== undefined) {
      if (char === valueQuote) valueQuote = undefined;
    } else if (char === '"' || char === "'") {
      if (cursor !== start && previousNonSpace !== '=') break;
      valueQuote = char;
    }
    if (char !== ' ' && char !== '\t') previousNonSpace = char;
    cursor += 1;
  }
  return cursor;
}

export function sanitizeSensitiveText(text: string): string {
  if (!text) return text;
  return maskSensitiveRanges(text, sensitiveTextRanges(text, new Set()));
}

const valueRanges = (values: readonly KeyedValue[]): SensitiveRange[] => values.map(({ start, end }) => ({ start, end }));

// Until #151, redaction replaced one pattern at a time, each on the output of the one before.
// A replacement can join text that was apart: `-ux://--user=" :\"secret"` becomes
// `-ux://--user=[REDACTED]secret"`, and the short `-u` value then runs on over `secret`.
// The patterns are applied once more in that order, each reading the text with the earlier
// ranges replaced, so that everything the old order hid stays hidden. Known values are not part
// of this pass: hiding more of them could hide a key and so hide less, and adding a known value
// must never show anything that was hidden without it.
const SEQUENTIAL_ORDER: ReadonlyArray<(text: string) => SensitiveRange[]> = [
  (text) => wholeMatches(text, PEM_PRIVATE_KEY_REGEX),
  (text) => valueRanges(quotedAssignments(text)),
  urlUserinfos,
  (text) => valueRanges(bearerValues(text)),
  (text) => [...httpHeaderValues(text)].map(({ credentialStart, end }) => ({ start: credentialStart, end })),
  (text) => valueRanges(curlUserValues(text, CURL_USER_EQUALS_PREFIX_REGEX)),
  (text) => valueRanges(curlUserValues(text, CURL_USER_SPACE_PREFIX_REGEX)),
  (text) => valueRanges(curlUserValues(text, CURL_SHORT_USER_COMPACT_PREFIX_REGEX)),
  (text) => valueRanges(headerAssignments(text)),
  (text) => valueRanges(sessionIdColonValues(text)),
  (text) => valueRanges(bareAssignments(text)),
  (text) => valueRanges([...optionValues(text)]),
  (text) => valueRanges(queryValues(text)),
  (text) => wholeMatches(text, KNOWN_TOKEN_REGEX),
];

function sequentialRanges(text: string): SensitiveRange[] {
  let hidden: SensitiveRange[] = [];
  for (const find of SEQUENTIAL_ORDER) {
    const view = maskedView(text, hidden);
    const found = find(view.text);
    if (found.length > 0) hidden = mergedRanges([...hidden, ...found.map(view.toOriginal)]);
  }
  return hidden;
}

/** `text` with each of the ordered, disjoint `hidden` ranges replaced by REDACTED_VALUE. */
function maskedView(text: string, hidden: readonly SensitiveRange[]): {
  text: string;
  toOriginal: (range: SensitiveRange) => SensitiveRange;
} {
  if (hidden.length === 0) return { text, toOriginal: (range) => range };
  // Start of each replacement in the view, and how far the view runs ahead of the text after it.
  const viewStarts: number[] = [];
  const shifts: number[] = [];
  let shift = 0;
  for (const range of hidden) {
    viewStarts.push(range.start + shift);
    shift += REDACTED_VALUE.length - (range.end - range.start);
    shifts.push(shift);
  }
  // Index of the last replacement that starts at or before `position` in the view, or -1.
  const replacementAt = (position: number): number => {
    let low = 0;
    let high = viewStarts.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (viewStarts[middle]! <= position) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  };
  // Where the view character at `position` comes from: a whole hidden range, or one character.
  const source = (position: number): SensitiveRange => {
    const index = replacementAt(position);
    if (index < 0) return { start: position, end: position + 1 };
    if (position < viewStarts[index]! + REDACTED_VALUE.length) return hidden[index]!;
    const original = position - shifts[index]!;
    return { start: original, end: original + 1 };
  };
  return {
    text: maskSensitiveRanges(text, hidden),
    toOriginal: ({ start, end }) => ({ start: source(start).start, end: end > start ? source(end - 1).end : source(start).start }),
  };
}

export function isSensitiveKeyName(key: string): boolean {
  return SENSITIVE_KEY_NAME_REGEX.test(key);
}

function patternRanges(matches: SensitiveMatches): SensitiveRange[] {
  const ranges: SensitiveRange[] = [...matches.whole, ...matches.userinfos];
  for (const header of matches.headers) ranges.push({ start: header.credentialStart, end: header.end });
  for (const group of [
    matches.quoted,
    matches.assignments,
    matches.headerAssignments,
    matches.options,
    matches.queries,
    matches.bearers,
    matches.curlUsers,
  ]) {
    for (const { start, end } of group) ranges.push({ start, end });
  }
  return ranges;
}

export function collectEmbeddedSensitiveValues(text: string, values: Set<string>): void {
  const matches = findSensitiveMatches(text);
  for (const { start, end } of matches.whole) addSensitiveValue(values, text.slice(start, end));
  for (const { valueStart, valueEnd } of matches.quoted) {
    const quotedValue = text.slice(valueStart, valueEnd);
    addSensitiveValue(values, quotedValue);
    // Everything inside the quotes is tracked as well: an embedded `token=…`, URL or header
    // can be printed again on its own.
    collectEmbeddedSensitiveValues(stripMatchingQuotes(quotedValue), values);
  }
  for (const value of outermostAndInnermost(matches.assignments)) {
    const assigned = text.slice(value.valueStart, value.valueEnd);
    addSensitiveValue(values, assigned);
    addShellStatementValue(values, assigned);
  }
  for (const value of outermostAndInnermost(matches.headerAssignments)) {
    addSensitiveValue(values, text.slice(value.valueStart, value.valueEnd));
  }
  for (const value of outermostAndInnermost(matches.options)) {
    const option = text.slice(value.valueStart, value.valueEnd);
    addSensitiveValue(values, option);
    addShellStatementValue(values, option);
  }
  for (const value of outermostAndInnermost(matches.queries)) {
    addSensitiveValue(values, text.slice(value.valueStart, value.valueEnd));
  }
  for (const { valueStart, valueEnd } of matches.bearers) addSensitiveValue(values, text.slice(valueStart, valueEnd));
  for (const { start, end } of matches.headers) {
    const value = text.slice(start, end);
    addSensitiveValue(values, value);
    addCredentialComponents(values, value);
  }
  for (const { start, end } of matches.userinfos) addUserinfoValues(values, text.slice(start, end));
  for (const { valueStart, valueEnd } of matches.curlUsers) {
    const value = text.slice(valueStart, valueEnd);
    addSensitiveValue(values, value);
    addCredentialComponents(values, value);
  }
}

// Keys inside a value are matched too, so `token=token=token=x` yields values that all end at
// the same place. Tracking only the outermost and the innermost of them keeps the tracked bytes
// linear; the ones between are substrings of the outermost and add nothing a new key would not.
function outermostAndInnermost(values: readonly KeyedValue[]): KeyedValue[] {
  const kept: KeyedValue[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    const next = values[index + 1];
    const previous = values[index - 1];
    const startsGroup = previous === undefined || previous.valueEnd !== value.valueEnd;
    const endsGroup = next === undefined || next.valueEnd !== value.valueEnd;
    if (startsGroup || endsGroup) kept.push(value);
  }
  return kept;
}

function addShellStatementValue(values: Set<string>, value: string): void {
  const separator = value.search(SHELL_SEPARATOR_REGEX);
  if (separator > 0) addSensitiveValue(values, value.slice(0, separator));
}

function addUserinfoValues(values: Set<string>, userinfo: string): void {
  const separator = userinfo.indexOf(':');
  // The password may start with `@` and may hold more `@` characters, as in
  // `https://u:secret@db;owner=ops@example.test` or `https://u:@secret@host;ops@example.test`.
  // The part up to the first `@` after the first password character goes first, and only that
  // part is split like a cookie: past it, `owner=ops` is not a credential.
  const firstAt = userinfo.indexOf('@', separator + 2);
  if (firstAt < 0) {
    addSensitiveValue(values, userinfo);
    addCredentialComponents(values, userinfo);
    return;
  }
  addSensitiveValue(values, userinfo.slice(0, firstAt));
  addCredentialComponents(values, userinfo.slice(0, firstAt));
  // The whole password and whole userinfo also cover a password with an unencoded `@`.
  // Adding the password before the full userinfo lets bounded trackers keep a shorter password
  // even when a long username pushes the full userinfo over the per-value byte limit.
  const password = userinfo.slice(separator + 1);
  if (password.length > 0) values.add(password);
  addSensitiveValue(values, userinfo);
}

export function addSensitiveValue(values: Set<string>, rawValue: string, key?: string): void {
  const value = stripMatchingQuotes(rawValue.trim());
  if (value.length === 0) return;
  // Multiline values are matched line by line, so each line stays maskable on its own.
  for (const line of value.split(/\r?\n/u)) {
    if (line.length > 0) values.add(line);
  }
  const authorizationValue = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
  if (authorizationValue?.[1]) {
    values.add(authorizationValue[1]);
  }
  if (key !== undefined && /(?:set[_-]?)?cookies?/i.test(key)) {
    addCookieValues(values, value);
  }
}

/** Hides the credentials `sanitizeSensitiveText` finds and every known value, in one pass. */
export function sanitizeTextWithValues(text: string, sensitiveValues: ReadonlySet<string>): string {
  if (!text) return text;
  return maskSensitiveRanges(text, sensitiveTextRanges(text, sensitiveValues));
}

function addCredentialComponents(values: Set<string>, rawValue: string): void {
  const value = stripMatchingQuotes(rawValue.trim());
  const authorizationValue = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
  if (authorizationValue?.[1]) {
    values.add(authorizationValue[1]);
  }
  const separator = value.indexOf(':');
  if (separator >= 0 && separator + 1 < value.length) {
    values.add(value.slice(separator + 1));
  }
  addCookieValues(values, value);
}

function addCookieValues(values: Set<string>, value: string): void {
  for (const cookie of value.split(';')) {
    const separator = cookie.indexOf('=');
    const cookieValue = separator >= 0 ? cookie.slice(separator + 1).trim() : '';
    if (cookieValue.length > 0) {
      values.add(cookieValue);
    }
  }
}

function stripMatchingQuotes(value: string): string {
  if (value.length >= 4 && value.startsWith('\\"') && value.endsWith('\\"')) {
    return value.slice(2, -2);
  }
  const first = value[0];
  return value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first
    ? value.slice(1, -1)
    : value;
}

/** The ranges `sanitizeTextWithValues` hides, on the original text. */
export function sensitiveTextRanges(text: string, values: ReadonlySet<string>): SensitiveRange[] {
  return [...patternRanges(findSensitiveMatches(text)), ...sequentialRanges(text), ...knownValueRanges(text, values)];
}

function knownValueRanges(text: string, values: ReadonlySet<string>): SensitiveRange[] {
  const ranges = substringSensitiveRanges(text, [...values].filter((value) => value.length >= 4));
  for (const value of values) {
    if (value.length === 0 || value.length >= 4) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bounded = new RegExp(
      String.raw`(?<![\p{L}\p{N}_])${escaped}(?![\p{L}\p{N}_])`,
      'gu',
    );
    for (const match of text.matchAll(bounded)) ranges.push({ start: match.index, end: match.index + value.length });
  }
  return ranges;
}

export function substringSensitiveRanges(text: string, values: Iterable<string>): SensitiveRange[] {
  const ranges: SensitiveRange[] = [];
  for (const value of values) {
    const length = value.length;
    if (length === 0 || length > text.length) continue;
    const first = text.indexOf(value);
    if (first < 0) continue;
    let spanStart = first;
    let spanEnd = first + length;
    if (spanEnd === text.length) {
      ranges.push({ start: spanStart, end: spanEnd });
      continue;
    }
    // KMP with on-the-fly span merging keeps overlapping copies of a long repetitive value
    // linear in O(|text| + |value|) instead of quadratic repeated indexOf(value, start + 1).
    const failure = new Int32Array(length);
    for (let i = 1, k = 0; i < length; i++) {
      while (k > 0 && value[i] !== value[k]) k = failure[k - 1]!;
      if (value[i] === value[k]) k++;
      failure[i] = k;
    }
    let matched = failure[length - 1]!;
    for (let i = spanEnd; i < text.length; i++) {
      while (matched > 0 && text[i] !== value[matched]) matched = failure[matched - 1]!;
      if (text[i] === value[matched]) {
        matched++;
        if (matched === length) {
          const matchStart = i + 1 - length;
          const matchEnd = i + 1;
          if (matchStart <= spanEnd) {
            spanEnd = matchEnd;
          } else {
            ranges.push({ start: spanStart, end: spanEnd });
            spanStart = matchStart;
            spanEnd = matchEnd;
          }
          matched = failure[matched - 1]!;
        }
      }
    }
    ranges.push({ start: spanStart, end: spanEnd });
  }
  return ranges;
}

function mergedRanges(ranges: readonly SensitiveRange[]): SensitiveRange[] {
  const ordered = [...ranges].filter((range) => range.end > range.start).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SensitiveRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end) merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    else merged.push(range);
  }
  return merged;
}

export function maskSensitiveRanges(text: string, ranges: readonly SensitiveRange[]): string {
  const parts: string[] = [];
  let copied = 0;
  for (const range of mergedRanges(ranges)) {
    parts.push(text.slice(copied, range.start), REDACTED_VALUE);
    copied = range.end;
  }
  parts.push(text.slice(copied));
  return parts.join('');
}

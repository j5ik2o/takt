import { describe, expect, it } from 'vitest';
import { Phase1ExecutionLog } from '../core/workflow/phase1-execution-log.js';
import { createSensitiveTextStreamRedactor } from '../shared/utils/sensitive-stream.js';
import { maskSensitiveRanges, sanitizeSensitiveText, sensitiveTextRanges } from '../shared/utils/sensitive-text.js';
import { sanitizeSensitiveTextWithKnownValues } from '../shared/utils/sensitive-value.js';

// Fixed examples of #151 (design sections 3 and 5, FINDING5-REREAD.md). Inputs are copied
// character for character. This file only uses functions that existed before #151, so it also
// runs against the previous implementation, where the leak examples fail.

const MARKERS = /Zq\d+Zq\d*/g;
const markersIn = (text: string): string[] => [...new Set(text.match(MARKERS) ?? [])];

function phase1(chunks: readonly string[]): string {
  const log = new Phase1ExecutionLog();
  for (const text of chunks) log.recordEvent({ type: 'text', data: { text } });
  return log.toReportInput();
}

function streamed(...texts: string[]): string[] {
  const redactor = createSensitiveTextStreamRedactor();
  return texts.map((text) => redactor.write(text, undefined) + redactor.flush(undefined));
}

// The stream is the previous stream in the first PR of #151 (design 11): its outputs are checked
// in the "known leaks (stream, first PR)" table below, and the second PR moves them back here.

/** Every path that shows `text` on its own. */
function shownOnItsOwn(text: string): Record<string, string> {
  return {
    display: sanitizeSensitiveText(text),
    ranges: maskSensitiveRanges(text, sensitiveTextRanges(text, new Set())),
    phase1: phase1([text]),
  };
}

/** Every path that shows `later` after `source`, tracking what `source` held. */
function shownLater(source: string, later: string): Record<string, string> {
  return {
    known: sanitizeSensitiveTextWithKnownValues(later, source),
    knownCommand: sanitizeSensitiveTextWithKnownValues(later, { command: source }),
    phase1: phase1([source + '\n', later]),
  };
}

/** The stream's output for `text` alone, and for `later` after `source`. */
const streamedAlone = (text: string): string => streamed(text)[0]!;
const streamedLater = (source: string, later: string): string => streamed(source + '\n', later)[1]!;

// FINDING5-REREAD.md 2.1: what the previous range path hid only by reading `token:` past the URL.
// 2.4: the same, glued to the host without a space. Answer A keeps both hidden on every path.
const RANGE_PATH_LEAKS: ReadonlyArray<{ input: string; secrets?: readonly string[]; note?: string }> = [
  { input: 'https://token:p@host;-u-uég97q:lgsn=Zq84Zq/ Set-Cookie: Zq85Zq' },
  { input: 'https://token:p@host;-ualice:Zq100Zq' },
  { input: 'https://token:p@host;https://token:p@host;https://token:p@host;-u<36zss7aa2f9p:n630tm1zvas7;g871v1lZq598Zq9uqk[\r\n' },
  // 2.1 supplement, seed 2 idx=10876 and seed 5 idx=9300: the report quotes these parts of the inputs.
  { input: "https://token:p@host;https://token:p@host;https://token:p@host;sk-Zq586Zqabcdefgh&x1://u:@lh691🔑8870v5aZq727Zq(?rs527r0@host'[", note: 'quoted part' },
  { input: 'https://token:p@host;cookie=q5se;Zq319Zqg20v0gg161v3h=#\r\n', note: 'quoted part' },
  { input: 'https://token:p@host-uuser:Zq101Zq' },
  { input: 'https://token:p@host:user:Zq102Zq' },
  { input: 'https://token:p@host:8080:lgsn=Zq103Zq' },
  { input: 'https://token:p@host=Zq105Zq' },
  { input: 'https://cookie:p@host:lgsn=Zq106Zq' },
  { input: 'https://token:p@host.:8443:user:Zq108Zq' },
  { input: 'https://TOKEN:p@HOST-uuser:Zq110Zq' },
  { input: 'https://COOKIE:p@HOST:u:Zq111Zq' },
  { input: 'https://token:Zq130Zq@host-uuser:Zq130Zq' },
  { input: 'https://token:p@host\u001b:Zq113Zq' },
  { input: 'https://token:p@host&-uuser:Zq121Zq' },
  { input: 'https://token:p@host|-uuser:Zq122Zq' },
  { input: 'https://token:p@host;-uuser:Zq123Zq' },
  { input: 'https://token:p@host-uuser:12345', secrets: ['12345'] },
  { input: 'https://token:p@host.Zq1Zq' },
];

describe('#151 fixed examples: what the previous range path hid stays hidden on every path', () => {
  it.each(RANGE_PATH_LEAKS.map((entry) => [entry.input, entry] as const))('%j', (_input, { input, secrets }) => {
    for (const [path, output] of Object.entries(shownOnItsOwn(input))) {
      for (const secret of secrets ?? markersIn(input)) expect(output, path).not.toContain(secret);
    }
  });
});

// Leak 1 (#165) and its variants (FINDING5-REREAD.md 2.2): a header name as the URL user, or
// inside its password, and then the real header. The later outputs are `later output: X end`,
// `echoed X` and a line holding only the secret. Design 5: the first two close by the union or by
// 4.2 alone; the secret-only line, Bearer and Basic close by 4.2 only.
const HEADER_AFTER_USERINFO: ReadonlyArray<readonly [source: string, secret: string]> = [
  ['https://cookie:a@host Cookie: Zq24Zq', 'Zq24Zq'],
  ['https://Cookie:a@host Cookie: Zq24Zq', 'Zq24Zq'],
  ['https://COOKIE:a@host Cookie: Zq24Zq', 'Zq24Zq'],
  ['https://set-cookie:a@host Set-Cookie: Zq24Zq', 'Zq24Zq'],
  ['https://set-cookie:a@h Set-Cookie: s=Zq26Zq', 'Zq26Zq'],
  ['https://my-cookie:a@host Cookie: Zq24Zq', 'Zq24Zq'],
  ['https://u:Cookie:p@h Cookie: Zq24Zq', 'Zq24Zq'],
  ['https://cookie:a@host\nCookie: Zq33Zq', 'Zq33Zq'],
  ['https://authorization:a@host Authorization: Zq24Zq', 'Zq24Zq'],
  ['https://Authorization:a@h Authorization: Bearer Zq24Zq', 'Zq24Zq'],
  ['https://Authorization:a@h Authorization: Bearer Zq25Zq9', 'Zq25Zq9'],
  ['https://proxy-authorization:a@h Authorization: Basic Zq24Zq', 'Zq24Zq'],
  ['https://proxy-authorization:a@h Authorization: Basic Zq32Zq', 'Zq32Zq'],
];

describe('#151 fixed examples: a header after a URL whose user or password is a header name', () => {
  for (const [source, secret] of HEADER_AFTER_USERINFO) {
    for (const later of [`later output: ${secret} end`, `echoed ${secret}`, secret]) {
      it(`${JSON.stringify(source)} then ${JSON.stringify(later)}`, () => {
        for (const [path, output] of [...Object.entries(shownOnItsOwn(source)), ...Object.entries(shownLater(source, later))]) {
          expect(output, path).not.toContain(secret);
        }
      });
    }
  }
});

const LEAK_2: readonly string[] = ["TOKEN=apikey: ?token=' 'Zq4Zq", 'token:token :--password=\\" \\"Zq0Zq'];
const PHASE1_COMPOSITION: readonly string[] = [
  "TOKEN=apikey: ?token=' 'Zq0Zqtoken: ,Zq0ZqBearer Zq1Zqabcdefgh12",
  "TOKEN=apikey: ?token=' 'Zq0Zqtoken: ,Zq0ZqBearer Zq1Zqabcdefgh12\nhttps://user:pa,Zq900Zq@host",
];
const UNNAMED_COOKIE = 'https://cookie:a@host Cookie: Zq34Zq; path=/';
const NAMED_COOKIE = 'https://cookie:a@host Cookie: sid=Zq36Zq; path=/';

describe('#151 fixed examples: leak 2 and the phase 1 composition', () => {
  it.each(LEAK_2.map((input) => [input]))('%j', (input) => {
    for (const [path, output] of Object.entries(shownOnItsOwn(input))) {
      for (const marker of markersIn(input)) expect(output, path).not.toContain(marker);
    }
  });

  // The phase 1 composition (design 1.1, 9.2, 6th edition): the previous log hid the second
  // Zq0Zq, because its display ran over its masked text and the query pattern chained across a
  // masked value. The previous display alone shows it, so only the log is checked here.
  it.each(PHASE1_COMPOSITION.map((input) => [input]))('phase 1 log of %j', (input) => {
    expect(phase1([input])).not.toContain('Zq0Zq');
  });
});

// Design 9.5: a cookie value without a name. The tracked value is `Zq34Zq; path=/`, which is not
// split, so `echoed Zq34Zq` shows the secret. This leak predates #151 (the previous implementation
// shows it as well) and is fixed by a follow-up PR, which turns this example into "hidden".
describe('#151 known leak (since before #151): a cookie value without a name', () => {
  it('shows the secret in later output (known leak, design 9.5)', () => {
    const source = UNNAMED_COOKIE;
    expect(sanitizeSensitiveTextWithKnownValues('echoed Zq34Zq', source)).toContain('Zq34Zq');
    for (const output of Object.values(shownOnItsOwn(source))) expect(output).not.toContain('Zq34Zq');
  });

  it('hides a named cookie value in the same place', () => {
    const source = NAMED_COOKIE;
    for (const output of Object.values(shownLater(source, 'echoed Zq36Zq'))) expect(output).not.toContain('Zq36Zq');
  });
});

// Known leaks of the stream paths in the first PR of #151 (design 11, 8th edition R7-6): the
// stream is the previous stream, so what the previous stream showed it still shows. This table is
// what every fixed example above shows through the stream; the test runs them all and compares,
// so the table cannot drift. The second PR closes these and turns this table empty.
const KNOWN_STREAM_LEAKS: ReadonlyArray<{ input: string; later?: string; leaked: readonly string[] }> = [
  { input: "TOKEN=apikey: ?token=' 'Zq4Zq", leaked: ['Zq4Zq'] },
  { input: 'token:token :--password=\\" \\"Zq0Zq', leaked: ['Zq0Zq'] },
  { input: PHASE1_COMPOSITION[0]!, leaked: ['Zq0Zq', 'Zq1Zq'] },
  { input: PHASE1_COMPOSITION[1]!, leaked: ['Zq0Zq', 'Zq1Zq'] },
];

// Leaks since before #151 that the review of #165 found; the previous implementation shows them as
// well, and follow-up PRs close them (then these examples turn into "hidden").
describe('#151 known leaks (since before #151) found in review', () => {
  it('a URL password with a `,` after an `@` shows its rest', () => {
    const text = 'https://:Zq50Zq@,Zq51Zq@host';
    expect(sanitizeSensitiveText(text)).not.toContain('Zq50Zq');
    expect(sanitizeSensitiveText(text)).toContain('Zq51Zq');
  });

  it('a value between two keys inside one value is not tracked on its own', () => {
    const source = 'token=first;password=Zq52Zq;token=last';
    expect(sanitizeSensitiveText(source)).not.toContain('Zq52Zq');
    expect(sanitizeSensitiveTextWithKnownValues('echoed Zq52Zq', source)).toContain('Zq52Zq');
  });
});

describe('#151 known leaks of the stream paths in the first PR', () => {
  it('are exactly what the fixed examples show through the stream', () => {
    const alone = [
      ...RANGE_PATH_LEAKS.map(({ input, secrets }) => ({ input, secrets: secrets ?? markersIn(input) })),
      ...[...LEAK_2, ...PHASE1_COMPOSITION, UNNAMED_COOKIE, NAMED_COOKIE].map((input) => ({ input, secrets: markersIn(input) })),
      ...HEADER_AFTER_USERINFO.map(([input, secret]) => ({ input, secrets: [secret] })),
    ];
    const later = [
      ...HEADER_AFTER_USERINFO.flatMap(([input, secret]) =>
        [`later output: ${secret} end`, `echoed ${secret}`, secret].map((text) => ({ input, later: text, secrets: [secret] }))),
      { input: UNNAMED_COOKIE, later: 'echoed Zq34Zq', secrets: ['Zq34Zq'] },
      { input: NAMED_COOKIE, later: 'echoed Zq36Zq', secrets: ['Zq36Zq'] },
    ];
    const leaks = [
      ...alone.map(({ input, secrets }) => ({ input, leaked: secrets.filter((secret) => streamedAlone(input).includes(secret)) })),
      ...later.map(({ input, later: text, secrets }) => ({ input, later: text, leaked: secrets.filter((secret) => streamedLater(input, text).includes(secret)) })),
    ].filter((leak) => leak.leaked.length > 0);
    expect(leaks).toEqual(KNOWN_STREAM_LEAKS);
  });
});

describe('#151 4.3: a quoted option value is one shell word, up to a shell operator', () => {
  it.each([
    ['curl --password "Zq40Zq"&& next', 'curl --password [REDACTED]&& next'],
    ["run --token 'a'Zq41Zq; echo done", 'run --token [REDACTED]; echo done'],
  ])('%j', (input, expected) => {
    expect(sanitizeSensitiveText(input)).toBe(expected);
  });
});

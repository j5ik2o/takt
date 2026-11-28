import { describe, expect, it } from 'vitest';
import { Phase1ExecutionLog } from '../core/workflow/phase1-execution-log.js';
import { createSensitiveTextStreamRedactor } from '../shared/utils/sensitive-stream.js';
import { maskSensitiveRanges, sanitizeSensitiveText, sensitiveTextRanges } from '../shared/utils/sensitive-text.js';
import { sanitizeSensitiveTextWithKnownValues } from '../shared/utils/sensitive-value.js';
import { TOOL_PATHS } from './helpers/sensitive-stream-drivers.js';

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

// The stream paths (design 3 "L-stream", 11): every fixed example below also runs through the
// redactor and through the tool paths (daemon toolTurn, ToolActivityDisplay, runningResult) in the
// "stream paths" test at the end of this file.

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

/** Every stream path, each returning everything it showed (committed output and previews). */
const STREAM_PATHS: ReadonlyArray<readonly [name: string, shown: (chunks: readonly string[]) => string]> = [
  ['redactor', (chunks) => (chunks.length === 1 ? streamedAlone(chunks[0]!) : streamedLater(chunks[0]!.slice(0, -1), chunks[1]!))],
  ...TOOL_PATHS.map(([name, drive]) => [name, (chunks: readonly string[]) => {
    const shown = drive({ input: {}, chunks, previews: chunks.map(() => true) });
    return [shown.committed, ...shown.moments].join('\n');
  }] as const),
];

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

// Design 9.5 of #151: a cookie value without a name. It was a known leak since before #151 (the
// tracked value `Zq34Zq; path=/` was not split); #175 closes it (takt-175 DESIGN.md, 4).
describe('#175: a cookie value without a name is hidden in later output', () => {
  it.each([
    [UNNAMED_COOKIE, 'Zq34Zq'],
    ['Cookie: Zq37Zq; path=/', 'Zq37Zq'],
    ['Set-Cookie: Zq38Zq; Path=/; HttpOnly; Secure', 'Zq38Zq'],
    ['set-cookie:Zq39Zq;Max-Age=60', 'Zq39Zq'],
    // R175-2: Base64 padding puts `=` into a value without a name.
    ['Cookie: Zq34Zq==; path=/', 'Zq34Zq=='],
    ['Set-Cookie: Zq40Zqab=cd; Path=/', 'Zq40Zqab=cd'],
  ])('%j', (source, secret) => {
    for (const [path, output] of [...Object.entries(shownOnItsOwn(source)), ...Object.entries(shownLater(source, `echoed ${secret}`))]) {
      for (const marker of markersIn(secret)) expect(output, path).not.toContain(marker);
    }
  });

  it('hides a named cookie value in the same place', () => {
    const source = NAMED_COOKIE;
    for (const output of Object.values(shownLater(source, 'echoed Zq36Zq'))) expect(output).not.toContain('Zq36Zq');
  });

  // Known over-masking (R175-2, case c): the first part is tracked whole, with or without `=`, so a
  // named cookie is hidden with its name where it is printed again.
  it('hides a named first cookie with its name where it is printed again', () => {
    const source = NAMED_COOKIE;
    for (const [path, output] of Object.entries(shownLater(source, 'echoed sid=Zq36Zq'))) {
      if (path === 'phase1') expect(output, path).toContain('echoed [REDACTED]');
      else expect(output, path).toBe('echoed [REDACTED]');
    }
  });

  // Over-masking bound: only the part before the first `;` is a value. The attributes after it are
  // not tracked, so later output naming them stays readable.
  it('keeps the cookie attributes readable in later output', () => {
    const source = 'Set-Cookie: Zq38Zq; Path=/; HttpOnly; Secure';
    const later = 'flags: HttpOnly Secure SameSite';
    for (const [path, output] of Object.entries(shownLater(source, later))) {
      if (path === 'phase1') expect(output, path).toContain(later);
      else expect(output, path).toBe(later);
    }
  });
});

// Design 9.5 and 11 (R9-8): `Bearer` right after a word character is not read as a bearer token
// by the previous display, the previous range path, the new display, phase 1 or the stream, so
// `Zq1Zq` leaks on every path. This leak predates #151; a follow-up PR (with #175) fixes it and
// turns these examples into "hidden". The stream-only leaks of the first PR (`Zq4Zq`, `Zq0Zq`) are
// closed by the second PR, so the stream paths leak exactly these.
const KNOWN_LEAKS_ON_EVERY_PATH: ReadonlyArray<{ input: string; later?: string; leaked: readonly string[] }> = [
  { input: PHASE1_COMPOSITION[0]!, leaked: ['Zq1Zq'] },
  { input: PHASE1_COMPOSITION[1]!, leaked: ['Zq1Zq'] },
];

describe('#151 known leak (since before #151): `Bearer` right after a word character', () => {
  it.each(PHASE1_COMPOSITION.map((input) => [input]))('%j shows Zq1Zq on every path', (input) => {
    for (const [path, output] of Object.entries(shownOnItsOwn(input))) expect(output, path).toContain('Zq1Zq');
    for (const [path, shown] of STREAM_PATHS) expect(shown([input]), path).toContain('Zq1Zq');
  });
});

// 14th edition, point 6 (design 9.5 and 11, R9-8): the stream-specific leaks of the first PR are
// closed on the stream paths by the second PR: `Zq4Zq` of #1 and `Zq0Zq` of #2, #3 and #4. `Zq1Zq`
// is not a stream leak: it leaks on every path since before #151 (a word character before `Bearer`),
// and it is fixed by a follow-up PR (#175, item 423). This test fixes that leak; it does not hide it.
describe('#151 2a: the stream paths close the first PR stream leaks and keep the Zq1Zq leak', () => {
  it.each([
    [LEAK_2[0]!, 'Zq4Zq'],
    [LEAK_2[1]!, 'Zq0Zq'],
    [PHASE1_COMPOSITION[0]!, 'Zq0Zq'],
    [PHASE1_COMPOSITION[1]!, 'Zq0Zq'],
  ])('%j hides %s on every stream path', (input, secret) => {
    for (const [path, shown] of STREAM_PATHS) expect(shown([input]), path).not.toContain(secret);
  });

  it.each(PHASE1_COMPOSITION.map((input) => [input]))('%j still shows Zq1Zq on every stream path', (input) => {
    for (const [path, shown] of STREAM_PATHS) expect(shown([input]), path).toContain('Zq1Zq');
  });
});

// Leaks since before #151 that the review of #165 found (#175). The previous implementation shows
// them as well; #175 closes them (takt-175 DESIGN.md, 1 and 2).
describe('#175: a URL password with a `,` right after an `@` is hidden to its last `@`', () => {
  // The display and the range path show exactly the URL with its userinfo hidden: the host stays.
  it.each([
    ['https://:Zq50Zq@,Zq51Zq@host', 'https://[REDACTED]@host'],
    ['https://u:Zq53Zq@,,Zq54Zq@host/repo.git', 'https://[REDACTED]@host/repo.git'],
    ['redis://:Zq55Zq@-,Zq56Zq@db:6379/0', 'redis://[REDACTED]@db:6379/0'],
    ['https://u:Zq57Zq@,Zq58Zq@,Zq59Zq@host', 'https://[REDACTED]@host'],
    ['clone https://u:Zq60Zq@x@,Zq61Zq@host failed', 'clone https://[REDACTED]@host failed'],
    // R175-1: once a `,` was skipped, later `,` before the next `@` do not end the URL either.
    ['https://:Zq50Zq@,Zq51Zq,Zq52Zq@host', 'https://[REDACTED]@host'],
    ['https://u:Zq69Zq@,Zq70Zq,Zq71Zq,@host', 'https://[REDACTED]@host'],
    ['https://u:Zq72Zq@,Zq73Zq;Zq74Zq,Zq75Zq@db:5432/x', 'https://[REDACTED]@db:5432/x'],
  ])('%j', (text, expected) => {
    expect(sanitizeSensitiveText(text)).toBe(expected);
    expect(maskSensitiveRanges(text, sensitiveTextRanges(text, new Set()))).toBe(expected);
    for (const [path, output] of Object.entries(shownOnItsOwn(text))) {
      for (const marker of markersIn(text)) expect(output, path).not.toContain(marker);
    }
  });

  it('hides the whole password where it is echoed later', () => {
    const source = 'https://:Zq50Zq@,Zq51Zq@host';
    for (const [path, output] of Object.entries(shownLater(source, 'echoed Zq50Zq@,Zq51Zq'))) {
      expect(output, path).not.toContain('Zq51Zq');
    }
  });

  // Over-masking bound: a `,` after a host still ends the URL, so a later address stays readable.
  it.each([
    'https://user:pass@host,admin@example.test',
    'https://u:p@h,admin@example.test',
    'https://u:p@1,admin@example.test',
    'https://u:p@x@host,admin@example.test',
    '["https://user:pass@host","admin@example.test"]',
    "['https://user:pass@host', 'admin@example.test']",
  ])('keeps the address after %j readable', (text) => {
    for (const [path, output] of Object.entries(shownOnItsOwn(text))) {
      expect(output, path).toContain('admin@example.test');
      expect(output, path).toContain('[REDACTED]');
    }
  });

  // R175-3: a host may be letters or digits of any script, as before #175.
  it.each([
    ['https://user:pass@例え,admin@example.test', 'https://[REDACTED]@例え,admin@example.test'],
    ['https://user:pass@bücher.test,admin@example.test', 'https://[REDACTED]@bücher.test,admin@example.test'],
    ['https://u:p@x@١٢٣,admin@example.test', 'https://[REDACTED]@١٢٣,admin@example.test'],
    ['https://user:pass@𠀀,admin@example.test', 'https://[REDACTED]@𠀀,admin@example.test'],
  ])('keeps the host and the address in %j', (text, expected) => {
    expect(sanitizeSensitiveText(text)).toBe(expected);
    expect(maskSensitiveRanges(text, sensitiveTextRanges(text, new Set()))).toBe(expected);
  });

  // Known leak, kept (open point 1): a `,` after letters or digits may follow a host, as in
  // `user:pass@host,admin@example.test`, so `@x,Zq77Zq@host` still shows its rest.
  it('still shows the rest after a `,` that follows letters or digits (known leak)', () => {
    expect(sanitizeSensitiveText('https://u:Zq76Zq@x,Zq77Zq@host')).toBe('https://[REDACTED]@x,Zq77Zq@host');
  });
});

describe('#175: a value between two keys inside one value is tracked on its own', () => {
  it.each([
    ['token=first;password=Zq52Zq;token=last', 'Zq52Zq'],
    ['TOKEN=a&password=Zq62Zq&token=z', 'Zq62Zq'],
    ['token=a|secret=Zq63Zq|api_key=z', 'Zq63Zq'],
    ['--token=first;--password=Zq64Zq;--token=last', 'Zq64Zq'],
    ['token=a;password=Zq65Zq;secret=Zq66Zq;token=z', 'Zq65Zq'],
    ['token=a;password=Zq65Zq;secret=Zq66Zq;token=z', 'Zq66Zq'],
  ])('%j then echoed %s', (source, secret) => {
    expect(sanitizeSensitiveText(source)).not.toContain(secret);
    for (const [path, output] of Object.entries(shownLater(source, `echoed ${secret}`))) {
      expect(output, path).not.toContain(secret);
    }
  });

  // Over-masking bound: what is tracked ends at the separator, so the next key is not a value.
  it('keeps later output that names the keys readable', () => {
    const source = 'token=first;password=Zq52Zq;token=last';
    const later = 'the token and password keys are set';
    for (const [path, output] of Object.entries(shownLater(source, later))) {
      if (path === 'phase1') expect(output, path).toContain(later);
      else expect(output, path).toBe(later);
    }
  });
});

// #151 design 9th edition, 11 #3 and #4 (open point 1, decided as (b)): `Bearer` right after a word
// character is not read, on every path, since before #151. #175 reads a capital `Bearer` there.
const GLUED_BEARER: ReadonlyArray<readonly [source: string, secret: string]> = [
  [PHASE1_COMPOSITION[0]!, 'Zq1Zqabcdefgh12'],
  [PHASE1_COMPOSITION[1]!, 'Zq1Zqabcdefgh12'],
  ['Zq0ZqBearer Zq1Zqabcdefgh12', 'Zq1Zqabcdefgh12'],
  // An escaped line break in serialized JSON puts an `n` right before the scheme.
  ['{"error":"401\\nBearer Zq67Zqabcdefgh12 rejected"}', 'Zq67Zqabcdefgh12'],
  ['headers=Accept\\tBearer Zq68Zqabcdefgh12', 'Zq68Zqabcdefgh12'],
];

describe('#175: a capital `Bearer` right after a word character is read', () => {
  it.each(GLUED_BEARER.map(([source, secret]) => [source, secret] as const))('%j', (source, secret) => {
    for (const [path, output] of [...Object.entries(shownOnItsOwn(source)), ...Object.entries(shownLater(source, `echoed ${secret}`))]) {
      for (const marker of markersIn(secret)) expect(output, path).not.toContain(marker);
    }
  });

  // Over-masking bound: a lowercase `bearer` inside a word stays prose, as do words without a digit.
  it.each([
    'the torchbearer 12345678 arrived',
    'pallbearer abc12345',
    'Bearer authentication is required',
    'useBearer authentication',
  ])('keeps %j readable', (text) => {
    expect(sanitizeSensitiveText(text)).toBe(text);
    expect(maskSensitiveRanges(text, sensitiveTextRanges(text, new Set()))).toBe(text);
  });
});

// Open point 6 (DECISIONS-after-review.md): the glued `Bearer` of #3 and #4 also shows through the
// stream, which is still the previous stream. #175 does not change the stream; this stays a known
// leak until the stream reads the new reading (second PR of #151), which turns it into "hidden".
describe('#175 known leak (stream): a capital `Bearer` right after a word character', () => {
  it.each(PHASE1_COMPOSITION.map((input) => [input]))('the stream shows Zq1Zq of %j', (input) => {
    expect(streamedAlone(input)).toContain('Zq1Zq');
  });
});

describe('#151 the stream paths (L-stream): the fixed examples leak only the known leaks on every path', () => {
  for (const [path, shown] of STREAM_PATHS) {
    it(path, () => {
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
        ...alone.map(({ input, secrets }) => ({ input, leaked: secrets.filter((secret) => shown([input]).includes(secret)) })),
        ...later.map(({ input, later: text, secrets }) => ({ input, later: text, leaked: secrets.filter((secret) => shown([input + '\n', text]).includes(secret)) })),
      ].filter((leak) => leak.leaked.length > 0);
      expect(leaks).toEqual(KNOWN_LEAKS_ON_EVERY_PATH);
    });
  }
});

describe('#151 4.3: a quoted option value is one shell word, up to a shell operator', () => {
  it.each([
    ['curl --password "Zq40Zq"&& next', 'curl --password [REDACTED]&& next'],
    ["run --token 'a'Zq41Zq; echo done", 'run --token [REDACTED]; echo done'],
  ])('%j', (input, expected) => {
    expect(sanitizeSensitiveText(input)).toBe(expected);
  });
});

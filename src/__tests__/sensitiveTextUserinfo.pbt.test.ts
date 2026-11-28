import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createSensitiveTextStreamRedactor, sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

// #2103: URL userinfo redaction must cover every user/password separator shape
// URL_USERINFO_CREDENTIALS_REGEX accepts, including a password that starts with
// a run of at signs and a URL that omits the user. These properties state the
// contract without any input filters: every generated input must satisfy them.
//
// Generated secrets are assembled from low-entropy parts at run time, so no
// fixture in this file reads like a real credential.

const REDACTED = '[REDACTED]';

const SECRET_PARTS = ['Zq', '24', '01', 'fake', 'FAKE'] as const;
const lowEntropySecret = (...parts: readonly string[]): string => parts.join('');

const display = (text: string): string => sanitizeSensitiveText(text);
const stream = (text: string): string => {
  const redactor = createSensitiveTextStreamRedactor();
  return redactor.write(text, {}) + redactor.flush({});
};

interface CredentialCase {
  readonly scheme: string;
  readonly user: string;
  readonly host: string;
  readonly secret: string;
  readonly url: string;
  readonly prefix: string;
  readonly suffix: string;
}

const secretArbitrary: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SECRET_PARTS), { minLength: 2, maxLength: 4 })
  .map((parts) => lowEntropySecret(...parts));
const schemeArbitrary = fc.constantFrom('https', 'http', 'redis', 'ftp', 'git+https', 'ssh', 'a');
const userArbitrary = fc.constantFrom('', 'u', 'user', 'alice');
const hostArbitrary = fc.constantFrom('host', 'example.test', '127.0.0.1', 'cache.local:6379');
const atRunArbitrary = fc.integer({ min: 0, max: 4 });
// Prefixes end with a non-key character (or the start of the text) so the scheme
// lookbehind sees a word boundary; suffixes never contain an at sign.
const prefixArbitrary = fc.constantFrom('', 'clone ', 'failed: ', '"', "'", '(');
const suffixArbitrary = fc.constantFrom('', ' failed', '/repo.git', '\n', ',next', ';ok', '"', ')');

const credentialArbitrary: fc.Arbitrary<CredentialCase> = fc
  .tuple(schemeArbitrary, userArbitrary, atRunArbitrary, secretArbitrary, hostArbitrary, prefixArbitrary, suffixArbitrary)
  .map(([scheme, user, atRun, secret, host, prefix, suffix]) => ({
    scheme,
    user,
    host,
    secret,
    url: `${scheme}://${user}:${'@'.repeat(atRun)}${secret}@${host}`,
    prefix,
    suffix,
  }));

const textOf = (credential: CredentialCase): string => credential.prefix + credential.url + credential.suffix;
const expectedOf = (credential: CredentialCase): string =>
  `${credential.prefix}${credential.scheme}://${REDACTED}@${credential.host}${credential.suffix}`;

describe('URL userinfo redaction properties', () => {
  it('property: a userinfo secret never reaches the displayed or streamed text', () => {
    fc.assert(
      fc.property(credentialArbitrary, (credential) => {
        const text = textOf(credential);
        expect(display(text)).not.toContain(credential.secret);
        expect(stream(text)).not.toContain(credential.secret);
        expect(display(text)).toContain(REDACTED);
      }),
      { numRuns: 200 },
    );
  });

  it('property: text without credentials comes back one character at a time unchanged', () => {
    // No at sign and no sensitive key word can appear in this alphabet, so no
    // rule other than the URL userinfo rule can fire. No generated input is
    // rejected; the property holds for every one of them.
    const neutralToken = fc.constantFrom(
      'zq', 'path', 'host', '8080', 'factory', 'cache', '/', ':', '.', '-', ' ', '?a=1', '&b=2', '_',
    );
    const neutralText = fc
      .tuple(fc.boolean(), fc.array(neutralToken, { maxLength: 16 }))
      .map(([hasScheme, tokens]) => (hasScheme ? 'https://' : '') + tokens.join(''));

    fc.assert(
      fc.property(neutralText, fc.nat(), (text, splitSeed) => {
        expect(display(text)).toBe(text);
        expect(stream(text)).toBe(text);

        const split = splitSeed % (text.length + 1);
        const redactor = createSensitiveTextStreamRedactor();
        const chunked = redactor.write(text.slice(0, split), {})
          + redactor.write(text.slice(split), {})
          + redactor.flush({});
        expect(chunked).toBe(text);
      }),
      { numRuns: 200 },
    );
  });

  it('property: redaction replaces exactly the userinfo span and no other character', () => {
    fc.assert(
      fc.property(credentialArbitrary, (credential) => {
        const text = textOf(credential);
        const expected = expectedOf(credential);
        expect(display(text)).toBe(expected);
        expect(stream(text)).toBe(expected);

        const head = `${credential.prefix}${credential.scheme}://`;
        const tail = `${credential.host}${credential.suffix}`;
        const output = display(text);
        expect(output.slice(0, head.length)).toBe(head);
        expect(output.slice(output.length - tail.length)).toBe(tail);
      }),
      { numRuns: 200 },
    );
  });

  it('property: quadrupling the input length stays within a constant factor of the time', () => {
    const shapeArbitrary = fc.constantFrom('at-run', 'colon-run', 'terminated-at-run', 'unterminated-at-run-tail');
    const sizeArbitrary = fc.integer({ min: 256, max: 2048 });
    const secret = lowEntropySecret('Zq', '24', 'Zq');

    const build = (shape: string, size: number): string => {
      switch (shape) {
        case 'at-run': return `https://u:${'@'.repeat(size)}`;
        case 'colon-run': return `https://u:${':'.repeat(size)}`;
        case 'terminated-at-run': return `https://u:${'@'.repeat(size)}${secret}@host`;
        default: return `https://u:${'@'.repeat(size)}${secret}`;
      }
    };
    const elapsed = (text: string): number => {
      const start = performance.now();
      display(text);
      return performance.now() - start;
    };
    // Take the fastest of three runs so a single scheduling hiccup does not
    // decide the property. The warm-up calls keep the regex engine and the JIT
    // out of the comparison.
    const fastest = (text: string): number => Math.min(elapsed(text), elapsed(text), elapsed(text));

    fc.assert(
      fc.property(shapeArbitrary, sizeArbitrary, (shape, size) => {
        display(build(shape, size));
        display(build(shape, size * 4));

        const small = fastest(build(shape, size));
        const large = fastest(build(shape, size * 4));
        // 0.5ms floor: below a millisecond the timer dominates the comparison.
        expect(large, `${shape} ${size} -> ${size * 4}`).toBeLessThan(Math.max(small, 0.5) * 12 + 5);
        expect(large, `${shape} ${size * 4}`).toBeLessThan(250);
      }),
      { numRuns: 40 },
    );
  });

  const linearSecret = lowEntropySecret('Zq', '24', 'Zq');
  it.each([
    ['an unterminated run of at signs', (bytes: number) => `https://u:${'@'.repeat(bytes)}`],
    ['a terminated run of at signs', (bytes: number) => `https://u:${'@'.repeat(bytes)}${linearSecret}@host`],
    ['a run of at signs before a non-at tail', (bytes: number) => `https://u:${'@'.repeat(bytes)}${linearSecret}`],
    ['a run of colons without an at sign', (bytes: number) => `https://u:${':'.repeat(bytes)}`],
  ])('sanitizes %s in linear time', (_name, build) => {
    const elapsed = (bytes: number): number => {
      const start = performance.now();
      display(build(bytes));
      return performance.now() - start;
    };
    elapsed(1024); // warm up regexes and JIT

    expect(elapsed(64 * 1024)).toBeLessThan(500);
    expect(elapsed(256 * 1024)).toBeLessThan(2000);
  });
});

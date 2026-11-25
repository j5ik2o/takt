import { describe, expect, it } from 'vitest';
import {
  createSensitiveTextStreamRedactor,
  MAX_TRACKED_SENSITIVE_SINGLE_VALUE_BYTES,
  sanitizeSensitiveText,
  sanitizeSensitiveTextWithKnownValues,
} from '../shared/utils/sensitiveText.js';

describe('sanitizeSensitiveText performance', () => {
  it('sanitizes a 64KiB uniform alphanumeric run without quadratic blowup', () => {
    // Command quality gates route up to 64KiB of command output through
    // sanitizeSensitiveText. A single uninterrupted [A-Za-z0-9_.-] run used to
    // trigger O(n^2) backtracking in the sensitive-key patterns (~4-5s for
    // this input); the linear-safe patterns finish in around a millisecond.
    // The 200ms budget leaves two orders of magnitude of headroom for slow
    // CI machines while still failing fast on any quadratic regression.
    const input = 'a1'.repeat(32 * 1024);
    sanitizeSensitiveText(input.slice(0, 1024)); // warm up regexes and JIT

    const start = performance.now();
    const sanitized = sanitizeSensitiveText(input);
    const elapsedMs = performance.now() - start;

    expect(sanitized).toBe(input);
    expect(elapsedMs).toBeLessThan(200);
  });

  // Each unit starts one of the credential patterns and never completes it. A pattern that
  // rescans the rest of the input from every start takes seconds here (the JSON web token
  // pattern took 15s at 256KiB before it was anchored to the start of a run).
  // The `<letters>-` units are scheme-like runs with no `://`: the URL userinfo pattern used to
  // restart at every letter after a `-` and rescan the rest of the run (8s at 256KiB).
  it.each([
    ['a scheme-like run of letters and hyphens', 'abc-'],
    ['an OpenAI key prefix in a hyphenated run', 'sk-'],
    ['a JSON web token prefix in a hyphenated run', 'eyJ-'],
    ['an AWS access key prefix in a hyphenated run', 'AKIA-'],
    ['a run of digits and hyphens', '1-'],
    ['a JSON web token prefix', 'eyJ_-'],
    ['a JSON web token with a missing part', 'eyJabcdefgh.eyJabcdefgh '],
    ['a bearer scheme', 'Bearer abc '],
    ['a bearer scheme without a value', 'bearer '],
    ['an escaped JSON key', String.raw`\"token\" `],
    ['an escaped JSON key without a value', String.raw`\"api_key\":`],
    ['a key query parameter', '?key'],
    ['a signature query parameter', '&x-amz-signature'],
    ['a Google API key prefix', 'AIza '],
    ['an AWS access key prefix', 'AKIA '],
    ['a GitHub token prefix', 'github_pat_ '],
    ['a GitLab token prefix', 'glpat- '],
    ['a Slack app token prefix', 'xapp- '],
  ])('stays linear on repeated %s', (_name, unit) => {
    const elapsed = (bytes: number): number => {
      const input = unit.repeat(Math.ceil(bytes / unit.length));
      const start = performance.now();
      sanitizeSensitiveText(input);
      return performance.now() - start;
    };
    elapsed(1024); // warm up regexes and JIT

    expect(elapsed(64 * 1024)).toBeLessThan(500);
    expect(elapsed(256 * 1024)).toBeLessThan(2000);
  });

  // One URL whose userinfo is a long run of separators. Trying every colon as the
  // user/password separator rescans the rest of the run each time (18s at 256KiB).
  it.each([
    ['colon-separated words without an @', 'https://', 'a:'],
    ['colons only without an @', 'https://', ':'],
    ['a password of @-separated words', 'https://user:pass', '@a'],
    ['a password of @ only', 'https://user:pass', '@'],
    ['a leading-@ password without a closing @', 'https://user:@', 'a'],
    ['a leading-@ password of @-separated words', 'https://user:', '@a'],
    ['a leading-@ password of @ only', 'https://user:@', '@'],
    ['a scheme behind a run of digits and hyphens', '', '1-'],
  ])('stays linear on a URL followed by %s', (_name, head, unit) => {
    const elapsed = (bytes: number): number => {
      const body = unit.repeat(Math.ceil(bytes / unit.length));
      const input = head === '' ? `${body}x://user:pass@host` : head + body;
      const start = performance.now();
      sanitizeSensitiveText(input);
      return performance.now() - start;
    };
    elapsed(1024); // warm up regexes and JIT

    expect(elapsed(64 * 1024)).toBeLessThan(500);
    expect(elapsed(256 * 1024)).toBeLessThan(2000);
  });
});

describe('sensitive text stream redactor performance', () => {
  // A long tracked value used to be matched against the end of each committed text by trying
  // every prefix of it, which is quadratic in its length.
  it.each([
    ['a URL whose password is a long run of @-separated words',
      (bytes: number) => ({ text: 'https://u:' + 'p@'.repeat(bytes / 2) + 'host\n', source: {} })],
    ['a long known value',
      (bytes: number) => ({ text: 'p@'.repeat(bytes / 2) + '\n', source: { token: 'p@'.repeat(bytes / 2) } })],
    ['a tracked 4KiB @-containing URL password echoed in long output',
      (bytes: number) => {
        const password = 'p@'.repeat(2 * 1024);
        const line = `https://u:${password}@host\n`;
        const pad = 'a@'.repeat(Math.max(1, Math.floor((bytes - line.length) / 2))) + '\n';
        return { text: line + pad, source: {} };
      }],
    ['a tracked max-sized known value against long output',
      (bytes: number) => {
        const value = 'p@'.repeat(MAX_TRACKED_SENSITIVE_SINGLE_VALUE_BYTES / 2 - 1) + 'X!';
        return {
          text: 'p@'.repeat(bytes / 2) + '\n',
          source: { token: value },
        };
      }],
  ])('stays linear on %s', (_name, input) => {
    const elapsed = (bytes: number): number => {
      const { text, source } = input(bytes);
      const start = performance.now();
      const redactor = createSensitiveTextStreamRedactor();
      redactor.write(text, source);
      redactor.flush(source);
      return performance.now() - start;
    };
    elapsed(1024); // warm up regexes and JIT

    expect(elapsed(64 * 1024)).toBeLessThan(500);
    expect(elapsed(256 * 1024)).toBeLessThan(2000);
  });

  it('keeps sanitizeSensitiveTextWithKnownValues linear on long @-containing URL passwords', () => {
    const elapsed = (bytes: number): number => {
      const url = 'https://u:' + 'p@'.repeat(bytes / 2) + 'host';
      const text = 'echoed ' + 'p@'.repeat(bytes / 2);
      const start = performance.now();
      sanitizeSensitiveTextWithKnownValues(text, { command: url });
      return performance.now() - start;
    };
    elapsed(1024); // warm up regexes and JIT

    expect(elapsed(64 * 1024)).toBeLessThan(500);
    expect(elapsed(256 * 1024)).toBeLessThan(2000);
  });
});

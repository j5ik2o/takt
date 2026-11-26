import { scaledMs } from '../../scripts/test-time-factor.mjs';
import { describe, expect, it } from 'vitest';
import { Phase1ExecutionLog } from '../core/workflow/phase1-execution-log.js';
import { sanitizeTextWithValues } from '../shared/utils/sensitive-text.js';
import {
  createSensitiveTextStreamRedactor,
  MAX_TRACKED_SENSITIVE_SINGLE_VALUE_BYTES,
  sanitizeSensitiveText,
  sanitizeSensitiveTextWithKnownValues,
} from '../shared/utils/sensitiveText.js';
import { trackedValuesOf } from './helpers/sensitive-text-tracked.js';
import { createLegacySensitiveTextStreamRedactor, type SensitiveTextStreamRedactorFactory } from '../shared/utils/sensitive-stream.js';

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

  it('keeps sanitizeSensitiveTextWithKnownValues linear on overlapping copies of a repetitive long URL password', () => {
    const elapsed = (bytes: number): number => {
      const password = 'x@'.repeat(bytes / 2);
      const url = `https://u:${password}@host`;
      const text = `echoed ${password.repeat(2)}`;
      const start = performance.now();
      const masked = sanitizeSensitiveTextWithKnownValues(text, { command: url });
      const duration = performance.now() - start;
      expect(masked).toBe('echoed [REDACTED]');
      return duration;
    };
    elapsed(1024); // warm up regexes and JIT

    expect(elapsed(64 * 1024)).toBeLessThan(500);
    expect(elapsed(256 * 1024)).toBeLessThan(2000);
  });

  it('keeps Phase1ExecutionLog linear on consecutive echoes of a repetitive long URL password', () => {
    const elapsed = (bytes: number): number => {
      const password = 'x@'.repeat(bytes / 2);
      const log = new Phase1ExecutionLog();
      log.recordEvent({ type: 'text', data: { text: `https://u:${password}@host\n` } });
      log.recordEvent({ type: 'text', data: { text: password.repeat(3) } });
      const start = performance.now();
      const output = log.toReportInput();
      const duration = performance.now() - start;
      expect(output).not.toContain('x@x@x@');
      return duration;
    };
    elapsed(1024); // warm up regexes and JIT

    expect(elapsed(64 * 1024)).toBeLessThan(500);
    expect(elapsed(256 * 1024)).toBeLessThan(2000);
  });
});

describe('redaction of overlapping credential forms stays linear', () => {
  // Every pattern restarts its scan at the start of the value it found, so keys inside values are
  // found too. Each shape below packs such keys (or near-keys) into one long run; 4x the input
  // must stay within a linear multiple of the time, and the whole pass within a fixed budget.
  // `TOKEN=a;a;…` took 2.2s at 1MiB in #160, and `;--user=alice` took 3.4s at 256KiB before.
  const median = (samples: number[]): number => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
  it.each([
    ['TOKEN=a;a;…', 'TOKEN=a', ';a'],
    ['colon-less --user= options', '', ';--user=alice'],
    ['URLs whose user is a key', '', 'https://token:p@host;'],
    ['assignments inside a value', '', 'token='],
    ['assignments across lines', '', 'token:\n'],
    ['-u options', '', '-u '],
    ['@ in a URL password', 'https://u:p', '@'],
    ['cookie assignments inside a value', '', 'cookie='],
    ['query keys inside a value', '', '?token='],
    ['option keys inside a value', '', '--password='],
    ['nested quoted assignments', '', `token="a password='b \\"`],
    ['escaped quotes in option values', '', '--password "x\\" '],
    ['quoted values holding assignments', '', 'credentials="note token=x end" '],
  ])('on %s', (_name, head, unit) => {
    const run = (bytes: number): number => {
      const text = head + unit.repeat(Math.ceil(bytes / unit.length));
      const start = performance.now();
      sanitizeTextWithValues(text, trackedValuesOf(text));
      sanitizeSensitiveText(text);
      return performance.now() - start;
    };
    run(4 * 1024); // warm up regexes and JIT
    const small = median([run(256 * 1024), run(256 * 1024), run(256 * 1024)]);
    const large = median([run(1024 * 1024), run(1024 * 1024), run(1024 * 1024)]);

    expect(large).toBeLessThan(Math.max(8 * small, 50));
    expect(large).toBeLessThan(5000);
  });
});

// #151: every path also runs the frozen copy of the previous implementation and the trace of its
// display (design 6). Each form is measured in five pairs of 1 MiB and 4 MiB, and the judgment is
// the ratio within a pair: a linear path is about 4 times slower at 4 MiB, a quadratic one 16
// times. The time limit at 4 MiB catches what the ratio cannot see: a path that becomes many times
// slower at every size. A path that never returns hangs the run instead: no check inside the test can stop it.
describe('the union with the previous redaction stays linear', () => {
  const median = (samples: number[]): number => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
  const fill = (unit: string, size: number): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  it.each([
    ['plain', 'lorem ipsum dolor '],
    ['at', '@'],
    ['schemes', 'http://'],
    ['urlList', 'https://u:p@h,'],
    ['tokenRun', 'token='],
    ['curlUser', '--user=a;'],
    ['cookieLines', 'Cookie: a=b; token:\n'],
    ['mixed', "TOKEN=apikey: ?token=' 'Zq4Zq https://cookie:p@host Cookie: sid=x\n"],
    ['l2', 'token :--password=\\" \\"Zq0Zq'],
    ['token lines', 'token:\n'],
    // Quoted assignments glued into one word share its end (review of #165, Devin).
    ['glued quoted assignments', 'token="a"'],
  ])('on %s', (name, unit) => {
    const run = (bytes: number): number => {
      const text = (name === 'at' ? 'https://u:' : '') + fill(unit, bytes);
      const start = performance.now();
      sanitizeTextWithValues(text, trackedValuesOf(text));
      sanitizeSensitiveText(text);
      return performance.now() - start;
    };
    run(16 * 1024);
    // Each pair runs back to back, so a load that slows the machine for a while slows both sizes.
    const pairs = Array.from({ length: 5 }, () => ({ small: run(1024 * 1024), large: run(4 * 1024 * 1024) }));
    const large = median(pairs.map((pair) => pair.large));
    const ratio = median(pairs.map((pair) => pair.large / pair.small));
    expect(ratio).toBeLessThan(6);
    expect(large).toBeLessThan(scaledMs(25_000));
  }, scaledMs(300_000));
});

// #151 2a (design 6 "the second PR's stream", R9-2, R9-7): A3's shape, a line only the new reading
// keeps open followed by long plain lines, written in 4 KiB chunks. The new stream reads its outer
// hold again at each previous boundary (at most 10,000 characters, five times), so it is slower than
// the inner-only stream by a constant, not by the input length. The tool paths read a preview after
// every write. The table goes to the PR body; past 4 times the inner-only stream at 256 KiB, the
// numbers go to the marshal before the merge (design 6).
describe('the second PR stream stays linear on A3 (write + flush, write + preview + flush)', () => {
  const median = (samples: number[]): number => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
  const a3 = (bytes: number): string[] => {
    const text = "--password=''a'\n" + ('p'.repeat(99) + '\n').repeat(Math.ceil(bytes / 100));
    return Array.from({ length: Math.ceil(text.length / 4096) }, (_, index) => text.slice(index * 4096, (index + 1) * 4096));
  };
  const streams: ReadonlyArray<readonly [name: string, create: SensitiveTextStreamRedactorFactory]> = [
    ['first PR (inner only)', createLegacySensitiveTextStreamRedactor],
    ['second PR', createSensitiveTextStreamRedactor],
  ];
  it.each([
    ['write + flush', false],
    ['write + preview + flush', true],
  ])('%s', (name, withPreview) => {
    const run = (create: SensitiveTextStreamRedactorFactory, bytes: number): number => {
      const chunks = a3(bytes);
      const start = performance.now();
      const redactor = create();
      for (const chunk of chunks) {
        redactor.write(chunk, undefined);
        if (withPreview) redactor.preview(undefined);
      }
      redactor.flush(undefined);
      return performance.now() - start;
    };
    const table: Record<string, Record<string, number>> = {};
    for (const [stream, create] of streams) {
      run(create, 16 * 1024);
      const sizes = { '16 KiB': 16 * 1024, '64 KiB': 64 * 1024, '256 KiB': 256 * 1024 };
      table[stream] = Object.fromEntries(Object.entries(sizes).map(([size, bytes]) => [size, Math.round(median([1, 2, 3].map(() => run(create, bytes))))]));
      const pairs = Array.from({ length: 5 }, () => ({ small: run(create, 64 * 1024), large: run(create, 256 * 1024) }));
      expect(median(pairs.map((pair) => pair.large / pair.small)), `${stream}: 256 KiB / 64 KiB`).toBeLessThan(6);
      expect(median(pairs.map((pair) => pair.large)), stream).toBeLessThan(scaledMs(20_000));
    }
    console.info(`#151 2a stream, A3 ${name} (ms, median of 3):`, JSON.stringify(table));
  }, scaledMs(300_000));
});

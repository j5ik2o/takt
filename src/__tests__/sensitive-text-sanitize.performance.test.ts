import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { scaledMs } from '../../scripts/test-time-factor.mjs';
import { Phase1ExecutionLog } from '../core/workflow/phase1-execution-log.js';
import { collectEmbeddedSensitiveValues } from '../shared/utils/sensitive-text.js';
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
    ['semicolon-delimited URLs whose username matches a sensitive key', 'https://token:p@host;'],
    ['semicolon-delimited colon-less curl --user= options', ';--user=alice'],
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
    ['repeated colon-less --user= options before a trailing @host', 'https://u:p@host', ';--user=alice'],
  ])('stays linear on a URL followed by %s', (_name, head, unit) => {
    const elapsed = (bytes: number): number => {
      const body = unit.repeat(Math.ceil(bytes / unit.length));
      const input = head === ''
        ? `${body}x://user:pass@host`
        : unit === ';--user=alice'
          ? `${head}${body}@host`
          : head + body;
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

describe('sanitizeSensitiveText scaling property-based test (fast-check)', () => {
  const perfNumRuns = (() => {
    const override = process.env.TAKT_PBT_PERF_NUM_RUNS;
    if (override !== undefined) {
      const parsed = Number.parseInt(override, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return process.env.CI ? 15 : 30;
  })();

  const perfUnitPieceArb = fc.constantFrom(
    'https://token:p@host',
    'https://:p@host',
    'https://u:@p@host',
    'https://token:p@host;TOKEN=left@RIGHT_SECRET',
    'CREDENTIALS="https://alice:pa55-word@host"',
    'TOKEN="https://user:pass@host"',
    'TOKEN=bare_secret_123',
    '["https://:443","ops@example.test"]',
    'Authorization: Bearer tok12345678',
    '--user=alice',
  );

  const perfUnitArb = fc.record({
    pieces: fc.array(perfUnitPieceArb, { minLength: 1, maxLength: 3 }),
    sep: fc.constantFrom(';', ',', '&', '|', ' ', '\n'),
  }).map(({ pieces, sep }) => `${pieces.join(sep)}${sep}`);

  function runOnce(input: string): void {
    sanitizeSensitiveText(input);
    const collected = new Set<string>();
    collectEmbeddedSensitiveValues(input, collected);
  }

  function medianBatchMs(input: string, repeats: number, samples = 3): number {
    const timings: number[] = [];
    for (let s = 0; s < samples; s += 1) {
      const start = performance.now();
      for (let r = 0; r < repeats; r += 1) {
        runOnce(input);
      }
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    return timings[Math.floor(timings.length / 2)]!;
  }

  // Property 5: 4x input length stays within a constant multiple of 4x runtime (no quadratic blowup)
  it(`Property 5 (linear scaling): 4x input length scales linearly without quadratic blowup (${perfNumRuns} runs)`, () => {
    const baseBytes = 32 * 1024;
    const quadBytes = baseBytes * 4;
    const minBaseBatchMs = 8;
    const maxBatchRepeats = 32;

    // Warm up JIT and regexes once before timing.
    const warmup = 'https://token:p@host;TOKEN=left@RIGHT_SECRET;'.repeat(64);
    runOnce(warmup);

    fc.assert(
      fc.property(perfUnitArb, (unit) => {
        const baseInput = unit.repeat(Math.ceil(baseBytes / unit.length)).slice(0, baseBytes);
        const quadInput = unit.repeat(Math.ceil(quadBytes / unit.length)).slice(0, quadBytes);

        // Calibrate batch repeat count so the base measurement stays well above timer noise
        // without masking quadratic blowups (e.g. 0.5ms -> 8ms = 16x) behind an artificial floor.
        let repeats = 1;
        let tBase = medianBatchMs(baseInput, repeats);
        while (tBase < minBaseBatchMs && repeats < maxBatchRepeats) {
          repeats *= 2;
          tBase = medianBatchMs(baseInput, repeats);
        }
        const tQuad = medianBatchMs(quadInput, repeats);

        // Linear scaling gives ~4x. Allow a 2.5x headroom (10x max) for CI jitter while
        // still failing quadratic regressions (~16x).
        expect(tQuad / tBase).toBeLessThanOrEqual(10);
        expect(tQuad / repeats).toBeLessThan(scaledMs(500));
      }),
      { numRuns: perfNumRuns },
    );
  });
});

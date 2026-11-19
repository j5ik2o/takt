import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('merge gate script', () => {
  it('passes its own test suite', { timeout: 120_000 }, () => {
    const script = fileURLToPath(new URL('../../tools/merge-gate/review_threads_gate_test.py', import.meta.url));
    const result = spawnSync('python3', [script], { encoding: 'utf8', timeout: 110_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout || result.stderr).toBe(0);
    expect(result.stdout).toContain('0 failed');
  });
});

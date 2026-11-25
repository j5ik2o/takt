import { defineConfig } from 'vitest/config';
import { e2eBaseTestConfig } from './vitest.config.e2e.base';
import { scaledMs } from './scripts/test-time-factor.mjs';

export default defineConfig({
  test: {
    ...e2eBaseTestConfig,
    reporters: ['verbose'],
    include: ['e2e/specs/opencode-parallel-sessions.e2e.ts'],
    testTimeout: scaledMs(480000),
    hookTimeout: scaledMs(120000),
  },
});

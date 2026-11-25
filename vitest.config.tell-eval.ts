import { defineConfig } from 'vitest/config';
import { scaledMs } from './scripts/test-time-factor.mjs';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['eval/scenarios/tell/**/*.test.ts'],
    reporters: ['verbose'],
    testTimeout: scaledMs(300_000),
    teardownTimeout: scaledMs(5_000),
  },
});

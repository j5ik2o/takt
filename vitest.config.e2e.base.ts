import type { TestUserConfig } from 'vitest/config';
import { scaledMs } from './scripts/test-time-factor.mjs';

export const e2eBaseTestConfig: TestUserConfig = {
  environment: 'node',
  globals: false,
  testTimeout: scaledMs(240000),
  hookTimeout: scaledMs(60000),
  teardownTimeout: scaledMs(30000),
  forceExit: true,
  pool: 'threads',
  maxWorkers: 1,
  reporters: ['verbose', 'json'],
};

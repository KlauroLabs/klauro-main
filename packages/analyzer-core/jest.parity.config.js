/**
 * Dedicated jest config for the full-corpus parity harnesses under
 * `src/__tests__/parity/`, which the default config ignores because a
 * differential over every `.ts`/`.tsx` file in the repo is minutes of work and
 * has no place in the inner loop. Kept as a separate config (rather than a
 * `--testPathIgnorePatterns` override) so the gate command is unambiguous and
 * the exclusion in the default config cannot be accidentally cancelled.
 */
const base = require('./jest.config.js');

module.exports = {
  ...base,
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/dist/',
    '<rootDir>/coverage/',
  ],
  testMatch: ['**/__tests__/parity/**/*.test.ts'],
  testTimeout: 30 * 60 * 1000,
  maxWorkers: 1,
};

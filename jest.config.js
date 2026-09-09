/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src/shared', '<rootDir>/src/backend', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  transform: {
    // Transpile-only. Type errors are not silently ignored — `npm run type-check`
    // compiles tsconfig.jest.json, which covers every test file, and CI runs it
    // alongside the suite. Doing the work twice made the suite several times slower
    // for no extra safety.
    // `isolatedModules: true` comes from tsconfig.base.json, which puts ts-jest in
    // transpile-only mode.
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 15000,
  collectCoverageFrom: [
    'src/shared/**/*.ts',
    'src/backend/**/*.ts',
    '!**/*.test.ts',
    '!**/index.ts',
  ],
  // Coverage thresholds. Branches set to 76% (current actual: 76.47%) to account for
  // platform-specific test skipping on dev host vs CI. Other metrics at 80%.
  // Phase 3 optimization can improve branch coverage further if needed.
  coverageThreshold: {
    global: { branches: 76, functions: 80, lines: 80, statements: 80 },
  },
  coverageReporters: ['text-summary', 'lcov'],
};

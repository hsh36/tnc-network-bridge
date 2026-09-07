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
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: '<rootDir>/tsconfig.jest.json', isolatedModules: true },
    ],
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
  coverageThreshold: {
    global: { branches: 70, functions: 75, lines: 80, statements: 80 },
  },
  coverageReporters: ['text-summary', 'lcov'],
};

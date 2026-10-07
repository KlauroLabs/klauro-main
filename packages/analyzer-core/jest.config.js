// Jest configuration for Klauro Backend
// Production-ready test configuration with comprehensive coverage

module.exports = {
  // Use ts-jest preset for TypeScript support
  preset: 'ts-jest',
  
  // Test environment
  testEnvironment: 'node',
  
  // Root directories for tests and source code
  roots: ['<rootDir>/src'],
  
  // Test file patterns
  testMatch: [
    '**/__tests__/**/*.test.ts'
  ],
  
  // File extensions to consider
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  
  // Transform TypeScript files
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { isolatedModules: true } }]
  },
  
  // Coverage configuration
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/__tests__/**/*',
    '!src/index.ts', // Entry point
    '!src/types/**/*' // Type definitions
  ],
  
  // Coverage thresholds
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 75,
      lines: 75,
      statements: 75
    }
  },
  
  // Coverage reporters
  coverageReporters: [
    'text',
    'text-summary',
    'html',
    'lcov',
    'clover'
  ],
  
  // Coverage output directory
  coverageDirectory: 'coverage',
  
  // Setup files
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  
  // Module name mapping for path aliases
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@analyzer/(.*)$': '<rootDir>/src/analyzer/$1',
    '^@types/(.*)$': '<rootDir>/src/types/$1'
  },
  
  // Clear mocks between tests
  clearMocks: true,
  
  // Restore mocks after each test
  restoreMocks: true,
  
  // Test timeout (30 seconds for integration tests)
  testTimeout: 30000,
  
  // Verbose output for debugging
  verbose: false,
  
  // Error handling
  errorOnDeprecated: true,
  
  // Detect open handles (useful for finding async issues)
  detectOpenHandles: true,
  
  // Force exit after tests complete
  forceExit: false,
  
  // Global setup: verifies the native tree-sitter addon can load in this
  // Node runtime BEFORE any test file executes, and aborts the whole run
  // with one unmissable diagnostic if it can't — see globalSetup.ts for why.
  globalSetup: '<rootDir>/src/__tests__/globalSetup.ts',
  // globalTeardown: '<rootDir>/src/__tests__/globalTeardown.ts',
  
  // Test result processor for custom formatting
  // testResultsProcessor: '<rootDir>/src/__tests__/testResultsProcessor.js',
  
  // Maximum number of workers
  maxWorkers: '50%',
  
  // Cache directory
  cacheDirectory: require('path').join(require('os').tmpdir(), 'klauro-jest-cache'),
  
  // Ignore patterns
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/dist/',
    '<rootDir>/coverage/'
  ],
  
  // Transform ignore patterns
  transformIgnorePatterns: [
    'node_modules/(?!(glob)/)'
  ]
};

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
    '^.+\\.ts$': 'ts-jest'
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
    },
    // Higher thresholds for core analyzer components
    'src/analyzer/base-analyzer.ts': {
      branches: 80,
      functions: 85,
      lines: 85,
      statements: 85
    },
    'src/analyzer/language-detector.ts': {
      branches: 75,
      functions: 80,
      lines: 80,
      statements: 80
    },
    'src/analyzer/plugin-registry.ts': {
      branches: 75,
      functions: 80,
      lines: 80,
      statements: 80
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
  
  // Global setup and teardown
  // globalSetup: '<rootDir>/src/__tests__/globalSetup.ts',
  // globalTeardown: '<rootDir>/src/__tests__/globalTeardown.ts',
  
  // Test result processor for custom formatting
  // testResultsProcessor: '<rootDir>/src/__tests__/testResultsProcessor.js',
  
  // Maximum number of workers
  maxWorkers: '50%',
  
  // Cache directory
  cacheDirectory: '<rootDir>/node_modules/.cache/jest',
  
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

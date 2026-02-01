// Test setup file for Rust analyzer tests
import { RustAnalyzer } from '../../analyzer/languages/rust-analyzer';
import { AnalysisContext } from '../../types/cas.types';

// Mock file system utilities for testing
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    access: jest.fn(),
    writeFile: jest.fn(),
    readdir: jest.fn()
  },
  existsSync: jest.fn()
}));

// Mock glob utility
jest.mock('glob', () => jest.fn());

// Global test utilities
declare global {
  const testContext: {
    projectPath: string;
    analyzer: RustAnalyzer;
  };
}

beforeEach(() => {
  // Set up test context
  global.testContext = {
    projectPath: '/test/project',
    analyzer: new RustAnalyzer()
  };
});
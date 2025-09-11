// Jest test setup configuration
// Global setup for all test files

import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

// Extend Jest matchers
import 'jest-extended';

// Global test configuration
const TEST_TIMEOUT = 30000;
jest.setTimeout(TEST_TIMEOUT);

// Mock console methods in tests to reduce noise
const originalConsole = global.console;

// Store original methods
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const originalDebug = console.debug;

// Global setup before all tests
beforeAll(async () => {
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error'; // Reduce log noise in tests
  
  // Create temporary directory for tests
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unravl-test-'));
  (global as any).TEST_TEMP_DIR = tempDir;
  
  // Suppress console output in tests (can be overridden per test)
  if (!process.env.VERBOSE_TESTS) {
    global.console = {
      ...originalConsole,
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
  }
  
  console.log('🧪 Test environment initialized');
});

// Global cleanup after all tests
afterAll(async () => {
  // Restore console
  global.console = originalConsole;
  
  // Cleanup temporary directory
  const tempDir = (global as any).TEST_TEMP_DIR;
  if (tempDir && await fs.pathExists(tempDir)) {
    await fs.remove(tempDir);
  }
  
  console.log('🧹 Test environment cleaned up');
});

// Setup before each test
beforeEach(() => {
  // Clear all mocks
  jest.clearAllMocks();
  
  // Reset any global state if needed
});

// Cleanup after each test
afterEach(() => {
  // Restore any mocked modules
  jest.restoreAllMocks();
});

// Utility functions for tests
(global as any).testUtils = {
  // Create a temporary directory for a test
  createTempDir: async (prefix: string = 'test'): Promise<string> => {
    return await fs.mkdtemp(path.join(os.tmpdir(), `unravl-${prefix}-`));
  },
  
  // Clean up a temporary directory
  cleanupTempDir: async (dir: string): Promise<void> => {
    if (await fs.pathExists(dir)) {
      await fs.remove(dir);
    }
  },
  
  // Create a test project structure
  createTestProject: async (dir: string, structure: Record<string, string | object>): Promise<void> => {
    for (const [filePath, content] of Object.entries(structure)) {
      const fullPath = path.join(dir, filePath);
      const dirname = path.dirname(fullPath);
      
      await fs.ensureDir(dirname);
      
      if (typeof content === 'string') {
        await fs.writeFile(fullPath, content);
      } else {
        await fs.writeJson(fullPath, content);
      }
    }
  },
  
  // Wait for a condition to be true
  waitFor: async (
    condition: () => boolean | Promise<boolean>,
    timeout: number = 5000,
    interval: number = 100
  ): Promise<void> => {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      if (await condition()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    
    throw new Error(`Condition not met within ${timeout}ms`);
  },
  
  // Suppress console output for a test
  suppressConsole: () => {
    global.console = {
      ...originalConsole,
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
  },
  
  // Restore console output
  restoreConsole: () => {
    global.console = originalConsole;
  },
  
  // Mock filesystem operations
  mockFs: {
    pathExists: jest.fn().mockResolvedValue(true),
    readFile: jest.fn().mockResolvedValue(''),
    writeFile: jest.fn().mockResolvedValue(undefined),
    readJson: jest.fn().mockResolvedValue({}),
    writeJson: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined)
  }
};

// Custom Jest matchers
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeValidAnalyzerResult(): R;
      toHaveValidBlueprint(): R;
      toContainComponent(componentId: string): R;
      toHaveConnection(from: string, to: string): R;
    }
  }
}

// Implement custom matchers
expect.extend({
  toBeValidAnalyzerResult(received: any) {
    const pass = (
      received &&
      typeof received === 'object' &&
      'projectName' in received &&
      'framework' in received &&
      'components' in received &&
      'connections' in received &&
      Array.isArray(received.components) &&
      Array.isArray(received.connections)
    );

    if (pass) {
      return {
        message: () => `Expected not to be a valid analyzer result`,
        pass: true,
      };
    } else {
      return {
        message: () => `Expected to be a valid analyzer result with projectName, framework, components, and connections`,
        pass: false,
      };
    }
  },

  toHaveValidBlueprint(received: any) {
    const pass = (
      received &&
      typeof received === 'object' &&
      'entryPoints' in received &&
      'exitPoints' in received &&
      'riskAreas' in received &&
      'metadata' in received &&
      Array.isArray(received.entryPoints) &&
      Array.isArray(received.exitPoints) &&
      Array.isArray(received.riskAreas)
    );

    if (pass) {
      return {
        message: () => `Expected not to have a valid blueprint`,
        pass: true,
      };
    } else {
      return {
        message: () => `Expected to have a valid blueprint with entryPoints, exitPoints, riskAreas, and metadata`,
        pass: false,
      };
    }
  },

  toContainComponent(received: any, componentId: string) {
    if (!received || !Array.isArray(received.components)) {
      return {
        message: () => `Expected to have components array`,
        pass: false,
      };
    }

    const pass = received.components.some((component: any) => component.id === componentId);

    if (pass) {
      return {
        message: () => `Expected not to contain component ${componentId}`,
        pass: true,
      };
    } else {
      return {
        message: () => `Expected to contain component ${componentId}`,
        pass: false,
      };
    }
  },

  toHaveConnection(received: any, from: string, to: string) {
    if (!received || !Array.isArray(received.connections)) {
      return {
        message: () => `Expected to have connections array`,
        pass: false,
      };
    }

    const pass = received.connections.some((connection: any) => 
      connection.from === from && connection.to === to
    );

    if (pass) {
      return {
        message: () => `Expected not to have connection from ${from} to ${to}`,
        pass: true,
      };
    } else {
      return {
        message: () => `Expected to have connection from ${from} to ${to}`,
        pass: false,
      };
    }
  }
});

// Error handler for unhandled promise rejections in tests
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit in tests, just log the error
});

// Memory leak detection
let initialMemoryUsage: NodeJS.MemoryUsage;

beforeAll(() => {
  initialMemoryUsage = process.memoryUsage();
});

afterAll(() => {
  if (process.env.CHECK_MEMORY_LEAKS) {
    const finalMemoryUsage = process.memoryUsage();
    const heapIncrease = finalMemoryUsage.heapUsed - initialMemoryUsage.heapUsed;
    
    // Warn if heap usage increased by more than 50MB
    if (heapIncrease > 50 * 1024 * 1024) {
      console.warn(`⚠️  Memory usage increased by ${Math.round(heapIncrease / 1024 / 1024)}MB during tests`);
    }
  }
});

export {};
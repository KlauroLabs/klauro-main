"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs-extra"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
require("jest-extended");
const TEST_TIMEOUT = 30000;
jest.setTimeout(TEST_TIMEOUT);
const originalConsole = global.console;
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const originalDebug = console.debug;
beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'error';
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unravl-test-'));
    global.TEST_TEMP_DIR = tempDir;
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
afterAll(async () => {
    global.console = originalConsole;
    const tempDir = global.TEST_TEMP_DIR;
    if (tempDir && await fs.pathExists(tempDir)) {
        await fs.remove(tempDir);
    }
    console.log('🧹 Test environment cleaned up');
});
beforeEach(() => {
    jest.clearAllMocks();
});
afterEach(() => {
    jest.restoreAllMocks();
});
global.testUtils = {
    createTempDir: async (prefix = 'test') => {
        return await fs.mkdtemp(path.join(os.tmpdir(), `unravl-${prefix}-`));
    },
    cleanupTempDir: async (dir) => {
        if (await fs.pathExists(dir)) {
            await fs.remove(dir);
        }
    },
    createTestProject: async (dir, structure) => {
        for (const [filePath, content] of Object.entries(structure)) {
            const fullPath = path.join(dir, filePath);
            const dirname = path.dirname(fullPath);
            await fs.ensureDir(dirname);
            if (typeof content === 'string') {
                await fs.writeFile(fullPath, content);
            }
            else {
                await fs.writeJson(fullPath, content);
            }
        }
    },
    waitFor: async (condition, timeout = 5000, interval = 100) => {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            if (await condition()) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, interval));
        }
        throw new Error(`Condition not met within ${timeout}ms`);
    },
    suppressConsole: () => {
        global.console = {
            ...originalConsole,
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        };
    },
    restoreConsole: () => {
        global.console = originalConsole;
    },
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
expect.extend({
    toBeValidAnalyzerResult(received) {
        const pass = (received &&
            typeof received === 'object' &&
            'projectName' in received &&
            'framework' in received &&
            'components' in received &&
            'connections' in received &&
            Array.isArray(received.components) &&
            Array.isArray(received.connections));
        if (pass) {
            return {
                message: () => `Expected not to be a valid analyzer result`,
                pass: true,
            };
        }
        else {
            return {
                message: () => `Expected to be a valid analyzer result with projectName, framework, components, and connections`,
                pass: false,
            };
        }
    },
    toHaveValidBlueprint(received) {
        const pass = (received &&
            typeof received === 'object' &&
            'entryPoints' in received &&
            'exitPoints' in received &&
            'riskAreas' in received &&
            'metadata' in received &&
            Array.isArray(received.entryPoints) &&
            Array.isArray(received.exitPoints) &&
            Array.isArray(received.riskAreas));
        if (pass) {
            return {
                message: () => `Expected not to have a valid blueprint`,
                pass: true,
            };
        }
        else {
            return {
                message: () => `Expected to have a valid blueprint with entryPoints, exitPoints, riskAreas, and metadata`,
                pass: false,
            };
        }
    },
    toContainComponent(received, componentId) {
        if (!received || !Array.isArray(received.components)) {
            return {
                message: () => `Expected to have components array`,
                pass: false,
            };
        }
        const pass = received.components.some((component) => component.id === componentId);
        if (pass) {
            return {
                message: () => `Expected not to contain component ${componentId}`,
                pass: true,
            };
        }
        else {
            return {
                message: () => `Expected to contain component ${componentId}`,
                pass: false,
            };
        }
    },
    toHaveConnection(received, from, to) {
        if (!received || !Array.isArray(received.connections)) {
            return {
                message: () => `Expected to have connections array`,
                pass: false,
            };
        }
        const pass = received.connections.some((connection) => connection.from === from && connection.to === to);
        if (pass) {
            return {
                message: () => `Expected not to have connection from ${from} to ${to}`,
                pass: true,
            };
        }
        else {
            return {
                message: () => `Expected to have connection from ${from} to ${to}`,
                pass: false,
            };
        }
    }
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
let initialMemoryUsage;
beforeAll(() => {
    initialMemoryUsage = process.memoryUsage();
});
afterAll(() => {
    if (process.env.CHECK_MEMORY_LEAKS) {
        const finalMemoryUsage = process.memoryUsage();
        const heapIncrease = finalMemoryUsage.heapUsed - initialMemoryUsage.heapUsed;
        if (heapIncrease > 50 * 1024 * 1024) {
            console.warn(`⚠️  Memory usage increased by ${Math.round(heapIncrease / 1024 / 1024)}MB during tests`);
        }
    }
});

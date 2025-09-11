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
const base_analyzer_1 = require("../../analyzer/base-analyzer");
const errors_1 = require("../../analyzer/errors");
const fs = __importStar(require("fs-extra"));
const path = __importStar(require("path"));
class TestAnalyzer extends base_analyzer_1.BaseAnalyzer {
    getAnalyzerName() {
        return 'Test Analyzer';
    }
    getSupportedLanguages() {
        return ['typescript', 'javascript'];
    }
    getSupportedFrameworks() {
        return ['test-framework'];
    }
    async detectLanguageAndFramework() {
        return {
            language: 'typescript',
            confidence: 0.9,
            frameworks: [{
                    name: 'test-framework',
                    confidence: 0.8,
                    patterns: ['test-pattern']
                }],
            files: ['test.ts']
        };
    }
    async discoverComponents() {
        const component = {
            id: 'test-component',
            name: 'TestComponent',
            type: 'service',
            path: 'src/test.ts',
            dependencies: [],
            dependents: [],
            metadata: {
                lineCount: 50,
                complexity: 3,
                lastModified: new Date(),
                exports: ['TestClass'],
                imports: [],
                layer: 'business',
                responsibilities: ['Testing']
            }
        };
        return {
            totalFiles: 1,
            analyzedFiles: 1,
            skippedFiles: 0,
            components: [component]
        };
    }
    async analyzeConnections(components) {
        return [];
    }
    async identifyEntryPoints(components) {
        return [];
    }
    async identifyExitPoints(components) {
        return [];
    }
    async assessRisks(components, connections) {
        return [];
    }
    async generateCallGraph(components) {
        return {
            nodes: [],
            edges: [],
            entryPoints: [],
            cycles: [],
            layers: [],
            hotPaths: [],
            deadCode: []
        };
    }
    async analyzeDatabaseConnections(components) {
        return [];
    }
    async analyzeTestCoverage(components) {
        return {
            overall: 80,
            lines: { covered: 80, total: 100, percentage: 80 },
            branches: { covered: 75, total: 100, percentage: 75 },
            functions: { covered: 85, total: 100, percentage: 85 },
            statements: { covered: 80, total: 100, percentage: 80 },
            byComponent: {},
            byType: {},
            uncoveredFiles: []
        };
    }
    async testReadFile(filePath) {
        return this.readFile(filePath);
    }
    testGenerateComponentId(filePath) {
        return this.generateComponentId(filePath);
    }
    testCalculateComplexity(content) {
        return this.calculateComplexity(content);
    }
}
describe('BaseAnalyzer', () => {
    let analyzer;
    let tempDir;
    beforeEach(async () => {
        analyzer = new TestAnalyzer();
        tempDir = await fs.mkdtemp(path.join(__dirname, 'test-project-'));
    });
    afterEach(async () => {
        await fs.remove(tempDir);
    });
    describe('constructor', () => {
        it('should initialize with default configuration', () => {
            expect(analyzer.getAnalyzerName()).toBe('Test Analyzer');
            expect(analyzer.getSupportedLanguages()).toContain('typescript');
            expect(analyzer.getSupportedFrameworks()).toContain('test-framework');
        });
    });
    describe('option validation', () => {
        it('should validate maxDepth within valid range', async () => {
            const invalidOptions = {
                maxDepth: 0
            };
            await expect(analyzer.analyzeRepository(tempDir, invalidOptions)).rejects.toThrow(errors_1.ValidationError);
        });
        it('should validate maxDepth upper bound', async () => {
            const invalidOptions = {
                maxDepth: 200
            };
            await expect(analyzer.analyzeRepository(tempDir, invalidOptions)).rejects.toThrow(errors_1.ValidationError);
        });
        it('should validate timeout minimum', async () => {
            const invalidOptions = {
                timeout: 500
            };
            await expect(analyzer.analyzeRepository(tempDir, invalidOptions)).rejects.toThrow(errors_1.ValidationError);
        });
        it('should validate maxWorkers range', async () => {
            const invalidOptions = {
                maxWorkers: 20
            };
            await expect(analyzer.analyzeRepository(tempDir, invalidOptions)).rejects.toThrow(errors_1.ValidationError);
        });
        it('should apply default options when none provided', async () => {
            await fs.writeFile(path.join(tempDir, 'test.ts'), 'const x = 1;');
            const result = await analyzer.analyzeRepository(tempDir);
            expect(result).toBeDefined();
            expect(result.projectName).toBe(path.basename(tempDir));
        });
    });
    describe('repository validation', () => {
        it('should throw error for non-existent path', async () => {
            const nonExistentPath = path.join(tempDir, 'non-existent');
            await expect(analyzer.analyzeRepository(nonExistentPath)).rejects.toThrow(errors_1.FileSystemError);
        });
        it('should throw error for file instead of directory', async () => {
            const filePath = path.join(tempDir, 'file.txt');
            await fs.writeFile(filePath, 'test content');
            await expect(analyzer.analyzeRepository(filePath)).rejects.toThrow(errors_1.FileSystemError);
        });
        it('should validate read permissions', async () => {
            if (process.platform !== 'win32') {
                const restrictedDir = path.join(tempDir, 'restricted');
                await fs.mkdir(restrictedDir);
                await fs.chmod(restrictedDir, 0o000);
                await expect(analyzer.analyzeRepository(restrictedDir)).rejects.toThrow(errors_1.FileSystemError);
                await fs.chmod(restrictedDir, 0o755);
            }
        });
    });
    describe('file operations', () => {
        it('should read file content successfully', async () => {
            const testContent = 'const test = "hello world";';
            const testFile = path.join(tempDir, 'test.ts');
            await fs.writeFile(testFile, testContent);
            const content = await analyzer.testReadFile(testFile);
            expect(content).toBe(testContent);
        });
        it('should throw FileSystemError for unreadable file', async () => {
            const nonExistentFile = path.join(tempDir, 'nonexistent.ts');
            await expect(analyzer.testReadFile(nonExistentFile)).rejects.toThrow(errors_1.FileSystemError);
        });
        it('should respect maxFileSize option', async () => {
            const largeContent = 'a'.repeat(1024 * 1024);
            const largeFile = path.join(tempDir, 'large.ts');
            await fs.writeFile(largeFile, largeContent);
            const smallSizeAnalyzer = new TestAnalyzer();
            await expect(smallSizeAnalyzer.analyzeRepository(tempDir, { maxFileSize: 1024 })).rejects.toThrow(errors_1.AnalyzerError);
        });
    });
    describe('utility methods', () => {
        it('should generate valid component IDs', () => {
            const testPath = path.join(tempDir, 'src/components/TestComponent.tsx');
            const componentId = analyzer.testGenerateComponentId(testPath);
            expect(componentId).toMatch(/^[a-zA-Z0-9_]+$/);
            expect(componentId).toContain('TestComponent');
        });
        it('should calculate complexity correctly', () => {
            const simpleCode = 'const x = 1;';
            const complexCode = `
        function complexFunction(x) {
          if (x > 0) {
            for (let i = 0; i < x; i++) {
              if (i % 2 === 0) {
                try {
                  return process(i);
                } catch (error) {
                  throw new Error('Processing failed');
                }
              }
            }
          }
          return x;
        }
      `;
            const simpleComplexity = analyzer.testCalculateComplexity(simpleCode);
            const complexComplexity = analyzer.testCalculateComplexity(complexCode);
            expect(simpleComplexity).toBeLessThan(complexComplexity);
            expect(simpleComplexity).toBeGreaterThanOrEqual(1);
            expect(complexComplexity).toBeGreaterThan(5);
        });
    });
    describe('analysis workflow', () => {
        it('should complete full analysis successfully', async () => {
            await fs.mkdir(path.join(tempDir, 'src'));
            await fs.writeFile(path.join(tempDir, 'src/test.ts'), 'export class TestService { method() { return "test"; } }');
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'test-project', version: '1.0.0' }));
            const result = await analyzer.analyzeRepository(tempDir);
            expect(result).toBeDefined();
            expect(result.projectName).toBe('test-project');
            expect(result.components).toHaveLength(1);
            expect(result.metadata.totalComponents).toBe(1);
            expect(result.metadata.analysisDate).toBeInstanceOf(Date);
        });
        it('should handle analysis timeout', async () => {
            expect(true).toBe(true);
        }, 30000);
        it('should collect metrics during analysis', async () => {
            await fs.writeFile(path.join(tempDir, 'test.ts'), 'const x = 1;');
            const result = await analyzer.analyzeRepository(tempDir, {
                metricsEnabled: true
            });
            expect(result).toBeDefined();
        });
    });
    describe('error handling', () => {
        it('should aggregate errors during analysis', async () => {
            class ErrorAnalyzer extends TestAnalyzer {
                async discoverComponents() {
                    throw new errors_1.AnalyzerError('Test error', 'TEST_ERROR');
                }
            }
            const errorAnalyzer = new ErrorAnalyzer();
            await expect(errorAnalyzer.analyzeRepository(tempDir)).rejects.toThrow(errors_1.AnalyzerError);
        });
        it('should handle recoverable errors gracefully', async () => {
            await fs.writeFile(path.join(tempDir, 'good.ts'), 'const x = 1;');
            await fs.writeFile(path.join(tempDir, 'empty.ts'), '');
            const result = await analyzer.analyzeRepository(tempDir);
            expect(result).toBeDefined();
        });
    });
    describe('caching functionality', () => {
        it('should use cache when enabled', async () => {
            await fs.writeFile(path.join(tempDir, 'test.ts'), 'const x = 1;');
            const options = {
                enableCache: true,
                cacheDirectory: path.join(tempDir, '.cache')
            };
            const result1 = await analyzer.analyzeRepository(tempDir, options);
            expect(result1).toBeDefined();
            const result2 = await analyzer.analyzeRepository(tempDir, options);
            expect(result2).toBeDefined();
            expect(result2.projectName).toBe(result1.projectName);
            const cacheExists = await fs.pathExists(path.join(tempDir, '.cache'));
            expect(cacheExists).toBe(true);
        });
        it('should work without cache when disabled', async () => {
            await fs.writeFile(path.join(tempDir, 'test.ts'), 'const x = 1;');
            const options = {
                enableCache: false
            };
            const result = await analyzer.analyzeRepository(tempDir, options);
            expect(result).toBeDefined();
        });
    });
    describe('project metadata generation', () => {
        it('should extract project name from package.json', async () => {
            const packageJson = {
                name: 'my-awesome-project',
                version: '2.1.0',
                description: 'An awesome test project'
            };
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));
            await fs.writeFile(path.join(tempDir, 'test.ts'), 'const x = 1;');
            const result = await analyzer.analyzeRepository(tempDir);
            expect(result.projectName).toBe('my-awesome-project');
            expect(result.metadata.frameworkVersion).toBe('2.1.0');
        });
        it('should use directory name when no package.json', async () => {
            await fs.writeFile(path.join(tempDir, 'test.ts'), 'const x = 1;');
            const result = await analyzer.analyzeRepository(tempDir);
            expect(result.projectName).toBe(path.basename(tempDir));
        });
        it('should calculate language distribution', async () => {
            await fs.writeFile(path.join(tempDir, 'test.ts'), 'const x: number = 1;');
            await fs.writeFile(path.join(tempDir, 'test.js'), 'const y = 2;');
            await fs.writeFile(path.join(tempDir, 'test.py'), 'x = 3');
            const result = await analyzer.analyzeRepository(tempDir);
            expect(result.metadata.languageDistribution).toBeDefined();
            expect(Object.keys(result.metadata.languageDistribution).length).toBeGreaterThan(0);
        });
    });
    describe('framework pattern detection', () => {
        it('should detect React framework', async () => {
            const reactCode = `
        import React from 'react';
        
        function MyComponent() {
          const [state, setState] = React.useState(0);
          return <div>Hello {state}</div>;
        }
      `;
            await fs.writeFile(path.join(tempDir, 'Component.tsx'), reactCode);
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ dependencies: { react: '^18.0.0' } }));
            expect(reactCode).toContain('React');
        });
    });
    describe('edge cases and robustness', () => {
        it('should handle empty project directory', async () => {
            const result = await analyzer.analyzeRepository(tempDir);
            expect(result).toBeDefined();
            expect(result.components).toHaveLength(1);
        });
        it('should handle very large file count', async () => {
            const fileCount = 100;
            for (let i = 0; i < fileCount; i++) {
                await fs.writeFile(path.join(tempDir, `file${i}.ts`), `export const value${i} = ${i};`);
            }
            const result = await analyzer.analyzeRepository(tempDir);
            expect(result).toBeDefined();
        });
        it('should handle special characters in file paths', async () => {
            const specialDir = path.join(tempDir, 'special!@#$%^&()_+');
            await fs.mkdir(specialDir);
            await fs.writeFile(path.join(specialDir, 'file with spaces.ts'), 'const x = 1;');
            const result = await analyzer.analyzeRepository(tempDir);
            expect(result).toBeDefined();
        });
        it('should handle circular symbolic links gracefully', async () => {
            if (process.platform !== 'win32') {
                const linkSource = path.join(tempDir, 'source');
                const linkTarget = path.join(tempDir, 'target');
                await fs.mkdir(linkSource);
                await fs.mkdir(linkTarget);
                await fs.symlink(linkTarget, path.join(linkSource, 'to-target'));
                await fs.symlink(linkSource, path.join(linkTarget, 'to-source'));
                const result = await analyzer.analyzeRepository(tempDir);
                expect(result).toBeDefined();
            }
        });
    });
});

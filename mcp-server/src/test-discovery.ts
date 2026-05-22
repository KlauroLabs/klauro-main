import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';
import type { CASOutput } from '../../backend/src/types/cas.types';

export type TestDiscoveryStatus =
  | 'cas-covered'
  | 'cas-partial'
  | 'potential-tests-missing-from-cas'
  | 'no-source-tests-found';

export interface TestDiscoveryEvidence {
  generated_at: string;
  path: string;
  status: TestDiscoveryStatus;
  cas_test_suites: number;
  source_test_files: number;
  potential_uncovered_test_files: Array<{
    path: string;
    framework: string;
    reason: string;
  }>;
  test_config_files: string[];
  sample_source_test_files: Array<{
    path: string;
    framework: string;
  }>;
  summary: string;
}

const TEST_PATTERNS = [
  '**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs}',
  '**/*.cy.{js,jsx,ts,tsx}',
  '**/tests/**/*.{js,jsx,ts,tsx,mjs,cjs,py,go,rs,dart,java,kt,cs,php}',
  '**/test/**/*.{js,jsx,ts,tsx,mjs,cjs,py,go,rs,dart,java,kt,cs,php}',
  '**/test_*.py',
  '**/*_test.py',
  '**/*_test.go',
  '**/*_test.rs',
  '**/*_test.dart',
  '**/*Test.java',
  '**/*Tests.java',
  '**/*Test.kt',
  '**/*Tests.kt',
  '**/*Test.cs',
  '**/*Tests.cs',
  '**/*Test.php',
];

const TEST_CONFIG_PATTERNS = [
  'jest.config.{js,ts,mjs,cjs}',
  'vitest.config.{js,ts,mjs,cjs}',
  'cypress.config.{js,ts,mjs,cjs}',
  'playwright.config.{js,ts,mjs,cjs}',
  'pytest.ini',
  'tox.ini',
  'noxfile.py',
  'phpunit.xml',
  'phpunit.xml.dist',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'pubspec.yaml',
];

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/vendor/**',
  '**/vendors/**',
  '**/venv/**',
  '**/.venv/**',
  '**/env/**',
  '**/site-packages/**',
  '**/.git/**',
  '**/coverage/**',
  '**/.nyc_output/**',
  '**/__pycache__/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/.sourcemaps/**',
  '**/sourcemaps/**',
  '**/*.js.map',
  '**/*.css.map',
  '**/*.bundle.js',
  '**/*.bundle.css',
  '**/*.min.js',
  '**/*.min.css',
  '**/.vite/**',
  '**/out/**',
  '**/Generated/**',
  '**/generated/**',
  '**/web/assets/**',
  '**/public/assets/**',
  '**/static/assets/**',
];

export async function getTestDiscoveryEvidence(projectPath: string, cas?: CASOutput): Promise<TestDiscoveryEvidence> {
  const sourceFiles = await glob(TEST_PATTERNS, {
    cwd: projectPath,
    ignore: IGNORE_PATTERNS,
    nodir: true,
    absolute: false,
  });
  const configFiles = await glob(TEST_CONFIG_PATTERNS, {
    cwd: projectPath,
    ignore: IGNORE_PATTERNS,
    nodir: true,
    absolute: false,
  });

  const casSuites = cas?.test_suites || [];
  const casFiles = new Set(casSuites.map(suite => normalizeProjectPath(projectPath, suite.file_path)).filter(Boolean));
  const sourceDetails: Array<{ path: string; framework: string }> = [];
  for (const file of sourceFiles.sort()) {
    if (!(await isExecutableTestFile(projectPath, file))) continue;
    const normalizedPath = normalizeProjectPath(projectPath, file);
    if (normalizedPath) sourceDetails.push({ path: normalizedPath, framework: inferFramework(file) });
  }
  const potentialUncovered = sourceDetails
    .filter(file => !hasMatchingCasSuite(file.path, casFiles))
    .slice(0, 50)
    .map(file => ({
      path: file.path,
      framework: file.framework,
      reason: 'Source test file exists but no CAS test suite references this file.',
    }));

  const status = statusFor(casSuites.length, sourceDetails.length, potentialUncovered.length);

  return {
    generated_at: new Date().toISOString(),
    path: projectPath,
    status,
    cas_test_suites: casSuites.length,
    source_test_files: sourceDetails.length,
    potential_uncovered_test_files: potentialUncovered,
    test_config_files: configFiles.sort(),
    sample_source_test_files: sourceDetails.slice(0, 25),
    summary: summaryFor(status, casSuites.length, sourceDetails.length, potentialUncovered.length),
  };
}

function statusFor(casSuites: number, sourceFiles: number, uncovered: number): TestDiscoveryStatus {
  if (casSuites > 0 && uncovered === 0) return 'cas-covered';
  if (casSuites > 0 && uncovered > 0) return 'cas-partial';
  if (sourceFiles > 0) return 'potential-tests-missing-from-cas';
  return 'no-source-tests-found';
}

function summaryFor(status: TestDiscoveryStatus, casSuites: number, sourceFiles: number, uncovered: number): string {
  if (status === 'cas-covered') return `${casSuites} CAS test suites cover ${sourceFiles} discovered source test files.`;
  if (status === 'cas-partial') return `${casSuites} CAS test suites found, with ${uncovered} discovered source test files not represented in CAS.`;
  if (status === 'potential-tests-missing-from-cas') return `${sourceFiles} source test files exist, but CAS reports no test suites.`;
  return 'No source test files were found after scanning common test paths and naming conventions.';
}

function hasMatchingCasSuite(sourceFile: string, casFiles: Set<string>): boolean {
  for (const casFile of casFiles) {
    if (sourceFile === casFile || sourceFile.endsWith(`/${casFile}`) || casFile.endsWith(`/${sourceFile}`)) return true;
  }
  return false;
}

function normalizeProjectPath(projectPath: string, filePath?: string): string {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  const normalizedProject = path.resolve(projectPath).replace(/\\/g, '/');
  if (path.isAbsolute(filePath)) {
    return normalized.startsWith(`${normalizedProject}/`)
      ? normalized.slice(normalizedProject.length + 1)
      : normalized;
  }
  return normalized.replace(/^\.\//, '');
}

function inferFramework(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.cy.ts') || lower.endsWith('.cy.js') || lower.includes('/cypress/')) return 'cypress';
  if (lower.includes('playwright')) return 'playwright';
  if (lower.endsWith('.test.ts') || lower.endsWith('.spec.ts') || lower.endsWith('.test.tsx') || lower.endsWith('.spec.tsx')) return 'jest-or-vitest';
  if (lower.endsWith('.test.js') || lower.endsWith('.spec.js') || lower.endsWith('.test.jsx') || lower.endsWith('.spec.jsx')) return 'jest-or-vitest';
  if (lower.endsWith('.py')) return 'pytest';
  if (lower.endsWith('_test.go')) return 'go-test';
  if (lower.endsWith('_test.rs')) return 'rust-test';
  if (lower.endsWith('_test.dart')) return 'flutter-test';
  if (lower.endsWith('test.java') || lower.endsWith('tests.java') || lower.endsWith('test.kt') || lower.endsWith('tests.kt')) return 'junit';
  if (lower.endsWith('test.cs') || lower.endsWith('tests.cs')) return 'xunit';
  if (lower.endsWith('test.php')) return 'phpunit';
  return 'unknown';
}

async function isExecutableTestFile(projectPath: string, filePath: string): Promise<boolean> {
  const normalized = filePath.replace(/\\/g, '/');
  const name = path.basename(normalized);
  if (name === '__init__.py' || name.endsWith('.d.ts')) return false;

  const absolutePath = path.join(projectPath, filePath);
  const content = await fs.readFile(absolutePath, 'utf8').catch(() => '');
  if (!content.trim()) return false;

  if (/\.(test|spec|cy)\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(name) || /\/tests?\//i.test(normalized) && /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(name)) {
    return /\b(?:describe|context|suite|it|test|specify|xdescribe|xit|xtest|fdescribe|fit|ftest)(?:\.|\s*\()/.test(content);
  }
  if (/\.py$/i.test(name)) {
    return /^\s*(?:async\s+)?def\s+test_[A-Za-z0-9_]+\s*\(/m.test(content) ||
      /^\s*class\s+Test[A-Za-z0-9_]+\s*[:(]/m.test(content);
  }
  if (/_test\.go$/i.test(name)) return /^\s*func\s+Test[A-Za-z0-9_]+\s*\(/m.test(content);
  if (/_test\.rs$/i.test(name)) return /#\[(?:tokio::)?test\][\s\S]{0,160}?\bfn\s+[A-Za-z0-9_]+/.test(content);
  if (/_test\.dart$/i.test(name)) return /\b(?:test|testWidgets)\s*\(\s*(['"`])([^'"`]+)\1/.test(content);
  if (/(Test|Tests)\.(java|kt|cs|php)$/i.test(name)) return /@Test/.test(content);
  return false;
}

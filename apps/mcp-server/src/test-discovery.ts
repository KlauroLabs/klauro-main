import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';
import pLimit from 'p-limit';
import * as ts from 'typescript';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

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
  '**/fixtures/**',
  '**/__fixtures__/**',
  '**/testdata/**',
  '**/cas-tests/**',
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

const JAVASCRIPT_TEST_APIS = new Set([
  'context',
  'describe',
  'fdescribe',
  'fit',
  'ftest',
  'it',
  'specify',
  'suite',
  'test',
  'xdescribe',
  'xit',
  'xtest',
]);

const JAVASCRIPT_TEST_NAMESPACES = new Set(['Bun', 'Deno', 'QUnit']);
const JAVASCRIPT_TEST_MODIFIERS = new Set(['concurrent', 'each', 'fails', 'only', 'serial', 'skip', 'todo']);

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
  const casFileIndex = buildPathSuffixIndex(casFiles);
  const readLimit = pLimit(16);
  const inspectedSourceFiles = await Promise.all(sourceFiles.sort().map(file => readLimit(async () => {
    const normalizedPath = normalizeProjectPath(projectPath, file);
    if (!normalizedPath) return null;
    if (!hasMatchingCasSuite(normalizedPath, casFileIndex) && !(await isExecutableTestFile(projectPath, file))) return null;
    return { path: normalizedPath, framework: inferFramework(file) };
  })));
  const sourceDetails = inspectedSourceFiles.filter((file): file is { path: string; framework: string } => Boolean(file));
  const potentialUncovered = sourceDetails
    .filter(file => !hasMatchingCasSuite(file.path, casFileIndex))
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

interface PathSuffixIndex {
  exact: Set<string>;
  suffixes: Set<string>;
}

function buildPathSuffixIndex(paths: Set<string>): PathSuffixIndex {
  const suffixes = new Set<string>();
  for (const filePath of paths) {
    for (const suffix of pathSuffixes(filePath)) suffixes.add(suffix);
  }
  return { exact: paths, suffixes };
}

function hasMatchingCasSuite(sourceFile: string, index: PathSuffixIndex): boolean {
  if (index.suffixes.has(sourceFile)) return true;
  return pathSuffixes(sourceFile).some(suffix => index.exact.has(suffix));
}

function pathSuffixes(filePath: string): string[] {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.map((_, index) => parts.slice(index).join('/'));
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
  const pathSegments = normalized.toLowerCase().split('/');
  const explicitJavaScriptTestName = /\.(test|spec|cy)\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(name);
  const supportDirectory = pathSegments.some(segment => ['helpers', 'support', 'test-helpers', 'test_helpers'].includes(segment));
  const supportFileName = /(?:^|[_-])(helper|support)(?:[_-]|\.)/i.test(name);
  if ((supportDirectory && !explicitJavaScriptTestName) || supportFileName) return false;

  const absolutePath = path.join(projectPath, filePath);
  const content = await fs.readFile(absolutePath, 'utf8').catch(() => '');
  if (!content.trim()) return false;

  if (/\.(test|spec|cy)\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(name) || /\/tests?\//i.test(normalized) && /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(name)) {
    return hasJavaScriptTestDeclaration(content, name);
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

function hasJavaScriptTestDeclaration(content: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, false, scriptKindFor(fileName));
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && isTestApiExpression(node.expression)) {
      found = true;
      return;
    }
    if (ts.isTaggedTemplateExpression(node) && isTestApiExpression(node.tag)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function isTestApiExpression(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return JAVASCRIPT_TEST_APIS.has(expression.text);
  if (ts.isPropertyAccessExpression(expression)) {
    if (JAVASCRIPT_TEST_MODIFIERS.has(expression.name.text)) return isTestApiExpression(expression.expression);
    return ts.isIdentifier(expression.expression) &&
      JAVASCRIPT_TEST_NAMESPACES.has(expression.expression.text) &&
      JAVASCRIPT_TEST_APIS.has(expression.name.text);
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (!argument || !ts.isStringLiteralLike(argument)) return false;
    if (JAVASCRIPT_TEST_MODIFIERS.has(argument.text)) return isTestApiExpression(expression.expression);
    return ts.isIdentifier(expression.expression) &&
      JAVASCRIPT_TEST_NAMESPACES.has(expression.expression.text) &&
      JAVASCRIPT_TEST_APIS.has(argument.text);
  }
  if (ts.isCallExpression(expression)) return isTestApiExpression(expression.expression);
  if (ts.isParenthesizedExpression(expression)) return isTestApiExpression(expression.expression);
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) {
    return isTestApiExpression(expression.expression);
  }
  return false;
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

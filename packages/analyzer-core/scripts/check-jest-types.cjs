const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

const project = JSON.parse(fs.readFileSync(0, 'utf8'));
const discovery = Object.fromEntries([
  'rootDir', 'roots', 'testMatch', 'testRegex', 'testPathIgnorePatterns',
  'moduleFileExtensions', 'modulePathIgnorePatterns', 'extensionsToTreatAsEsm',
].filter(key => project[key] !== undefined).map(key => [key, project[key]]));
const listed = spawnSync(process.execPath, [
  require.resolve('jest/bin/jest'), '--listTests', '--json', '--runInBand',
  '--config', JSON.stringify(discovery),
], { cwd: project.rootDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (listed.error || listed.status !== 0) {
  throw new Error('Jest typecheck discovery failed: ' + (listed.error?.message || listed.stderr || listed.signal || listed.status));
}
const tests = JSON.parse(listed.stdout);
if (!Array.isArray(tests) || !tests.length || tests.some(file => typeof file !== 'string')) {
  throw new Error('Jest typecheck discovery returned no test files or an invalid manifest');
}
tests.sort();
const transform = project.transform.find(entry => entry[1].includes('ts-jest'));
if (!transform) throw new Error('Jest typecheck requires the configured ts-jest transform');
const configured = transform[2]?.tsconfig;
if (configured === false) throw new Error('Jest typecheck requires a TypeScript project configuration');
const configPath = typeof configured === 'string'
  ? path.resolve(project.rootDir, configured)
  : ts.findConfigFile(project.rootDir, ts.sys.fileExists);
if (!configPath) throw new Error('Jest typecheck could not find tsconfig.json');
const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
const configuredOptions = ts.convertCompilerOptionsFromJson(typeof configured === 'object' ? configured : {}, project.rootDir);
const parsed = ts.parseJsonConfigFileContent(loaded.config || {}, ts.sys, path.dirname(configPath),
  { ...configuredOptions.options, noEmit: true },
  configPath);
const setupFiles = [...project.setupFiles || [], ...project.setupFilesAfterEnv || [], project.globalSetup, project.globalTeardown]
  .filter(file => typeof file === 'string' && /\.[cm]?tsx?$/.test(file));
const roots = [...new Set([...parsed.fileNames, ...tests, ...setupFiles])].sort();
const program = ts.createProgram(roots, parsed.options);
const diagnostics = [
  ...loaded.error ? [loaded.error] : [], ...parsed.errors, ...configuredOptions.errors, ...ts.getPreEmitDiagnostics(program),
];
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => project.rootDir,
    getCanonicalFileName: file => file,
    getNewLine: () => '\n',
  }));
  process.exitCode = 1;
}
process.stdout.write('[jest-typecheck] ' + JSON.stringify({
  tests: tests.length, roots: roots.length, program_files: program.getSourceFiles().length,
  manifest_sha256: crypto.createHash('sha256').update(JSON.stringify(tests)).digest('hex'),
  isolated_modules: parsed.options.isolatedModules === true, diagnostics: diagnostics.length,
}) + '\n');

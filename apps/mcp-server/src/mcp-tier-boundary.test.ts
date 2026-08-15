import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const sourceRoot = path.resolve(__dirname);

const analysisFiles = [
  'analyzer.ts',
  'cas-contract.ts',
  'cas-sections.ts',
  'cross-codebase-analysis.ts',
  'deployable-analysis.ts',
  'layered-analysis.ts',
  'semantic-roles.ts',
  'workspace-graph.ts',
];

const telemetryFiles = [
  'runtime-contract.ts',
  'runtime-sdk.ts',
  'self-telemetry.ts',
  'telemetry-fusion.ts',
  'telemetry-ingestion.ts',
];

const fabricFiles = [
  'context-fabric.ts',
  ...fs.readdirSync(path.join(sourceRoot, 'coordination'))
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map(file => `coordination/${file}`),
];

function localImports(file: string): string[] {
  const absolute = path.join(sourceRoot, file);
  const source = fs.readFileSync(absolute, 'utf8');
  const imports: string[] = [];
  const pattern = /(?:from|import)\s+['"](\.[^'"]*)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const resolved = path.resolve(path.dirname(absolute), match[1]);
    const relative = path.relative(sourceRoot, resolved.endsWith('.ts') ? resolved : `${resolved}.ts`);
    imports.push(relative.split(path.sep).join('/'));
  }
  return imports;
}

test('MCP analysis modules cannot consume telemetry or Fabric', () => {
  const forbidden = new Set([...telemetryFiles, ...fabricFiles]);
  const violations = analysisFiles.flatMap(file =>
    localImports(file)
      .filter(imported => forbidden.has(imported))
      .map(imported => `${file} imports ${imported}`)
  );
  assert.deepEqual(violations, []);
});

test('telemetry modules cannot consume Fabric', () => {
  const forbidden = new Set(fabricFiles);
  const violations = telemetryFiles.flatMap(file =>
    localImports(file)
      .filter(imported => forbidden.has(imported))
      .map(imported => `${file} imports ${imported}`)
  );
  assert.deepEqual(violations, []);
});

test('tier manifests contain existing unique production modules', () => {
  const files = [...analysisFiles, ...telemetryFiles, ...fabricFiles];
  assert.equal(new Set(files).size, files.length);
  assert.deepEqual(files.filter(file => !fs.existsSync(path.join(sourceRoot, file))), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

for (const entry of ['query', 'semantic-search', 'hosted-project-query', 'telemetry-ingestion']) {
  test(`${entry} reads CAS without initializing the analysis engine`, () => {
    const script = `
      require(${JSON.stringify(path.join(__dirname, entry + '.ts'))});
      const initialized = Object.keys(require.cache).filter(file =>
        /[\\\\/]src[\\\\/]analyzer\\.ts$/.test(file) ||
        /[\\\\/]core[\\\\/]orchestrator\\.ts$/.test(file));
      process.stdout.write(JSON.stringify(initialized));
    `;
    const output = execFileSync(process.execPath, [
      '--import', require.resolve('tsx'),
      '-e', script,
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.deepEqual(JSON.parse(output), []);
  });
}

test('hosted query bundles exclude analysis orchestration', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const filename = path.join(__dirname, '..', 'dist-hosted', 'query-runtime-metafile.json');
  const builds = JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<string, { inputs: Record<string, unknown> }>;
  assert.deepEqual(Object.keys(builds).sort(), ['runtime', 'worker']);
  for (const [name, build] of Object.entries(builds)) {
    const forbidden = Object.keys(build.inputs).filter(file =>
      /(?:^|\/)src\/analyzer\.ts$/.test(file) ||
      /(?:^|\/)core\/orchestrator\.ts$/.test(file));
    assert.deepEqual(forbidden, [], name);
  }
});

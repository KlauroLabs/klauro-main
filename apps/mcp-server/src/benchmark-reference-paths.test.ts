import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { defaultBenchmarkReferencePaths } from './benchmark-reference-paths';

test('benchmark references default to the containing repository', () => {
  const source = path.join(path.parse(process.cwd()).root, 'workspace', 'apps', 'mcp-server', 'src');
  assert.deepEqual(defaultBenchmarkReferencePaths(source, ''), [path.join(path.parse(process.cwd()).root, 'workspace')]);
});

test('benchmark references accept portable path-delimited configuration without duplicates', () => {
  const left = path.resolve('left');
  const right = path.resolve('right');
  assert.deepEqual(
    defaultBenchmarkReferencePaths(process.cwd(), [left, right, left].join(path.delimiter)),
    [left, right],
  );
});

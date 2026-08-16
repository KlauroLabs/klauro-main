import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('analyzer images pin the verified Node runtime instead of following a floating major tag', () => {
  for (const dockerfile of ['apps/api/Dockerfile', 'apps/mcp-server/Dockerfile.analyzer']) {
    const source = read(dockerfile);
    assert.match(source, /^ARG NODE_VERSION=22\.22\.0$/m);
    assert.match(source, /^FROM node:\$\{NODE_VERSION\}-bookworm-slim/m);
    assert.doesNotMatch(source, /^FROM node:22-bookworm-slim/m);
  }
});

test('native C sharp grammar stays on the tree-sitter 0.21 compatible release', () => {
  for (const manifest of ['apps/mcp-server/package.json', 'packages/analyzer-core/package.json']) {
    const dependencies = JSON.parse(read(manifest)).dependencies as Record<string, string>;
    assert.equal(dependencies['tree-sitter-c-sharp'], '0.23.1');
  }
  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string }> };
  assert.equal(lock.packages['node_modules/tree-sitter-c-sharp']?.version, '0.23.1');
});

test('VPS source sync preserves remote generated workspaces outside the deployment snapshot', () => {
  const source = read('infrastructure/vps/deploy.sh');
  assert.match(source, /--exclude \.claude\/worktrees/);
  assert.match(source, /--exclude '\.klauro-\*'/);
  assert.match(source, /--exclude \.customer-package/);
});

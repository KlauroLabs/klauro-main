import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const root = path.resolve(__dirname, '../../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function occursInOrder(source: string, values: string[]): boolean {
  let cursor = 0;
  for (const value of values) {
    const position = source.indexOf(value, cursor);
    if (position < 0) return false;
    cursor = position + value.length;
  }
  return true;
}

test('customer onboarding documents the complete hosted first-value path', () => {
  for (const file of ['docs/mcp/GETTING-STARTED.md', 'docs/mcp/CUSTOMER-ONBOARDING.md']) {
    const source = read(file);
    assert.ok(occursInOrder(source, [
      'install.sh',
      'klauro login --register',
      'klauro install --claude-scope user',
      'klauro init',
      'klauro analyze',
      'klauro doctor',
    ]), `${file} must preserve the supported customer command order`);
  }
});

test('customer docs distinguish native, npm fallback, and contributor runtimes', () => {
  const gettingStarted = read('docs/mcp/GETTING-STARTED.md');
  const configuration = read('docs/mcp/CONFIGURATION.md');
  const onboarding = read('docs/mcp/CUSTOMER-ONBOARDING.md');
  for (const source of [gettingStarted, configuration, onboarding]) {
    assert.match(source, /checksum-verified/i);
    assert.match(source, /Node\.js 20\+/);
  }
  assert.match(gettingStarted, /monorepo from source requires Node\.js 22/i);
  assert.match(configuration, /monorepo requires Node\.js 22/i);
  assert.doesNotMatch(onboarding, /dependency-free npm/i);
});

test('readiness documentation preserves product scope and unresolved gates', () => {
  const readiness = read('docs/PRODUCT-READINESS.md');
  assert.match(readiness, /Klauro is for any software/);
  assert.match(readiness, /Capability names and descriptions read as grounded product behavior/);
  assert.match(readiness, /authorized AI provider/);
  assert.match(readiness, /full analyzer, MCP, proof-machine/);
  assert.match(readiness, /deploy the identical source/);
  assert.doesNotMatch(readiness, /current local primary-package proofs/i);
});

test('terminality documentation covers prerequisite and product auth counterexamples', () => {
  const terminality = read('docs/TERMINAL-CAPABILITY-ABSORPTION-GATE.md');
  assert.match(terminality, /authentication is prerequisite and non-terminal/i);
  assert.match(terminality, /authentication is terminal/i);
  assert.match(terminality, /recursive CAS nodes/i);
  assert.doesNotMatch(terminality, /No product surface can run this composition today/i);
});

test('customer deployment options label planned integrations', () => {
  const onboarding = read('docs/mcp/CUSTOMER-ONBOARDING.md');
  assert.match(onboarding, /Git app import service pending/i);
  assert.match(onboarding, /Planned integration path/i);
  assert.match(onboarding, /Local committed-source analyzer[\s\S]*Implemented and tested/i);
});

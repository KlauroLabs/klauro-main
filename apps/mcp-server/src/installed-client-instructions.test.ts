import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTALLED_CLIENT_INSTRUCTIONS } from './installed-client-instructions';
import { INSTALLED_TOOL_NAMES } from './installed-tool-registry';
import { createServer } from './installed-client-server';
import { buildOrientCapsule } from './query';

const TOOL_TOKEN = /\b(?:get|find|search|assess|validate|analyze|sync|start|stop|poll|list|plan|check|resolve|run|evaluate|fab)_[a-z_]+\b/g;

function namedTools(): Set<string> {
  return new Set(INSTALLED_CLIENT_INSTRUCTIONS.match(TOOL_TOKEN) ?? []);
}

function registeredTools(): Set<string> {
  return new Set(Object.keys((createServer() as any)._registeredTools));
}

test('every tool named in the installed-client instructions is registered by the installed client', () => {
  const registered = registeredTools();
  const named = namedTools();
  assert.ok(named.size >= 20, `expected many tool references, found ${named.size}`);
  const missing = [...named].filter(name => !registered.has(name)).sort();
  assert.deepEqual(missing, []);
});

test('the registry and the registered tools agree', () => {
  assert.deepEqual([...registeredTools()].sort(), [...INSTALLED_TOOL_NAMES].sort());
});

test('every orient-capsule dimension tool the installed client exposes is taught', () => {
  const registered = registeredTools();
  const capsule = buildOrientCapsule({ nodes: [], edges: [], system: { name: 'fixture' } } as any);
  const untaught = Object.entries(capsule.dimensions)
    .map(([name, dimension]) => [name, (dimension as { tool: string }).tool] as const)
    .filter(([, tool]) => registered.has(tool) && !INSTALLED_CLIENT_INSTRUCTIONS.includes(tool))
    .map(([name, tool]) => `${name} -> ${tool}`);
  assert.deepEqual(untaught, []);
});

test('the instructions teach the status remedy without login and the deferred-schema step', () => {
  assert.match(INSTALLED_CLIENT_INSTRUCTIONS, /no_analysis/);
  assert.match(INSTALLED_CLIENT_INSTRUCTIONS, /klauro accounts/);
  assert.match(INSTALLED_CLIENT_INSTRUCTIONS, /klauro init --force/);
  assert.match(INSTALLED_CLIENT_INSTRUCTIONS, /Never run klauro login/);
  assert.match(INSTALLED_CLIENT_INSTRUCTIONS, /ToolSearch/);
});

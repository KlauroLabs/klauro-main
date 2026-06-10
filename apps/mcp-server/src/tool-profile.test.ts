import { strict as assert } from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { CORE_TOOL_NAMES, createServer, resolveToolProfile } from './server';
import { saveAnalysis } from './storage';

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function registeredToolNames(server: ReturnType<typeof createServer>): string[] {
  return Object.keys((server as any)._registeredTools);
}

function gatewayCallback(server: ReturnType<typeof createServer>): (args: any) => Promise<any> {
  const registered = (server as any)._registeredTools['klauro_query'];
  return registered.callback ?? registered.handler;
}

test('tool profile defaults to full and only accepts core explicitly', () => {
  const previous = process.env.KLAURO_TOOL_PROFILE;
  try {
    delete process.env.KLAURO_TOOL_PROFILE;
    assert.equal(resolveToolProfile(), 'full');
    process.env.KLAURO_TOOL_PROFILE = 'core';
    assert.equal(resolveToolProfile(), 'core');
    process.env.KLAURO_TOOL_PROFILE = 'unknown-value';
    assert.equal(resolveToolProfile(), 'full');
  } finally {
    restoreEnv('KLAURO_TOOL_PROFILE', previous);
  }
});

test('core profile registers exactly the core tools plus the gateway', () => {
  const previous = process.env.KLAURO_TOOL_PROFILE;
  try {
    process.env.KLAURO_TOOL_PROFILE = 'core';
    const server = createServer();
    const names = registeredToolNames(server).sort();
    assert.deepEqual(names, [...CORE_TOOL_NAMES, 'klauro_query'].sort());

    const gatewayDescription = (server as any)._registeredTools['klauro_query'].description as string;
    assert.ok(gatewayDescription.includes('get_route_table'));
    assert.ok(gatewayDescription.includes('analyze_codebase'));
    for (const coreName of CORE_TOOL_NAMES) {
      assert.ok(!gatewayDescription.includes(coreName), `gateway description should not list core tool ${coreName}`);
    }
  } finally {
    restoreEnv('KLAURO_TOOL_PROFILE', previous);
  }
});

test('full profile registers the full tool set without the gateway', () => {
  const previous = process.env.KLAURO_TOOL_PROFILE;
  try {
    delete process.env.KLAURO_TOOL_PROFILE;
    const server = createServer();
    const names = registeredToolNames(server);
    assert.ok(names.length > 100, `expected full tool set, got ${names.length}`);
    assert.ok(names.includes('get_route_table'));
    assert.ok(names.includes('analyze_codebase'));
    for (const coreName of CORE_TOOL_NAMES) {
      assert.ok(names.includes(coreName), `full profile missing core tool ${coreName}`);
    }
    assert.ok(!names.includes('klauro_query'));
  } finally {
    restoreEnv('KLAURO_TOOL_PROFILE', previous);
  }
});

test('klauro_query dispatches to a long-tail tool handler', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-tool-profile-test-'));
  const projectPath = path.join(root, 'repo');
  const storagePath = path.join(root, 'storage');
  const previousProfile = process.env.KLAURO_TOOL_PROFILE;
  const previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  const previousCompression = process.env.KLAURO_ANALYSIS_COMPRESSION;

  process.env.KLAURO_TOOL_PROFILE = 'core';
  process.env.KLAURO_STORAGE_PATH = storagePath;
  process.env.KLAURO_ANALYSIS_COMPRESSION = 'none';

  try {
    await fs.ensureDir(projectPath);
    await saveAnalysis(projectPath, {
      analysis_timestamp: '2026-01-01T00:00:00.000Z',
      nodes: [{ id: 'node-1', kind: 'function', name: 'listDrivers', file_path: 'src/drivers.ts' }],
      edges: [],
      route_table: [{ method: 'GET', path: '/drivers', controller: 'DriversController', handler: 'listDrivers' }],
      system: { name: 'repo', type: 'application', technologies: { languages: [], frameworks: [], databases: [], external_services: [] } },
    } as unknown as CASOutput);

    const server = createServer();
    const result = await gatewayCallback(server)({ tool: 'get_route_table', args: { path: projectPath } });
    assert.ok(!result.isError, `expected success, got ${result.content?.[0]?.text}`);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.total, 1);
    assert.equal(payload.routes[0].method, 'GET');
    assert.equal(payload.routes[0].path, '/drivers');
  } finally {
    restoreEnv('KLAURO_TOOL_PROFILE', previousProfile);
    restoreEnv('KLAURO_STORAGE_PATH', previousStoragePath);
    restoreEnv('KLAURO_ANALYSIS_COMPRESSION', previousCompression);
    await fs.remove(root);
  }
});

test('klauro_query reports unknown tools and invalid arguments clearly', async () => {
  const previous = process.env.KLAURO_TOOL_PROFILE;
  try {
    process.env.KLAURO_TOOL_PROFILE = 'core';
    const server = createServer();
    const callback = gatewayCallback(server);

    const unknown = await callback({ tool: 'not_a_real_tool', args: {} });
    assert.equal(unknown.isError, true);
    const unknownMessage = JSON.parse(unknown.content[0].text).error as string;
    assert.ok(unknownMessage.includes("Unknown Klauro tool 'not_a_real_tool'"));
    assert.ok(unknownMessage.includes('get_route_table'));

    const invalid = await callback({ tool: 'get_route_table', args: {} });
    assert.equal(invalid.isError, true);
    const invalidMessage = JSON.parse(invalid.content[0].text).error as string;
    assert.ok(invalidMessage.includes("Invalid arguments for 'get_route_table'"));
    assert.ok(invalidMessage.includes('path'));
  } finally {
    restoreEnv('KLAURO_TOOL_PROFILE', previous);
  }
});

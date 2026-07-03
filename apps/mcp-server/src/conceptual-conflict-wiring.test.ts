import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { createServer } from './server';
import { saveAnalysis } from './storage';

/**
 * Verifies the check_conceptual_conflicts MCP wiring end to end: agent A
 * retypes getUser's nullability, agent B reports it is concurrently editing
 * renderProfile (a caller of getUser per the CAS "calls" edge) — asserts a
 * contract-divergence conflict comes back for both, and that check_collision
 * also surfaces it once both agents have reported.
 */
function getToolHandler(server: ReturnType<typeof createServer>, name: string): (args: any) => Promise<any> {
  const registered = (server as any)._registeredTools[name];
  return registered.callback ?? registered.handler;
}

test('check_conceptual_conflicts detects contract-divergence between two agents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-conceptual-wiring-'));
  const projectPath = path.join(root, 'repo');
  const storagePath = path.join(root, 'storage');
  const coordDir = path.join(root, 'coord');
  const previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  const previousCompression = process.env.KLAURO_ANALYSIS_COMPRESSION;
  const previousCoordDir = process.env.KLAURO_COORD_DIR;

  process.env.KLAURO_STORAGE_PATH = storagePath;
  process.env.KLAURO_ANALYSIS_COMPRESSION = 'none';
  process.env.KLAURO_COORD_DIR = coordDir;

  try {
    await fs.ensureDir(projectPath);
    await saveAnalysis(projectPath, {
      cas_version: '1.10.0',
      analysis_timestamp: '2026-01-01T00:00:00.000Z',
      nodes: [
        { id: 'sym:getUser', kind: 'function', name: 'getUser', file_path: 'src/auth.ts' },
        { id: 'sym:renderProfile', kind: 'function', name: 'renderProfile', file_path: 'src/profile.ts' },
      ],
      edges: [
        { id: 'e1', source: 'sym:renderProfile', target: 'sym:getUser', type: 'calls' },
      ],
      system: { name: 'repo', type: 'application', technologies: { languages: [], frameworks: [], databases: [], external_services: [] } },
    } as unknown as CASOutput);

    const server = createServer();
    const checkConceptual = getToolHandler(server, 'check_conceptual_conflicts');
    const checkCollision = getToolHandler(server, 'check_collision');

    // Agent B reports first: it is editing renderProfile (a caller of getUser).
    const bResult = await checkConceptual({
      workspace: projectPath,
      agent_id: 'agent-b',
      agent_kind: 'claude',
      intent: 'add profile picture rendering to renderProfile',
      changes: [
        {
          symbol_id: 'sym:renderProfile',
          name: 'renderProfile',
          file: 'src/profile.ts',
          change_kind: 'body',
        },
      ],
    });
    assert.ok(!bResult.isError, `expected success, got ${bResult.content?.[0]?.text}`);
    const bPayload = JSON.parse(bResult.content[0].text);
    assert.equal(bPayload.other_agents_considered, 0);
    assert.equal(bPayload.conflicts.length, 0, 'no conflict yet — agent A has not reported');

    // Agent A retypes getUser's nullability, concurrently with B's report above.
    const aResult = await checkConceptual({
      workspace: projectPath,
      agent_id: 'agent-a',
      agent_kind: 'claude',
      intent: 'make getUser non-null now that auth guarantees a session',
      changes: [
        {
          symbol_id: 'sym:getUser',
          name: 'getUser',
          file: 'src/auth.ts',
          change_kind: 'nullability',
          before: { nullable: true },
          after: { nullable: false },
        },
      ],
    });
    assert.ok(!aResult.isError, `expected success, got ${aResult.content?.[0]?.text}`);
    const aPayload = JSON.parse(aResult.content[0].text);
    assert.equal(aPayload.other_agents_considered, 1, 'agent A should see agent B\'s prior report');
    assert.equal(aPayload.conflicts.length, 1);
    assert.equal(aPayload.conflicts[0].kind, 'contract-divergence');
    assert.equal(aPayload.conflicts[0].severity, 'high');
    assert.equal(aPayload.conflicts[0].passes_textual_merge, true);
    assert.deepEqual([...aPayload.conflicts[0].agents].sort(), ['agent-a', 'agent-b']);

    // Now that both have reported, check_collision for agent A should also
    // surface the conceptual conflict (augmented path), not just path/symbol overlap.
    const collisionResult = await checkCollision({
      workspace: projectPath,
      agent_id: 'agent-a',
      intent: 'make getUser non-null now that auth guarantees a session',
      symbols: ['sym:getUser'],
      changes: [
        {
          symbol_id: 'sym:getUser',
          name: 'getUser',
          file: 'src/auth.ts',
          change_kind: 'nullability',
          before: { nullable: true },
          after: { nullable: false },
        },
      ],
    });
    assert.ok(!collisionResult.isError, `expected success, got ${collisionResult.content?.[0]?.text}`);
    const collisionPayload = JSON.parse(collisionResult.content[0].text);
    assert.ok(Array.isArray(collisionPayload.conceptual_conflicts), 'check_collision should surface conceptual_conflicts');
    assert.equal(collisionPayload.conceptual_conflicts.length, 1);
    assert.equal(collisionPayload.conceptual_conflicts[0].kind, 'contract-divergence');
  } finally {
    if (previousStoragePath === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStoragePath;
    if (previousCompression === undefined) delete process.env.KLAURO_ANALYSIS_COMPRESSION;
    else process.env.KLAURO_ANALYSIS_COMPRESSION = previousCompression;
    if (previousCoordDir === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = previousCoordDir;
    await fs.remove(root);
  }
});

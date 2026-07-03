import { strict as assert } from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { createServer } from './server';
import { saveAnalysis } from './storage';

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function toolCallback(server: ReturnType<typeof createServer>, name: string): (args: any) => Promise<any> {
  const registered = (server as any)._registeredTools[name];
  return registered.callback ?? registered.handler;
}

/**
 * Fixture CAS: getUser <- renderProfile (calls edge), plus an unrelated
 * billingHandler -> formatCurrency pair, matching the shape used by
 * coordination/partitioner.test.ts so blast-radius separation is exercised
 * the same way.
 */
async function withFixtureProject(fn: (projectPath: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-plan-parallel-work-test-'));
  const projectPath = path.join(root, 'repo');
  const storagePath = path.join(root, 'storage');
  const previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  const previousCompression = process.env.KLAURO_ANALYSIS_COMPRESSION;
  process.env.KLAURO_STORAGE_PATH = storagePath;
  process.env.KLAURO_ANALYSIS_COMPRESSION = 'none';

  try {
    await fs.ensureDir(projectPath);
    await saveAnalysis(projectPath, {
      cas_version: '1.10.0',
      analysis_timestamp: '2026-01-01T00:00:00.000Z',
      nodes: [
        { id: 'sym:getUser', name: 'getUser', type: 'function', source: { file: 'src/user.ts' } },
        { id: 'sym:renderProfile', name: 'renderProfile', type: 'function', source: { file: 'src/profile.ts' } },
        { id: 'sym:billingHandler', name: 'billingHandler', type: 'function', source: { file: 'src/billing.ts' } },
        { id: 'sym:formatCurrency', name: 'formatCurrency', type: 'function', source: { file: 'src/format.ts' } },
      ],
      edges: [
        { id: 'e1', source: 'sym:renderProfile', target: 'sym:getUser', type: 'calls' },
        { id: 'e2', source: 'sym:billingHandler', target: 'sym:formatCurrency', type: 'calls' },
      ],
      system: { name: 'repo', type: 'application', technologies: { languages: [], frameworks: [], databases: [], external_services: [] } },
    } as unknown as CASOutput);

    await fn(projectPath);
  } finally {
    restoreEnv('KLAURO_STORAGE_PATH', previousStoragePath);
    restoreEnv('KLAURO_ANALYSIS_COMPRESSION', previousCompression);
    await fs.remove(root);
  }
}

test('createServer registers plan_parallel_work', () => {
  const server = createServer();
  const names = Object.keys((server as any)._registeredTools);
  assert.ok(names.includes('plan_parallel_work'), 'plan_parallel_work must be registered');
});

test('plan_parallel_work: 3 conflicting + 3 disjoint tasks -> correct batch count, factor, and no-conflict invariant', async () => {
  await withFixtureProject(async (projectPath) => {
    const server = createServer();
    const callback = toolCallback(server, 'plan_parallel_work');

    const tasks = [
      // 3 mutually conflicting tasks (all touch the same symbol).
      { id: 'c1', intent: 'retype getUser', target_symbols: ['sym:getUser'] },
      { id: 'c2', intent: 'add logging to getUser', target_symbols: ['sym:getUser'] },
      { id: 'c3', intent: 'add validation to getUser', target_symbols: ['sym:getUser'] },
      // 3 mutually disjoint tasks (distinct files, no call-graph relation).
      { id: 'd1', intent: 'edit unrelated file 1', target_paths: ['src/mod1.ts'] },
      { id: 'd2', intent: 'edit unrelated file 2', target_paths: ['src/mod2.ts'] },
      { id: 'd3', intent: 'edit unrelated file 3', target_paths: ['src/mod3.ts'] },
    ];

    const result = await callback({ tasks, path: projectPath, include_blast_radius: false });
    assert.ok(!result.isError, `expected success, got ${result.content?.[0]?.text}`);
    const payload = JSON.parse(result.content[0].text);

    // c1/c2/c3 all conflict pairwise -> need 3 separate batches for them;
    // d1/d2/d3 are disjoint from everything -> all fit into batch 1 alongside c1.
    assert.equal(payload.batches.length, 3, `expected 3 batches, got ${JSON.stringify(payload.batches)}`);
    assert.equal(typeof payload.parallelism_factor, 'number');
    assert.ok(payload.parallelism_factor > 1, 'expected some parallelism from the disjoint tasks');
    assert.ok(typeof payload.summary === 'string' && payload.summary.includes('batch 1 runs'));

    // Invariant: no two co-batched tasks conflict.
    const conflictSet = new Set(
      (payload.conflict_edges as Array<{ a: string; b: string }>).map((e) => [e.a, e.b].sort().join('|'))
    );
    for (const batch of payload.batches) {
      const ids: string[] = batch.task_ids;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = [ids[i], ids[j]].sort().join('|');
          assert.ok(!conflictSet.has(key), `tasks ${ids[i]} and ${ids[j]} conflict but share a batch`);
        }
      }
    }
    // Sanity: the 3 conflicting tasks are indeed pairwise flagged.
    assert.ok(conflictSet.has(['c1', 'c2'].sort().join('|')));
    assert.ok(conflictSet.has(['c1', 'c3'].sort().join('|')));
    assert.ok(conflictSet.has(['c2', 'c3'].sort().join('|')));
  });
});

test('plan_parallel_work: task with only intent (no declared footprint) is inferred and partitioned, not unpartitionable', async () => {
  await withFixtureProject(async (projectPath) => {
    const server = createServer();
    const callback = toolCallback(server, 'plan_parallel_work');

    const tasks = [
      { id: 't1', intent: 'refactor getUser to be non-null' }, // no declared footprint -> must infer sym:getUser
      { id: 't2', intent: 'add logging to getUser', target_symbols: ['sym:getUser'] },
    ];

    const result = await callback({ tasks, path: projectPath, include_blast_radius: false });
    assert.ok(!result.isError, `expected success, got ${result.content?.[0]?.text}`);
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.unpartitionable, undefined, 't1 should not be unpartitionable — intent names a real CAS symbol');
    assert.equal(payload.footprint_source?.t1, 'inferred');
    assert.equal(payload.footprint_source?.t2, 'declared');

    // Proof the inferred footprint was wired into real conflict detection:
    // t1 (inferred getUser) must conflict with t2 (declared getUser).
    assert.equal(payload.batches.length, 2, 't1 and t2 both target getUser and must land in different batches');
    const edge = (payload.conflict_edges as Array<{ a: string; b: string }>).find(
      (e) => (e.a === 't1' && e.b === 't2') || (e.a === 't2' && e.b === 't1')
    );
    assert.ok(edge, 'expected a conflict edge between t1 and t2');
  });
});

test('plan_parallel_work: blast-radius separates literal-disjoint but caller-linked tasks into different batches', async () => {
  await withFixtureProject(async (projectPath) => {
    const server = createServer();
    const callback = toolCallback(server, 'plan_parallel_work');

    // t1 edits getUser directly; t2 edits renderProfile, a real CALLER of
    // getUser per the fixture CAS. Literal (declared) footprints are
    // disjoint, so a file/symbol-only view would put them in one batch.
    const tasks = [
      { id: 't1', intent: 'retype getUser to non-null', target_symbols: ['sym:getUser'] },
      { id: 't2', intent: 'add avatar to renderProfile', target_symbols: ['sym:renderProfile'] },
    ];

    const withoutBlastRadius = await callback({ tasks, path: projectPath, include_blast_radius: false });
    const withoutPayload = JSON.parse(withoutBlastRadius.content[0].text);
    assert.equal(withoutPayload.batches.length, 1, 'literal footprints are disjoint -> no blast radius means no conflict seen');

    const withBlastRadius = await callback({ tasks, path: projectPath, include_blast_radius: true });
    assert.ok(!withBlastRadius.isError, `expected success, got ${withBlastRadius.content?.[0]?.text}`);
    const withPayload = JSON.parse(withBlastRadius.content[0].text);

    assert.equal(withPayload.batches.length, 2, 'blast-radius expansion must separate these into different batches');
    const edge = (withPayload.conflict_edges as Array<{ a: string; b: string; reason: string }>).find(
      (e) => (e.a === 't1' && e.b === 't2') || (e.a === 't2' && e.b === 't1')
    );
    assert.ok(edge, 'expected a conflict edge between t1 and t2');
    assert.equal(edge!.reason, 'blast-radius');
  });
});

test('plan_parallel_work: without a path, partitions on declared footprints only and notes reduced fidelity', async () => {
  const server = createServer();
  const callback = toolCallback(server, 'plan_parallel_work');

  const tasks = [
    { id: 't1', intent: 'edit a', target_paths: ['src/a.ts'] },
    { id: 't2', intent: 'edit b', target_paths: ['src/b.ts'] },
  ];
  const result = await callback({ tasks });
  assert.ok(!result.isError, `expected success, got ${result.content?.[0]?.text}`);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.batches.length, 1);
  assert.ok(typeof payload.fidelity_note === 'string' && payload.fidelity_note.includes('No `path`'));
});

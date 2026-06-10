import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { TelemetryEvent } from './telemetry-ingestion';

async function main(): Promise<void> {
  process.env.KLAURO_EMBEDDING_ENABLED = 'false';
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-telemetry-proof-'));
  process.env.KLAURO_STORAGE_PATH = storage;

  const { getOrchestrator } = await import('./analyzer');
  const { ingestTelemetryBatch, loadTelemetryObservations } = await import('./telemetry-ingestion');
  const { buildOperationalPriorities } = await import('./product');

  const fixture = path.join(process.cwd(), 'fixtures', 'analysis-truth', 'rails-work-orders');
  console.log(`Analyzing ${fixture} (embeddings disabled)`);
  const cas = await getOrchestrator().orchestrateAnalysis(fixture);
  console.log(`CAS ready: ${cas.nodes.length} nodes, ${(cas.entry_points || []).length} entry points, ${(cas.runtime_static_links || []).length} runtime links`);

  const controllerFile = 'app/controllers/work_orders_controller.rb';
  const now = Date.now();
  const events: TelemetryEvent[] = [];
  for (let index = 0; index < 30; index += 1) {
    events.push({
      kind: 'error',
      timestamp: new Date(now - index * 30_000).toISOString(),
      service_name: 'work-orders-api',
      environment: 'production',
      method: 'POST',
      route: '/work_orders',
      status: 500,
      duration_ms: 180 + index * 7,
      trace_id: `trace-create-${Math.floor(index / 3)}`,
      span_id: `span-create-${index}`,
      volume: 12,
      error: {
        type: 'NoMethodError',
        message: "undefined method 'permit' for nil:NilClass",
        stack_top_frames: [
          { file: controllerFile, line: 47, function: 'work_order_params' },
          { file: controllerFile, line: 15, function: 'create' },
        ],
      },
    });
  }
  for (let index = 0; index < 15; index += 1) {
    events.push({
      kind: 'request',
      timestamp: new Date(now - index * 45_000).toISOString(),
      service_name: 'work-orders-api',
      environment: 'production',
      method: 'POST',
      route: '/work_orders',
      status: 201,
      duration_ms: 90 + index * 4,
      trace_id: `trace-ok-${index}`,
    });
  }
  for (let index = 0; index < 5; index += 1) {
    events.push({
      kind: 'request',
      timestamp: new Date(now - index * 60_000).toISOString(),
      service_name: 'work-orders-api',
      environment: 'production',
      method: 'GET',
      route: '/work_orders',
      status: 200,
      duration_ms: 40 + index * 3,
      trace_id: `trace-list-${index}`,
    });
  }

  const ingestion = await ingestTelemetryBatch(cas, fixture, events);
  console.log('\nIngestion result');
  console.log(`  events: ${ingestion.event_count}, persisted: ${ingestion.persisted}, source: ${ingestion.source}`);
  console.log(`  correlation: matched=${ingestion.correlation_summary.matched} partial=${ingestion.correlation_summary.partial} unmatched=${ingestion.correlation_summary.unmatched}`);
  for (const target of ingestion.matched_targets.slice(0, 5)) {
    console.log(`  target: ${target.label} (${target.type}) file=${target.file || '-'} observations=${target.observations} errors=${target.errors}`);
  }
  if (ingestion.unmatched.count > 0) {
    console.log(`  unmatched hints: ${ingestion.unmatched.top_hints.map(hint => `${hint.hint} x${hint.count}`).join(', ')}`);
  }

  const set = await loadTelemetryObservations(fixture, { source: 'ingested' });
  const priorities = buildOperationalPriorities(cas, set.observations, { limit: 5 });
  console.log(`\nOperational priorities (ingested=${priorities.sources.ingested}, simulated=${priorities.sources.simulated})`);
  for (const priority of priorities.priorities) {
    console.log(`  [${priority.severity}] score=${priority.priority_score} source=${priority.source} ${priority.title}`);
    console.log(`    static_target: ${priority.static_target?.label || '-'} file=${priority.static_target?.file || '-'} errors=${priority.runtime.errors} volume=${priority.runtime.estimated_volume}`);
  }

  const top = priorities.priorities[0];
  const failures: string[] = [];
  if (!top) failures.push('no operational priorities produced');
  if (top && top.source !== 'ingested') failures.push(`top priority source is ${top.source}, expected ingested`);
  if (top && top.runtime.errors < 30) failures.push(`top priority errors ${top.runtime.errors}, expected >= 30`);
  if (!top?.static_target?.file) {
    failures.push('top priority has no static_target.file');
  } else {
    const resolved = path.isAbsolute(top.static_target.file)
      ? top.static_target.file
      : path.join(fixture, top.static_target.file);
    if (await fs.pathExists(resolved)) {
      console.log(`\nstatic_target.file resolves on disk: ${resolved}`);
    } else {
      failures.push(`static_target.file does not resolve: ${resolved}`);
    }
  }
  if (ingestion.correlation_summary.unmatched > 0) {
    failures.push(`expected all events to correlate, got ${ingestion.correlation_summary.unmatched} unmatched`);
  }

  await fs.remove(storage);

  if (failures.length > 0) {
    console.error(`\nPROOF FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\nPROOF PASSED: ingested telemetry drives an ingested-provenance priority with a resolvable static target.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

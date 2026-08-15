


















import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import {
  buildCrossCodebaseSystemGraph,
  type CrossCodebaseInput,
  type CrossCodebaseSystemGraph,
} from '../cross-codebase-analysis';

export type WGroup = 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6' | 'W7' | 'W8';

export interface WASDimension {
  key: string;
  label: string;
  group: WGroup;

  emitted: number;

  examples: string[];

  campABCannot: string;

  casFields: string[];
}

export interface CampWASReport {
  workspace: string;
  repos: number;
  dimensions: WASDimension[];
  aggregate: {
    dimensions: number;
    totalEmitted: number;
    reposCrossed: number;
  };
  outOfCategory: true;
  campABCannot: string;
}


const FIXTURE_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'was-bench',
  'ui-api-worker',
);
const WORKSPACE_NAME = 'ui-api-worker';

let cached: CampWASReport | null = null;

export function _resetCampWASCache(): void {
  cached = null;
}

async function repoDirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of await fs.readdir(dir)) {
    if (f === 'truth.json') continue;
    if ((await fs.stat(path.join(dir, f))).isDirectory()) out.push(f);
  }
  return out.sort();
}


async function buildRealWorkspaceGraph(): Promise<{
  graph: CrossCodebaseSystemGraph;
  repos: number;
}> {
  const dirs = await repoDirs(FIXTURE_DIR);
  const repositories: CrossCodebaseInput[] = [];
  for (const name of dirs) {
    const repoPath = path.join(FIXTURE_DIR, name);
    const cas: any = await analyzeForBench(repoPath);
    repositories.push({ path: repoPath, name, cas });
  }
  const graph = buildCrossCodebaseSystemGraph(WORKSPACE_NAME, repositories);
  return { graph, repos: repositories.length };
}

function take(values: Array<string | undefined | null>, n = 3): string[] {
  return values.filter((v): v is string => Boolean(v && v.trim())).slice(0, n);
}


function reposCrossedFromLinks(graph: CrossCodebaseSystemGraph): number {
  const repos = new Set<string>();
  for (const link of graph.links) {
    if (link.source_codebase_id) repos.add(link.source_codebase_id);
    if (link.target_codebase_id) repos.add(link.target_codebase_id);
  }
  for (const link of graph.application_links) {
    if (link.source_application_id) repos.add(`app:${link.source_application_id}`);
    if (link.target_application_id) repos.add(`app:${link.target_application_id}`);
  }

  return Math.max(repos.size, graph.codebases.length);
}





function buildDimensions(graph: CrossCodebaseSystemGraph): WASDimension[] {
  const dims: WASDimension[] = [];


  const w1Emitted =
    graph.applications.length +
    graph.distribution_units.length +
    (graph.composition ? 1 : 0) +
    graph.environments.length +
    graph.codebases.length +
    graph.runtime_topology.components.length;
  dims.push({
    key: 'composition_topology',
    label: 'Composition & topology',
    group: 'W1',
    emitted: w1Emitted,
    examples: take([
      `composition: ${graph.composition?.kind}`,
      ...graph.applications.map(a => `application: ${a.name}`),
      ...graph.distribution_units.map(d => `distribution-unit: ${d.name}`),
      ...graph.environments.map(e => `environment: ${e.name}`),
    ]),
    campABCannot:
      'A single-repo indexer has no concept of an "application" that spans repos, ' +
      'no workspace composition kind (monorepo/polyrepo/hybrid), and no runtime topology across services.',
    casFields: [
      'applications',
      'distribution_units',
      'composition',
      'environments',
      'codebases',
      'runtime_topology',
    ],
  });


  const w2Emitted =
    graph.interfaces.length +
    graph.application_links.length +
    graph.integration_links.length +
    graph.unmatched_interfaces.length;
  dims.push({
    key: 'integration_seams',
    label: 'Cross-repo integration seams',
    group: 'W2',
    emitted: w2Emitted,
    examples: take([
      ...graph.application_links.map(
        l => `seam: ${l.source_application_id} -> ${l.target_application_id} (${l.kind})`,
      ),
      ...graph.interfaces.map(i => `interface: ${i.role} ${i.kind} ${i.name ?? ''}`),
      ...graph.unmatched_interfaces.map(
        u => `broken-seam: ${u.role} ${u.name} (${u.reason})`,
      ),
    ]),
    campABCannot:
      'A single-repo indexer sees one side of a fetch->route seam; it cannot fuse a producer in repo A ' +
      'to a consumer in repo B, and has no way to flag a broken seam (a producer with no consumer).',
    casFields: ['interfaces', 'application_links', 'integration_links', 'unmatched_interfaces'],
  });


  const w3Emitted = graph.data_flow_paths.length;
  dims.push({
    key: 'data_flow_lineage',
    label: 'Cross-repo data flow & lineage',
    group: 'W3',
    emitted: w3Emitted,
    examples: take(
      graph.data_flow_paths.map(
        p => `flow: ${p.source_codebase_id} -> ${p.target_codebase_id} ${p.name}`,
      ),
    ),
    campABCannot:
      'Data lineage that crosses repo boundaries (PII/payment data flowing ui->api->worker->external) ' +
      'is invisible to a tool that indexes a single repo; there is no boundary to trace across.',
    casFields: ['data_flow_paths'],
  });


  const w4Emitted =
    graph.workspace_capabilities.length +
    graph.workspace_domains.length +
    graph.workspace_workflows.length +
    graph.workspace_entities.length +
    graph.workspace_entity_paths.length +
    (graph.workspace_narrative ? 1 : 0);
  dims.push({
    key: 'product_understanding',
    label: 'Workspace product understanding',
    group: 'W4',
    emitted: w4Emitted,
    examples: take([
      graph.workspace_narrative?.title
        ? `narrative: ${graph.workspace_narrative.title}`
        : undefined,
      ...graph.workspace_capabilities.map(c => `capability: ${c.name}`),
      ...graph.workspace_domains.map(d => `domain: ${d.name}`),
      ...graph.workspace_entities.map(e => `entity: ${e.name}`),
      ...graph.workspace_entity_paths.map(
        p => `entity-path: ${p.entity_name} across ${p.project_ids.length} repos`,
      ),
    ]),
    campABCannot:
      'What the WHOLE product is/does/why — capabilities, domains, workflows, and one entity traced across ' +
      'every repo that touches it — has no analog in a single-repo tool; it has no workspace to summarize.',
    casFields: [
      'workspace_capabilities',
      'workspace_domains',
      'workspace_workflows',
      'workspace_entities',
      'workspace_entity_paths',
      'workspace_narrative',
    ],
  });


  const ownershipKeys = Object.keys(graph.ownership ?? {}).length;
  const activitySignal =
    (graph.activity?.status && graph.activity.status !== 'unknown' ? 1 : 0) +
    (graph.activity?.hotspots?.length ?? 0) +
    (graph.activity?.contributors?.length ?? 0);
  const w5Emitted = ownershipKeys + activitySignal;
  dims.push({
    key: 'ownership_activity',
    label: 'Ownership & activity',
    group: 'W5',
    emitted: w5Emitted,
    examples: take([
      ...Object.entries(graph.ownership ?? {}).map(
        ([app, o]) =>
          `owner: ${app} -> ${o.owners.join(', ') || o.team || o.lifecycle || o.owner_source}`,
      ),
      graph.activity?.status ? `activity: ${graph.activity.status} (${graph.activity.change_rate})` : undefined,
      ...(graph.activity?.hotspots ?? []).map((h: any) => `hotspot: ${h.label}`),
    ]),
    campABCannot:
      'Ownership of a cross-repo seam (who owns the producer vs the consumer) and activity correlated across ' +
      'the whole workspace cannot be assembled by a tool that only ever sees one repo at a time.',
    casFields: ['ownership', 'activity'],
  });


  const telemetrySignal =
    (graph.telemetry?.status && graph.telemetry.status !== 'not-configured' ? 1 : 0) +
    (graph.telemetry?.observed_links ?? 0) +
    (graph.telemetry?.instrumentable_links ?? 0) +
    (graph.telemetry?.hot_signals?.length ?? 0) +
    (graph.telemetry?.guidance?.length ?? 0);
  const w6Emitted = telemetrySignal + graph.runtime_components.length + graph.runtime_links.length;
  dims.push({
    key: 'telemetry',
    label: 'Telemetry & runtime fusion',
    group: 'W6',
    emitted: w6Emitted,
    examples: take([
      graph.telemetry?.status ? `telemetry: ${graph.telemetry.status}` : undefined,
      `instrumentable-links: ${graph.telemetry?.instrumentable_links ?? 0}`,
      ...graph.runtime_components.map(c => `runtime-component: ${c.name ?? c.id}`),
      ...(graph.telemetry?.guidance ?? []).map(g => `guidance: ${g}`),
    ]),
    campABCannot:
      'Correlating runtime behavior to the cross-repo static structure (which observed call crosses which seam) ' +
      'requires the workspace fusion; a single-repo tool has no cross-repo seam to attach telemetry to.',
    casFields: ['telemetry', 'runtime_components', 'runtime_links'],
  });


  const w7Emitted =
    graph.risk_areas.length +
    graph.priority_work_items.length +
    graph.quality_flags.length +
    (graph.health ? 1 : 0);
  dims.push({
    key: 'health_risk',
    label: 'Health, risk & priority',
    group: 'W7',
    emitted: w7Emitted,
    examples: take([
      graph.health ? `health: ${graph.health.status} (score ${graph.health.score})` : undefined,
      ...graph.risk_areas.map(r => `risk[${r.severity}]: ${r.title}`),
      ...graph.quality_flags.map(q => `quality-flag[${q.severity}]: ${q.message}`),
    ]),
    campABCannot:
      'Workspace-level risk — an unauthenticated seam between two services, a broken producer/consumer pair — ' +
      'is invisible from inside any single repo; the risk lives in the gap BETWEEN repos.',
    casFields: ['risk_areas', 'priority_work_items', 'quality_flags', 'health'],
  });


  const w8Emitted = graph.system_insights.length + graph.inferred_insights.length;
  dims.push({
    key: 'insights',
    label: 'Insights & inferences',
    group: 'W8',
    emitted: w8Emitted,
    examples: take([
      ...graph.system_insights.map(i => `insight: ${i.title}`),
      ...graph.inferred_insights.map(i => `inferred: ${i.title}`),
    ]),
    campABCannot:
      'System-level insights inferred from the fused cross-repo graph (e.g. "this UI consumes an API with no ' +
      'matching producer") have no source for a tool that never assembles a workspace graph.',
    casFields: ['system_insights', 'inferred_insights'],
  });

  return dims;
}

export async function buildCampWASReport(): Promise<CampWASReport> {
  if (cached) return cached;

  const { graph, repos } = await buildRealWorkspaceGraph();
  const dimensions = buildDimensions(graph);
  const reposCrossed = reposCrossedFromLinks(graph);

  const report: CampWASReport = {
    workspace: WORKSPACE_NAME,
    repos,
    dimensions,
    aggregate: {
      dimensions: dimensions.length,
      totalEmitted: dimensions.reduce((sum, d) => sum + d.emitted, 0),
      reposCrossed,
    },
    outOfCategory: true,
    campABCannot:
      'Every Camp A/B tool (scip, stack-graphs, codebase-memory, embeddings) operates on ONE repo; it has no ' +
      'workspace / application / cross-repo-seam concept, so it emits NONE of the W1–W8 cross-repo facts.',
  };

  cached = report;
  return report;
}

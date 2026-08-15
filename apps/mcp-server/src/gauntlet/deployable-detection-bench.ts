





















































































import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import {
  buildCrossCodebaseSystemGraph,
  type CrossCodebaseInput,
  type CrossCodebaseSystemGraph,
  type SystemApplication,
} from '../cross-codebase-analysis';


export interface ExpectedDeployableBoundaryFields {
  bundled_into?: string;
  boundary_evidence?: string[];
  possible_bundle?: boolean;
}

export type DeployableUnderTest = SystemApplication & ExpectedDeployableBoundaryFields;

const FIXTURES_ROOT = path.resolve(__dirname, '..', '..', 'fixtures', 'deployable-detection');

export interface FixtureCase {
  id: string;
  dir: string;
  workspaceName: string;
}

export const FIXTURES: FixtureCase[] = [
  { id: 'rust-installer-bundle', dir: path.join(FIXTURES_ROOT, 'rust-installer-bundle'), workspaceName: 'rust-installer-bundle-fixture' },
  { id: 'installer-script-only-bundle', dir: path.join(FIXTURES_ROOT, 'installer-script-only-bundle'), workspaceName: 'installer-script-only-bundle-fixture' },
  { id: 'turborepo-2apps', dir: path.join(FIXTURES_ROOT, 'turborepo-2apps'), workspaceName: 'turborepo-2apps-fixture' },
  { id: 'next-fullstack', dir: path.join(FIXTURES_ROOT, 'next-fullstack'), workspaceName: 'next-fullstack-fixture' },
  { id: 'go-cmd-monorepo', dir: path.join(FIXTURES_ROOT, 'go-cmd-monorepo'), workspaceName: 'go-cmd-monorepo-fixture' },
  { id: 'evidence-gated-negative', dir: path.join(FIXTURES_ROOT, 'evidence-gated-negative'), workspaceName: 'evidence-gated-negative-fixture' },
  { id: 'rust-messy-workspace', dir: path.join(FIXTURES_ROOT, 'rust-messy-workspace'), workspaceName: 'rust-messy-workspace-fixture' },
  { id: 'docker-shared-dir-entrypoint-fixture', dir: path.join(FIXTURES_ROOT, 'docker-shared-dir-entrypoint-fixture'), workspaceName: 'docker-shared-dir-entrypoint-fixture' },
];

export interface DeployableDetectionBenchResult {
  fixture: FixtureCase;
  graph: CrossCodebaseSystemGraph;
  applications: DeployableUnderTest[];
}

const cache = new Map<string, DeployableDetectionBenchResult>();

export function _resetDeployableDetectionBenchCache(): void {
  cache.clear();
}

export async function runDeployableDetectionBench(fixtureId: string): Promise<DeployableDetectionBenchResult> {
  const cached = cache.get(fixtureId);
  if (cached) return cached;

  const fixture = FIXTURES.find(f => f.id === fixtureId);
  if (!fixture) throw new Error(`unknown deployable-detection fixture: ${fixtureId}`);

  const cas = await analyzeForBench(fixture.dir);
  const repository: CrossCodebaseInput = { path: fixture.dir, name: fixture.workspaceName, cas };
  const graph = buildCrossCodebaseSystemGraph(fixture.workspaceName, [repository]);
  const applications = graph.applications as DeployableUnderTest[];

  const result: DeployableDetectionBenchResult = { fixture, graph, applications };
  cache.set(fixtureId, result);
  return result;
}


export function topLevelDeployables(applications: DeployableUnderTest[]): DeployableUnderTest[] {
  return applications.filter(app => app.deployable !== false && !app.bundled_into);
}


export function findApplication(applications: DeployableUnderTest[], needle: string): DeployableUnderTest | undefined {
  const n = needle.toLowerCase();
  return applications.find(
    app => app.name.toLowerCase().includes(n) || (app.path_hint ?? '').toLowerCase().includes(n),
  );
}

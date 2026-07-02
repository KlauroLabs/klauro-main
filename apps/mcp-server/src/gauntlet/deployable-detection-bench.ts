/**
 * Deployable-detection fixture matrix + bench.
 *
 * MEASURES the deployable-detection BOUNDARY: given a repo/monorepo, which
 * roots are independently deployable units, which are bundled together
 * (evidence-gated merge, e.g. an installer packaging two binaries), which
 * roll up as shared/internal code (not their own deployable), and which
 * look-alike structures must NOT be split (a single Next.js app with both
 * pages and API routes is one deployable, not two).
 *
 * This is a blackbox bench: it runs a REAL analysis via `analyzeForBench`
 * (apps/mcp-server/src/gauntlet/product-analysis.ts — the same product
 * entry point used by shared-code-rollup-bench.ts and friends) and then
 * calls `buildCrossCodebaseSystemGraph` (the product's own workspace-graph
 * builder, exported from ../cross-codebase-analysis) on the resulting CAS.
 * No engine internals are imported, no AI/model env is set — see
 * docs/KLAURO-PRODUCT-MODEL.md and the blackbox-testing principle.
 *
 * CONTRACT UNDER TEST: `SystemApplication.bundled_into` / `.boundary_evidence`
 * (the evidence-gated merge fields owned by the deployable resolver being
 * built alongside this bench, apps/mcp-server/src/cross-codebase-analysis.ts
 * `applicationSurfaceFromFile`/`applicationSurfaceCandidatesFromCas`). At the
 * time this bench file was authored those fields did not yet exist on
 * `SystemApplication` — the assertions below are written to the EXPECTED
 * contract so the bench is ready the moment the resolver lands. Until then,
 * bundling assertions read `undefined` and fail; see the accompanying test
 * file for which assertions are load-bearing today vs. awaiting the resolver.
 *
 * FIXTURE MATRIX (apps/mcp-server/fixtures/deployable-detection/):
 *   1. rust-installer-bundle — Cargo workspace; bin/client + bin/client-service
 *      packaged by ONE Dockerfile + build-installer.sh; bin/gateway has its own
 *      Dockerfile. EXPECT 2 deployables: client (client-service bundled_into
 *      client), gateway. crates/shared rolls up (not its own deployable).
 *   2. turborepo-2apps — apps/web (Next, own Dockerfile) + apps/api (own
 *      Dockerfile), packages/ui is a shared lib. EXPECT 2 deployables;
 *      packages/ui rolls up.
 *   3. next-fullstack — the look-alike trap: one Next app with app/ pages AND
 *      app/api/ route handlers, ONE Dockerfile/ONE build. EXPECT 1 deployable,
 *      NOT split into frontend+backend.
 *   4. go-cmd-monorepo — cmd/server, cmd/worker, cmd/cli each `package main`
 *      with its own Dockerfile; internal/* libs. EXPECT 3 deployables;
 *      internal/* rolls up.
 *   5. evidence-gated-negative — two sibling apps/*, one with a Dockerfile,
 *      one with NO ship artifact and not imported by the other. EXPECT it
 *      stays a SEPARATE (possibly flagged possible_bundle) application, NOT
 *      forced into bundled_into.
 */

import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import {
  buildCrossCodebaseSystemGraph,
  type CrossCodebaseInput,
  type CrossCodebaseSystemGraph,
  type SystemApplication,
} from '../cross-codebase-analysis';

/** Fields the deployable resolver (agent-B) is expected to add to SystemApplication. */
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
  { id: 'turborepo-2apps', dir: path.join(FIXTURES_ROOT, 'turborepo-2apps'), workspaceName: 'turborepo-2apps-fixture' },
  { id: 'next-fullstack', dir: path.join(FIXTURES_ROOT, 'next-fullstack'), workspaceName: 'next-fullstack-fixture' },
  { id: 'go-cmd-monorepo', dir: path.join(FIXTURES_ROOT, 'go-cmd-monorepo'), workspaceName: 'go-cmd-monorepo-fixture' },
  { id: 'evidence-gated-negative', dir: path.join(FIXTURES_ROOT, 'evidence-gated-negative'), workspaceName: 'evidence-gated-negative-fixture' },
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

/** Deployables not folded into another (bundled_into unset) — the "top-level" ship units. */
export function topLevelDeployables(applications: DeployableUnderTest[]): DeployableUnderTest[] {
  return applications.filter(app => app.deployable !== false && !app.bundled_into);
}

/** Find an application by a case-insensitive substring match on name or path_hint. */
export function findApplication(applications: DeployableUnderTest[], needle: string): DeployableUnderTest | undefined {
  const n = needle.toLowerCase();
  return applications.find(
    app => app.name.toLowerCase().includes(n) || (app.path_hint ?? '').toLowerCase().includes(n),
  );
}

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
 *   6. rust-messy-workspace — the shipped-gate trap: a Cargo workspace with
 *      8 bins. client+client-service are packaged by ONE top-level Dockerfile
 *      + build-installer.sh with ENTRYPOINT=client; gateway and server each
 *      have their OWN Dockerfile; smoke-test/demo-cast/bench-tool/scratch are
 *      plain [[bin]] crates referenced by NO ship artifact anywhere. EXPECT 3
 *      top-level deployables: client (client-service bundled_into client),
 *      gateway, server. The 4 unshipped bins must be deployable:false
 *      (runnable-not-shipped) — RUNNABLE is not SHIPPED. crates/shared rolls
 *      up (not its own deployable).
 *   8. installer-script-only-bundle — the installer-SCRIPT-ONLY bundling trap
 *      (regression lock for the .sh/.bat/.nsi source-inventory gap): a Cargo
 *      workspace with bin/client + bin/client-service, NO Dockerfile at all —
 *      the ONLY bundling evidence is build-installer.sh, which builds both
 *      binaries via a shell function parameter indirection (`local
 *      binary_name=$1; cargo build -p "$binary_name"`), mirroring the real
 *      zerac/poc build-mac-installer.sh pattern. EXPECT 1 top-level
 *      deployable: client (client-service bundled_into client). This proves
 *      .sh files actually reach the deployable-evidence installer provider
 *      via the product source snapshot, independent of any Dockerfile-based
 *      bundling evidence.
 *   7. docker-shared-dir-entrypoint-fixture — the entrypoint-as-primary +
 *      utility-bin-false-positive trap (modeled on a real repo): bin/bina +
 *      bin/binb each have their OWN per-service Dockerfile, both living in a
 *      SHARED docker/ directory; bina's Dockerfile has NO CMD and an
 *      ENTRYPOINT that is a generic wrapper script (entrypoint.sh) rather
 *      than the binary itself, so the real shipped binary must be recovered
 *      from the Dockerfile's sole build-output binary. A separate top-level
 *      Dockerfile bundles bina+binb generically (dev/test convenience image)
 *      and must NOT steal primary attribution from their own dedicated
 *      Dockerfiles. Separately, a Cargo `[[bin]] name = "version"` target at
 *      the repo root shares its bare name with an unrelated `crates/version`
 *      LIBRARY crate (deployable:false) — the two must NOT collide into one
 *      SystemApplication (identity-collision bug) and the bin target itself
 *      must resolve to deployable:false via the shipped-gate (no Tier-1
 *      artifact references it — RUNNABLE is not SHIPPED). EXPECT 2 top-level
 *      deployables: bina, binb (each its own primary, neither is bundled into
 *      the other or into the generic top-level Dockerfile); the version bin
 *      and the version lib crate are both deployable:false.
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

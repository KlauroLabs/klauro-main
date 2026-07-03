/**
 * JVM (Java/Kotlin, Gradle/Maven, Spring Boot) + .NET deployable-detection
 * bench — disjoint from deployable-detection-bench.test.ts (agent-JVM's
 * fabric-coordinated slice of the breadth fan-out).
 *
 * Blackbox: runs the REAL analysis via `analyzeForBench` (the product's own
 * entry point, see product-analysis.ts) and `buildCrossCodebaseSystemGraph`
 * (the product's own workspace-graph builder). No engine internals, no AI
 * env — see docs/KLAURO-PRODUCT-MODEL.md / the blackbox-testing principle.
 *
 * FIXTURES (apps/mcp-server/fixtures/deployable-detection/):
 *   1. spring-multimodule — Gradle multi-module build: apps/orders-service +
 *      apps/billing-service (each its own @SpringBootApplication + main +
 *      Dockerfile), packages/common-lib is a plain library module (no main,
 *      no application plugin). EXPECT 2 top-level deployables; common-lib
 *      rolls up (not its own deployable).
 *   2. dotnet-solution — a .sln with OrdersApi (Microsoft.NET.Sdk.Web,
 *      WebApplication.CreateBuilder/app.Run(), own Dockerfile) +
 *      BillingWorker (OutputType Exe, top-level Program.cs, own Dockerfile)
 *      + Common.Domain (plain class library, no OutputType Exe, not Web
 *      SDK). EXPECT 2 top-level deployables; Common.Domain rolls up.
 */

import * as path from 'path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeForBench } from './product-analysis';
import { buildCrossCodebaseSystemGraph, type CrossCodebaseInput, type SystemApplication } from '../cross-codebase-analysis';

const FIXTURES_ROOT = path.resolve(__dirname, '..', '..', 'fixtures', 'deployable-detection');

interface ExpectedDeployableBoundaryFields {
  bundled_into?: string;
  boundary_evidence?: string[];
  possible_bundle?: boolean;
}
type DeployableUnderTest = SystemApplication & ExpectedDeployableBoundaryFields;

function topLevelDeployables(applications: DeployableUnderTest[]): DeployableUnderTest[] {
  return applications.filter(app => app.deployable !== false && !app.bundled_into);
}

function findApplication(applications: DeployableUnderTest[], needle: string): DeployableUnderTest | undefined {
  const n = needle.toLowerCase();
  return applications.find(
    app => app.name.toLowerCase().includes(n) || (app.path_hint ?? '').toLowerCase().includes(n),
  );
}

async function analyzeFixture(fixtureDir: string, workspaceName: string): Promise<DeployableUnderTest[]> {
  const cas = await analyzeForBench(fixtureDir);
  const repository: CrossCodebaseInput = { path: fixtureDir, name: workspaceName, cas };
  const graph = buildCrossCodebaseSystemGraph(workspaceName, [repository]);
  return graph.applications as DeployableUnderTest[];
}

test('spring-multimodule: orders-service + billing-service are 2 deployables, common-lib rolls up', async () => {
  const applications = await analyzeFixture(
    path.join(FIXTURES_ROOT, 'spring-multimodule'),
    'spring-multimodule-fixture',
  );

  const orders = findApplication(applications, 'orders-service');
  const billing = findApplication(applications, 'billing-service');
  const commonLib = findApplication(applications, 'common-lib');

  // BASELINE: both Spring Boot app modules should be discovered as
  // application surfaces (each has its own @SpringBootApplication + main).
  assert.ok(orders, 'expected an orders-service application surface to be detected');
  assert.ok(billing, 'expected a billing-service application surface to be detected');

  // BASELINE: common-lib is a plain library module (no main, no application
  // plugin) — it should not be flagged as its own deployable.
  if (commonLib) {
    assert.notEqual(commonLib.deployable, true, 'packages/common-lib should not be its own deployable (it rolls up)');
  }

  // Neither app should be bundled into the other.
  assert.equal((orders as any)?.bundled_into, undefined, 'orders-service should not be bundled into anything');
  assert.equal((billing as any)?.bundled_into, undefined, 'billing-service should not be bundled into anything');

  const topLevel = topLevelDeployables(applications);
  const topLevelNames = topLevel.map(a => a.name).sort();
  assert.equal(
    topLevel.length,
    2,
    `expected 2 top-level deployables, got ${topLevel.length}: ${topLevelNames.join(', ')}`,
  );
});

test('dotnet-solution: OrdersApi + BillingWorker are 2 deployables, Common.Domain rolls up', async () => {
  const applications = await analyzeFixture(
    path.join(FIXTURES_ROOT, 'dotnet-solution'),
    'dotnet-solution-fixture',
  );

  const ordersApi = findApplication(applications, 'OrdersApi');
  const billingWorker = findApplication(applications, 'BillingWorker');
  const commonDomain = findApplication(applications, 'Common.Domain') || findApplication(applications, 'CommonDomain');

  // BASELINE: both runnable .csproj projects should be discovered as
  // application surfaces — OrdersApi (Microsoft.NET.Sdk.Web) and
  // BillingWorker (OutputType Exe + top-level Program.cs statements).
  assert.ok(ordersApi, 'expected an OrdersApi application surface to be detected');
  assert.ok(billingWorker, 'expected a BillingWorker application surface to be detected');

  // BASELINE: Common.Domain is a plain class library (no OutputType Exe, not
  // Web SDK) — it should not be flagged as its own deployable.
  if (commonDomain) {
    assert.notEqual(commonDomain.deployable, true, 'packages/Common.Domain should not be its own deployable (it rolls up)');
  }

  assert.equal((ordersApi as any)?.bundled_into, undefined, 'OrdersApi should not be bundled into anything');
  assert.equal((billingWorker as any)?.bundled_into, undefined, 'BillingWorker should not be bundled into anything');

  // determineSystemType() (orchestrator.ts) defaults system.type to
  // 'application' whenever a codebase has no controller/component/package/
  // module CAS node types — true of this C# fixture, since the C# analyzer
  // emits class/method/route node types. That silent default used to leak
  // into isDeployableApplication()'s `systemType === 'application'`
  // fallthrough for the synthetic repo-ROOT "<workspace>" codebase surface,
  // inflating the count to 3. Fixed at the resolver level (phantom-root
  // suppression in suppressWorkspaceContainerRoots(), cross-codebase-
  // analysis.ts): the root surface is now suppressed whenever system.type
  // was defaulted without real evidence AND sibling deployables exist. This
  // genuinely asserts exactly 2 top-level deployables now.
  const topLevel = topLevelDeployables(applications);
  const topLevelNames = topLevel.map(a => a.name).sort();
  assert.equal(
    topLevel.length,
    2,
    `expected exactly 2 top-level deployables (OrdersApi, BillingWorker), got ${topLevel.length}: ${topLevelNames.join(', ')}`,
  );
  assert.ok(topLevel.includes(ordersApi), 'expected OrdersApi to be a top-level deployable');
  assert.ok(topLevel.includes(billingWorker), 'expected BillingWorker to be a top-level deployable');
});

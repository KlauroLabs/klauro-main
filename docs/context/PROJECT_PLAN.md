# Klauro Non-UI Product Plan

## Product direction

Klauro is the understanding and visibility layer for any software system. It turns source structure, framework semantics, product comprehension, runtime evidence, and concurrent work into one trustworthy Code Analysis Specification graph.

The current product program has two active surfaces over the same CAS truth:

- The installed MCP and CLI give coding agents bounded, evidence-backed understanding and change context.
- The hosted analyzer stores analyses, coordinates work across machines, accepts runtime telemetry, and serves the installed client.

The designed human UI is a later sibling surface. It is outside the current beta-readiness scope, but it must consume CAS relationships rather than recreate them.

## Active architecture

- `packages/analyzer-core/` owns source analysis, CAS construction, recursive composition, comprehension, ICELOT, terminality, framework and library intelligence, incremental reuse, and semantic validation.
- `apps/mcp-server/` owns the installed agent product, hosted analyzer service, account and project binding, remote synchronization, Fabric coordination, runtime ingestion, proposal previews, proof gates, and release artifacts.
- `packages/klauro-sdk-js/` and `packages/klauro-sdk-py/` are the supported runtime telemetry SDKs.
- `legacy/` contains reference implementations only. It is not an active customer API, schema, or UI contract.

There is no active NestJS customer API or MikroORM production schema in analyzer-core. Database reference files under legacy paths must not be presented as deployed behavior.

## Delivery priorities

### 1. CAS truth

- Preserve a complete recursive relationship graph at every analyzed scope.
- Derive parent comprehension from child evidence instead of concatenating child labels.
- Keep capabilities, flows, steps, entities, ICELOT, and terminality canonical and referentially complete.
- Make missing, uncertain, stale, and failed analysis visible.

### 2. Agent product

- Resolve the correct analysis from any handed path, including monorepos and analyzed subprojects.
- Provide useful first context before broad source exploration.
- Bound every response with explicit totals, pagination, and truncation state.
- Supply risk, tests, idioms, invariants, and connected behavior before edits.
- Preserve hosted and installed tool-contract parity.

### 3. Fabric collaboration

- Continuously attribute in-flight semantic change to each participant.
- Support overlapping work without blocking or organizing collaboration around locks.
- Surface duplicate work, recreated concepts, contract divergence, and relevant knowledge while work is still in flight.
- Measure merge decisions, surprises, attribution loss, and reconciliation latency.

### 4. Runtime truth

- Persist observations even when no matching analysis exists yet.
- Backfill observations into code, steps, flows, and capabilities when CAS becomes available.
- Preserve disagreement between static and runtime evidence rather than overwriting either side.
- Keep unmatched and uncertain observations queryable.

### 5. External beta readiness

- Prove clean install, account selection, initialization, analysis, updates, recovery, uninstall, and first MCP context.
- Verify local and Linux/VPS behavior across languages, frameworks, repository shapes, and scale classes.
- Ship reproducible artifacts with checksums, version identity, rollback protection, and actionable diagnostics.
- Keep customer documentation limited to implemented and verified behavior.

## Acceptance contract

The non-UI product is beta-ready only when every row in `docs/PRODUCT-READINESS.md` has current direct evidence, all deterministic local and VPS gates pass, live hosted failures are either repaired or explicitly owned external prerequisites, and a clean tester can reach a useful MCP answer without repository-specific assistance.

## Current execution state

Recursive CAS, tier boundaries, canonical comprehension, ICELOT aggregation, generalized terminality, telemetry backfill, Fabric semantic streams, and the installed thin client are implemented with focused proof. Local analyzer and MCP baselines are green. Linux/VPS verification is active. The checkout now resolves to a project owned by the active hosted account; a fresh hosted analysis and broad proof-machine rerun remain before external beta.

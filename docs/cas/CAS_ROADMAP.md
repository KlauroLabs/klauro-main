# CAS Analyzer Roadmap

## Scope

This roadmap tracks analyzer priorities after CAS v1.8.0. Older version-specific plans are preserved in the individual RFP documents. The active product framing is that CAS is the shared truth layer for both the human UI and the agent MCP surface.

## Current Foundation

- Language analyzers for TypeScript/JavaScript, Python, Java, C#, Go, Rust, and PHP.
- Framework analyzers for major web, frontend, testing, Rust, and .NET frameworks.
- Library analyzers for selected database, routing, realtime, state, and data-fetching packages.
- MCP query surface for summaries, nodes, calls, flows, tests, risks, dependencies, libraries, watch mode, and change history.
- Incremental analysis with change detection, file cache, history, and snapshots.
- Runtime-static links that identify telemetry signals and instrumentation candidates.
- Evidence-backed analysis facts with confidence for graph objects and relationships.
- Cross-repository links with confidence and source evidence for APIs, contracts, shared schemas, packages, and database usage.
- Semantic change impact that maps modified code to workflows, capabilities, data entities, runtime links, and contracts.

## Near-Term Priorities

### 1. Trustworthy Relationship Graph

CAS quality is the product foundation. Prioritize fixes that make the graph more complete and more reliable:

- Controller to service to repository call chains.
- Parent/child relationships for methods, functions, components, hooks, and class members.
- Entry point handler links.
- Exit point links for database, API, SDK, file, queue, and cache operations.
- Test-to-code links.
- Import, dependency, and DI relationships.

### 2. Human Verification Surface

The UI must help people inspect what AI-generated and human-written systems actually contain:

- Top-level system overview.
- Drilldown by framework role, flow, module, and node.
- Route and flow tracing.
- Risk, test, security, and data context on selected nodes.
- Clear indicators when CAS data is missing or uncertain.

### 3. Agent Verification Surface

The MCP server should expose the same truth in agent-friendly slices:

- High-signal summaries for orientation.
- Targeted queries for callers, callees, flows, tests, risks, and history.
- Coding context that avoids token-heavy file discovery.
- Change-history and snapshot tools for recent-work awareness.

### 4. Library and Framework Depth

Deepen analyzers where customer code needs richer behavior-level understanding:

- ORM analyzers for entity fields, relations, indexes, queries, and migrations.
- Auth analyzers for guards, roles, providers, and protected paths.
- Frontend data/state analyzers for queries, mutations, stores, contexts, and protected views.
- Messaging and queue analyzers for publishers, subscribers, topics, and payloads.

### 5. Runtime Correlation

Telemetry should validate and enrich the runtime-static links CAS already emits:

- Runtime call frequency.
- Error and latency hotspots.
- Actual traffic through entry points and flows.
- Drift between static expectations and production behavior.
- Promotion of `instrumentable` links to `observed` links when telemetry is present.

## Priority Table

| Priority | Area | Why It Matters |
| --- | --- | --- |
| 1 | Relationship graph correctness | If CAS is wrong, UI and MCP are both wrong |
| 2 | Route/flow tracing | This is the fastest way to prove behavior-level understanding |
| 3 | UI drilldown | Customers need to see what AI-built systems contain |
| 4 | MCP query ergonomics | Agents need focused context without reading every file |
| 5 | ORM/auth/frontend library depth | These are common places where behavior hides |
| 6 | Runtime correlation | Completes the static-to-runtime trust loop |

## Analyzer Design Rules

Library and framework analyzers should:

1. Register with the orchestrator using stable analyzer IDs.
2. Detect themselves from package metadata, imports, configuration, decorators, and file patterns.
3. Enhance existing nodes when possible instead of creating duplicates.
4. Preserve analyzer attribution on contributed metadata and relationships.
5. Emit relationship edges for behavior that downstream surfaces need.
6. Surface uncertainty rather than pretending incomplete analysis is complete.

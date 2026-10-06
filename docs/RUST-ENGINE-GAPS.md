# TypeScript analysis removal: inventory, plan and Rust gaps

Owner rule: remove all analysis code that was in TypeScript. The engine is Rust. Where Rust is missing a piece, record it. No legacy code.

This document is a read-only inventory. No code was changed. The full per-file table is a scratch file kept outside the repository; the figures below come from a static import-graph run over `packages/analyzer-core/src`, `apps/mcp-server/src` and `apps/api/src`, using the same bundle entries that `apps/mcp-server/scripts/build-bundle.mjs` ships.

## 1. How "live" was decided

The live analysis path is `analyzeProject` (`apps/mcp-server/src/analyzer.ts`), then `analyzeWithTierStack`, then the engine binary, then `tierStackToCas`. A module is classed as follows.

| Class | Meaning |
|---|---|
| LIVE | Reachable from a production bundle entry once the orchestrator registration inside `createOrchestrator` is cut. |
| ORCH-ONLY | Reachable only through `createOrchestrator` or the `AnalyzerOrchestrator`. After the rewire in section 4 these are dead. |
| NOT-IN-PROD | Not reachable from any bundle entry. Tests, benches, gauntlets, one-off scripts, or legacy code. |

Confirmed facts about the live path:

- The orchestrator is called for one thing only: `orch.createIncrementalBaseline` at `analyzer.ts:865`. Its result is stored by `saveIncrementalState` and read back by `analysis-freshness-deep.ts` (a tracked-file count) and by `analyzeProjectIncremental`.
- `analyzeProjectIncremental` is not incremental any more. It reloads the previous CAS, calls `analyzeProject`, and diffs with `changesBetween`.
- `analyzer.ts` still builds the whole analyzer registry (about 170 registrations, each lazily `require`d) in `createOrchestrator`. That single function is what keeps 383 files bundled into every hosted artifact.
- `src/server.ts` (8015 lines) is a legacy full MCP server. No bundle entry reaches it; only 10 test files import it. The shipped server is `installed-client-server.ts`.
- `tree-sitter-ts-worker.ts` is a bundle entry of its own but is spawned only by the TypeScript language analyzer, so it dies with the orchestrator.

## 2. Totals

Production TypeScript, test files excluded.

| Area | Files | Lines | Notes |
|---|---|---|---|
| analyzer-core, ORCH-ONLY | 383 | 194,810 | Orchestrator (24,724), 120 framework analyzers (67,954), 40 language analyzers (37,741), 48 library analyzers (23,012), 165 `core/` modules (64,830), packs (830), embedding provider internals (289). Dead once `createOrchestrator` is removed. |
| analyzer-core, NOT-IN-PROD | 39 | 7,524 | Barrel `index.ts` files, `types/index.ts` (1,855), two call-graph extractors (1,971), `ai-analyzer.ts`, `co-change-index.ts`, `entry-point-security.ts`. Dead today. |
| analyzer-core, LIVE analysis | 40 | 13,011 | Query-time modules that compute facts from the CAS. Need a port or a decision (section 3). |
| analyzer-core, LIVE AI and embedding | 16 | 5,489 | `ai/` (4,470) and `analyzer/embedding/` (1,019). |
| analyzer-core, LIVE keep | 32 | 13,396 | CAS types (5,070), tier-stack reader and mapper, storage helpers, build identity, run log. Includes `language-spec.ts` and `idiom-detector.ts` clusters that become dead after two small rewires (section 4). |
| mcp-server `src`, LIVE | 226 | 90,725 | Of which about 30 files and 25,232 lines compute analysis facts (class A), and 18 files and 18,329 lines are query-time modules that may compute (class B). The rest is transport, storage, auth and CLI. |
| mcp-server `src`, NOT-IN-PROD | 200 | 78,692 | Legacy `server.ts` (8,015), 153 bench, proof and gauntlet files (57,894), 46 other files (12,783). |
| apps/api | 2 | 48 | Wrapper only. Not analysis. |
| apps/app, SDKs | 189 | about 11,000 | UI and runtime telemetry SDKs. Not analysis. |

Rough headline: 383 files and 194,810 lines go with the orchestrator, 39 files and 7,524 lines are dead already, and 40 plus roughly 48 files (about 38,000 lines) of live query-time code need a port or an explicit decision. Tests that exist only for deleted code add another 214 files and 36,031 lines, with 160 mixed files (61,128 lines) to triage.

The Rust engine is 53,440 lines under `native/klauro-engine/src` plus more than 100 integration test files with fixtures.

## 3. Inventory by area

### 3.1 The orchestrator and its analyzers (ORCH-ONLY)

| Module group | Lines | What it computes | Rust equivalent |
|---|---|---|---|
| `core/orchestrator.ts` | 24,724 | Runs analyzers, merges contributions, builds the whole CAS, and builds the incremental baseline. | Engine pipeline in `main.rs`. Incremental baseline: MISSING. |
| `core/capability-*`, `domain-extractor`, `ai-domain-recovery`, `text-vocabulary` | about 14,000 | Capability catalog authoring, repair, audience, reconciliation, naming, descriptions. | `capabilities.rs`, `capabilities/supporting.rs`, `comprehend.rs`, `author.rs`, `composition.rs`, `parent.rs`, `jev.rs`. COVERED. |
| `core/tree-sitter-*`, `wasm-tree-sitter`, `native-parse`, `generic-tree-sitter-analyzer`, `language-spec`, `typescript-*`, `javascript-*`, `source-corpus` | about 9,000 | Parsing and node and edge extraction. | `language.rs`, `typescript.rs`, `generic.rs`, `resolve.rs`, `structured.rs`. COVERED. |
| `core/deployable-evidence/*` | about 5,500 | Deployable and shipping evidence. | `scope.rs`, `scope/app_bundles.rs`, `subproject.rs`, `dockerfile.rs`, `bundler.rs`, `published.rs`. COVERED, mobile, JVM and native packaging providers PARTIAL. |
| `core/incremental-*`, `change-detector`, `analyzer-contribution-cache`, caches | about 5,500 | Per-file impact, propagation and reuse. | `facts_cache.rs` only. PARTIAL: no impact or propagation, no baseline state. |
| `core/consistency-model`, `architectural-conflicts`, `paradigm-conformance`, `conventions-applier`, `communication-seams` | about 2,700 | Consistency, conflicts, conformance, conventions, seams. | `conform.rs`, `convention.rs`, `architecture.rs`, `principles.rs`, `practices.rs`, `crossings.rs`. PARTIAL. Conflicts in progress. |
| `core/call-graph-builder`, `call-chain-analyzer`, `canonical-call-chains`, `in-repo-call-resolution` | about 1,700 | Call resolution and chains. | `resolve.rs`, `resolve/typing.rs`, `graph.rs`. Edges COVERED. The `call_chains` section is not emitted. |
| `core/infra-topology-linker`, `external-service-graph`, `service-identity` | about 850 | Infrastructure and external service links. | `services.rs`, `service_catalog.rs`, `crossings.rs`. PARTIAL. HTTP exit URLs in progress. |
| `core/dependency-*`, `manifest-library-detection`, `library-public-api-surface` | about 1,000 | Dependency manifest, roles, library surface. | `dependencies.rs`. PARTIAL. Libraries rollup in progress. |
| `core/git-analyzer` | 473 | Git history facts. | `history.rs`. COVERED for history and churn. |
| `core/module-health`, `coverage-gaps`, `codebase-type`, `artifact-type`, `node-roles`, `structural-importance` | about 2,000 | Health, coverage gaps, codebase type, roles, importance. | `health.rs`, `coverage.rs`, `roles.rs`. PARTIAL. Codebase type and structural importance: MISSING. |
| `frameworks/*` (120 files) | 67,954 | One analyzer per framework: routes, handlers, guards, UI components, jobs. | `entry_exit.rs` with `data/registrars.tsv` (generic registrar patterns), `generic/*.rs` (actix, django, ktor, phoenix, rocket, scala, swift route families), `rails_routes.rs`, `screens.rs`, `typescript/routes.rs`. Route frameworks go through the generic path. See gap G7. |
| `languages/*` (40 files) | 37,741 | Per-language extraction and special analyzers (IaC, protobuf, SOAP, container topology). | `language.rs`, `language_tables.rs`, `dockerfile.rs`, `schema_files.rs`, `tables.rs`. Languages COVERED. IaC, CloudFormation, SOAP and protobuf analyzers: see G9. |
| `libraries/*` (48 files) | 23,012 | ORM, messaging, auth, observability, state, DI, GraphQL, workflow, mocking. | `entities/orm`, `queues.rs`, `messages.rs`, `brokers.rs` (uncommitted). ORM COVERED. Others in progress or MISSING. |
| `packs/*` | 830 | Declarative analyzer packs. | MISSING. `docs/SPEC-ANALYZER-PACKS.md` needs an owner decision. |

### 3.2 LIVE modules in analyzer-core that compute facts (query time)

These are imported by `query.ts`, `product.ts`, `cross-codebase-analysis.ts`, `deployable-analysis.ts`, `agent-adoption.ts` and `description-enrichment.ts`. Each computes a new fact from the stored CAS, so by the working definition each is analysis. Borderline ones are marked B.

| Module | Lines | Computes | Live callers | Rust equivalent |
|---|---|---|---|---|
| `flow-concepts.ts` | 2,684 | Flow concepts, effects, termini from entry-point flows. | query, description-enrichment | PARTIAL: `steps.rs`, `icelot.rs`, flows in `capabilities.rs`. Gap G3. |
| `entry-point-flow-builder.ts` | 1,489 | Per-entry flow walk and labels. | flow-projection, flow-concepts | PARTIAL: `steps.rs`. |
| `idiom-detector.ts` | 1,234 | Codebase idiom detection. Live only for one constant (`EMPTY_CATEGORY_COUNTS`). | tier-stack-evidence | Trivial rewire; detector itself is dead. Idioms arrive from `conform.rs`. |
| `reachability-index.ts` | 539 | Graph reachability index and blast radius. | query, deployable-analysis, partitioner | MISSING in engine (`reach.rs` is AI rate control, not graph reachability). Gap G4. |
| `product-map.ts`, `product-map-flow-linking.ts` | 685 | Product map. | query | MISSING. Gap G4. |
| `behavior-diff.ts` | 520 | Behavioural diff between two analyses. | query | MISSING. Bench: `gauntlet/depth-behavioral-diff-bench.ts`. B. |
| `communication-seams.ts` | 563 | Seam inventory. | tier-stack-seams, cross-codebase | PARTIAL: `crossings.rs`. Gap G2. |
| `data-lineage.ts` | 387 | Entity lineage. | product-map | MISSING. Gap G4. |
| `terminality.ts`, `terminal-signal.ts`, `terminality-scope.ts`, `flow-chain-edges.ts` | 900 | Terminal-entity facts. | deployable-analysis, cross-codebase, query | PARTIAL: `terminality_of` in `capabilities.rs`. |
| `entity-relations.ts` | 632 | Entity relation index. | semantic-roles | PARTIAL: `entities.rs`. |
| `cas-composition.ts`, `recursive-cas.ts` | 354 | Composition of child CAS trees. | cross-codebase, deployable-analysis | PARTIAL: `composition.rs`, `parent.rs`. |
| `semantic-coverage.ts` | 310 | Coverage of understanding. | query | MISSING. B. |
| `understanding-contract.ts` | 296 | Per-node understanding contract. | flow-concepts | MISSING. B. |
| `entry-point-deployable.ts` | 319 | Attaches deployables to entry points. | deployable-analysis | PARTIAL: `scope.rs`. |
| `structural-cross-links.ts` | 223 | Cross-links between structures. | query | MISSING. |
| `framework-comprehension.ts` | 233 | Framework depth report. | query | MISSING. B. |
| `community-detection.ts` | 120 | Communities in the graph. | query | MISSING. Gap G4. |
| `minhash-clone-detection.ts` | 133 | Clone detection. | query | MISSING. Gap G4. |
| `flow-chains.ts`, `flow-merge-by-entry.ts`, `flow-target.ts`, `flow-entry-naming.ts`, `entry-point-flow-projection.ts`, `entry-point-product-role.ts` | about 740 | Flow chains and journeys as query-time projection (doctrine allows). | query, agent-adoption | B: projection over stored flows. Keep as TypeScript read code. |
| `guard-classification.ts`, `guard-relationships.ts`, `exit-point-effects.ts`, `http-route-path.ts`, `capability-flow-evidence.ts`, `unshipped-entry.ts`, `change-risk-evidence.ts` | about 270 | Small classifiers used by the flow modules. | flow modules | B. Move with the flow modules. |
| `graph-validation.ts` | 108 | Integrity counts on nodes and edges. | tier-stack-to-cas | B: derived count, cheap to move into the engine. |
| `link-coverage.ts` | 44 | Link coverage ratio. | tier-stack-seams | B. |
| `language-builtins.ts`, `local-package-import-context.ts` | 457 | Builtin name tables and package import context. | analyzer, flow builder, upload | PARTIAL: `builtins.rs`. |

AI and embedding (LIVE):

| Module | Lines | Role | Rust equivalent |
|---|---|---|---|
| `ai/ai-service.ts`, `ai-cache.ts`, `ai-prompts.ts`, `providers/*`, `element-description-validator.ts`, `semantic-dataset.ts`, `config/ai.config.ts` | about 5,000 | Provider layer for per-element descriptions and the workspace narrative. | The engine asks the bridge itself (`jev.rs`, `budget.rs`, `comprehend.rs`, `author.rs`). The TS layer exists only for `description-enrichment.ts` and `cross-codebase-analysis.ts`. |
| `analyzer/embedding/*` | 1,019 | Embedding providers, vector stores. | MISSING. Gap G6. |

### 3.3 LIVE mcp-server modules that compute facts

Class A means the module computes new facts. Class B means a query-time projection that may compute.

| Module | Lines | Class | What it does | Rust equivalent or target |
|---|---|---|---|---|
| `cross-codebase-analysis.ts` | 12,100 | A | Workspace-level cross-repository graph, seams, narrative, complexity. | MISSING as an engine stage. Gap G5. |
| `query.ts` | 6,076 | B | Query tools. Mixes projection with computation (communities, clones, product map, behaviour diff). | Keep as TypeScript; move computed pieces into the engine (section 3.2). |
| `agent-adoption.ts` | 5,911 | B | Agent context assembly. | Keep as read code. Uses `semanticSearch`. |
| `product.ts` | 2,541 | A | Answer packs, cross-repo links, route and contract drift, journeys across repositories, operational priorities. | PARTIAL: contract shapes in progress. Gap G5. |
| `deployable-analysis.ts` | 1,854 | A | Materialises per-deployable CAS trees. | PARTIAL: `scope.rs`, `subproject.rs`, `composition.rs`. Per-deployable slicing is a projection and can stay. |
| `description-enrichment.ts` | 1,166 | A | AI per-element descriptions, applied after analysis. | PARTIAL: `elements.rs`, `catalog_descriptor.rs`, `comprehend.rs`. |
| `semantic-search.ts` | 741 | A | Embeddings over code. | MISSING. Gap G6. |
| `semantic-roles.ts` | 626 | A | Entity and flow role classification. | PARTIAL: `roles.rs`, `entities.rs`. |
| `coordination/conceptual-conflict.ts`, `contract-intent.ts`, `partitioner.ts`, `intent-merge.ts`, `collision.ts` | about 2,600 | A | Conflict, contract and merge planning over claims. | MISSING. These work on in-flight claims plus the CAS. Owner decision: fabric logic, not source analysis. |
| `greenfield-guidance.ts`, `proposal-preview.ts` | 1,326 | A | Architecture guidance and iteration compare. | MISSING. |
| `analysis-breaking-changes.ts`, `analysis-change-report.ts`, `analysis-engine-delta.ts` | 500 | A | Diffs between two analyses. | MISSING. B in spirit: diff of stored CAS, query-time. |
| `layered-analysis.ts` | 327 | B | L0 index: walks the tree, counts files by language. | PARTIAL: `discovery.rs`, `language_hints.rs`. |
| `idiom-query.ts`, `invariant-validation.ts` | 1,000 | B | Read stored idioms; validation computes violations. | B. |
| `test-discovery.ts`, `test-query.ts`, `graph-test-selection.ts` | 630 | A/B | Tests reaching a node. | PARTIAL: `verification` section from the engine. |
| `change-risk-rank.ts`, `cas-change-risk-rank.ts`, `dead-code-evidence.ts`, `surprising-coupling.ts` | about 280 | A | Small scorers over the CAS. | PARTIAL: `dead.rs`. Others MISSING. |
| `cross-repository-evidence.ts`, `workspace-composition-terminality.ts`, `workspace-contracts.ts`, `workspace-member-resolver.ts`, `incremental-workspace-analysis.ts` | about 680 | A | Workspace joins. | MISSING (G5). |
| `telemetry-fusion.ts`, `runtime-query-overlays.ts` | 380 | B | Join runtime events to the CAS. | B: read-time overlay. |
| `analysis-mastery.ts` | 877 | B | Truth and agent-proof evaluators. | B: evaluation tooling. |
| `source-coverage.ts`, `analysis-scope.ts`, `analysis-focus.ts` | about 750 | B | Filters. | Keep. |
| `analyzer.ts` | 2,316 | B | Run orchestration plus description-preservation guards (`hasStaleNarrativePattern`, `preservePreviousAIDescriptions`). | Keep the run wrapper; the registry body is deleted. The AI-text guards are borderline. |
| `remote-analyzer-service.ts` | 4,466 | B | Hosted service. Transport. | Keep. |
| `entry-point-flow-presentation.ts`, `flow-chain-journeys.ts`, `capability-flow-links.ts`, `query-call-relationships.ts` | about 530 | B | Presentation and journey projection. | Keep (doctrine: journeys are a query-time projection). |

### 3.4 NOT-IN-PROD in mcp-server

Legacy `server.ts` (8,015) imports `entry-point-enrichment.ts`, `entry-point-security.ts` and `co-change-index.ts`; delete all four with it. The 153 bench, proof and gauntlet files are classified in section 5.

## 4. Removal plan, in dependency order

1. Rewire the baseline. Replace `orch.createIncrementalBaseline(...)` at `analyzer.ts:865` with a small TypeScript function that builds `IncrementalState` from the engine's file list (path, content hash, mtime). Preferred: add per-file `hash` to the engine file list and map it in `tierStackToCas`. Consumers to check: `analysis-freshness-deep.ts`, `storage.ts` (`saveIncrementalState`, `loadIncrementalState`), `analyzeProjectIncremental`, `incremental-benchmark.ts`.
2. Cut `createOrchestrator` and `getOrchestrator` from `analyzer.ts` (lines 62 to 676, about 600 lines of registrations) and the imports of `orchestrator`, `language-analyzer-catalog` and every analyzer. `withAnalysisLane` keeps its permit logic but no longer builds an orchestrator.
3. Replace `EMPTY_CATEGORY_COUNTS` import in `tier-stack-evidence.ts` with a local constant. That frees `idiom-detector.ts`, `idiom-data-access.ts`, `glob-cache.ts`, `event-loop-yield.ts`, `build-artifact-paths.ts` (about 1,700 lines).
4. Replace the source-hash fingerprints. `scripts/stage-fingerprints.cjs`, `parser-stage-manifest.json` and `core/stage-fingerprint.ts` hash TypeScript analyzer sources and `native/klauro-parse`. Switch both fingerprints to the engine binary hash and the engine's own data tables. Until then, deleting the analyzers changes the fingerprint and invalidates every stored analysis.
5. Move the source of truth for language tables into Rust. `packages/analyzer-core/scripts/generate-language-tables.mjs` reads `language-registry.ts` and `scaffold-paths.ts` and writes the Rust tables. Make `data/languages.tsv` the source and delete the generator. `language-registry.ts` is still imported by `remote-source.ts`, `upload-scope-guard.ts` and `layered-analysis.ts` (upload scope); either read the extension list from the engine at runtime or keep a pure extension table in the client (not analysis).
6. Delete outright, in one commit: `core/orchestrator.ts` and the 383 ORCH-ONLY files, the 39 NOT-IN-PROD analyzer-core files, `src/analyzer/ast`, `src/analyzer/scripts/python_ast_parser.py`, empty `controllers`, `services` and `patterns` directories, `packages/analyzer-core/temp`, `packages/analyzer-core/cas-tests` (799 MB of outputs and scripts that call the orchestrator), and `native/klauro-parse` together with `verify-native-parser.cjs`, `native-parse.ts`, vendored grammars used only by it, and the copy steps in `build-bundle.mjs`. Check `legacy/` (154 tracked files, 244 MB) for the same.
7. Delete from mcp-server: `server.ts`, `entry-point-enrichment`, `co-change-index`, `gauntlet/coverage.ts` (lists TypeScript analyzers through `getOrchestrator`), `scripts/generate-terminal-public-corpus-receipts.ts` (calls `createOrchestrator().orchestrateAnalysis`), `gauntlet/camp-*`, `camps-bench`, `full-grid`, `camp-a-langs-bench` (they drive the TS tree-sitter analyzers directly), `graph-integrity-gate-cli.ts` (needs `graph-referential-integrity`; re-point to the engine output or drop), `analysis-usefulness-review.ts` import of `external-service-plausibility`.
8. Port or decide the LIVE analysis modules in section 3.2 and 3.3, in this order: modules the tier-stack mapper imports (`communication-seams`, `graph-validation`, `link-coverage`), then those that `query.ts` computes (`reachability-index`, `product-map`, `community-detection`, `minhash-clone-detection`, `behavior-diff`, `data-lineage`, `semantic-coverage`), then the workspace modules, then embeddings. Until a module is ported it stays; the owner rule means each stays only as a tracked gap, not as new work.
9. Delete the TS AI provider layer and `description-enrichment.ts` once the engine writes element descriptions into the CAS.
10. Remove dead dependencies (section 6).

### Rewires and their targets

| Live caller | Calls | Rewire to |
|---|---|---|
| `analyzer.ts:865` | `createIncrementalBaseline` | Engine file list with hash (step 1). |
| `analyzer.ts:476` | `breadthLanguageExtensions` | Delete with the registry. |
| `analyzer.ts` (AI guards) | `isLanguageBuiltinName` | Keep a local set, or read from the engine. |
| `tier-stack-evidence.ts` | `idiom-detector` constant | Local constant. |
| `tier-stack-seams.ts` | `buildSeamInventory`, `linkCoverageOf` | Engine seam output (G2). |
| `tier-stack-to-cas.ts` | `buildGraphValidation` | Engine validation counts. |
| `stage-fingerprints.cjs`, `stage-fingerprint.ts` | TypeScript source hash | Engine binary hash. |
| `generate-language-tables.mjs` | `language-registry.ts`, `scaffold-paths.ts` | `data/languages.tsv` as source. |
| `query.ts` | seven analysis modules | Engine fields (G4). |

## 5. Tests and benches

Counts are by direct imports: a test that imports only orchestrator-cone files tests deleted code.

| Group | Files | Lines | Decision |
|---|---|---|---|
| Tests importing only ORCH-ONLY code (analyzer tests under `__tests__/analyzers`, colocated `*-analyzer.test.ts`, `__tests__/core` for orchestrator internals, parity, compliance) | 214 | 36,031 | Delete with the code. Before deleting, harvest each fixture as a Rust integration test where the engine lacks coverage (section 7 names the covering test per gap). |
| Tests importing both live and ORCH-ONLY code | 160 | 61,128 | Triage per file. Most import `cas.types` plus an analyzer. Convert to engine fixtures or delete. Lists are in the scratch inventory. |
| Tests importing only LIVE code (storage, query, hosted, tier-stack, CLI) | 269 | 60,973 | Keep. They test the product. |
| Tests with no production import (setup, globalSetup, helpers, parity data) | 45 | 8,969 | Delete the parity harness (`extractor-differential-parity`, `parity:extractor`, `jest.parity.config.js`) because it compares the TS extractor to itself. |
| Tests of `server.ts` and other NOT-IN-PROD code | 106 | 12,450 | Delete with the code. |

Benches and gauntlets under `apps/mcp-server/src/gauntlet` and `src/*-benchmark.ts` run through `analyzeForBench` or `analyzeProject`. They test the product and stay, except those named in plan step 7. The messaging, DI, pattern, ORM, auth, GraphQL, component, shared-code rollup, security facts, architectural consistency, depth and interface-signature benches are the acceptance tests for the Rust gaps in section 7; keep them and let them go red until the lanes land.

Scripts to retire: `tier-registry:check` and `tier-registry:update` (`scripts/analyzer-tier-registry.mjs`), `parity:extractor`, `corpus-sweep.mjs` and `framework-sweep.mjs` if they call TS analyzers, `unused-code` scripts if they depend on the analyzer tsconfig exclusions.

## 6. Dependencies that become unused

`packages/analyzer-core/package.json` (and the same entries in `apps/mcp-server/package.json`):

| Package | Reason |
|---|---|
| `tree-sitter`, `tree-sitter-c-sharp`, `tree-sitter-go`, `tree-sitter-javascript`, `tree-sitter-php`, `tree-sitter-rust`, `tree-sitter-typescript` | Imported only from ORCH-ONLY files. Also drop from `nativePackages` in `build-bundle.mjs`, `postinstall` `verify-native-parser.cjs`, and the Dockerfile native install. |
| `web-tree-sitter`, `tree-sitter-wasms` | Used by `wasm-tree-sitter.ts` (ORCH-ONLY) and grammar copying in `build-bundle.mjs`. |
| `@typescript-eslint/typescript-estree`, `@typescript-eslint/parser` | ORCH-ONLY (the TS call-graph extractors). |
| `@babel/parser`, `@babel/traverse`, `@babel/types`, `acorn`, `acorn-walk`, `espree`, `estraverse`, `escodegen` | No production import at all. |
| `js-yaml`, `@types/js-yaml`, `fast-xml-parser` | Used by ORCH-ONLY analyzers only. Check `deployable-analysis` and `klauro-config` before removal. |
| `handlebars`, `isomorphic-dompurify`, `validator`, `dotenv`, `pg-pool`, `joi`, `axios` | No production import. |
| `@anthropic-ai/sdk`, `openai`, `@huggingface/inference` | Live only through the TS AI provider layer; unused after step 9. |
| `ioredis`, `pg` | Live through `ai-cache` and the embedding vector store; unused after steps 8 and 9. |

Keep: `fs-extra`, `glob`, `p-limit`, `p-retry`, `winston`, `zod`, `typescript`, `esbuild`.

## 7. Rust gap list

Marked "in progress" are the items lanes L1 to L5 are porting now. Every other item is a finding from this inventory and has no lane.

| # | Area | Capability TS has that the engine lacks | Covering bench or test | Status |
|---|---|---|---|---|
| G1 | Messaging | Message broker publish, subscribe and consume wiring (`libraries/messaging/messaging-analyzer.ts`, 1,432 lines). | `gauntlet/messaging-bench.ts`, `messaging/*.test.ts`. Engine has `brokers.rs` and `data/broker_calls.tsv` (uncommitted). | in progress |
| G1 | HTTP exits | Outbound HTTP exit URLs and client attribution (`outbound-http-client-analyzer.ts`, `reqwest-analyzer.ts`). | `__tests__/analyzers` HTTP tests, `gauntlet/depth-*` benches. | in progress |
| G1 | DI | Dependency-injection container wiring (`di-container-analyzer.ts`, 798; `mediator-cqrs-analyzer.ts`, 546). | `gauntlet/di-bench.ts`. | in progress |
| G1 | Design patterns | Named design patterns beyond `design_patterns.rs` (`architectural-library-analyzer.ts`, 922). | `gauntlet/pattern-bench.ts`, `architecture-library-bench.ts`. | in progress |
| G1 | Solidity | Security facts (`frameworks/solidity/security-analyzer.ts`, 536; `languages/solidity-analyzer.ts`, 1,059). Engine has `solidity_security.rs` (12 lines, uncommitted). | `gauntlet/security-facts-bench.ts`, `solidity-analyzer.test.ts`. | in progress |
| G1 | Calls | Dart and Elixir call extraction (`dart-analyzer.ts`, 668; `elixir-analyzer.ts`, 894). | `dart-analyzer.test.ts`, `elixir-analyzer.test.ts`, `gauntlet/camp-a-langs`. | in progress |
| G1 | Routes | Clojure and OCaml routes (`compojure`, `reitit`, `dream`). | per-framework `*-analyzer.test.ts`. | in progress |
| G1 | Imports | Workspace imports across packages (`local-package-import-context.ts`, workspace globs). | `workspace-*` tests, `gauntlet/enterprise-hosted-parity.ts`. | in progress |
| G1 | GraphQL | Resolvers and schema (`libraries/graphql-analyzer.ts`, 823). | `gauntlet/graphql-bench.ts`, `graphql-analyzer.test.ts`. | in progress |
| G1 | Render trees | Component render trees (`react-component-analysis.ts`, `vue-*`, `angular-*`). Engine has `render_tree.rs` (uncommitted). | `gauntlet/component-bench.ts`. | in progress |
| G1 | Conflicts | Architectural conflicts (`architectural-conflicts.ts`, 558). | `gauntlet/architectural-consistency-bench.ts`. | in progress |
| G1 | Shapes | Contract shapes and type shapes (`validation-schema-analyzer.ts`, 1,039). Engine has `shapes.rs` (uncommitted). | `gauntlet/depth-contract-drift-bench.ts`, `interface-signature-bench.ts`. | in progress |
| G1 | Libraries | Library exports and the shared-code rollup. | `gauntlet/shared-code-rollup-bench.ts`. | in progress |
| G2 | Seams | Communication seam inventory and link coverage live in TypeScript (`communication-seams.ts`, `link-coverage.ts`) and are called from the mapper. The engine emits crossings only. | `tier-stack-links.test.ts`, `tier-stack-to-cas.test.ts`. | MISSING |
| G3 | Flows | Query-time flow concepts and effects (`flow-concepts.ts`, 2,684; `entry-point-flow-builder.ts`, 1,489). The engine emits flows and steps; the TS recomputes effects and termini. | 26 tests import `flow-concepts`; `gauntlet/depth-taint-bench.ts`. | PARTIAL |
| G4 | Derived graph facts | Communities, reachability and blast radius, product map, data lineage, clone detection, behaviour diff, semantic coverage. None are in the engine output. | `gauntlet/depth-behavioral-diff-bench.ts`, `product-map.test.ts`, `data-lineage.test.ts`. | MISSING |
| G4 | CAS sections | Sections the mapper never fills: `method_calls`, `call_chains`, `decorators`, `documentation_summary`, `todos_summary`, `implementation_health`, `system_health`, `behaviors`, `communities`, `reachability_index`, `structural_importance_meta`, `categories`, `tags`, `security_contexts`, `security_boundaries`, `test_coverage`, `mocks`, `fixtures`, `test_gaps`, `flow_coverage`, `change_risks`, `entry_point_flows`, `data_lineage`, `domain_concepts`, `flow_graph`, `runtime_static_links`, `external_services`, `distribution_units`, `module_health`, `product_map`, `codebase_type`, `coverage_gaps`, `conventions_applied`, `consistency_model`, `dependency_manifest`, `dependency_roles`, `configuration`, `analysis_errors`. For each one, decide: engine emits it, or the section is dropped from the schema. | `__tests__/core/cas-*` shape tests; `gauntlet/response-size-bench.ts`. | MISSING (decide per section) |
| G5 | Workspace | Cross-repository graph, route and contract drift, workspace composition and narrative (`cross-codebase-analysis.ts`, 12,100; `product.ts`; `workspace-*`). The engine analyses one root. | `gauntlet/was-bench.ts`, `camp-was-bench.ts`, `shared-code-rollup-bench.ts`, `cross-codebase-gauntlet.ts`. | MISSING |
| G6 | Embeddings | Embedding providers, vector stores and semantic search (`analyzer/embedding/*`, `semantic-search.ts`). | `semantic-retrieval-benchmark.ts`, `gauntlet/search-quality-bench.ts`. | MISSING; owner decision, since the product direction names speed from the engine and no paid API |
| G7 | Route frameworks | Per-framework route analyzers (about 60) are replaced by generic registrars and a few route families. No engine rule names Sanic, Starlette, Tornado, Vert.x, Quarkus, Micronaut, JAX-RS, Vapor (partly via `swift`), Warp, Crow, Drogon, Kemal, Mojolicious, Genie, Apex REST, GoRouter, Shelf, Akka HTTP, http4s, SolidStart, AngularJS. Coverage is unverified, not necessarily absent. | Per-framework colocated `*-analyzer.test.ts` and `gauntlet/framework-bench.ts`; run each fixture through the engine. | PARTIAL, unverified |
| G8 | Non-route semantic analyzers | Airflow, Dagster, Prefect, Luigi (DAG tasks), Jupyter notebooks, ML training, WPF and Blazor UI, CI pipeline (`ci-pipeline-analyzer.ts`, 1,101), Unity, Unreal, Godot, Arduino, kernel modules, WordPress hooks, Electron and Tauri IPC (`ipc` registrar exists), Redux, Zustand, Socket.IO, tRPC, TanStack Query, workflow engines (`workflow-analyzer.ts`, 1,311), OpenAPI specs, cron, observability, auth libraries, mocking (`mocking-library-analyzer.ts`, 935), Jest and Cypress test-framework analysis (`jest-analyzer.ts`, 1,208; `cypress-analyzer.ts`, 1,047). | colocated `*-analyzer.test.ts`; `gauntlet/auth-bench.ts`, `orm-bench.ts`. | MISSING unless noted; `verification` section covers test cases only |
| G9 | Language specials | CloudFormation, Terraform, IaC (`iac-analyzer.ts`, 1,193), protobuf (877), SOAP and WSDL (1,108), container topology (1,096), reverse proxy (992), distribution artifacts (533), JSON file stores (402), shell (727), CLI (664). Engine has `dockerfile.rs`, `schema_files.rs`, `service_catalog.rs`. | colocated tests of the same names. | PARTIAL |
| G10 | Incremental | Per-file baseline state, impact, propagation and contribution refresh. The engine has `facts_cache.rs` only. | `incremental-*.test.ts`, `incremental-benchmark.ts`, `analysis-scale-benchmark.ts`. | PARTIAL; baseline needed for freshness (plan step 1) |
| G11 | History | Co-change index (`co-change-index.ts`). `history.rs` has churn and fix commits only. | `co-change-index.test.ts`. | PARTIAL |
| G12 | Entry security | Entry-point security and interaction-reach enrichment (`entry-point-security.ts`, `entry-point-enrichment.ts`). Both are reached only from legacy `server.ts` today, so no live loss. | tests of the same names. | PARTIAL (guards exist) |
| G13 | Analyzer packs | Declarative packs (`packs/`, 830 lines). | `pack-*.test.ts`, `docs/SPEC-ANALYZER-PACKS.md`. | MISSING; owner decision |
| G14 | Source of truth | Language and scaffold tables are generated from TypeScript into Rust. | `generate-language-tables.mjs`. | rewire (plan step 5) |
| G15 | Fingerprints | Stage fingerprints hash TypeScript sources. | `stage-fingerprint.test.ts`. | rewire (plan step 4) |

## 8. Risky rewires

1. Stage fingerprints (step 4). A fingerprint change invalidates every stored analysis, so do it once, in the same release that removes the orchestrator, and confirm that stored analyses are recomputed rather than served stale.
2. Incremental baseline (step 1). `analysis-freshness-deep` and the warm path read `incremental-state*.json`; a missing or empty baseline must read as "unknown", not "fresh".
3. `query.ts` fan-in (G4). Seven analysis modules are computed per query on the hosted query worker. Moving them to precomputed engine fields changes the CAS shape and storage size; check `response-size-bench` and the query-worker memory budget.
4. Language-table generator (step 5). The Rust tables are generated from the TypeScript registry; deleting the registry first breaks the engine build.
5. Hosted build (`build-bundle.mjs --hosted`). It requires the native parser and engine binaries and copies `klauro-parse` and grammars; update the probe and the copy steps in the same change or the hosted build aborts.
6. Mixed tests (160 files). Deleting them hides regressions in the live code they also cover; split before deleting.
7. `analyzer.ts` AI-description guards (`preservePreviousAIDescriptions`, `hasStaleNarrativePattern`). They shape stored text across runs. Keep them until descriptions come from the engine.

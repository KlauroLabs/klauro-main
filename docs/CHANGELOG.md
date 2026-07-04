# Changelog

All notable changes to Klauro are recorded here. Entries are grounded in commits, test runs, or
agent-feedback reports (`~/.klauro/agent-feedback/*.md`) — nothing is asserted without a source.
Where an item was still in flight at the time this entry was written, it is marked **pending
final verify** rather than presented as done.

## v1.0.16 — Correctness wave 2: honest identity, coverage, evidence-gating (2026-07-04)

A second parallel wave off the adversarial analysis audit. Every agent reproduced-before-coding and
several disproved their own premise. Full gate green: tsc both packages, analyzer-core 877 jest,
touched mcp-server suites; node-http validated on real repos.

### Fixed / Added

- **Hash names never leak into identity, and the REAL name is recovered.** Production analyses write
  the source to a hash-named workspace dir; `path.basename(projectPath)` fallbacks echoed that hash
  into `deployable_evidence[].name`, `system.name`, idiom `claim` text, and container `service_aliases`.
  Now: a `safeDeployableName` guard (never emit a hash) **plus** a real `displayName` threaded
  end-to-end (remote-analyzer-service → orchestrator → 24 evidence-provider fallback sites) so the name
  is *correct*, not just a placeholder. zerac-ui: `b4d1b9a5fa2fab1c` → `@zerac-ui/source` / `zerac-ui`.
- **Honest file counts.** `technologies.languages[].files` was an AST-node count (5.9–15.7× inflated);
  now a distinct-source-file count (zerac-api 11,668 → 759, exact vs ground truth), with monorepo
  abs/relative double-count fixed.
- **Raw Node `http.createServer` analyzer** — previously invisible; now surfaces real routes as entry
  points (kontinuum 0→161, soon-bos 0→5). Evidence-based; dynamic dispatch honestly partial, never faked.
- **ORM attribution import-gated** — MikroORM `EntityManager` was mislabeled "TypeORM" by bare-symbol
  regex; now attributed by real import source (added a MikroORM rule; zerac-api 20 nodes corrected).
- **Production snapshot dropped config YAML** — `remote-source.ts` excluded non-manifest `.yaml`/`.yml`
  (`config/routes.yaml`, `security.yaml`) that Symfony/container-topology/gorouter/Kemal analyzers read;
  now included (dead misleading `SOURCE_EXTENSIONS` set removed).

### Known follow-ups (honest)
- File-walk coverage shortfall on large repos (this repo parses ~875 of ~1,240 files) — a separate,
  pre-existing gap surfaced by the file-count fix.
- soon-bos raw-HTTP routing is dynamic; node-http resolves 5 of ~228 (honest partial).

## v1.0.15 — Fleet hardening: fabric race-safety, honest analysis, token efficiency (2026-07-04)

A six-agent parallel "make it flawless" wave (coordinated through the fabric one of them was
simultaneously hardening). Every agent reproduced-before-coding and several found bugs worse than
the one they were sent after. Full gate green: tsc both packages, analyzer-core 855 jest + 132 node,
mcp-server coordination/query/registration/response 173.

### Fixed

- **Fabric race-safety (found a bug worse than the target).** `grant-manager`'s own "one grant per
  symbol" invariant was violated **100/100** under a concurrent-request repro (both callers passed
  the conflict check before either wrote — the enforcement path agents rely on). `releaseAgent` had a
  matching TOCTOU (unlocked read then append → silent no-op release). Both fixed with an atomic
  `withWorkspaceLock` critical section (0/100 post-fix). `fab release` against the wrong `FAB_WS` now
  warns + exits non-zero instead of silently "succeeding."
- **Fabricated route rows.** `buildRouteTable` emitted fake `GET /` rows from NestJS `app.listen()`
  bootstraps; now requires `trigger.path` (zerac-api 327→323, 0 bogus, all real routes still resolve).
- **Express under-detection.** `canAnalyze` missed `import * as express` and destructured `Router` →
  a real Express repo went 0→3 routes, resolving to real handlers.
- **Dead-registration footgun consolidated.** Three analyzer-registration lists → one live path
  (`analyzer.ts` `createOrchestrator`); the other two (unused `frameworks/index.ts` helpers,
  never-bootstrapped legacy NestJS `cas-analyzer.service.ts`) marked/removed. Found `McpToolRegistrationAnalyzer`
  **silently dead** (registered only in a dead list → never ran in prod despite green tests); wired
  live + added a guard test that fails if any analyzer isn't in the live path.
- **Token blow-up.** Untargeted `get_flow_concepts` returned one flow per entry point — measured
  **1,133 flows / ~467,618 tokens** in a single response. Now capped at 15 (untargeted) with explicit
  `total_available`/`truncated`/`gaps` — **>92× smaller (467k→5k), full I/L/S/O preserved**. Plus
  `get_agent_context` bounded counts + de-duplicated risk context.
- **Corpus-harness OOM.** A 39k-node CAS caused a V8 *fatal* (uncatchable, under the try/catch);
  fixed via heap re-exec + early buffer release. Self-repo (39,298 nodes) + openclaw (76,307) now
  sweep clean.

## v1.0.14 — Fastify + scheduled-job coverage (2026-07-04)

Closes the last residual from the v1.0.13 corpus re-validation (`finance-context-ts` under-detected).
The residual turned out not to be workspace-discovery (apps already had manifests) but two missing
analyzers, found by dogfooding. Full suite green (849 jest + 132 node); no regressions.

### Added

- **Fastify route analyzer** (`packages/analyzer-core/src/analyzer/frameworks/web/fastify-analyzer.ts`).
  Express-only route detection meant `@fastify/*` apps had **zero** visible routes. Now extracts
  `fastify.get/post/…`, `fastify.route({…})`, the TS-generic form, and multi-level
  `fastify.register(plugin, {prefix})` plugin-encapsulation chains (import/export graph + BFS, incl.
  same-file non-exported plugin wrappers). Emits `http` entry points; `route_table` derives for free.
  `finance-context-ts`/`apps/ext-web-api`: **1 → 50 entry points (45 HTTP routes)**, spot-checked
  byte-exact incl. 3-level prefix chains and auth flags.
- **Scheduled-job entry-point detector** (`packages/analyzer-core/src/analyzer/libraries/cron-analyzer.ts`).
  `cron` `CronJob`, `node-cron` `schedule()`, and `@nestjs/schedule` `@Cron`/`@Interval`/`@Timeout`
  now emit `type: 'schedule'` entry points (handler = the job fn, schedule expr as metadata) — real
  flow roots. `apps/scheduler`: **1 → 7** entry points; zerac-api gained 5 legitimate `@Cron` roots
  (no regression to its 327 HTTP routes). `get_flow_concepts` now roots flows at Fastify routes and
  cron jobs. Source: `~/.klauro/agent-feedback/2026-07-04-fastify-cron.md`.
- **Defensive**: workspace-glob member discovery (pnpm/turbo/nx globs) for the latent
  "glob declares a member with no own package.json" shape (not present in the local corpus), with a
  guard against re-triggering the v1.0.13 Dockerfile-boundary bug.

### Noted (follow-up)

- The live analyzer registration is `apps/mcp-server/src/analyzer.ts`; **two other registration lists
  exist and are dead paths** — flagged for consolidation.

## v1.0.13 — Backend flow accuracy (2026-07-04)

Three analyzer-correctness fixes found by dogfooding the v1.0.12 conceptual layer on real repos —
together they turn flows from frontend-shallow into honest end-to-end backend traces, especially on
monorepos. Full suite green (56/56 jest suites, **839** tests; tsc clean both packages).

### Fixed

- **Monorepo blindness** (`orchestrator.ts`, `language-registry.ts`). `discoverProjectRoots` treated
  any directory containing a `Dockerfile`/`Containerfile` as an independent nested project, so in
  Nx/Turborepo/pnpm-workspace monorepos every `apps/*` (Dockerfile, deps hoisted, no nested
  `package.json`) was misclassified and **excluded from analysis entirely** — every backend
  controller silently invisible. New `isPackageBoundaryManifest()` excludes deploy-tooling manifests
  from defining a boundary. zerac-api: `entry_points` **12 → 519**, HTTP routes **0 → 327** (323/327
  resolved to real controller methods), `get_flow_concepts` **257 multi-step flows** now rooted at
  real HTTP routes instead of a synthetic file-level fallback.
  Source: `~/.klauro/agent-feedback/2026-07-04-route-entrypoints.md`.
- **DI-injected call resolution** (`typescript-javascript-analyzer.ts`). `this.<field>.<method>()`
  where `<field>` is a constructor-injected dependency fell through to a name-guessing heuristic
  instead of type resolution. New `resolveDiFieldCall()` resolves field → declared type → class →
  method (evidence-gated; ambiguous cases fan out tagged, never guessed). zerac-api: **+788** real
  service→repo call edges; on this repo, services like `OrganizationsService.findAll` went 0 → real
  callers. (Honest byproduct: `AnalysisRepository.create` correctly stayed 0 callers — it is genuine
  dead code here.) Source: `~/.klauro/agent-feedback/2026-07-04-callgraph-di.md`.
- **Fabricated DB side-effects** (`typescript-javascript-analyzer.ts`). `isRepositoryCall` treated
  ORM method names (`findAll`/`persist`/`flush`/…) as DB-repository calls regardless of receiver,
  inventing `exit_db_*` side-effects on plain service methods — corrupting the I/L/S/O `side_effects`
  contract flows surface. Now receiver-gated on real repository/ORM type evidence. zerac-api: 9
  confirmed fabrications removed, 140 real DB accesses correctly (re)attributed.
  Source: `~/.klauro/agent-feedback/2026-07-04-repocall-fix.md`.

### Added

- **One-stop deploy** (`infrastructure/vps/deploy.sh`, `npm run deploy`): build → sync → rebuild →
  fail-loud verify (`/health`, `/dist` version, tarball HTTP), with a guard that refuses to ship a
  `docker-compose.yml` missing the `/opt/klauro/downloads` mount. `--with-release[=…]` chains the
  version cut; `--skip-app-build`/`--no-verify` flags.

## v1.0.12 — Conceptual understanding layer (2026-07-04, live on `mcp.klauro.com`)

Cut and deployed 2026-07-04 (bumped from v1.0.11 `5292d01f`; tagged `v1.0.12`). Live-verified:
`/health` ok, running version 1.0.12, `/dist/latest.json` 1.0.12 + tarball HTTP 200. **199**
registered tools (`get_flow_concepts` + `get_unified_perspectives` added, up from 197 at v1.0.11).
Converged gate green on the merged tree: tsc clean both packages, analyzer-core **828/828** jest,
coordination **108/108**, `fabric-fleet-proof` all **6** properties. Built in one parallel session
of 7+ agents coordinating through the fabric (co-editing `orchestrator.ts`/`server.ts` clean).

### Added

- **`get_flow_concepts` — the conceptual flow/step tier.** New MCP tool and analyzer
  (`packages/analyzer-core/src/analyzer/core/flow-concepts.ts`) computing the behavioral
  hierarchy Capability → Flow → Step → Function over the existing CAS graph, per
  `docs/SPEC-CONCEPTUAL-LAYER.md`: each Flow and Step carries a uniform I/L/S/O + Constraints
  contract (side-effects split into `state_changes` vs. `external_integrations`), Steps map to
  functions 1:1, 1:many, or a sub-section of one function, and Flows link to
  `system_capabilities`/`data_entities` only via direct structural match — never guessed by name
  similarity. Deterministic-first; the only AI seam (`opts.nameStep`) is inert when omitted.
  7/7 new unit tests passing (`flow-concepts.test.ts`). Verified against a real 11,881-node CAS
  (`~/dev/zerac/zerac-api`): traced two coherent 3-step flows (route → component → hooks).
  Source: `~/.klauro/agent-feedback/2026-07-03-flow-concepts.md`.
- **Fabric conceptual vocabulary — coordination now speaks flow/step/capability/entity.**
  `apps/mcp-server/src/coordination/` gained a `ConceptualCoordinate` type and
  `conceptual-scope.ts`, wired additively into `claim_work`, `check_collision`, and
  `plan_parallel_work`: claims auto-derive their flow/step/capability coordinate from
  paths/symbols via a real `getFlowConcepts` call (declared values still win when supplied), and
  every response now carries `concept`/`concept_awareness` unconditionally, not just on collision.
  The comparison classifier treats same-flow/different-step as `'awareness'` (non-blocking) and
  same-step, or different-flows-same-entity-constraints, as `'conceptual_conflict'` (advisory —
  never gates the literal grant). Verified with a real two-flow CAS (Checkout/Refund sharing an
  `Order.total must be positive` invariant): correctly flagged a cross-file conceptual conflict
  between two agents who never touched the same file. 10 new tests in
  `conceptual-scope.test.ts` + 4 in `partitioner.test.ts`; full coordination suite 113/113 passing,
  zero regressions. Source: `~/.klauro/agent-feedback/2026-07-03-conceptual-vocab-fabric.md`.
- **Conceptual UI.** New "Conceptual" tab in the real app SPA (`apps/app`) — a three-column
  Flows → Steps → Contract drill-down (`ConceptualView`) plus a `StructuralPerspectivePanel`
  showing architectural conflicts, paradigm conformance, and raw perspectives side by side. New
  backend route `GET /api/projects/:id/conceptual` in `remote-analyzer-service.ts`, additive only.
  Verified against real stored analysis for `~/dev/zerac/zerac-api` (e.g. an "Organizations" flow
  → capability → 3 ordered steps, 1:many mapped to 5 hook-usage functions; 4 architectural
  conflicts + 18 principle violations against real controller files). `apps/app` build clean
  (232KB bundle), no existing route/page altered.
  Source: `~/.klauro/agent-feedback/2026-07-03-conceptual-ui.md`.
- **Consumer-teaching surfaces updated for the conceptual layer + parallel-by-default fabric.**
  `SERVER_INSTRUCTIONS` (server.ts), `docs/mcp/CLAUDE-MD-PROMPT.md`, `docs/mcp/USAGE.md`, the
  installed agent skill/bootstrap templates (`agent-bootstrap.ts`, `agent-defaults.ts`,
  `agent-workflow.ts`) all now teach the Capability→Flow→Step→Function drill path
  (`get_summary` → `get_flow_concepts` → `get_coding_context`/`get_call_chain`) and state
  parallel-through-the-fabric as the default coordination posture, not a fallback for when work
  collides. Grep-verified landed in all four surfaces; `createServer()` boots clean; only
  description/prose strings touched, no tool registration changed.
  Source: `~/.klauro/agent-feedback/2026-07-03-consumer-teaching.md`.

### Added (continued) — verified & shipped in v1.0.12

The following were in flight when this entry was first drafted; all landed, were verified, and
ship in v1.0.12.

- **Registration/entry-point → real-handler edge-linking** (`orchestrator.ts`/`react-analyzer.ts`/
  `ai-stack-analyzer.ts`/`mcp-tool-registration-analyzer.ts`) — closes the substrate gap
  `get_flow_concepts` flagged honestly (React `hook_usage` nodes and this repo's own
  `entry_mcp_tool_*` markers had no outgoing call edge to the function they invoke, so flows
  degraded to shallow single steps). Handlers are resolved by exact-name match only; ambiguous or
  unresolved candidates get no edge (never fabricated). Real before/after: Klauro self
  **0/198 → 198/198** mcp-tool entry points with outgoing `calls` edges (system-wide single-step
  flows ~200 → 3); zerac-api **0/24 → 24/24** React Query hooks resolved to real fetchers, 5/8
  flows now with populated `external_integrations`. **822/822** jest, 122/122 node tests.
  Source: `~/.klauro/agent-feedback/2026-07-03-registration-edge-link.md`.
- **Structural-perspective unification** — `get_unified_perspectives` (new tool) plus
  `structural-cross-links.ts`: a Flow/Step now carries its architectural layer + paradigm
  deviations, and an architectural conflict resolves to the flows/steps/capabilities it touches
  (bidirectional, evidence-gated — link omitted when no genuine overlap). 6/6 new tests.
  Source: `~/.klauro/agent-feedback/2026-07-03-structural-unify.md`.
- **Flow entity derivation** — `deriveCapabilityOperationRoots` in `flow-concepts.ts` seeds flow
  roots from `system_capabilities[].operations[]` (the real blocker was call-graph reachability,
  not an id namespace — proven empirically). zerac-api: **0 → 171/1261** lifecycle touchers
  resolved, **0 → 83/206** flows now carry real derived entities (e.g. `setBillingModel` →
  `['Partner','Billing']`) — making the cross-flow same-entity conceptual conflict reachable by
  *derivation* on a real repo. Step-level `entities` added. 13/13 tests.
  Source: `~/.klauro/agent-feedback/2026-07-03-flow-entities.md`.
- **End-to-end fabric fleet proof** — `apps/mcp-server/src/gauntlet/fabric-fleet-proof.ts` +
  `docs/FABRIC-FLEET-PROOF.md`: all 6 properties (ambient awareness, non-blocking parallelism,
  cross-file conceptual-conflict catch, dedup, conceptual partitioning, honest fabric-vs-no-fabric
  contrast) demonstrated on real flow ids from a real analysis. Re-run green on the converged tree.
  Source: `~/.klauro/agent-feedback/2026-07-03-fabric-fleet-proof.md`.
- **`fab` release fix** — `releaseAgent()` in `local-store.ts` releases ALL of an agent's active
  claims by `agent_id` (the CLI `claim`/`release` used mismatched claim_id schemes, so finished
  agents lingered as `active` and produced false-overlap noise). Dogfood-CLI only; the product
  `release_work` path was unaffected. Test added.
- **Hash/id-token domain-naming guard hardening** (`orchestrator.ts`) — continuation of the
  v1.0.11 corpus hash-domain fixes; shipped.

## v1.0.11 — 2026-07-03 (commit `5292d01f`)

Corpus-validation hardening from the `~/dev` real-repo sweep (`docs/CORPUS-VALIDATION.md`):

- Fixed deployable over-count from a route-path-keyed dedupe (`collectServerEntries` now dedupes
  by `rootPath`, not `rootPath::routePath`) — 432→16 evidence rows on the affected repo, 15% of
  the 33-repo corpus was affected. Commit `a257f30b`.
- Fixed a name-corruption bug in distribution-artifact naming (`productNameFromFile`'s unanchored
  regex stripped `install` out of `Uninstall.bat`) plus an NSIS `${VAR}` template-leak fix.
  Commit `a257f30b`.
- Fixed a hash-suffixed garbage domain/deployable name: `isGenericDomainToken` gained a
  hash/id-shape guard (`isHashOrIdShapedToken`) so a content-hash or generated ID surviving as the
  top terminal token no longer composes into `<hash>-management`; a hostname-shaped token guard
  (`isHostShapedToken`) was added alongside it. Commits `8777a22c`, `3a177d4b`.
- `corpus-sweep.ts` harness added (blackbox, resumable): first scorecard 33 repos analyzed
  (5 standalone + 28 sub-repos across 3 workspaces, including an 89 GB workspace with a 61 GB
  `target/` directory correctly excluded), 0 crashes.

See `docs/CORPUS-VALIDATION.md` for full methodology and `docs/COMPETITIVE-PROOF.md` for the
284-win/3-tie/0-loss competitive scorecard shipped in this release line.

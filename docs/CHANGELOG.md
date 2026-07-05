# Changelog

All notable changes to Klauro are recorded here. Entries are grounded in commits, test runs, or
agent-feedback reports (`~/.klauro/agent-feedback/*.md`) — nothing is asserted without a source.
Where an item was still in flight at the time this entry was written, it is marked **pending
final verify** rather than presented as done.

## v1.0.24 — Entry-point parity guard + live analyzer-packs + telemetry backfill (2026-07-05)

### Fixed
- **Entry-point type drift, permanently.** `isValidEntryPoint` now derives its accepted set from a single
  `ENTRY_POINT_TYPES` const that the `CASEntryPoint['type']` union is itself built from — so adding a kind
  can never again be silently dropped by a separate hardcoded allowlist (the bug that hit type-data-ML and
  cat-api). A parity guard test round-trips all 21 kinds through the real merge; dead `grpc`/`graphql` and
  never-emitted allowlist entries removed. (`isValidExitPoint` carries the same latent drift but its
  allowlist and union genuinely diverge with cast-emitted types — deferred to avoid dropping working exit
  points.)

### Added
- **Declarative analyzer-packs are live.** `PackAnalyzer` is wired into the production orchestrator, driven
  by built-in packs + a `.klaurorc` `packs:` glob. Proven end-to-end through `analyzeForBench`: **Hapi**
  (which has NO coded analyzer) yields 0→**3** real route entry points from pure `hapi-routes.pack.yaml`,
  Koa 0→2; a repo with no packs is unaffected. Any language/framework is now coverable by a YAML declaration.
- **Telemetry backfill + MCP parity.** Persisted `unmatched` runtime observations re-correlate to CAS nodes
  once an analysis appears (triggered after `saveAnalysis` and lazily in `get_runtime_observations`), and
  `route_metrics` is now returned by the `get_runtime_observations` MCP tool (HTTP↔MCP parity). So Klauro's
  self-telemetry auto-upgrades from route-level to **node-level** the moment its own source is analyzed.

## v1.0.23 — Telemetry durability: persist raw, correlate lazily (2026-07-05)

Found by dogfooding self-telemetry on Klauro's own production: ingest **dropped the entire batch**
when the project had no prior analysis (`No analysis found → dropping batch`, once per request), and the
SDK's HTTP ingest route 404'd and requeued forever. Telemetry should never be lost because the code
isn't analyzed yet.

### Fixed
- `ingestTelemetryBatch(cas: CASOutput | null, …)` — a null CAS is now valid: raw runtime observations
  (route/method/status/duration/error/timestamp) **persist verbatim** to the same store
  `loadTelemetryObservations` reads; correlation to CAS nodes happens lazily when an analysis exists (the
  with-analysis fusion path is unchanged, no regression). The self-loop no longer drops or log-spams; the
  SDK route `POST /api/telemetry/runtime-events/:projectId` acks **200** instead of 404.
- New `summarizeRouteMetrics()` — CAS-free per route+method aggregation (request_count / error_rate /
  p50 / p95 / p99 / max), surfaced additively as `route_metrics` on `GET /v1/telemetry/observations` so
  traffic + latency are visible **before** a project is analyzed.

## v1.0.22 — Telemetry read-back + ingest reconcile + self-telemetry on Klauro itself (2026-07-05)

Closing the v1.0.21 telemetry follow-ups + turning the self-loop on.

### Added
- **Runtime-observation read API** on the deployed analyzer service: `GET /v1/telemetry/observations`
  (raw observations, no CAS required) and `GET /v1/telemetry/node-metrics` (per-node traffic /
  error_rate / p50-p95-p99 latency / status distribution, correlated to CAS nodes when an analysis exists).
- **Self-telemetry enabled on Klauro's own infra** — `KLAURO_SELF_TELEMETRY=1`,
  `KLAURO_SELF_TELEMETRY_PROJECT=/opt/klauro/source`, in-process transport. Klauro now emits its own
  runtime signal, correlated to its own static graph — the product dogfooding itself.

### Fixed
- **SDK↔server ingest-path reconcile (P1):** `POST /api/telemetry/runtime-events/:projectId` (the path the
  SDK actually POSTs) now routes through the same ingest as the self-loop. It was structurally unreachable —
  the `/api/` prefix is a reserved account-session namespace whose guard 401'd before any telemetry handler
  ran; fixed by intercepting the telemetry path above that guard with analyzer-auth. The installable SDK now
  ingests against a real server instead of 404-ing.

## v1.0.21 — Coverage explosion + installable telemetry + self-improving intelligence (2026-07-05)

The largest single-session expansion. A ~14-agent heterogeneous fleet (Claude + Codex on one
coordination fabric) landed with **zero lost work**: tsc both packages 0 errors, analyzer-core 999
jest, mcp-server touched suites 36/36, live-registration guard 2/2, and — dogfooded —
`validate_codebase_idioms` reports **0 violations** across 113 files / 15 new analyzer dirs (the
coverage surface reads as one author).

### Added — codebase-type coverage (any codebase, not just web backends)
Desktop (Electron/Tauri IPC + commands), game (Unity/Unreal/Godot lifecycle), embedded/systems
(C/Arduino/kernel-module ISR + driver hooks), data/ML (Airflow/Dagster/Prefect/Luigi/Jupyter/ML-training),
frontend component-depth (React/Vue/Angular/Svelte event entry points — 0→173 on real zerac/client-ui),
library public-API entry points. New `CASEntryPoint` kinds: `ipc`, `command`, `interrupt`, `driver`,
`task`, `pipeline`, `notebook-cell`, `train`, `rpc` (all cooperatively added to one union across ~13
agents, no clobber).

### Added — architectural library coverage
DI containers, mediator/CQRS, reactive streams (RxJS/Reactor/RxJava/Combine), state
(MobX/Recoil/Jotai/Pinia/NgRx/XState), ORM ×9 (Sequelize/Knex/Objection/Diesel/SeaORM/GORM/sqlx/ent/Dapper),
validation schemas (Zod/Yup/class-validator/Joi/Ajv/Marshmallow/Cerberus — zerac-api 96 contracts),
outbound HTTP clients (axios/got/ky/requests/httpx/RestTemplate/Feign/…), **testing frameworks** (~15),
**mocking/doubles/factories** (dependency-seam map — zerac-api 86 doubles → 20 seams), **messaging/brokers**
(Kafka/RabbitMQ/NATS/Redis/BullMQ/Celery/Sidekiq/SQS — producer→topic→consumer; Celery repo 46 consumers),
**auth/authz** (Passport/NextAuth/Spring Security/Devise/Casbin/OPA — `guards` edges onto routes; 16/68
guarded), **API/RPC** (gRPC server handlers incl. no-`.proto` repos, `rpc` entry points), **observability**
(OTel/Sentry/Prometheus/Winston/Pino static inventory).

### Added — infra-as-code analysis + understanding
CloudFormation, raw Kubernetes manifests, Docker Compose, Dockerfile-depth (joining existing
terraform/Helm/Pulumi/Ansible). **Infra→code topology linker**: `DEPLOYS`/`EXPOSES`/`ROUTES_TO`/
`PROVISIONS_CHANNEL|DATABASE|STORAGE`/`RUNTIME_DEPENDS_ON` edges (image→app, k8s Service→port→routes,
`aws_sqs_queue`→messaging channel), evidence-gated with join-key audit trail. Real: zerac-api 30 edges.

### Added — installable telemetry SDKs + per-node runtime metrics
`@klauro/telemetry` (npm — Express/Fastify/Koa/Nest, 20/20 tests + over-the-wire e2e) and
`klauro-telemetry` (pip — FastAPI/Flask/Django, 16/16). `get_runtime_sdk_package` now serves a real
install + 3-line init for the detected stack (was a stub). **Per-node runtime metrics**: traffic
(`request_count`), `error_count`/`error_rate`, latency p50/p95/p99, status distribution — surfaced on
`get_runtime_observations.node_metrics`, keyed to the CAS node. Round-trip dogfooded (error_rate exact,
percentiles correct). Env-gated **self-telemetry loop** (`KLAURO_SELF_TELEMETRY`, off by default) so
Klauro emits its own runtime signal correlated to its own static graph.

### Added — self-improving coverage intelligence + extensibility
Codebase-type classifier (evidence-first, fixes the `desktop-app` monorepo misclassification) +
**coverage-gap self-discovery** (`get_coverage_gaps`: unknown-deps, low-extraction, zero-entry-points,
unhandled tree-sitter node types) — the learn-as-you-go loop. Declarative `.klaurorc` `conventions:` +
`declare_convention` MCP tool. Declarative **analyzer-pack engine** (YAML + tree-sitter queries; Koa/Hapi
proof packs — a framework with no coded analyzer, from pure YAML).

### Fixed
- **Generic decorator argument capture** — any decorator's literal args now populate
  `CASDecorator.parameters`, closing the `.klaurorc` custom-route path (`@Endpoint('/orders','GET')`:
  matched:false → matched:true with a real route). Also fixed a latent positional-index slot bug.
- **`orchestrator.isValidEntryPoint()`** silently dropped new entry-point kinds via a hardcoded allowlist
  separate from the union (hit by 2 agents) — new kinds added; parity guard queued.
- **Spurious `dev`/`ml` CASLibrary** from pyproject `[project.optional-dependencies]` extras-key misparse
  (non-TOML-aware regex) — fixed + regression test; `coverage-gaps` workaround removed.
- Fabric crash-recovery cascade (torn final line swallowed subsequent appends); `analyzeForBench`
  name-corruption of stored analyses.

### Fabric — giant-fleet scale
N=200 real OS processes: worker errors 33→**0**, shared-file integrity **1200/1200** exact, **0
double-grants** throughout. Fixed an O(n²) lock-hold (`readClaimLog` re-parsed the whole log inside the
lock → `(size,mtime)` cache + compaction). `SPEC-GIANT-FLEET.md`.

### Known follow-ups (v1.0.22)
- SDK ingest path `/api/telemetry/runtime-events/:projectId` vs server `/v1/telemetry/ingest` — reconcile
  for install-anywhere (self-loop uses in-process transport meanwhile).
- Expose fabric coordination as MCP tools (`claim_work`/`check_collision`/`release_work`) — CLI-only today.
- Wire analyzer-pack `PackAnalyzer` into the orchestrator; `isValidEntryPoint`↔union parity guard;
  terraform HCL-body capture for cloud-resource name joins; a first-class runtime-topology section in
  `get_product_map`.

## v1.0.20 — Framework breadth + blast-radius at grep-parity + measured token savings (2026-07-04)

The "prove it + spread it" pass. Full gate green: tsc both, analyzer-core 893 jest, framework node-tests
166/166, live-registration guard 2/2 (every new analyzer wired live, no dead paths).

### Added — major-framework coverage across languages (live count 48 → ~68)
A 6-agent parallel wave (co-editing the shared registration files clean through multiple real fabric
409s): **Go** — Gin/Echo/Fiber/Chi (was 0); **Dart** — shelf server routes; **Python** —
aiohttp/Sanic/Tornado/Starlette; **JVM** — JAX-RS/Jersey, Vert.x, Akka HTTP, Play (parses `conf/routes`);
**Ruby** — Sinatra; **PHP** — Slim/CodeIgniter; **Clojure** — Reitit/Ring; **Rust** — warp, tonic (gRPC);
**C++** — Drogon, Crow (first C++ web support). Each evidence-gated, handler-resolved, fixture/real-repo
validated. Honest shape: ~130 languages parse; the *majors* now covered for ~10 major languages (not
"dozens per language" — that's JS/TS only).

### Fixed
- **`get_callers` blast-radius now at grep parity.** The v1.0.19 dedupe fixed one case; a real metered
  benchmark showed it still returned a fraction of consumers (11% on zerac-api). Root causes (AST-level):
  decorator-argument identifiers, decorator-name refs, `abstract_class_declaration`, and class
  `extends`/`implements` were all unscanned. Now resolved (no fabricated edges; shadowing respected).
  Real: `INTERNAL_GET_ERRORS` 1/18→**18/18**, `AllowAnonymous` 0/23→**23/23**, `EventBusService` 8/9→**9/9**.
- Play's `conf/routes` reaches the analyzer (snapshot allowlist) and isn't treated as a package boundary.

### Measured (real gpt-5.5, on-machine, metered — `docs/IMPACT-BENCHMARK.md`)
Agent token cost, with-Klauro vs grep/read baseline: **orientation ~98% fewer tokens at equal
correctness** (35,010 → 537 to orient one repo); **blast-radius ~98% fewer AND now grep-parity complete**
after the fix above. Honest: measured with gpt-5.5 (Claude CLI wasn't headless-authable here); directional
sample size — the harness (`scratchpad/token-grid.ts` pattern) is reusable for a larger grid.

## v1.0.19 — Blast-radius completeness: dedupe phantom util-node twins (2026-07-04)

The v1.0.18 `get_callers` fix was real but incomplete on real repos — the right-shape re-benchmark
found it still returned 0 consumers for service/config consts. Root cause (a duplicate-node footgun):
`react-analyzer`'s `analyzeUtils` emits a phantom `util_<hash>` twin node (absolute path) for the same
declaration `typescript-javascript-analyzer` emits as `variable_…` (relative path); each analyzer's
resolver saw only its own, so `get_callers` landing on the twin got 0 incoming edges. Fixed with
`dedupeUtilNodeDuplicates` (merge by normalized `source.file`+name, redirect edges to the survivor).
Verified fresh: `API_CONFIG` 2 nodes→1, **0→4 incoming references = grep**; `API_ENDPOINTS` 22,
`STORAGE_KEYS` 16; `TIER_RATE_LIMITS` unchanged. 885 analyzer-core jest.

**Impact verdict (`docs/IMPACT-BENCHMARK.md`, right-shape re-benchmark):** decisive wins where grep
structurally can't compete — entity lifecycle (`get_data_lineage`: 57 categorized readers/writers,
cross-language, one call) and unfamiliar-repo orientation (`get_summary`). Blast-radius (`get_callers`)
now complete on TS after this fix. Honest open edges: PHP has no identifier-reference machinery yet
(standalone feature); exact token-savings needs a real (non-sandbox) environment to measure.

## v1.0.18 — Call-graph blast-radius + fabric proven at scale (2026-07-04)

From the "prove it" campaign. A with-vs-without-Klauro impact benchmark exposed real tool gaps
(honest negative on small comprehension tasks); the flagship one is now fixed.

### Fixed
- **`get_callers` now tracks cross-file references to exported constants and interface properties**,
  not just function calls — the core of blast-radius analysis on the most common JS/TS pattern. Root
  cause was a dead-path footgun: the live `TreeSitterTSExtractor` only walked `call_expression`. Added
  a distinct `references` edge (never fabricated). Before: `get_callers(TIER_RATE_LIMITS)` on soon-lens
  = 1 (file only); after = 4 (the real cross-file consumers, matching grep).
- Import-source-gated call resolution (imported *local* functions no longer mislabeled external).
- `assess_change_risk` returns an explicit `{unsupported, reason, suggested_node_id}` on unsupported
  node types instead of a misleading whole-repo dump.
- `get_configuration(affecting_node_id)` surfaces directly-branched-on `process.env` flags via the new
  references edges.
- 882 analyzer-core jest; full mcp-server suite 1,288 (0 failures) on this tree.

### Proven
- **Fabric fleet-ready at scale** (`docs/FABRIC-FLEET-PROVEN.md`): a real N-process (8→64) concurrent
  stress harness, verified by replaying the on-disk claim log — **0 double-grants across 960+ real
  processes**, perfect shared-file correctness, conceptual-conflict precision 1.0. Honest limits:
  same-machine only (cross-machine tier untested), no crash-recovery test.
- Verification breadth closed: full mcp-server suite 1,288/0-fail, corpus 42 repos/0 crashes, live prod
  functional smoke PASS.

### Deferred (honest)
- `search_nodes` conceptual-query recall (needs an eval harness); `get_security_overview`
  enforced-but-conditionally-disabled state (schema change). Not patched speculatively.

## v1.0.17 — Stop analyzing the legacy reference tree as live code (2026-07-04)

Follow-up from v1.0.16's file-count fix. Verifying the "875 of ~1,240 files" gap (verify-first) showed
it was **mostly legitimate** (legacy/ + fixtures/cas-tests excluded by design, one file over the 1 MB
cap) — but surfaced a real bug in the other direction: **~102 `legacy/web/` files were being analyzed
as live product code.** The `package.json#workspaces` glob branch of `discoverProjectRoots` (added
defensively in v1.0.14) had no legacy-exclusion awareness, and this repo's `workspaces` includes
`legacy/*`. Fixed by routing both root-discovery branches through the existing legacy exclusion.
Self-analysis: 102 wrongly-parsed legacy files → 0; parsed-file count now matches ground truth
(861 vs 860). No cross-repo regression (zerac-api unchanged). 878 jest.

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

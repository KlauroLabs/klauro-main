# Klauro Product Readiness

This is the evidence contract for Klauro's non-UI beta. A requirement is complete only when its proof passes against the same committed candidate that is released and deployed.

## Product premises

1. Klauro is for any software. AI-built software may benefit disproportionately, but it is not the product boundary.
2. CAS is one recursive structure at arbitrary depth. Leaves are source-derived; parents preserve child facts, compute direct-child seams, and re-derive comprehension for their own purpose.
3. Tiers are a dependency contract: Tier 1 index, graph, and static ICELOT; Tier 2 framework, architecture, and library semantics; Tier 3 comprehension; Tier 4 observed telemetry; Tier 5 Fabric collaboration.
4. Comprehension consists of capabilities, flows, steps, and entities. Capabilities express product purpose in product-manager language. Flows express complete behavior. Steps are human actions with many-to-many code mappings. Entities are what the system exists to manage, produce, transform, or communicate.
5. ICELOT is Input, Constraints, Effects, Logic, Output, and Telemetry. It applies below capability, changes abstraction at each level, and retains evidence and provenance.
6. Terminality is a relational signal across entities, flows, capabilities, and recursive CAS nodes. Terminal and proximal-terminal elements help identify why a system exists without confusing prerequisites such as authentication for product purpose.
7. Fabric enables concurrent work on any semantic unit, including overlap. Participant-attributed in-flight CAS exposes recreation, divergence, reusable knowledge, merge decisions, and surprise without blocking or serializing work.
8. The UI is outside this readiness program except for the contracts it consumes. CAS and APIs supply complete relationships without frontend inference.
9. Production code is self-documenting, decomposed, testable, and free of explanatory comments that naming and structure can replace.
10. Production analysis logic is structural and corpus-general. Framework and library intelligence uses open evidence interpretation; unknown ecosystems degrade honestly.
11. Performance is part of correctness. Parsing, graph algorithms, caching, incremental invalidation, persistence, and query paths carry measured budgets.

## Readiness requirements

| ID | Requirement | Required proof |
| --- | --- | --- |
| CAS-1 | One CAS envelope recursively contains full child CAS nodes to arbitrary depth without a closed scope vocabulary. | Schema tests, depth-four fixture, cycle rejection, round-trip serialization, and no depth maximum. |
| CAS-2 | Leaf analysis is source-derived; composition declares its mode; every level carries the same tier shape. | Leaf, composed, and conformance fixtures. |
| CAS-3 | Composition preserves complete child facts, computes direct-child seams, reports orphan source, and never silently truncates. | Seam, orphan, pagination, and composition fixtures. |
| CAS-4 | Tier 3 comprehension is re-derived at each parent rather than unioned. | Parent capability, flow, and entity reframing with child provenance. |
| TIER-1 | Every production analysis module belongs to one tier and lower tiers cannot import or synthesize higher tiers. | Exhaustive dependency-boundary gate. |
| TIER-2 | Framework-less and framework-backed systems produce equivalent roles from structural and convention evidence. | Cross-language parity and framework-depth gauntlets. |
| ICE-1 | Code units, steps, and flows expose canonical ICELOT with abstention and provenance; capabilities do not carry ICELOT. | Schema and aggregation tests for all six facets. |
| COMP-1 | Exactly one persisted model exists for capabilities, flows, steps, and entities. | Parallel-model search gate and query projection tests. |
| COMP-2 | Navigation is bidirectional from capability to code and code to capability without dangling semantic references. | Referential-integrity and semantic-coverage gates. |
| COMP-3 | Capability names and descriptions read as grounded product behavior without hardcoded domain vocabulary. | AI-backed description benchmark, renamed fixtures, corpus proof, and provenance checks. |
| TERM-1 | Terminality and proximal terminality operate across entity, flow, capability, and recursive CAS dependency graphs. | Domain-neutral commerce-auth and auth-product counterexamples. |
| TERM-2 | Terminality informs candidates and ranking without overriding contradictory evidence or fabricating purpose. | Falsification fixtures and provenance assertions. |
| TEL-1 | Runtime events persist before analysis and later backfill to code, steps, flows, and capabilities. | Ingestion-before-analysis and backfill integration tests. |
| TEL-2 | Runtime observations annotate rather than overwrite static facts and expose uncertainty. | Static/runtime contradiction and unmatched-event tests. |
| TEL-3 | SDKs and hosted ingestion work end to end against the development service. | JavaScript and Python SDK live smoke, auth, error, retry, and observed-flow proof. |
| FAB-1 | In-flight CAS is continuous, semantic, participant-attributed, and overlap-preserving. | Mixed human and agent same-function proof with distinct deltas. |
| FAB-2 | Awareness, claims, extensions, and subscriptions never block work and work across machines. | Two-machine overlapping-claim proof with continuous updates. |
| FAB-3 | Duplicate work, recreation, contract divergence, and relevant knowledge surface before completion. | Same-concept/different-file and same-file/different-concept fleet scenarios. |
| FAB-4 | Merge-decision count and surprise rate are measured with no lost work. | Sustained fleet report. |
| AGENT-1 | Installed MCP resolves a repository, supplies useful first context, supports task workflows, and bounds every response without silent loss. | Clean install plus varied real-repository gauntlets. |
| AGENT-2 | Hosted and installed tools are contract-compatible and errors state problem, cause, and recovery. | Surface parity, stale-client, auth, unavailable-analysis, pagination, and response-budget tests. |
| BETA-1 | Install, authentication, project initialization, analysis, update, uninstall, and recovery work from a clean machine within the first-value budget. | Clean-environment journey with timings and failure injection. |
| BETA-2 | Release artifacts are source-exact, versioned, checksummed, upgrade-safe, and refuse known-bad states. | Remote release build, identity, publication, dirty-tree, and rollback gates. |
| BETA-3 | Representative codebase shapes and scales meet truth, latency, memory, and survivability budgets on the VPS. | Full proof machine, real corpus, scale, robustness, and zero unexplained errors. |
| BETA-4 | Customer docs distinguish implemented behavior from planned work and contain complete onboarding and troubleshooting. | Documentation contract tests and clean-user walkthrough. |
| CODE-1 | Production source is self-documenting, decomposed, and independently testable. | Hygiene, size, complexity, orphan, duplicate, and focused-test gates. |
| GEN-1 | No production rule is repository-, customer-, fixture-, or scenario-specific. | Purity gates, renamed fixtures, unknown ecosystems, and language parity. |
| PERF-1 | Parsing, indexing, composition, querying, telemetry, and Fabric meet explicit latency and memory budgets. | CPU, wall, RSS, complexity, and regression budgets on the VPS. |
| PERF-2 | Incremental analysis reuses trees, fingerprints, indexes, and unaffected derived layers. | Symbol, file, package, deployable, and cross-repository locality benchmarks. |

## Current exact evidence

- Candidate `da7dcb07fe84` passes the release-safety, deployment-reproducibility, and distribution-channel suites on the VPS. Its purity gate checks 17 evidence-derived names and 366 reviewed vocabulary shapes with zero violations.
- Candidate `da7dcb07fe84` builds one Linux x64 SEA artifact on the VPS, executes it natively with Node and npm absent from `PATH`, builds the customer tarball once, verifies version and Git identity, and dry-publishes atomically into an isolated proof directory with a valid checksum.
- Candidate `916ca48e2e80` passes MCP typechecking, production hygiene across 717 files, the 79-file size ratchet, and a production Vite build on the VPS. The later release candidate includes those commits; the final all-suite rerun is still required.
- The latest full MCP candidate run covered 306 files and 2,280 tests: 2,234 passed, 46 were explicitly skipped, and none failed or crashed. The latest full analyzer-core evidence covers 3,174 passing tests. Both predate the current release-hardening commits and therefore remain supporting evidence, not final-candidate proof.
- The real-corpus agent gauntlet analyzed 40 of 40 discovered eligible repositories with every repository agent-context-ready and no failures. Post-analysis test discovery consumed 2.8 seconds across the corpus after indexed and bounded discovery replaced repeated scans.
- Analysis mastery passes 11 language and framework truth fixtures at 100/100. The new-user hosted journey completes build, install, authentication, full analysis, installed MCP context, and incremental sync in 19.9 seconds.
- Fabric fleet, telemetry ingestion, robustness, terminality, recursive CAS, tier boundaries, and incremental-locality proofs are green in their latest focused and broad runs. They must be rerun or accepted by the final source-exact proof machine before release.

## Open beta gates

1. Run capability-title and description inference against an authorized AI provider and prove product-manager quality, grounding, abstention, and fallback behavior. Existing hosted credentials are not valid evidence after exposure, and local Mac inference is excluded from the current verification plan.
2. Run the full analyzer, MCP, proof-machine, real-corpus, telemetry, Fabric, robustness, install, release, and documentation gates against one final commit on the VPS.
3. Cut the release from that commit, publish its verified artifacts, deploy the identical source, and confirm live health, build identity, distribution identity, installed-client analysis, telemetry, and Fabric behavior.
4. Record the final reports and live identities here. Until then, the goal remains active and the deployed development service is not the beta candidate.

# Proposal: analysis trust and review

Status: proposal, revised 2026-10-04 after an audit of what the repository already has. Nothing here is built. The ideas come from comparing Klauro with adjacent tools in which an agent re-reads a repository and authors a map each time. Klauro starts ahead on truth because it computes the graph once; the aim is to make that advantage visible and checkable. This document is generic by design (see `docs/KLAURO-PRODUCT-MODEL.md`) and names no outside product.

Every item below extends an existing mechanism, named in its section. Where an earlier draft proposed something that already exists, or that would weaken an existing rule, it was cut or reshaped. The companion document is `docs/PROPOSAL-ACCURACY-AND-DEPTH-FROM-THE-FIELD.md`.

## Rules these proposals must respect

- `docs/cas/DETERMINISM-BOUNDARY.md`: a failed comprehension call is a thrown exception, not a degraded artifact. Nothing here may publish a degraded analysis as complete.
- `docs/ANALYSIS-NORTH-STAR.md`, "What the output contains": the output never carries cache keys, hit rates, stage timings or per-analyzer ledgers; those live in internal state beside the analysis. Every new output field needs a line in `docs/ANALYSIS-OUTPUT-STOCKTAKE.md`, and a build gate enforces it.
- The same document: any change to these layers is measured on at least four repositories across at least three language families, with the spread recorded.
- `docs/KLAURO-PRODUCT-MODEL.md`: the local store is a read-through cache over the hosted source of truth; freshness is lazy and hotness-adaptive, with no background poller; nothing of Klauro's is kept in the repository except configuration.
- Unshipped code is tagged and kept, never hidden (`unshipped.rs`, `docs/SPEC-DEPLOYABLE-DETECTION.md`). Structure and delivery status stay separate: the analysis says where a capability touches the code and how it ships, not whether work on it is planned, active or done.
- The core tool profile plus gateway is the mechanism behind unprompted agent adoption; nothing may shrink it.

## 1. Run ledger and publish gate

Today the counters exist but are not kept: `author::went_unanswered` and the per-run counts print to stderr, and `parent::enforce` drops capabilities with no provenance with one stderr line. A run once lost several hundred AI answers to a rate limit and still published normally.

Persist a ledger as internal state beside the analysis, extending those two functions: AI asks, answered from memory, answered fresh, unanswered after all retries; capabilities, flows or entities dropped by an invariant, with the reason; sub-projects that fell back to a default; engine, contract and prompt-contract versions. Reuse the existing `description_generation.status` vocabulary and `layers_ready`.

The output carries only a `complete` flag and the list of dropped items, each with a stocktake line. The ledger makes the boundary rule enforceable: an unanswered ask or an invariant drop that leaves a hole means the run fails and nothing is stored, instead of a partial result that looks whole. Publication stays atomic. Consumers (CLI, desktop, MCP) show the ledger's outcome and never present a failed run as complete.

Decision needed: whether an invariant drop (as opposed to an unanswered ask) fails the run or publishes with the dropped item listed. The first matches the boundary rule; the second matches how `parent::enforce` behaves today.

## 2. A mechanical evidence check for AI claims

The grounding step already exists: `tighten_claims` carries the stub, sample, configured and unreachable rules, `Grounding` records supported and invented claims and an outcome, and `jev.rs` vets answers. What is missing is a check that does not rely on the model grading itself.

Extend those, with two additions:

- a mechanical check that every cited evidence id exists among the index facts handed to the model, and that no sentence names an entity that is not among them. It runs against index facts, never against source, because no pass after the first index reads source (`docs/ANALYSIS-TIERS.md`);
- a way for the model to say what the facts did not settle, kept as internal state and shown on request, not stamped on every output claim.

A claim with no supporting evidence is rejected, not softened. A configured provider, an injected adapter, a local stub and a durable service stay different claims, as `tighten_claims` already says.

Decision needed first: `docs/ANALYSIS-NORTH-STAR.md` says there is no confidence score and no validation pass for capabilities, while `docs/SEMANTIC-MODEL.md` ("Evidence and confidence, everywhere") says the opposite, and the code follows the second. Pick one stance in the documents before this lands. This proposal assumes the model-facing check stays internal and the output keeps its current vocabulary.

## 3. Rename-safe identity and a delta over the engine's output

A comparison of analyses already exists: `compare_analysis_iterations`, `diff_behavior` (journeys matched by entry signature and terminal entities), `get_changes_between`, `get_changes_for_*`, `get_analysis_at`, `get_analysis_snapshots`, and the fabric tools `fab_check_collision`, `check_conceptual_conflicts` and `plan_intent_merge`. Identifiers survive line shifts (`stable_ids.rs`). Do not build a second comparison.

What is genuinely new:

- a delta over the Rust engine's capabilities, flows, steps, entities, seams and sub-projects, with a receipt naming both revisions, built on the existing tools;
- identity that survives renames: today `docs/SPEC-FRESHNESS.md` and the incremental tests treat rename pairs as fail-closed;
- a producer for `BreakingChange`, which is declared in `cas.types.ts` and has no code that emits it (see section 6 of the companion proposal).

## 4. Route between two nodes

Reach already exists: `get_callers` and `get_callees` take `maxDepth` and `limit` and report `truncated`; `getAffectedSet` uses the reachability index and reports `truncated` and `method`; `get_interface_signature` gives blast radius at function, flow, capability, project and workspace level; `assess_change_risk` and `get_call_chain` (entry to end) exist. Extend them rather than add reach.

The missing piece is **route**: the path or paths between two arbitrary steps, with evidence on each hop and a statement of the bound applied. Every result states its bounds, so a reader knows when it is complete.

## 5. A reason for every refresh

Refresh already keys on cited facts: `memory.rs` memoizes answers on the facts text in the prompt, so edits to uncited prose cost nothing, and `KLAURO_AI_CACHE_PATH`, `KLAURO_ONLY_PARTS`, `facts_cache.rs` and the stage fingerprints exist. Freshness itself is `docs/SPEC-FRESHNESS.md`, implemented. The gap is small: report why a part refreshed (which evidence changed) in the ledger of section 1.

## 6. Plain-file export

The machine export exists (`analysis-export-process.ts`, `cas-export-decoder.ts`, compressed JSON). Add a documented, human-diffable Markdown contract on top of it, with a written schema, so any agent or tool can read an analysis without Klauro running and it can be attached to a ticket. Every field needs a stocktake line.

## 7. A public proof gallery

A pinned-corpus mechanism and a receipt pattern exist: `gauntlet/fixtures/terminality-public-corpus.json` pins archives by checksum, source and license, `generate-terminal-public-corpus-receipts.ts` and `release-proof-receipt.mjs` produce receipts, and `docs/COMPETITIVE-PROOF.md` and `docs/CORPUS-VALIDATION.md` hold the sweeps. A navigable public gallery of well-known open-source projects, each with its receipt and evidence links, is built from those. It demonstrates the product and exposes weaknesses early.

## 8. Unresolved is not a leaf

A flow's `standing` is terminal, proximal or reading, derived only from effects along the resolved path (`comprehend.rs`). A path that ends in a call the engine could not resolve, with no effect found, is labeled reading, as though proven read-only. That claim is not supported, and it flows into terminality, capability weights and absorption.

The pieces already exist but are not kept. `resolve.rs` counts `unresolved_calls`, `dynamic_calls` and `unresolved_names`, only to stderr. A `guessed` set of name-only edges exists and `comprehend.rs` already distrusts guessed edges unless the callee is hand-written. `steps.rs` stops silently at its depth and action limits, and `leads_into` is truncated silently.

Distinguish three path ends: **proven** (no further calls), **known boundary** (library, runtime or external-service code, classified and stated) and **open** (an unresolved call in our own code, or a traversal cut by a bound). Then:

- persist the unresolved and dynamic call counts per flow, and record when a bound was hit;
- add `open` as a fourth standing, updating the standing match in `capabilities.rs` and the serialization; standing is reading only when no end is open;
- terminality, weights and absorption treat open as unknown, never as zero;
- report, per project, the share of flows with open ends, so resolver work has a number to drive down;
- keep `tests/guessed_callee_terminal.rs` green: a guessed edge that is trusted for a hand-written callee stays terminal.

## 9. Three-valued results

Prior art exists: `tool-surface-dogfood` already distinguishes OK, EMPTY and not-applicable, `get_flow_concepts` omits facets and gives reasons in `gaps`, and data lineage carries `external_transfer_unresolved`. Other gates are two or three valued in a different way (`competitor-readiness.ts` and `agent-adoption.ts` use pass, warn, fail).

Make every check, verifier and comparison return pass, fail or unknown, kept distinct, with empty or insufficient input returning unknown. Known audit targets: `win-validator.ts` returns an efficiency win for a scenario nobody contested, and the invariant results in `verify.rs` are two-valued. Check `evaluate_analysis_truth` the same way.

## 10. Authority per fact

Pieces exist: `EntryPoint.registrar`, `Guard.via`, the `parent.rs` provenance invariant, the in-memory `guessed` set, `Grounding.confidence()`, and `evidence_source` and `signal_quality` on the change-validation findings. What is missing is the edge itself: `IndexEdge` carries only source, target and kind.

Promote the `guessed` set into a persisted authority field on each edge, ranked: deterministic extraction; an edge resolved by structure (imports, types, declared receivers); an edge guessed by name alone; an AI interpretation grounded in those; an AI interpretation the grounding step did not hold. When sources disagree the higher authority wins and the conflict is recorded; a lower claim is never silently promoted. Authority on edges is index data, surfaced through MCP results; it is not a capability-level confidence score (see the decision in section 2). Runtime telemetry laid over the static graph follows the same ranks: exact captured observations outrank declared mappings, and co-change is never presented as causation (`ingest_telemetry` and `get_runtime_static_links` are the starting point).

## 11. What remains after the audit

- **Hidden-tool reasons and list-changed notifications.** The tool profiles (`core`, `core-no-pillars`, `full`) and the gateway exist, as do response budgets and `orient_capsule`. Missing: a stated reason per hidden tool and a notification when the list changes. These are additions to the existing profiles and must not shrink the core profile.
- **A fail-closed readiness stage.** The readiness tooling exists (`evaluate_agent_readiness`, `tool-surface-dogfood`, `scale-survivability-gate.sh`, `prove-release-candidate.sh`). Add: the AI backend killed mid-run must fail the run with a ledger entry; a declared project must never disappear into the root; truncation and unsupported syntax must be reported.
- **Obligation closure** for measuring how much of a specification is done: genuinely new. An obligation closes only when evidence of comparable authority passes; contradictions, duplicate owners and unknowns keep it open; empty input yields unknown.

## Order

1. The run ledger and publish gate (section 1): small, closes a real failure mode, and every later item reports through it.
2. Open ends, three-valued results and authority per fact (sections 8, 9, 10): they change what the analysis may claim.
3. The documentation decision in section 2, then the mechanical evidence check.
4. Rename-safe identity and the engine delta (section 3), which needs sections 8 and 9 to treat missing data as unknown.
5. Route (section 4), the plain-file export (section 6), then the gallery (section 7).
6. Refresh reasons (section 5) alongside the next incremental work, and section 11 as those surfaces are next touched.

## Open questions

- The two decisions marked above (invariant drops fail or publish; the documented stance on evidence and confidence).
- Whether unknowns are model-authored, deterministic or both.
- The identity scheme that survives renames.

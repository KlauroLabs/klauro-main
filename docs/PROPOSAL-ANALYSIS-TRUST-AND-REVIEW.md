# Proposal: analysis trust and review

Status: proposal, 2026-10-04. Nothing here is built. These ideas come from comparing Klauro with adjacent tools in which an agent re-reads a repository and authors a diagram or map each time. Klauro starts ahead on truth because it computes the graph once. The aim here is to make that advantage visible and checkable. This document is generic by design (see `docs/KLAURO-PRODUCT-MODEL.md`); it names no outside product.

## 1. An analysis receipt

Every analysis carries a receipt saying what it is and what it is not. Today a degraded run can look complete: a run once lost several hundred AI answers to a rate limit and still published normally; a provenance rule can drop capabilities without a trace.

The receipt records, per analysis and per sub-project:

- the revision analyzed and which paths were dirty;
- AI requests asked, answered from memory, answered fresh, and unanswered after all retries;
- capabilities, flows or entities dropped by an invariant, with the reason;
- sub-projects that fell back to a default;
- the engine, contract and prompt-contract versions;
- a single `complete` flag that is false whenever anything above is non-zero.

Consumers (CLI, desktop, MCP) show a degraded analysis as degraded and never present it as complete. A failed gate returns a structured repair report, not a silent partial result. Publication is atomic: nothing is stored until the checks pass. This extends the honest-degradation rule in `docs/ANALYSIS-NORTH-STAR.md` and the existing "went unanswered" counter.

## 2. Claims next to evidence, with unknowns

Every AI-written sentence about code is a claim. Each claim should sit beside:

- **evidence**: the code regions it rests on (path and line range at the analyzed revision), checked mechanically for existence and for membership in the facts handed to the model;
- **unknowns**: what the facts did not settle, written next to the claim they limit (for example, "a file write exists here; durability is not established");
- **kind**: whether the thing is observed, configured, stubbed, or only declared. A configured provider, an injected adapter, a local stub and a durable service are different claims. A function exported but never called on any normal path is an optional capability, not a runtime edge.

A claim with no supporting evidence is rejected, not softened. A label, a package description or a config value never becomes an observed service. This builds on the grounding step and the stub and configuration rules already in the tighten pass, and adds the missing explicit unknowns and the mechanical check.

## 3. Analysis delta

A first-class comparison of two analyses of the same project: which capabilities, flows, steps, entities, seams and sub-projects were added, removed or changed, matched by stable identity, with a receipt naming both revisions. This serves pull-request review, Fabric (what a participant's in-flight work changes), and release notes. It reuses stable identifiers and the incremental machinery; the new part is the comparison and its review surface.

## 4. Reach and route as read operations

Two queries over the analysis graph, available through MCP and every client:

- **reach**: everything downstream (or upstream) of a step, flow or entity, with minimum depth per item and a hop bound recorded;
- **route**: the path or paths between two steps, with the evidence on each hop.

Results state their bounds so a reader knows when a result is complete. These are natural views for flow navigation and impact review.

## 5. Refresh keyed on cited evidence

An analysis refreshes a part only when something it cites changed: files added, removed or renamed, or a source that one of its answers rests on. Edits to prose, specs or documents that nothing cites cost nothing. The memo already keys on prompt content; the refinement is to key each answer on the evidence it used and to expose the reason a part refreshed. An optional repository hook on branch movement can trigger the check without polling.

## 6. Structure and status stay separate

The analysis states where a capability touches the code and how it is delivered. It does not state whether the work is planned, active or done; that belongs to whatever tracks work. Keep status fields out of capabilities, flows and entities.

## 7. A plain-file export

A documented export of an analysis as human-diffable Markdown or JSON files, with a written contract, so any agent or tool can read it without Klauro running. It also makes the analysis easy to attach to a ticket or review.

## 8. A public proof gallery

A gallery of navigable analyses of well-known open-source projects, each with its receipt and its evidence links, built from the existing corpus. It demonstrates the product, and it exposes weaknesses early.

## 9. Unresolved is not a leaf

Today a flow's standing comes only from the effects found along its resolved path: terminal when it changes something or hands something off, proximal when it leads into other flows, otherwise reading. A path that ends in a call the engine could not resolve, with no effect found, is labeled reading, as though it were proven read-only. That is a claim the facts do not support, and it flows into terminality, capability weights, absorption decisions and every "what does this change" answer.

Distinguish three kinds of path end:

- **proven end**: no further calls;
- **known boundary**: a call into library, runtime or external-service code that is not ours, classified and stated;
- **open**: a call in our own code that could not be resolved, or a traversal cut by a bound (depth, cycle, size).

A flow with any open end carries an `open` count and the first few unresolved callees. Its standing is reading only when no end is open; otherwise it is reported as open, not read-only. Terminality, weights and absorption treat open as unknown, never as zero. Trace and reach results (section 4) list unresolved paths and any traversal bound explicitly, and a comparison never reads an open end as the absence of an effect. Report, per project, the share of flows with open ends, so resolver work has a number to drive down.

## 10. Three-valued results

Every check, verifier, comparison and gauntlet outcome is pass, fail or unknown, kept distinct. Empty or insufficient input returns unknown, never pass. Absence of evidence is never evidence of absence: missing data does not read as "no change" or "no difference", and an incomplete comparison is unknown. A contradiction or an unknown keeps an obligation open. Audit the verify stage, the conformance stage, truth evaluation and the delta (section 3) for places where "nothing found" is reported as success.

## 11. Authority per fact

Facts differ in how much they can be trusted, and the analysis already knows the ranks implicitly. State them:

1. deterministic extraction from source;
2. an edge resolved by structure (imports, types, declared receivers);
3. an edge guessed by name alone;
4. an AI interpretation grounded in the facts above;
5. an AI interpretation the grounding step did not hold.

Each claim and edge records its authority and its limitations. When sources disagree the higher authority wins and the conflict is recorded; a lower-authority claim is never silently promoted. Authority is shown per item in MCP results, in the receipt (section 1) and in clients. For runtime telemetry laid over the static graph, exact captured observations outrank declared mappings, and co-change is never presented as causation.

## 12. Further ideas, noted and not yet designed

- **A task-shaped tool contract.** Describe every MCP tool as inspect, search, trace, compare or workflow, each returning facet-level availability, typed edges with evidence, unresolved paths and stated limits. Advertise only the tools callable right now, with the reason each other tool is hidden and a notification when the list changes. Audit the current surface against this shape; coordination and telemetry tools can appear only once configured.
- **A readiness verifier.** One command runs staged end-to-end checks on fixtures and prints a compact summary, keeping the full report. Include fail-closed stages: the AI backend killed mid-run must produce a degraded receipt; a declared project must never disappear into the root; stale or tampered memory must be rejected; truncation and unsupported syntax must be reported, not hidden.
- **Obligation closure for progress measurement.** To measure how much of a specification is done, an obligation closes only when evidence of comparable authority passes; contradictions, duplicate owners and unknowns keep it open; empty input yields unknown.

## Order

1. The receipt (section 1): small, and it closes a real failure mode.
2. Open ends (section 9), three-valued results (section 10) and authority per fact (section 11): they change what the analysis is allowed to claim, so they come before more features.
3. Claim unknowns and the mechanical evidence check (section 2).
4. Analysis delta (section 3), which depends on sections 9 and 10 to treat missing data as unknown.
5. Reach and route (section 4), then the export (section 7), then the gallery (section 8).
6. Evidence-keyed refresh (section 5) alongside the next incremental-analysis work.
7. The ideas in section 12 as the tool surface and test suite are next touched.

## Open questions

- Where the receipt lives in the stored analysis and how it is versioned.
- Whether the unknowns are AI-authored, deterministic, or both.
- The identity scheme that survives renames for the delta.

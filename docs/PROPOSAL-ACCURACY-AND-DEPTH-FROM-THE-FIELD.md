# Proposal: accuracy, speed, depth and tooling, from a survey of the field

Status: proposal, 2026-10-04. Nothing here is built. Open-source code-understanding tools were surveyed from their public documentation; none was run. This document is generic by design (see `docs/KLAURO-PRODUCT-MODEL.md`) and names no outside product. It complements `docs/PROPOSAL-ANALYSIS-TRUST-AND-REVIEW.md`, whose sections 9 to 11 (open ends, three-valued results, authority per fact) several findings below confirm.

What the survey showed about the field: most tools index structure and sell token savings. Few measure accuracy against an independent answer key, and none that was found derives purpose-level capabilities or a parent analysis from child sub-projects. The opportunity is not new features; it is proving the claims we already make.

## 1. An independent answer key for call accuracy

The strongest evaluation design found scores resolved call edges against compiler-grade output (SCIP indexers for Go, Java, C#, C and C++, the Rust analyzer, the TypeScript compiler, and a Python type resolver). It works like this:

- precision and recall are reported together, because either alone can be gamed;
- an edge matches when caller and callee land on the same declaration line;
- every cell carries a 95% confidence interval;
- repositories are split into development and held-out sets before any tuning, and the held-out set is chosen in advance;
- losses are published beside wins.

Adopt this as an offline harness, run on the VPS and not on a developer machine. It needs no product change and gives a real accuracy number where we currently rely on corpus spot checks. Start with Go, TypeScript and Java. The harness is a blackbox client of the engine and reads only its output, per the blackbox-testing rule. Ground truth must never be derived from our own graph: a recall figure scored against the graph that produced it is circular and proves nothing.

## 2. Evaluation hygiene for every claim we publish

- **Freeze the sampling frame before the run** and commit it. One survey found four defensible sampling choices produced token-saving figures of 21%, 31%, 56% and 67% on the same build.
- **Block the control arm from the treatment tool.** One with-versus-without benchmark found the control arm reached the tool under test in 26 of 28 runs until access was blocked. Our agent benchmarks need the same guard and a check that proves it held.
- **Use blind scoring and no model judge** where a mechanical check exists (file recall, edge match, test-run match).
- **Report quality next to cost.** A large token cut with no gain in answer quality is a result to report, not hide.
- **Publish losses.** Show where a stack scores poorly and why, per stack and per language.
- **Use a sealed split** of any public benchmark, split by instance before work starts.

## 3. Carry confidence and provenance on every edge

Several tools tag each edge with how it was found (extracted, inferred, ambiguous; or resolved by a named strategy; or by a heuristic). This is section 11 of the trust proposal, now with a concrete shape:

- an edge records its resolver (structure, type, name, bridge, framework rule), a confidence tier, and a heuristic flag;
- resolved calls and uses with no uniquely proven target are different edge kinds, so a reader can tell "calls this" from "refers to something like this";
- the receipt reports edge counts by tier per project.

The edge-kind split is cheap to adopt without building a type system, and it feeds the open-end count in section 9 of the trust proposal.

## 4. Unresolved links reported per service

One tool reports, per service, the calls it detected, resolved and left unresolved, so that a service that is genuinely isolated looks different from one whose links were never followed. Our seam gaps are exactly this class: base-URL calls from the UI to the API, spawn through a resolved path constant, and Tauri IPC invokes. Adopt two things:

- a per-sub-project link coverage figure (detected, resolved, unresolved) stored in the analysis and shown beside the seams;
- route-prefix resolution: when a prefix is passed into another function or file (Express routers, FastAPI routers, Axum nests, Rails scopes, Swift route groups), resolve it before linking.

## 5. Freshness without a stale-index class of bug

- Before serving a query, compare the tree against the last build's fingerprint (a cheap stat pass, a few milliseconds) and rebuild only what moved, so results are correct for uncommitted edits.
- When a response touches a file whose reindex is still pending, say so in the response (a per-file staleness line).
- On client connect, reconcile size and modification time plus content hash against the working tree, so edits made while no watcher ran are caught.
- A response carries a statement of what its facts were computed from and when, so an agent can tell when they have gone stale.

## 6. Entity-level change analysis

- **Entity-matched diff:** match changed entities by name, kind and scope (including renames) instead of by line, then report impacted entities and tests. This extends the analysis delta (section 3 of the trust proposal) and the in-flight reconciliation Fabric already provides.
- **Review certificate:** a diff report that lists entities changed and static callers the change does not touch, so a reviewer sees what the change might break without being edited.
- **Public-surface certification:** each changed export is marked breaking, non-breaking or potentially breaking, with the named consumers. A diff that opens a new path into a declared sensitive boundary is flagged.
- **Deterministic merge gates for concurrent agents:** refuse a merge that drops either side's changes, undoes them, duplicates a key or case, or no longer parses. No AI is needed. This is directly relevant to concurrent editing of one checkout.
- **Baselines:** pin a baseline and report only regressions introduced since the pin, so pre-existing problems do not drown a review. Treat missing evidence as unknown, never as safe.

## 7. Health, hotspot and test analytics

- **Test selection from graph edges** (this test reaches that source file), not from file names. Stamp each answer measured or inferred; an empty answer is unknown (trust proposal, section 10).
- **Change risk as a percentile** against the repository's own recent commits, with documentation, test and configuration commits excluded from the bug-fix history.
- **A self-check after every index** against the repository's own history: how many of the highest-risk files had a recent bug fix, against a baseline rate. It is cheap and catches silent breakage.
- **Dead code with a confidence tier** and the evidence for it, never a flat list.
- **Surprising coupling:** unexpected cross-community or cross-language links, or a peripheral module reaching a hub.
- Risk weights are calibrated on a real defect corpus and scored at a commit before the bug window, with file size as a control, or they are just opinions.

## 8. Speed and scale

- Size worker pools and caches from the container's core and memory limits, not the host's.
- Batch indexing with resumable checkpoints (for example every 50 files), so a killed run resumes instead of restarting.
- Bootstrap a fresh clone from a stored compressed snapshot of the graph, then index incrementally; resolve merge conflicts on the snapshot by keeping the local copy.
- Record resident memory, file descriptors and page faults every few seconds during large runs, so a bug report carries the trajectory.
- One tool indexed a very large repository in about two hours at 11.7 GiB peak, and another claims minutes at a few GiB. Neither is a bar we must match, but we should publish our own large-repository time and peak memory with the commit and hardware.

## 9. Resolution beyond names

- A resolution pass for type information (generics, return-type propagation, narrowing, trait and extension calls) layered on the syntax pass, falling back to textual resolution when it cannot decide, is the approach with the most accuracy gain and the most work. Adopt the fallback structure and the edge kinds from section 3 first.
- Where compiler indexes exist, ingest them as a higher-authority source and fall back to syntax where they do not cover a file. This needs a toolchain on the machine running it, so it fits the VPS and the harness in section 1, not a thin client.
- Calls recorded from a test run, merged into the graph, expose dynamic dispatch that static analysis cannot see. Defer; it is the most expensive item here.
- Cross-language bridges matched by literal names (native bridges, module registries) with a recorded strategy.

## 10. Tool surface

- Offer a small number of task-shaped tools, or a preset, and let a single orient call return the first useful slice for a task.
- An escalation ladder from summary to outline to hot path to a policy-gated source window, so an agent pays for depth only when it needs it.
- Per-client tiered tool lists, and hooks that nudge searches toward the analysis tools.

## What to leave alone

- Per-file model-written indexes committed to the repository: too slow, and against our compute-once design.
- Token-saving headlines without a stated sampling frame or a quality result.
- Heavy external database or vector-store requirements. The batching and checkpoint ideas apply; the stack does not.
- Copying code from copyleft or commercial-licensed projects. Take ideas and use permissively licensed data only.

## Order

1. The answer-key harness (section 1) with evaluation hygiene (section 2): it makes every later change measurable.
2. Edge kinds, resolver and confidence (section 3) and link coverage (section 4): they feed the trust proposal and cost little.
3. Freshness (section 5).
4. The self-check after every index (section 7), which catches silent breakage cheaply.
5. Entity-matched diff and certification (section 6), then test selection and change risk (section 7).
6. Scale measurements and snapshot bootstrap (section 8).
7. Type-aware resolution and compiler-index ingestion (section 9), driven by the harness numbers.

## Open questions

- Which stacks the first held-out set covers, and who chooses it.
- Where link coverage and edge-tier counts live in the stored analysis and how they are versioned.
- Whether the compiler-index toolchains run in the existing analysis image or a separate verification image.

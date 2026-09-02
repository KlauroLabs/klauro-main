# Capabilities: what the system can do

A plain-language guide to a body of data Klauro produces, written so you can decide how and
where to present it. It describes what the information *is* and the shape it comes in — the
presentation is yours to design.

`Audience: design` · `Scope: one codebase at a time, repo-wide` · `Tests: out of scope` ·
`Numbers: from a live analysis` · `Counts: 0 (no grounded outcome) to 25+ (a mature product)`

No Figma screen covers the full `/capabilities` catalog page — the Repo overview screen
(node 1647:37709) shows a 6-card preview of it. This brief is the design contract for the
full page, derived from that preview plus the design language.

---

## Start here: what we're describing

A capability is an outcome the system's actual audience came to obtain — "Execute trades,"
"Settle payments," "Review reports and audit history." It's the answer to "what can someone
obtain from this product?", one rung above the flows that implement it. Capabilities reconcile
first-party product intent with real entry points, flows, entities, effects, and operations;
product text proposes an outcome, while implementation evidence grounds it. See
`docs/COMPREHENSION-LAYER.md` for the canonical semantic contract.

> **Who looks at this, and why**
> A new engineer asking *"what are the pieces of this product?"* · A PM asking *"which parts
> are core vs. supporting, and how risky is each?"* · Anyone tracing a bug asking *"which
> capability does this flow belong to?"*

## The mental model: two views, linked by canonical identity

Like entities (see `entities.md`), a capability has **two independently computed projections**
linked by its canonical capability id. The client renders those resolved relationships; it does
not infer or repair them by matching display names:

**The catalog view** (`product_map.capabilities`) — name, a one-line description, category
(core/supporting/admin/internal), criticality, and the entity names it touches. This is the
"what is it and why does it matter" view.

**The relationship view** (`conceptual.capabilities`) — the same capability's id and its
`related_flows`: an edge per flow that relates to it, each carrying a **role** (primary,
supporting, prerequisite, operational, recovery, observability), never just a bare list. This
is the "what actually implements it" view.

A product proposal with no flow or equivalent behavior evidence is reported as an intent gap,
not published as an implemented capability. A grounded catalog capability may temporarily have
no flow edge when equivalent implementation evidence exists but flow construction has not yet
resolved the relationship. A flow relationship with no catalog entry is an implemented but
undocumented capability candidate. These mismatches remain explicit rather than being hidden.

## The one/many/none shape (binding, from LANE-COMMON)

A capability's flow-relationship count is important context before row detail: **none**
(grounded by equivalent behavior evidence while flow linkage remains unresolved), **one** (a
typical, well-scoped capability), or **many** (a product outcome implemented by several flows).
All three can be honest shapes, but zero flows must not turn ordinary infrastructure such as
logging or health checks into a capability. Authentication, logging, payments, and search are
scope-relative: they are capabilities only when they are outcomes that product's audience came
to obtain.

## Data realities

- Description and entity-count come from `product_map`, which is a **best-effort AI-assisted**
  view over the structural graph, not a pure deterministic count — expect occasional short or
  generic descriptions on smaller/newer analyses.
- Criticality (`critical`/`high`/`medium`/`low`) is not shown on the Repo-overview preview cards
  (not in that Figma frame) but IS shown on the full catalog page — it's real, evidence-derived
  data (risk-scored from entry-point exposure and blast radius), not editorial judgment.
- A repo with a single capability is a real, common shape for a small library or utility. Zero
  is also valid when no product outcome is grounded; the explicit reconciliation state explains
  whether that means no claim, an intent gap, or an incomplete analysis.

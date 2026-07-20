# Capabilities: what the system can do

A plain-language guide to a body of data Klauro produces, written so you can decide how and
where to present it. It describes what the information *is* and the shape it comes in — the
presentation is yours to design.

`Audience: design` · `Scope: one codebase at a time, repo-wide` · `Tests: out of scope` ·
`Numbers: from a live analysis` · `Counts: 1 (a thin utility repo) to 25+ (a mature product)`

No Figma screen covers the full `/capabilities` catalog page — the Repo overview screen
(node 1647:37709) shows a 6-card preview of it. This brief is the design contract for the
full page, derived from that preview plus the design language.

---

## Start here: what we're describing

A capability is a core business function the system exists to perform — "Trade Execution,"
"Payment Settlement," "Reporting & Audit." It's the answer to "what does this product *do*,"
one rung above the flows that implement it and one rung below the individual operations inside
each flow. Capabilities are evidence-derived (grouped from real entry points, flows, and
operations), never a hand-authored feature list.

> **Who looks at this, and why**
> A new engineer asking *"what are the pieces of this product?"* · A PM asking *"which parts
> are core vs. supporting, and how risky is each?"* · Anyone tracing a bug asking *"which
> capability does this flow belong to?"*

## The mental model: two views, joined by name

Like entities (see `entities.md`), a capability is **two independently computed views** joined
client-side by name:

**The catalog view** (`product_map.capabilities`) — name, a one-line description, category
(core/supporting/admin/internal), criticality, and the entity names it touches. This is the
"what is it and why does it matter" view.

**The relationship view** (`conceptual.capabilities`) — the same capability's id and its
`related_flows`: an edge per flow that relates to it, each carrying a **role** (primary,
supporting, prerequisite, operational, recovery, observability), never just a bare list. This
is the "what actually implements it" view.

A capability with a catalog entry but no flow edges is a real, correct shape — usually an
early-stage or infrastructure-adjacent capability nothing has been traced to yet. A capability
with flow edges but no catalog entry is also real — the flow-relationship computation runs
independently and can outpace the catalog pass.

## The one/many/none shape (binding, from LANE-COMMON)

A capability's flow-relationship count is the single most important thing to show before any
row detail: **none** (pure infrastructure — logging, health checks — correctly has zero linked
flows), **one** (a typical, well-scoped capability), or **many** (cross-cutting concerns like
auth or audit legitimately relate to most of the system's flows). All three are correct,
evidence-backed shapes, not a completeness signal — do not treat "0 flows" as broken data.

## Data realities

- Description and entity-count come from `product_map`, which is a **best-effort AI-assisted**
  view over the structural graph, not a pure deterministic count — expect occasional short or
  generic descriptions on smaller/newer analyses.
- Criticality (`critical`/`high`/`medium`/`low`) is not shown on the Repo-overview preview cards
  (not in that Figma frame) but IS shown on the full catalog page — it's real, evidence-derived
  data (risk-scored from entry-point exposure and blast radius), not editorial judgment.
- A repo with a single capability is a real, common shape for a small library or utility — not
  an error state.

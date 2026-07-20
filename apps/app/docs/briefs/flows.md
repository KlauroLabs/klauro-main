# DESIGN BRIEF · KLAURO

## Flows: what happens next, for every way in

A plain-language guide to a body of data Klauro produces, written so you can decide how and where
to present it. It describes what the information *is* and the shape it comes in — the presentation
is yours to design. This page IS designed in Figma ("Flow List" / "Flow Overview", file
`Ux2aXXgq4jzD9T4TZaDAw8`) — this brief documents the DATA CONTRACT behind that design, the
companion the entry-points brief plays for the entry-points screens.

**Audience:** design · **Scope:** one codebase at a time · **Tests:** out of scope · **Numbers:**
from a live analysis of Klauro's own repository (`proof-of-concept`, self-analyzed — 49,492 nodes,
4,614 entry points)

---

## START HERE

### What we're describing

Every entry point opens into a flow — the *what happens next* for that door. An entry point tells
you how you get in; a flow tells you what the system actually does once you're inside: the ordered
steps it moves through, what data it touches along the way, what it calls outside itself, and where
it ends up. The entry→flow pair is the key relationship in this data model: the entry point is the
address, the flow is the story that starts there.

> **Who looks at this, and why**
> An engineer tracing "what actually happens when someone hits `POST /orders`?" without reading
> five files by hand · A reviewer asking "does this flow touch the payment entity, and does it
> call out to Stripe?" before approving a change · Someone building a mental map of a capability
> asking "which flows serve this, and is this flow the main path or a supporting one?" The
> through-line: **the system's behavior, traced and named, not just its addresses.**

### Flows outnumber almost everything else in the analysis

This repository has **4,614 entry points** — 958 product-facing, 3,656 are test entry points
(excluded from this page, same discipline as the entry-points brief). Every one of those product
entry points can, in principle, derive a flow, so flow counts run from a dozen on a small service
to well over a thousand on a large one. Filtered to just the *core* role (the domain-facing, not
supporting or infrastructure, flows), this repository still has **577** — a dozen-to-thousands
range is the honest expectation for any codebase, not just this one.

### One fetch returns a page, never everything

The server caps a flow-list request at **20 flows by default** (up to 50 with an explicit
`max_flows`, only when a `target` narrows the query does the cap lift). This page's list therefore
always shows a first page, not a full inventory — search and the Type/Tags filters are how a
reviewer narrows down to the flow they actually want, not decoration on top of a complete table.

---

## THE MENTAL MODEL

### A flow is an ordered chain of steps, not a raw call graph

Klauro's flow-derivation groups the entry point's downstream call chain into named semantic steps
(Validate → Process → Persist → Call External → Respond is the archetypal shape) rather than
listing every function call. Each step ties back to one or more concrete functions — sometimes a
whole function, sometimes a line-range *section* of one large function — so "the step" and "the
code" are always one navigation away from each other.

### Every step, and the flow as a whole, carries the same six-facet contract

Both a flow and each of its steps carry: **input** (what it receives), **logic** (what it does, in
one line), **side effects** split into *state changes* (writes to data) and *external
integrations* (calls to other systems), **output** (what it returns), and **constraints**
(validation/auth/rate-limit/error/invariant/business rules, each tied to real evidence). This
repeats the entry-points brief's ICELOT model at flow granularity — the flow-level contract is the
*aggregate* across the whole chain; a step's own contract is its narrower slice.

### Roles are classified, not asserted

Every flow carries a `role`: **core** (serves a domain capability), **supporting** (auth, config,
notifications, audit), or **infrastructure** (health checks, telemetry, migrations, serialization —
plumbing). This repository, filtered to product entry points, comes back **577 core** flows in the
first structural pass, with the classifier weighing entry-point type, terminus shape, and
capability linkage above name-guessing. A flow whose classification looks wrong is a real finding,
not noise — the `role_evidence` field says exactly why it landed where it did.

### Capabilities and flows are M:N, and the role lives on the EDGE

A flow can relate to more than one capability, and the SAME flow can be primary for one capability
while merely supporting another — the role is a property of the *relationship*, not the flow or the
capability alone. On this repository, `App Add Member` relates to two capabilities
(`cap_mcp_server`, `cap_fab_mcp_tool_surface`), both as `supporting` — its entry point isn't a
listed operation of either capability, but it touches entities both capabilities care about. That
"supporting, both ways" shape is a real, common answer, not a fallback — one capability, many
capabilities, or zero capabilities linked are all honest outcomes this page must hold at once (per
the entry-points brief's same one/many/none discipline).

### An entry-point id tells you the modality without a second fetch

Entry-point ids are minted `entry_<type>_<...>` — `entry_http_...`, `entry_cli_...`,
`entry_event_...` — so a flow's `entry_point` string alone is enough to classify it into the same
family/kind vocabulary the entry-points page uses (Web/HTTP, CLI, Event, Schedule, and so on),
without loading the full CAS just to label one badge. This is what "flows grouped by entry
modality" means in practice on this page — the Tags filter, not a re-fetch.

---

## WHAT THE PAGE HOLDS AT EACH LEVEL

**The list** — name, role, how many capabilities link to it (0/N, both honest), step count. Three
metrics the mock shows (avg. users/month, avg. bugs/month, execution time) have no backing field in
this data yet — see DESIGN-NOTES.md.

**The detail page** — the step chain end to end; the currently-selected step's own narrower
contract (functions, inputs, outputs); the flow-level aggregate contract (inputs, outputs,
constraints); system effects (external integrations, state changes); the entities it touches; and
the entry point it starts from, linked back to the entry-points page. Flow-to-flow relationships
("used by", "downstream flows") and internal-service relationships have no backing field yet —
also in DESIGN-NOTES.md, not silently dropped.

### Data realities to design for

- **Counts span a dozen to 2,000+** depending on codebase size — this repository alone derives
  4,614 flow candidates (958 product-shaped).
- **The response budget is real** — 20 flows per fetch by default; design for "first page plus
  narrowing," not "the whole table."
- **Zero is a valid, common answer** for capability links, external integrations, and constraints —
  render it plainly, never hide the row or fake a value.
- **Raw code-shaped names happen** — a flow named after its handler function (`Call react`,
  `App Add Member`) is exactly as real as a clean domain phrase like "Create Order"; both must
  read cleanly in the same table.

# Functions: the finest drilldown into the code itself

DESIGN BRIEF · KLAURO

A plain-language guide to a body of data Klauro produces, written so you can decide how and where
to present it. It describes what the information *is* and the shape it comes in — the presentation
is yours to design. Follows the entry-points design brief's structure and tone (the canonical
exemplar); the differences are called out explicitly rather than silently improvised.

**Audience:** design · **Scope:** one codebase, every node in it · **Tests:** out of scope ·
**Numbers:** from a live analysis (this repository analyzing itself)

---

## Start here: what we're describing

Every other view in this product — capabilities, flows, entry points, entities — is Klauro
*interpreting* the code: grouping it, naming its purpose, telling you what it's for. This view is
the opposite move. It's the code **as the analyzer actually parsed it**: every function, method,
class, interface, property, and variable it found, each with its exact file and line. If the other
views are the map, this is the terrain the map was drawn from.

That makes it the *last* stop in the product's drilldown ladder, not a parallel one. A capability
links to the flows that realize it; a flow links to the functions that implement its steps; an
entry point links to the handler function it calls. All of those links eventually point at *this*
data. This view is where every other view's "jump to the code" lands.

> **Who looks at this, and why**
> A developer who followed a link here from a capability, flow, or entry point and wants the exact
> file:line, the signature, and "what else is near this." · An engineer auditing a specific
> function's blast radius before changing it — "what calls this, and what does it call?" · Someone
> who doesn't have a starting point yet and wants to search or browse by name, type, or file — the
> one place in the product where you go from zero (no capability, no flow, no entry point in mind)
> straight to a function. The through-line: **the code, addressable by name, with no interpretation
> layer between you and it.**

## The mental model: nodes, not "functions"

The route is called "Functions" because that's the readable name, but the data underneath is
broader — Klauro calls every one of these a **node**, and a node can be a function, a method, a
class, an interface, a property, or a variable. There's no separate "classes" view or "variables"
view; they all live in one browsable set, distinguished by a `type` field. A **file is not itself
a browsable node here** — files get their own dedicated view (see "The file view" below), so this
catalog only ever holds things *defined inside* a file, never the file as a row.

Unlike entry points, node `type` is not a small, fixed vocabulary — it's whatever label the
language-specific analyzer for that file produced (`function`, `method`, `interface`, `property`,
`variable`, and dozens more across 45+ supported languages). **Don't hardcode a type list.** The
type filter has to be built from whatever types are actually present in the loaded analysis, the
same way the file filter has to be built from whatever files are present — both are open,
data-driven vocabularies, not closed enums like the entry-point kind list.

## What we know about a single node

| WHAT IT IS | WHAT IT TELLS THE READER |
|---|---|
| **Name** — `name` | The clean identifier: `apiRequest`, `handleCreate`. Always a real code token — there's no separate "friendly label" the way some entry points get one. |
| **Type** — `type` | function, method, class, interface, property, variable, … — see above. |
| **Signature** — `signature` | Parameters (name, type, optional/default) and return type, when the node is callable. A class/interface/property has none — this is `null`, not an empty `()`. |
| **Where it lives** — `source.file` / `source.line` / `source.end_line` | The exact file and line range. The primary way anyone jumps from this view into an editor. |
| **Description & its source** — `description` / `description_source` | A one-line explanation, tagged with how it was produced: written deterministically from structure, written by AI, written by hand, or reused from a similar node. The tag matters — it's the difference between "the analyzer inferred this" and "a person said this." |
| **Tags** — `tags` | Free-form labels the analysis attached (e.g. a framework role). Present on some nodes, absent on most. |
| **Callers** | Every node with a `calls` edge pointing *at* this one — who reaches this code. |
| **Callees** | Every node this one has a `calls` edge pointing *to* — what this code reaches. |
| **Its file's other nodes** | Everything else defined in the same file — the neighborhood. |
| **Risk & stability** | Present only when the analysis computed them for this specific node (see below) — most nodes have neither. |

### Callers and callees are the point

Name, type, and file:line describe *one* node. Callers and callees describe its **relationships**
— and per the task this view exists to serve, those relationships are first-class, not a footnote:
each caller and each callee is itself a full node, rendered as a row that links onward to its own
detail page, which has its own callers and callees, which link onward again. There's no floor to
this — you can follow a call chain as deep as the analysis traced it, one node at a time. This is
the mechanism the capability → flow → function ladder eventually bottoms out into: a flow's steps
name functions, and from a function you can now walk the *actual call graph* around it, not just
the flow's curated sequence.

A caller or callee row can point at something that isn't independently browsable here — most
commonly an **exit point** (a synthetic node representing an external call, like a `fetch()` or a
database query, which the analysis tracks as an edge target but which has no file:line of its own
to browse into). Render that row honestly: the edge is real and the name is real, it just doesn't
link anywhere further. Don't drop it and don't fake a link.

### Risk and stability: present sometimes, absent others

Two more facts *can* attach to a node, computed by a separate inference layer that doesn't run
uniformly over every node in an analysis:

- **Change risk** — a risk level (low/medium/high/critical) plus the specific factors behind it
  (many callers, no tests, recent bug-fix churn, sits on a critical path, …). Computed for nodes
  the analysis flagged as risk-relevant, not for all 47,000.
- **Temporal stability** — a stability class (stable/evolving/volatile/fragile) derived from git
  churn, bug-fix density, and refactor frequency.

Same stance as the entry-points brief's telemetry section: **absent is the common case, not an
error.** Most nodes carry neither field. Design the node detail page to look complete without
them, and richer with them — never a fake "Risk: none computed" panel where there's simply no
data.

## The file view: the same nodes, sliced the other way

Every node names the file it lives in — the file view is that same relationship read backwards:
pick a file, see everything Klauro found inside it, **grouped by type**. It's a much smaller
surface than the full node browser (a file's node count runs from a handful up to a few hundred,
never tens of thousands), so it doesn't need the browser's search/filter/paging machinery — it's a
straightforward grouped list. Two views, one relationship, read in opposite directions: node → its
file (a single link on the detail page), and file → its nodes (a dedicated page).

## The shape of the real data

Five facts about how this data actually looks, mirroring the entry-points brief's own five —
because a naive treatment of a "browse everything" view breaks even harder here than it does for
entry points.

**01 — The count is enormous, and no server-side search exists yet.**
This repository's own analysis holds **49,492 nodes and 57,469 edges**. A small codebase might
carry a few hundred; a large monorepo like this one runs into the tens of thousands. Today, the
only API route serving this data (`GET /api/projects/:id/cas`) returns the **entire** analysis in
one response — there's no `?search=` or `?type=` endpoint yet. Every view built against this data
today has to fetch that one whale-sized payload once, then filter and page through it entirely in
the browser. That's an honest, real limitation, not a design choice: it's more network weight than
any other view in this product pays, and it's the first thing that should change once a
server-side node-search route exists. Filtering/paging logic here is written as a thin selector
over the cached payload specifically so a real search endpoint can be swapped in underneath it
later without changing how the page consumes it.

**02 — The distribution is extremely lopsided, by both type and file.**
A single 466-line source file in this repository (`apps/app/src/api.ts`) accounts for **302**
nodes on its own — mostly interface property declarations — while most files carry a fraction of
that. Function/method nodes are typically a small minority of the total; property and variable
declarations dominate by raw count in a typed codebase. A flat, un-grouped list makes this
invisible; type and file each need to be first-class filters, not an afterthought, or the browser
reads as noise.

**03 — Every name is a raw code token, by definition.**
Unlike entry points — where roughly a third of names are code tokens and the rest are closer to
plain phrases — **every node name here is a code identifier**, always. There is no "clean phrase"
version of `apiRequest` or `SessionUser`. The design doesn't need a token-detection heuristic the
way the entry-points view does; it needs monospace type treatment as the default, everywhere,
because that *is* the correct rendering for 100% of rows, not a special case for some of them.

**04 — IDs are even rawer than names, and must never be the primary label.**
A node's `id` (e.g. `function_apps/app/src/api.ts_apiRequest_0`) and its `qualified_name` encode
the file path, the name, and a disambiguating index, concatenated with underscores — useful for a
technical reader doing a literal lookup, unreadable as a primary label. `name` is always the clean
identifier to lead with; `id`/`qualified_name` belong in secondary, small, monospace text, if shown
at all.

**05 — Detail varies by node type, same as detail varies by entry-point kind.**
A function or method carries a real signature (parameters, types, return type). A class or
interface carries none — it has children (its properties/methods) instead, reachable through "its
file's other nodes" rather than a signature block. A property carries neither a signature nor
(usually) callers/callees. The sparse case — a property with just a name, a type-in-name, and a
file:line — is the common case for roughly half of what this view holds, not the exception; design
it first, the way the entry-points brief insists on designing the bare-label case first.

> **Don't forget the in-between states**
> A node whose analysis has no description yet (deterministic description generation didn't run,
> or produced nothing usable). A node with zero callers *and* zero callees — a true leaf, which is
> common and correct, not a broken graph. A search or filter combination that matches nothing. A
> file with only one or two nodes in it. Each of these is a normal, expected state to design for,
> not an edge case to patch in afterward.

## How it all fits together

```
Codebase
  └─ File            — one source file; owns a set of nodes, browsable as its own view
       └─ Node        — YOU ARE HERE — a function, method, class, interface, property, variable
            ├─ Callers   — nodes with a `calls` edge INTO this one
            ├─ Callees   — nodes this one has a `calls` edge OUT TO
            └─ Risk / stability — present only when the analysis computed them
```

Two directions of movement define the interaction, and both are drilldown, not navigation-away:

- **Sideways, through the call graph** — from any node, to its callers or callees, to *their*
  callers or callees, indefinitely. This is the graph-traversal interaction the task exists to
  make possible, and it's the one thing no other view in this product offers at this grain.
- **Sideways, through the file** — from any node, to its file's other nodes, to any of *those*
  nodes' own detail pages.

There's no vertical move upward defined by this data alone (node → flow, node → entry point) —
those links live on the flow and entry-point records themselves (a flow's steps reference
function IDs; an entry point's handler references a node ID), not on the node. A node detail page
can be a landing target from those other views, but doesn't have to independently discover its way
back up; that's the calling view's link to build, not this one's.

## No Figma design exists for these routes

Checked the 5 screens named in `apps/app/docs/LANE-COMMON.md`'s Figma section and confirmed against
`apps/app/docs/SCREEN-MAP.md`: none is a node/function browser or detail screen. `/codebases/:projectId/functions`
and `.../functions/:nodeId` are **derived** — SCREEN-MAP.md names Flow List (table pattern) and Flow
Overview (detail pattern) as the closest designed screens, the same pairing the entry-points lane
derived its own list/detail pages from. See `apps/app/docs/DESIGN-NOTES.md` for the specific
element-level derivations (search bar, filter row, bordered table card, header + stacked card
sections) this build reused from those two screens. The file view
(`/codebases/:projectId/functions/file/*`) has no Figma precedent either and isn't in SCREEN-MAP.md
at all — it's this lane's own addition, derived from the same Flow Overview card pattern used for
the relationship lists.

---

*Klauro · Node/function analysis · Counts from a live analysis of this repository ·
Plain-language design handoff*

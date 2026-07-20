# DESIGN BRIEF · KLAURO

## Dependencies: everything a system reaches for, and everywhere it reaches out

A plain-language guide to a body of data Klauro produces, written so you can decide how and where
to present it. It describes what the information *is* and the shape it comes in — the presentation
is yours to design.

**Audience:** design · **Scope:** one codebase at a time · **Tests:** out of scope · **Numbers:**
from a live analysis of Klauro's own repository (`proof-of-concept`, self-analyzed — 49,492 nodes)

---

## START HERE

### What we're describing

Entry points are every way *into* a running system. This is their mirror: every way the system
reaches back *out*. Klauro calls each one an **exit point** — a database query, an outbound HTTP
call, a message pushed onto a queue, a file written, a cache invalidated. Together, entry points
and exit points are the complete surface of contact between this system and everything around it —
one page shows the doors people knock on, this page shows everywhere the system itself goes
looking for help.

Four related but distinct bodies of data sit under one "Dependencies" rung:

- **Exit points** — every individual outbound call site, grouped by family.
- **External services** — the *named systems* those calls resolve to (Postgres, Redis, a specific
  third-party API), when the analyzer can identify one.
- **Libraries** — what the codebase declares it depends on, from its own manifests.
- **Communication seams** — whether each outbound call waits for an answer or fires and moves on.

> **Who looks at this, and why**
> An engineer new to a system asking *"what does this actually talk to, and how much of it is
> our own database versus someone else's API?"* · A reviewer scoping a migration or an outage,
> asking *"if Postgres goes down, how much of this breaks?"* · Anyone auditing what third-party
> code runs inside this system before adding a new dependency. The through-line: **the blast
> radius of everything outside this codebase's own walls.**

---

## THE MENTAL MODEL

### Exit points come in five families

Exit points fall into families based on *what kind of thing they reach* — a split this page
computes from the analyzer's fixed exit-point vocabulary (11 kinds, `CASExitPointType`). The counts
below are from this repository's own live analysis, and they are **extremely lopsided** — that
skew is not noise, it's the system's character.

**Data stores** — 862 (846 database + 16 cache), 66% of all exit points
The dominant family, by a wide margin. Every query, write, and cache operation this codebase makes
against its own state. A system this database-heavy reads as "most of what this code does is
persist and retrieve" — worth surfacing before a single row of detail.

**Libraries & SDKs** — 342, 26%
Calls into third-party libraries that themselves reach outside the process (AWS SDK, MikroORM
client construction, the Anthropic/OpenAI SDKs). Distinct from External Services below: this
family is *what the call looks like in the code*, not *what it resolves to*.

**Outbound APIs** — 71, 5.5%
Direct HTTP calls this codebase makes to another service, plus any webhooks it fires.

**Messaging** — 25, 1.9%
Redis pub/sub and similar publish/subscribe calls — how this system talks to other running copies
of itself or other services, asynchronously.

**Device & client** — 0 in this analysis, but never dropped from the vocabulary
Local file writes, browser storage, client-side navigation, analytics pings. A frontend-heavy
codebase would show real numbers here; a backend service typically shows zero, which is itself
informative, not an omission.

> Same discipline as the entry-points family mix: **the vocabulary is fixed and complete.** A
> family with zero members for this codebase simply doesn't render a section here — it's never
> a surprise, because the full list is documented, not invented on the fly.

### One exit point can name a service, or not

Not every exit point resolves to a named external service. `ext_https:_post`, `ext_mikro-orm`,
`ext_redis_cache`, `ext_anthropic`, `ext_openai` — the analyzer names a service when the call
target is identifiable (a known SDK, a resolvable hostname, a docker-compose service name like
`postgres:5432`). A `fetch()` call to a URL built from a runtime variable often can't be resolved
to a name at analysis time — it still shows up as an exit point, just without a service identity
attached. **Don't design the external-services list as "the complete list of what this talks to"**
— it's the subset the analyzer could put a name to. The exit-points list underneath it is the
complete one.

---

## THE FULL VOCABULARY

### Every kind of exit point

| Family | Kind | Meaning |
|---|---|---|
| Data stores | Database | A query or write against a relational/document store. |
| Data stores | Cache | A read, write, or invalidation against an in-memory store. |
| Libraries & SDKs | Library / SDK | A call into a third-party library that itself reaches out. |
| Outbound APIs | Outbound API call | An HTTP/RPC request to another service. |
| Outbound APIs | Webhook | An HTTP callback fired to notify another service. |
| Messaging | Message / queue | An item pushed onto a queue for another consumer. |
| Messaging | Event / topic | A published event, or a subscription to one. |
| Device & client | File | A local filesystem read or write. |
| Device & client | Navigation | A client-side redirect or route change. |
| Device & client | Client storage | A browser storage read/write. |
| Device & client | Analytics | A tracking/telemetry call. |

---

## THE KEY RELATIONSHIP

### Every exit point drills to the function that makes it

An exit point isn't a floating fact — it's one line inside one function. Every exit point carries
`source_node`, the id of the function or method containing that call. This page's design contract:
**every row is clickable, and clicking it opens that function's own detail page** (signature,
file:line, callers, callees) — the same node-detail surface the Functions lane owns. This mirrors
the entry-points brief's "every entry point opens into a flow": here, every exit point opens into
the code that fires it.

> **Why this matters for the design**
> This page answers "what does the system depend on" at the *catalog* level — the shape, the
> families, the named services. But the moment someone asks "wait, where exactly does this
> happen," the answer should be one click away, not a separate search. Leave that door open from
> every row.

---

## DATA REALITIES

**The database-class dominates, and that's the point.** 66% of exit points in a real analysis are
database or cache operations. A dependencies page that gives every family equal visual weight
(five equal-sized cards) would misrepresent the system as evenly-distributed when it's really
"this is fundamentally a data-persistence-heavy service with some SDK calls and a thin messaging
layer." Show the shape before the rows — chip counts or proportional sizing, not five identical
boxes.

**Evidence provenance, not vibes.** Every exit point, external service, and library entry in this
data model traces back to a specific call site or manifest line (`source_node` + file:line for
exit points; `declared_in` manifest paths for dependencies). Nothing here is inferred from a
package name or a folder structure — if the analyzer can't point to the line, it doesn't claim the
dependency. Surfacing that evidence (even just a file:line caption under a row) is what makes this
page trustworthy for a security or migration review, not just a pretty catalog.

**"Recognized" libraries and "all declared" dependencies are different lists, on purpose.**
`libraries` is the subset the analyzer's framework/library detectors interpreted — it comes with
usage patterns and a criticality flag. `dependency_manifest` is the complete, uninterpreted raw
list straight from every package.json/requirements.txt/Cargo.toml in the repo. A dependency can
appear in the manifest with no detected usage pattern (small, quiet libraries) — that's a real,
common gap between the two lists, not a bug in either one. Design for both views to coexist rather
than silently merging them into one number that overstates or understates coverage.

**Communication seams here are sync/async only, not the full model.** Klauro computes a richer
seam classification server-side (sync / async / **passive** — two components that share state
through a database table with no direct call between them) for agent-facing tools. That passive
modality isn't wired into this page's data source yet (see `apps/app/docs/DESIGN-NOTES.md`), so
what's built today is the two-thirds of the picture the live data actually supports: does this
call wait for a response, or not. Design the summary so it can grow a third "passive" segment
later without a rework — it's the honest gap, not a placeholder concept.

**Empty is a real state, three different ways.** No exit points at all (a pure library with no
side effects), no *named* external services despite plenty of exit points (nothing resolved to an
identity), and no dependency manifest at all (no package.json/requirements.txt found) are three
distinct, legitimate empty states — each deserves its own honest sentence, not one generic "no
data" box.

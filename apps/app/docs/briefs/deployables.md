# Deployables: what actually ships, on its own

A plain-language guide to a body of data Klauro produces, written so you can decide how and
where to present it. It describes what the information *is* and the shape it comes in — the
presentation is yours to design.

`Audience: design` · `Scope: one deployable unit at a time` · `Numbers: from a live analysis` ·
`Data source today: a client-side mirror of the analyzer's rule, not yet the MCP-scoped surface
itself — see "Data realities" below`

No Figma screen covers this page. It's derived from the design language + the closest designed
screen (the entry-points catalog's per-deployable switcher shape) — this brief is the design
contract for what got built.

---

## Start here: what we're describing

Most codebases Klauro analyzes ship as ONE thing — one API, one service, one CLI. That's the
common, valid, terminal case, and it needs no special treatment.

Some codebases ship as **more than one independently-runnable piece from the same repo**: an
API server and a background worker built from the same monorepo, each with its own
Dockerfile; a CLI binary and the library it's built from; an installer that bundles two
binaries into one artifact. When a codebase resolves **two or more** of these — Klauro calls
each one a **deployable unit**, and the repo has "promoted" to a Deployable Analysis Workspace
(DAS). Below two, there's nothing to switch between, and the page says so plainly rather than
showing a picker with one disabled choice.

> **Who looks at this, and why**
> An engineer asking *"if I change this file, which of our shipped artifacts does it actually
> affect?"* · A reviewer asking *"does this repo really ship two things, or is that one
> Dockerfile just a build stage?"* · Anyone drawing the boundary between "this codebase" and
> "the thing that actually runs in production" before reasoning about blast radius. The
> through-line: **the repo's own claim about what it ships, made out of evidence, not folder
> names.**

## The mental model: evidence decides, not names

A deployable unit isn't a guess based on directory structure. It's built from concrete,
inspectable **ship evidence** — a Dockerfile, a `docker-compose.yml` service block, a
Kubernetes manifest, an installer script, a CI deploy step, a standalone binary target. Each
piece of evidence carries:

- **What kind of ship declaration it is** (container, compose-service, k8s, serverless,
  installer, ci-deploy, bin, server-entry, package, build-image).
- **A tier**, which says how strong a claim it makes:
  - **Tier 1 — Ship declaration.** Something that unambiguously packages and runs an artifact
    (a Dockerfile, a compose service, an installer). Always counts as a ship unit on its own.
  - **Tier 2 — Runnable entry.** A binary target, a server's main entry. Counts on its own
    ONLY when it's the sole runnable candidate in the whole repo — otherwise it needs a
    Tier-1 sibling to vouch for it.
  - **Tier 3 — Package identity.** Weaker still; same sole-runnable exemption as Tier 2.
- **The concrete evidence lines** that justified the claim — file paths, manifest keys, port
  bindings. This is rendered directly, not summarized away, because evidence IS the product:
  a viewer should be able to see exactly why the analyzer called this a ship unit.

A unit can **bundle** other candidates into itself (an installer's evidence names the two
binaries it packages) — a bundled candidate is folded under its owning unit and never counted
as a separate ship unit, even though it still gets its own root path and evidence.

## The picker: sub_cas_nodes

The top of the page is a switcher — same shape as the entry-points catalog's deployable
switcher, one rung more specific. It lists every qualified unit by name; picking one scopes
everything below it to that unit. With only one unit, the picker doesn't render at all — one
unit means the repo hasn't promoted.

## Per-unit sections, in disclosure order

**Overview** — name, tier, kind, root path, and the boundary evidence lines. The "why does
this count" answer, always visible, never behind a click.

**Ship evidence** — what this unit actually packages: the paths under `ships_paths` (with the
bundle's entrypoint member marked), declared port bindings, and — for a container — the base
images its Dockerfile builds `FROM`. Any of these can be legitimately empty for a given kind
(a `bin` has no ports); an empty section is a real case, not a missing one.

**Bundled members** — the runnable candidates this unit's own evidence names as something it
packages, listed under it, never as peer rows. Empty for the common case of a unit that bundles
nothing.

**Entry points & capabilities** — every entry point attributed to this unit's file tree,
reusing the exact same table the entry-points catalog uses, plus the capabilities those entry
points collectively serve (aggregated straight off each entry point's own capability tags — no
separate lookup, no capability that exists in the abstract with zero entry points under it).

**Entities & files** — the data entities this unit's code creates, reads, updates, or deletes,
and a count of the files resolved under its root. A unit with zero entities (an infra/glue-code
unit with no persisted shapes of its own) is common and shown as exactly that, not an error.

## Data realities

- **The picker's ids are the real ones.** The `das:...` id scheme is reproduced exactly as the
  analyzer computes it (same slug-of-kind-root-name construction, same collision handling), so
  if the MCP-scoped surface is ever exposed over HTTP, these ids will already match it.
- **The per-unit slice is an approximation, and says so in the code and here.** The true DAS
  slice (`get_summary` with a `das_unit_id` scope) walks the call graph to compute a
  reachability closure per unit, including shared/owned code attribution across units. That
  algorithm lives only in the MCP surface today — `GET /api/projects/:id/cas` returns the full,
  repo-wide CAS payload, not a pre-sliced one. This page instead scopes entry points by their
  existing `deployable_id` attribution (root-path-prefix matching, computed server-side and
  already present on each entry point) and scopes files/entities by the same root-path
  membership test. The numbers will usually agree with the true slice; they can diverge for
  code genuinely shared between units, which the true slice tags explicitly and this page
  currently cannot.
- **Orphan node count is an honest gap, not a fabricated zero.** The DAS spec asks that nodes
  reached by no unit at all be reported, never silently dropped. That count requires computing
  every unit's reachability closure at once — this page cannot do that without the MCP tool, so
  it says exactly that instead of guessing.
- **A single-deployable codebase is the common case**, not a degraded one. Most repos will
  never show this page's picker at all — that's success, not a missing feature.

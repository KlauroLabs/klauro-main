# Trivial-case degenerate findings — one repo, one deployable

**Date:** 2026-08-09
**Method:** blackbox only — `mcp__klauro__*` MCP calls against the hosted
product (`mcp.klauro.com`), no engine imports. No new analysis was submitted;
an existing hosted analysis for the target (`project_id: prj_NoIB2-3iP290WjKc`,
run at `2026-08-10T02:33:44Z`, `state: succeeded`) was reused via
`resolve_agent_analysis` / `get_summary` / `get_semantic_coverage` to avoid
adding load to shared analysis infrastructure while peer lanes were running.
Terminology in this document follows the owner's current usage: **CAS that
nests**, sub-CAS nodes, parent/leaf CAS. "WAS", "DAS", and "Analysis Scope"
are not used below even though the live product's own field names and status
strings still use them (see Finding 5) — `docs/analysis-scope/SPECIFICATION.md`
v2.0.0 was read first per instruction, and is itself mid-consolidation.

## Target

A self-hosted, single-language application repo under the owner's local
`~/dev` tree, not touched or modified for this exercise beyond read-only MCP
queries (git status before and after the session is identical — three
untracked `.klauro*` files were already present from an earlier session, none
added or removed by this one). Shape, not identity, matters here:

- One backend language, one embedded frontend asset set, no framework beyond
  the language's own stdlib HTTP server.
- **659 files**, single `main.go` entry point, single compiled binary.
- Four packaging recipes for that one binary (Debian package build, RPM
  package build, Alpine-base Docker image, distroless-base Docker image) and
  three CI workflows that drive those recipes.
- One database (Postgres), reached through a single storage package.

This is functionally identical in shape to the ~657-file / "7 ship units" /
`0.0096` coverage example already on record — independently re-derived and
verified here, not assumed.

## What the product currently reports

```
type: "monorepo"
das_index.promoted: true
das_index.qualified_unit_count: 7
das_index.reason: "7 tier-qualified ship units resolved (>= 2), so this CAS
                    is a Deployable-Analysis Workspace."
das_index.coverage_ratio: 0.0096   (114 / 11890 nodes covered)
das_index.orphan_node_count: 11776
communication_seams: {"sync":34,"async":0,"passive":106,"total":140,
                       "level":"deployable"}
```

The 7 "ship units": `packaging/debian`, `packaging/docker/alpine`,
`packaging/docker/distroless`, `packaging/rpm` (all `kind: container`), plus
`.github/workflows/rpm_packages.yml`, `.github/workflows/docker.yml`,
`.github/workflows/debian_packages.yml` (all `kind: ci-deploy`).

## Ground truth, checked by reading the actual Dockerfiles

```
packaging/debian/Dockerfile:      ADD . /src            CMD ["/src/packaging/debian/build.sh"]
packaging/rpm/Dockerfile:         ADD . /go/src/app      RUN make <binary-name>
packaging/docker/alpine/Dockerfile:      COPY --from=build /go/src/app/<binary-name> /usr/bin/<binary-name>   CMD ["/usr/bin/<binary-name>"]
packaging/docker/distroless/Dockerfile:  COPY --from=build /go/src/app/<binary-name> /usr/bin/<binary-name>   CMD ["/usr/bin/<binary-name>"]
```

All four build from the same source root (the repo root, `ADD .`), compile
the same `main.go` into the same single binary, and (where they run it at
all) run the identical `CMD`. Two are OS-package **builders** that don't even
run the binary — they produce `.deb`/`.rpm` artifacts. This is exactly the
"packaging VARIANT" case named in the brief: distinct artifacts sharing an
entry point and source root. It is one deployable, packaged four ways. The
three CI workflows are pipelines that *build* those four variants — they are
not independent deployables and should never have been eligible for
ship-unit status at all; a CI workflow is not a ship unit, it is what
produces one.

## Finding 1 — structural label is wrong

`type: "monorepo"` for a 659-file, single-binary, single-database
application. There is nothing here that fits any reasonable definition of
monorepo (no independently-versioned packages, no independently-deployable
services sharing a source tree). This is a leaf CAS with **zero** real
sub-CAS nodes, mislabeled as a parent.

## Finding 2 — manufactured sub-CAS nodes (the root cause of everything downstream)

The ship-unit detector counts one unit per Dockerfile/build-artifact
signature and one per CI workflow carrying a "deploy marker," with no
collapse step for shared entrypoint + shared source root. `promotion_threshold`
is 2; four packaging variants alone clear it 2x over, and the three CI
workflows pile on three more. Once `qualified_unit_count >= 2`, the whole CAS
flips into what the reason string still calls "Deployable-Analysis Workspace"
mode, and every downstream metric that assumes real children starts reporting
against those 7 phantom units instead of against the one real deployable.
This is precisely the invariant the owner named: **a parent must never
contradict — or in this case, must never even be manufactured out of — its
children when there are no independent children to justify one.**

## Finding 3 — coverage_ratio reads as catastrophic failure and is not one

`coverage_ratio: 0.0096`, `orphan_node_count: 11776` of `graph_node_count:
11890`. The "orphans" sampled include `test_suite_client_client_test_go_*` —
ordinary Go test functions, i.e. most of the graph. This isn't a broken
analysis; it's the denominator being "membership in one of the 7 fake ship
units" instead of "membership in the one real deployable." A leaf CAS covers
its own graph by definition (there is nothing else for its nodes to belong
to). Once Finding 2 is fixed and `qualified_unit_count` correctly resolves
to 0 or 1, this field should either read ~1.0 or, per the brief's own rule
("a CAS with no children is COMPLETE, not deficient"), be **absent** rather
than present as a near-zero scalar that reads as defect.

## Finding 4 — communication_seams framed as inter-deployable traffic that doesn't exist

`communication_seams` reports `"level":"deployable"`, `34 sync / 0 async /
106 passive`. For a single-deployable system this framing implies traffic
*between* deployables. There is only one deployable here; whatever the 34
"sync" edges actually are (most plausibly ordinary intra-process calls
between the 7 phantom units, i.e. between packages of the same binary), they
are being reported through a vocabulary that presupposes plural children.
This is downstream of Finding 2 in the same way Finding 3 is — the seam
counter walks the same manufactured unit boundaries.

## Finding 5 — dead terminology is still live in the product's own output

The field is literally named `das_index`, and its `reason` string says
`"...so this CAS is a Deployable-Analysis Workspace."` The owner's brief
states plainly that DAS is dead vocabulary. It is not just a naming
preference issue for docs — it is baked into a field name and a
human-readable string a consumer of the MCP tool sees directly. Whatever the
fix for Findings 1–4, this is worth flagging separately since it will not be
fixed by changing the detection logic alone.

## Does the rest of the output actually let you understand the system?

Setting the das_index/coverage noise aside, the parts of `get_summary` that
don't depend on ship-unit boundaries are accurate and useful, checked
against source:

- **What it is** — the AI-authored description ("self-hosted news
  aggregator... create, modify, and categorize feeds... OAuth2 and WebAuthn...
  Ansible playbooks") matches the actual system. `system_type:
  backend-service`, `architecture_type: "Full-stack application"` (it does
  ship an embedded web UI, so this is defensible) are both reasonable.
- **8 capabilities** (manage feeds, read/organize entries, discover/subscribe,
  manage accounts, secure API access, WebAuthn, schedule updates, session
  security) — all real, all traceable to actual handlers and entities. No
  invented capability, nothing obviously missing.
- **Where data lives** — 25 data entities correctly enumerated (`User`,
  `Feed`, `Entry`, `Category`, `APIKey`, `Integration`, `WebAuthnCredential`,
  ...), with sensitive-field flags (`Integration.WallabagPassword`,
  `Feed.Password`, `APIKey.Token`, etc.) that are all real fields in the Go
  models. This is genuinely useful and correct.
- **What a new engineer should learn first** — the top-3 "journeys" surfaced
  are `X-Forwarded-Proto config parsing`, `main() -> Parse`, and the Ansible
  playbook entry, ranked above any feed-reading journey. That is a weak
  onboarding signal (config parsing and CLI arg parsing are not what a new
  engineer needs first in a feed reader) but not a wrong fact — just a
  ranking miss, worth a note, not a headline finding.
- **How it talks to other services** — there are no other services. The
  product has no way to say that cleanly; it says `communication_seams` with
  a `"level":"deployable"` framing instead (Finding 4), which is actively
  misleading rather than silent.

**Net read:** a consumer reading only `get_summary` for this repo would come
away with a correct understanding of what the system does, its capabilities,
and its data model — and a *wrong* understanding of its shape (monorepo, 7
ship units, "0.96% covered"). The correct 90% is undermined by the wrong 10%,
because `type` and `das_index` are exactly the fields a consumer checks
first to decide how much to trust everything else.

## Scope of this pass

This covers only the trivial end, per instruction ("the trivial-case verdict
is worth more to me right now... it is the cheaper fix"). The complex-end
matrix (16-17 repo trees, parent/child contradiction and inter-node-fact
invariants) was not started this session — flagged as the explicit next
step, not silently dropped.

## Bottom line

One root cause, not four independent ones: **ship-unit detection has no
entrypoint+source-root variant-collapse step**, so a single Go binary
packaged four ways plus three CI workflows that build those packages
resolves to 7 "qualified units," which flips `type` to monorepo, invents a
`das_index`, divides the real graph by a fake denominator (coverage_ratio),
and reframes intra-binary calls as inter-deployable seams. Fixing the
collapse rule (same entrypoint + same source root ⇒ one unit, and CI
workflows are never themselves ship-unit candidates) should make Findings
1–4 disappear together. Finding 5 (dead `das_index`/"Deployable-Analysis
Workspace" naming in live output) needs a separate, explicit rename pass —
it will survive a correct detection fix.

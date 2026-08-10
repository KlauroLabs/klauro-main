# Complex-case findings — a real multi-repo tree, parent composition

**Date:** 2026-08-09/10
**Method:** blackbox only (`klauro` CLI + `mcp__klauro__*`), no engine imports.
**Note on commit timing:** this file was written but **not yet committed** —
at write time `docs/cas/proof-of-concept` had an in-progress merge
(`.git/MERGE_HEAD` present, unresolved conflict in
`packages/analyzer-core/src/types/cas.types.ts`) from a concurrent peer
lane. Committing on top of an unresolved merge risks finishing someone
else's conflict resolution by accident, so this file was left untracked
until the tree is clean. Whoever lands this should `git add` +
commit it once the merge resolves.

## Headline finding: there is currently no parent to test

The two invariants the owner asked for — a parent must never contradict its
children, and a parent must be union-plus-inter-node-facts — **could not be
tested against the live product**, because the live, installed product has
no reachable way to compose a parent CAS from multiple analyzed repos right
now. This is the most important finding of this pass, ahead of anything
about the invariants themselves.

Evidence:

- The CLI's own source (`apps/mcp-server/src/cli.ts` in this repo) defines
  `workspace-analysis`, `cross-codebase-analysis`, `workspace-get`,
  `workspace-list`, `account-workspaces`, and `account-workspace-attach` as
  real commands, including a worked example in its own help text:
  `klauro workspace-analysis ~/dev/<tree-a>/<repo-a> --reference-path
  ~/dev/<tree-a>/<repo-b> --target <tree-a>-workspace` — the CLI's own
  worked example names two real repos from one of the local multi-repo
  trees available to this session, i.e. exactly this class of subject was
  the design target for the feature.
- The **installed** CLI binary (`/opt/homebrew/bin/klauro`, version
  `1.0.127+2235c82c0370-dirty`, built `2026-07-24T05:26:28Z`) does not
  recognize any of those commands. `klauro workspace-analysis ...`,
  `klauro cross-codebase-analysis ...`, and `klauro account-workspaces`
  all fall straight through to the generic usage banner — same behavior as
  typing a nonexistent command. Verified directly, not inferred.
- No equivalent tool exists in the currently connected `mcp__klauro__*`
  tool surface either (checked by search; every exposed tool takes a single
  `path` scoped to one bound project — `get_summary`, `get_product_map`,
  `resolve_agent_analysis`, etc. — there is no `list_workspace_analyses` or
  cross-codebase tool live in this session's server build).
- No per-repo CAS output inspected below populates `repository_links` or
  `cross_repository_links` (both defined in the CAS spec) — confirmed by
  grepping the full `get_summary` payloads for four analyzed repos. Zero
  cross-repo link detection happens even at the single-repo level.

**Consequence for the two invariants:** invariant 1 (parent never
contradicts a child) is vacuously untestable — there is no parent claim to
check for contradiction. Invariant 2 (parent = union + inter-node facts) is
testable only by hand, outside the product, which is what the rest of this
document does — and it shows the raw material for a correct parent
composition already exists in the per-repo facts; the product simply never
joins it.

## The subject

Two large multi-repo trees were available this session, each roughly
16-17 repositories across several languages. Chose one of the two
arbitrarily. Enumerated all 16 repos in the chosen tree before touching
anything:

```
admin-ui            scan-repo
client-ui            secondary-ui-repo
contractors          mobile-repo
poc / poc-old        tray-repo
releases             system-infra
self-hosted-builder  website
backend-repo            ci-repo
demo-repo           scan-repo
```

Languages across the tree, from file-extension survey: TypeScript/TSX
(admin-ui, client-ui, contractors, backend-repo, secondary-ui-repo, website), Rust
(poc, poc-old, scan-repo, tray-repo, mobile-repo's native layer), Python
(demo-repo), Dart/Flutter + Kotlin/Swift/C++ (mobile-repo), Terraform
(system-infra), Groovy/Jenkinsfile (ci-repo). `poc` alone has 256k raw
files (cargo `target/` build output inflates this; source is a small
fraction — matches the existing memory note that this specific directory
is target-dominated). Two repos (`poc`, `client-ui`) already carried
`.klaurorc` artifacts from an earlier, unrelated session — not created by
this pass, not modified further, read-only queries only.

From READMEs, this is a zero-trust/VPN-style product: `backend-repo` is a
NestJS backend exposing `admin-api`, `user-api`, `internal-api`, and
`mcp-api`; `admin-ui` and `client-ui` are two separate React frontends;
`mobile-repo` is a Flutter client with a Rust native core for VPN tunneling;
`system-infra` is the Terraform for the AWS deployment; `self-hosted-builder`
is a self-hosted install path.

## What was analyzed, and how (operational-limit compliance)

Chose a 4-repo core cluster to keep the box's shared load bounded while
still spanning three languages and a real client/server boundary:
**backend-repo** (backend), **admin-ui** (frontend), **mobile-repo** (mobile,
Rust+Dart), and **client-ui** (frontend — reused an existing hosted
analysis from an earlier session rather than re-running it).

- Checked `uptime`/`vm_stat` before every step. Local load stayed in the
  17-40 range throughout (peer lanes active); note this reflects the local
  Mac, not the hosted analyzer VPS — this session had no SSH access to the
  VPS to check its load directly, so compliance with the "2 concurrent /
  sequential batches" limit was enforced by **never issuing more than one
  `klauro analyze` at a time and polling each to completion before starting
  the next**, which is the actionable equivalent available from this
  vantage point.
- Set up **git worktree copies** in the scratchpad directory for the three
  repos that needed a fresh analysis (never ran `klauro init`/`analyze`
  against the owner's real checkouts). Removed all three worktrees after
  use.
- Reused `client-ui`'s existing hosted analysis via `resolve_agent_analysis`
  rather than re-running it (`analyzer_build` on that stored analysis:
  produced under `cas_version 1.11.0`, same as the three fresh runs — safe
  to compose against).
- Total: 3 new analyses (backend-repo: 17,155 nodes / 97s; admin-ui: 12,611
  nodes / 79s; mobile-repo: 1,645 nodes / 45s), all sequential, 1 reused.

## Operational incident: a worktree-remove step deleted real files in the owner's repo — caught and fixed

While cleaning up worktrees after analysis, `git worktree remove --force`
on the `mobile-repo` scratch worktree was followed by a `git status` check
of the **real** `~/dev/<tree>/mobile-repo` repo that showed 29 files under
`native/` (the Rust core) as deleted in the working tree. This is the same
defect class as the standing `GIT_INDEX_FILE worktree hazard` note: a
linked worktree shares the object database with the main checkout, and
something in the analyze/worktree-remove sequence propagated a deletion
back to the real working tree. `git fsck` on all three repos showed only
harmless dangling objects, no corruption. `git status` also revealed a
peer agent's own worktree already present under
`admin-ui/.claude/worktrees/agent-a76a774c627ed7b86` and a stale prunable
worktree entry under `backend-repo` pointing at a now-gone `/private/tmp/...`
path — i.e. concurrent worktree activity from other sessions in these same
repos, consistent with the "several peer lanes are analysing concurrently"
warning.

**Fixed immediately**: `git checkout -- native/` in the real
`mobile-repo` repo restored all 29 files; `git status --short` confirmed
clean afterward; `git fsck` showed no corruption; the stale prunable
worktree entry (directory already gone) was pruned with
`git worktree prune`, the peer's active worktree in `admin-ui` was left
untouched. All three touched repos (`backend-repo`, `admin-ui`, `mobile-repo`)
and the untouched `client-ui` were re-verified clean (`git status --short`
empty except client-ui's pre-existing, pre-session `.klaurorc` files)
before writing this document.

**This should be treated as a standing hazard, not a one-off**: worktree
copies were the sanctioned way to avoid touching real repos during
analysis, and the mechanism itself has a data-loss failure mode under
concurrent multi-session use. Flagging for the owner and for whoever owns
the `GIT_INDEX_FILE worktree hazard` note — this is a second, independent
trigger of the same class of bug, this time via plain `git worktree
add`/`remove --force`, no custom `GIT_INDEX_FILE` involved.

## Confirmatory finding: the trivial-case root cause reproduces here, just masked

`backend-repo` is a **genuine** NestJS monorepo (its own README says so), and
its `das_index` correctly finds four real sub-applications:
`internal-api`, `user-api`, `admin-api`, `mcp-api` (41/64/292/14 entry
points respectively). `type: "monorepo"` is **correct** here — useful
negative control showing the classifier isn't universally broken.

But layered on top of those four legitimate units, `das_index` also
resolves two more "qualified units" that both claim the **entire repo
root** and both report **exactly 379 entry points — the total for the
whole system**:

```
das:compose-service:root:app-base   | compose-service | root "."  | 379 entry points
das:installer:root:backend         | installer       | root "."  | 379 entry points
```

This is the identical defect class from the trivial-case report (root-level
packaging/compose/installer evidence counted as its own ship unit
alongside the real sub-units it's built from), just **not visible in the
headline metrics here** because real sub-units exist to anchor coverage:
`coverage_ratio: 0.9999`, `qualified_unit_count: 6` (4 real + 2 phantom).
On a repo with real children the phantom root units are silent noise on
`sum_of_unit_node_counts` (which the spec already documents can exceed
`graph_node_count` for legitimate reasons — shared code — so this
particular over-count doesn't currently trip anything visibly broken). On
a repo with *no* real children (the trivial case), the same
root-claims-everything behavior is the entire defect. One fix — don't let
root-path evidence register as its own ship unit when the root's evidence
is just "this is where the sub-units live" — should close both.

## Confirmatory finding: the correct single-deployable path already exists and works

`admin-ui` (a plain React app, no packaging variants, no CI-deploy noise)
resolves `qualified_unit_count: 1`, `promoted: false`, and — this is the
important part — the `reason` string is exactly right: *"1 tier-qualified
ship unit found (unnamed-service) — below the promotion threshold of 2, so
this CAS is its own single deployable and needs no per-unit slicing.
Coverage and orphan counts describe slices and are therefore zero here,
not 'nothing found'."* `coverage_ratio: 0` here is not a bug — the string
explicitly disclaims it, framed exactly the way the trivial-case report
argued the field *should* be framed. This is strong evidence the fix for
the trivial-case defect is narrow: get `qualified_unit_count` right (collapse
packaging variants, exclude CI workflows, don't double-count repo root),
and the already-correct single-deployable branch takes over automatically.

## Invariant 2, tested by hand: real cross-repo entity duplication exists and the product cannot see it

Pulled `database_entities` from all four children and compared by name and
shape:

| Concept | backend-repo (backend, source of truth) | admin-ui | client-ui | mobile-repo |
|---|---|---|---|---|
| User/account | `User` | (referenced via `IUserRoleAssign`, `PartnerMe`) | `User`, `UserBasic`, `CurrentUser`, `UserData` | — |
| Device | `UserDevice`, `ServiceAccountDevice` | `IDevice`, `ConnectedDevice` | `IDevice`, `UserDevice`, `IUserDeviceRegister` | `ApiRegisterDevice`, `CheckDevice` |
| Gateway/agent | `Agent`, `Gateway`, `InlineGateway`, `AgentControl` | `TGateway`, `InlineGatewayUpsert`, `InlineGatewayBasic` | — | — |
| Access/policy | `AccessRequest`, `AccessBinding`, `Policy`, `PolicyConditions` | `TAccess`, `IPolicy`, `GrantAccess`, `TGrantAccess` | `Access`, `AccessRequests`, `PaginatedAccessRequests` | — |
| Notification | `Notification`, `NotificationMetadata` | `INotification`, `IUnreadCount` | `Notification`, `UnreadCount` | — |
| Group/org | `Group`, `Organization`, `Role` | `IPaginatedGroups`, `PartnerWithHomeOrg`, `MemberPermissions` | `Group`, `Organization`, `Role` | — |

The same six domain concepts are independently, differently typed in three
or four repos each — the User/Device/Gateway/Access/Notification/Group
family recurs across the backend and both frontends with no shared type
package and no product-surfaced link between them. This is precisely the
finding the brief said "no child can see": each repo's own CAS correctly
lists its own version of `User` or `UserDevice`; none of them can say "this
is the same entity as the one three repos over, and here the field names
and shapes diverge." That comparison is exactly what a parent CAS should
compute and currently cannot, because there is no parent (Headline
Finding).

## Invariant 2, seam surface: `communication_seams` never leaves `level: "deployable"`

All four children report `communication_seams` at `"level":"deployable"`
only — backend-repo: 1512 sync/42 async/321 passive (intra-monorepo, i.e.
between its own four NestJS apps); admin-ui: 6 sync/1069 async; client-ui:
6 sync/81 async; mobile-repo: 47 sync/0 async. None of these are, or claim
to be, edges *between* backend-repo and admin-ui/client-ui/mobile-repo — e.g.
no edge asserting "admin-ui's `useFetchAgents` hook calls backend-repo's
`GET /agents` route." Given admin-ui and client-ui both plainly are HTTP
clients of backend-repo (React apps calling a NestJS backend is the whole
point of the product), this is a real, checkable inter-node fact a correct
parent should surface, and currently nothing does — same root cause as the
Headline Finding, not a new defect.

## Trying to answer the real question anyway

Using only the per-child product output (no parent available), attempted:
major services and what each does, how they talk, where data lives, what a
new engineer should learn first.

- **What are the major services and what does each do** — **true and
  useful, by hand-assembly**: backend-repo's 11 capabilities (manage
  users/groups, agents/gateways, access requests/bindings, billing,
  networks/resources, devices, policies, traffic logs, notifications,
  health) correctly describe a zero-trust access broker. admin-ui and
  client-ui's capability lists (326 and 46 respectively — see caveat below)
  are frontend-shaped restatements of the same domain from two different
  user roles (admin vs. end user). mobile-repo's capabilities describe VPN
  tunnel management (signal/agent-connection/UDP transport). A reader who
  manually stitched all four `get_summary` calls together would land on a
  correct picture. **But the product never does this stitching — a
  consumer has to do exactly the manual work this document just did.**
- **How do they talk to each other** — **absent**, not wrong. Nothing in
  the product claims a false connection; it simply has no mechanism to
  claim a true one either (Invariant 2 seam finding above).
- **Where does data live** — **true, per child, but not deduplicated**:
  each child correctly flags its own sensitive fields (backend-repo's `User`,
  `Billing`; admin-ui's `PartnerBilling`; client-ui's `User.email`). A
  reader has to notice by eye that `User` in three of the four repos is
  "the same" `User` — the product doesn't flag it, and won't unless
  Invariant 2 is closed.
- **What must a new engineer learn first** — **weak here on its own
  terms, independent of the parent question**: admin-ui's `get_summary`
  reports **326 capabilities**, with top entries like "View Hook", "Manage
  Column Width", "Manage App Context" — UI-implementation-detail noise
  ranked above anything a new engineer would actually need (auth, access
  requests, gateway management). This looks like the "generic output"
  failure mode named in `docs/SPEC-ABSTRACTION-TIERS.md` §Tier 3 (capability
  extraction over-firing on every hook/prop-bag in a large React app,
  producing volume instead of substance) — separate from the parent-child
  question, worth flagging on its own.

## A third, unrelated but systemic defect noticed in passing

Three of the four children (`admin-ui`, `client-ui`, `mobile-repo`) failed
L5 AI enrichment with the identical error: *"Klauro comprehension produced
an ungrounded system description that failed the grounding gate
(read-only-product-mutation-claim)."* Only `backend-repo` (the backend)
succeeded. This reads as a systemic issue with the grounding gate on
frontend/client-shaped repos specifically (three different frontend
stacks — React, React, Flutter — all hit the same gate; the one NestJS
backend didn't), not a one-off. Not investigated further — out of scope
for this pass, flagged for whoever owns L5/comprehension.

## Bottom line

The two invariants the owner most wants proven are **not testable against
the live product today**, because parent-CAS composition (`workspace-analysis`
/ `cross-codebase-analysis` / account-workspace grouping) exists only in
this repo's in-progress source, not in the installed CLI or the connected
MCP server. Tested by hand instead: the raw material for both invariants is
present and good — genuine cross-repo entity duplication exists and is
findable (Invariant 2's clearest case), and there is no contradiction to
find for Invariant 1 only because there is no parent claim yet to contradict.
The trivial-case root cause (root-path evidence double-counted as its own
ship unit) reproduces here too, confirmed on a repo where it's currently
silent (real sub-units mask it) rather than loud — same fix should close
both. Separately: a worktree cleanup step in this session deleted and then
restored 29 real files in the owner's `mobile-repo` checkout, a second,
independent trigger of the standing `GIT_INDEX_FILE worktree hazard` class
of bug — flagged as a live operational risk under concurrent multi-session
use, not just a historical incident.

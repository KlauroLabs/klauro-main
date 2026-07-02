# Entity Model: Org / Workspace / Project / User + Monorepo Handling

Status: design study, not yet implemented. Grounded against two real monorepos on
this machine (`/Users/michaelshattuck/dev/zerac/zerac-api`,
`/Users/michaelshattuck/dev/unravl/proof-of-concept`) and the current
`account-store.ts` schema. All claims below are backed by tool calls made
during this study; see "Validation evidence" for exact outputs.

## 1. Honest current-state: does Klauro already detect deployables?

**Yes, largely — this was the central open question and the answer is yes with
one real gap.**

`apps/mcp-server/src/cross-codebase-analysis.ts` already has a full
`applications` / `deployables` / `distribution_units` model in the WAS
(Workspace Analysis Spec) layer. It runs `buildApplications()` over one or more
CAS inputs and, critically, does **not** treat "one repo = one application" —
`applicationSurfaceCandidatesFromCas()` (line ~9600) walks every CAS node's
source file and every `distribution_unit` and classifies sub-paths:

```
/^(apps\/[^/]+)/     -> deployable: true   (apps/admin-api, apps/user-api, ...)
/^(services\/[^/]+)/ -> deployable: true
/^(cmd\/[^/]+)/      -> deployable: true   (Go convention)
/^(bin\/[^/]+)/      -> deployable: true
/^(packages\/[^/]+)/ -> deployable: false  (library)
/^(crates\/[^/]+)/   -> deployable: false  (Rust library)
```

This is exactly the "apps/* = deployable, packages|libs/* = library" heuristic
the proposed model calls for, and it already exists, running today, wired into
`run_workspace_analysis` / `get_workspace_capability_map`.

### What it gets right (validated against zerac-api)

Running `run_workspace_analysis(paths: ["zerac-api"])` against the real
4-deployable NestJS monorepo produced **exactly the 4 real deployables**,
correctly separated from 6 pieces of noise (docker-compose services, the repo
root, a loose script):

| id | deployable | kind | path_hint |
|---|---|---|---|
| `app:admin-api` | true | service | `apps/admin-api` |
| `app:user-api` | true | service | `apps/user-api` |
| `app:mcp-api` | true | service | `apps/mcp-api` |
| `app:internal-api` | true | service | `apps/internal-api` |
| `app:app-base` | false | service | `docker-compose.base.yml` |
| `app:minio`/`postgres`/`redis` | false | service | `docker-compose.yml` (infra) |
| `app:application` | false | service | loose script |
| `app:zerac-api` | true* | service | repo-root fallback |

(*the repo-root fallback entry is a duplicate/umbrella surface, not a 5th real
deployable — see gap G1 below.)

Note the founder's brief assumed zerac-api has 2 deployables (user-api,
admin-api); the real repo has **4** (`admin-api`, `user-api`, `mcp-api`,
`internal-api`, confirmed via `nest-cli.json`'s `projects` map and `ls apps/`).
The model below is designed for N deployables, not 2.

Deployables are also correctly attached to cross-cutting capabilities and
workflows. The "Inline Gateway Validation" capability's `deployable_ids` field
is `["app:admin-api", "app:user-api"]`, and its (degraded/deterministic)
description literally cites both controllers:

> "...through 34 HTTP routes (apps/admin-api/src/app/inline-gateway/inline-gateway-web.controller.ts, apps/user-api/src/app/app.controller.ts)."

The "Device" workflow is tagged the same way, spanning `admin-api` and
`user-api`. So Klauro doesn't just list deployables — it already knows which
capabilities/workflows cross deployable boundaries within one repo.

Same pattern held on the proof-of-concept repo itself: `run_workspace_analysis`
on this repo correctly isolated `apps/api`, `apps/app`, `apps/marketing-site`,
`apps/mcp-server` as the 4 deployables and `packages/analyzer-core` as a
library (deployable: false), plus 2 `application_links` between deployables
(vs. zerac-api's 0 — see gap G2).

### G1 — Gap: no first-class "shared library" edge between deployables

This is the real, material gap, and it is the one thing the founder's brief
explicitly asked to validate. `zerac-api`'s WAS output has:

```
composition.package_link_count: 0
composition.runtime_link_count: 0
summary.application_link_count: 0
distribution_units: []
cross_repo_links (get_cross_repo_links): links: []
```

Klauro knows `admin-api` and `user-api` both use `libs/business/auth` (that
path string appears ~7,485 times across the two apps' evidence arrays in the
raw WAS JSON — it's baked into individual capability/route evidence), but
there is **no aggregated, queryable "these N deployables share library X"
edge**. `get_shared_components(path)` — the tool that sounds like it should
answer this — only finds intra-app duplication (e.g. a React `StatCard`
component reused 16x inside `apps/internal-api/client`), not cross-deployable
`libs/*` sharing. This was tested directly and confirmed: it returned only
`internal-api/client/src/shared/components/*` hits, nothing from
`libs/business/*` or `libs/infrastructure/*`.

**What to build:** a `shared_libraries` (or `internal_dependency_edges`) field
in the workspace deployable model: for each pair of deployables, the set of
`libs/*`/`packages/*` targets both import, derived from the existing per-CAS
import graph (the analyzer already resolves TS path aliases like
`@app/business/auth` to `libs/business/auth` — that data exists per-repo, it's
just never rolled up across deployables). This is the single highest-leverage
addition for the monorepo story: it's what lets the product answer "if I
change `libs/business/auth`, which of my 4 deployables break?"

### G2 — `application_link_count` is inconsistent/underpowered

proof-of-concept found 2 application_links, zerac-api found 0, despite
zerac-api obviously having HTTP calls between its NestJS apps (they share a
Postgres db and dispatch background jobs via BullMQ across admin-api and
internal-api). `composition.reasons` for zerac-api says "4 deployable(s) are
isolated and should not be forced into the system graph" — i.e. the linker
correctly refused to *guess* links without evidence, which is the right
conservative default, but it means the runtime/db-sharing signal that *does*
exist (both apps hit the same Postgres via TypeORM, same Redis) isn't being
promoted to an application_link. This is lower priority than G1 but related:
shared *database* usage between deployables is a cousin of shared *library*
usage and both should feed the "what do these projects share" surface.

## 2. The account-store.ts current data model vs. the proposal

Read directly: `apps/mcp-server/src/account-store.ts` (283 lines) and the
`/api/*` handlers in `remote-analyzer-service.ts`.

Current schema (flat, no org, no team, no repo-awareness):

```
User            { id, email, name, password_hash }
Workspace       { id, name, created_by_user_id }
WorkspaceUser   { workspace_id, user_id, role: owner|admin|member }
Project         { id, workspace_id, name, repo_url?, local_path?, analysis_id? }
Session         { token_hash, user_id, expires_at }
```

Routes confirmed via grep: `POST /api/auth/register`, `POST /api/auth/login`,
`GET/POST /api/workspaces`. No org endpoints, no team endpoints, no per-project
invite endpoint, no repo/deployable-scoped project creation.

Distance from the proposed model:
- **No Organization at all.** Workspace has no nullable `organization_id` —
  it's implicitly always user-owned today (`created_by_user_id`, no org
  concept in between).
- **No Team.**
- **Workspace roles exist** (owner/admin/member) — this part is already
  correctly shaped for the proposal, just needs an org layer above it.
- **Project is 1:1 with `analysis_id`**, i.e. today "one project = one whole
  repo's analysis." There is no `repo_id` + `deployable_id`/`subpath` split.
  This is the crux of the monorepo gap: the schema has no way to represent
  "4 projects, 1 repo."
- **No per-project invites/roles** — membership is only at the workspace
  level; a user invited to a workspace sees all its projects. The proposal's
  "invitable to individual projects OR workspaces" isn't supported.
- **repo_url/local_path are strings on Project, not a first-class Repo
  entity** — so there's nowhere to hang "this repo has N deployables" or "here
  are the repos in this workspace" independent of which projects were created
  from them.

## 3. The entity model (proposed, refined)

```
Organization
  id, name, created_by_user_id, created_at

OrganizationUser              (org-level roles; needed once Team exists,
  org_id, user_id, role: owner|admin|member    or even before, for org-wide billing/admin)

Team                          (optional; groups users within an org for
  id, org_id, name                              default project access — v2, not blocking)
TeamUser
  team_id, user_id

Workspace
  id, name, organization_id?  (NULLABLE — see reasoning below)
  owner_user_id?              (set when organization_id is null)
  created_at

WorkspaceUser
  workspace_id, user_id, role: owner|admin|member

Repo                          (NEW — first-class, decoupled from Project)
  id, workspace_id, provider (github|gitlab|local), url?, local_path?,
  default_branch, last_indexed_at

Project
  id, workspace_id, repo_id, deployable_id?, subpath?, name,
  analysis_id?, kind (deployable|library|umbrella), created_at

ProjectUser                   (per-project invite/role, ADDITIVE to
  project_id, user_id, role      workspace membership — see below)

User
  id, email, name, password_hash, created_at
```

### Reasoning on the contested points

**Workspace.organization_id nullable — keep it nullable.** This is the
cheapest way to support solo/personal usage without a forced org, and it
matches what's already implicit in the current schema (workspace has no org
concept and works fine standalone). Making org mandatory would require a
"personal org" auto-created per user, which is just a nullable field wearing
a disguise, plus it complicates transfer ("transfer this workspace to an
org" vs. "transfer this workspace between orgs" become two different
operations if personal-org is fake). Keep it nullable; transferability
(workspace.organization_id changes, or owner_user_id changes to a null org)
is then a single mutation.

**Must a Project belong to a Workspace? Yes — with one nuance.** A Project
should always have exactly one `workspace_id`, because roles/billing/access
control live at the workspace level and a project without a workspace has
nowhere to inherit permissions from. The nuance the brief's model glosses
over: a Project should *also* always have a `repo_id`, because in the
monorepo case, N projects share 1 repo, and today's schema conflates "project"
and "repo" 1:1. Splitting `repo_id` out is the actual fix needed, not the
workspace-nullability question (which doesn't need to be revisited — a
project's workspace should never be optional, since Klauro's role/entitlement
model is workspace-scoped throughout the account-store).

Tradeoff of NOT requiring workspace: you'd need project-level org/owner
tracking duplicated from workspace, which is exactly the mess `Workspace`
exists to avoid. No good argument found against "project always belongs to
workspace" during this study.

**Per-project invites, additive not exclusive.** `ProjectUser` should layer on
top of `WorkspaceUser`, not replace it: a workspace member gets default
visibility into all the workspace's projects (matches today's behavior), and
`ProjectUser` is only needed for the narrower case of inviting someone to
*one* project without giving them workspace-wide access (e.g. a contractor
who should only see `admin-api`, not `internal-api`). If no `ProjectUser` rows
exist for a project, it inherits from workspace membership; if rows exist,
they scope it down. This avoids requiring a ProjectUser row for every
workspace member on every project (an O(users × projects) row explosion for
no benefit in the common case).

## 4. Monorepo → N projects mapping

**Detection: reuse WAS `applications`/`deployables` verbatim — don't build a
second heuristic.** The path-prefix classifier in
`applicationSurfaceCandidatesFromCas()` (apps/mcp-server/src/cross-codebase-analysis.ts:9663)
already produces exactly the `{name, path_hint, deployable: bool}` tuples a
"create N projects from this repo" import flow needs. Concretely:

1. User connects a repo (or points at `local_path`) to a Workspace.
2. Klauro runs (or re-uses) CAS analysis on the repo root.
3. Call `run_workspace_analysis(paths: [repo_path])` (single-repo WAS run —
   exactly what this study did) and read `.deployables` from the result
   (the array already filtered to `deployable: true`, e.g.
   `["app:admin-api","app:user-api","app:mcp-api","app:internal-api"]`).
4. For each deployable, create one `Project` row:
   `{ repo_id, deployable_id: app.id, subpath: app.path_hint, name: app.name, kind: 'deployable' }`.
5. Non-deployable applications (`libs/business/auth`, `packages/analyzer-core`)
   are **not** turned into projects by default — they're referenced, not
   owned, the same way `deployable: false` entries are excluded from
   `.deployables` today. (Optional: surface them as a read-only "Shared
   Libraries" tab per repo, not as Projects a user can be invited to
   individually — invites don't make sense for a library.)

**Lineage: `repo_id` + `subpath`/`deployable_id` on Project** (already
reflected in the schema above). This is sufficient because `subpath` is
already the WAS `path_hint` and is stable across re-analysis (path-based, not
generated-ID-based), so re-running analysis after new commits doesn't orphan
the Project↔deployable link.

**"What do sibling projects share": the G1 gap must be closed first.** Today
there's no queryable answer beyond re-deriving it by grepping raw WAS JSON for
shared `libs/*` evidence strings (which is what this study had to do — see
Section 1). The concrete fix: add a `shared_dependencies` computation to
`run_workspace_analysis`'s output, one row per (deployable_a, deployable_b,
shared_target, shared_target_kind: library|database|queue), derived from:
- import-graph intersection for `libs/*`/`packages/*` targets (new — needs the
  cross-deployable import rollup described in G1)
- exit-point target intersection for `database`/`cache`/`message` exit-points
  that resolve to the same physical target (this data already exists per-repo
  via `get_exit_points`, it just isn't cross-referenced between deployables
  in one repo today)

Until that lands, the UI-facing "what does project X share with project Y in
this repo" feature should be scoped down to "shared libs" computed by a direct
import-graph query (`get_dependencies`/`get_callers` per deployable, intersect
the `libs/*` targets) rather than promised as a WAS-level feature — it's a
real gap, not a UI polish item.

## 5. Concrete gaps, prioritized

**Klauro (product) must add:**
1. **G1 — shared-library rollup across deployables in one repo.** Highest
   priority; this is the single missing piece between "detects deployables"
   (done) and "shows you the monorepo's actual internal coupling" (not done).
   Land as a new field on the WAS deployable/application_link output, sourced
   from existing per-CAS import resolution.
2. **G2 — promote shared-database/shared-queue signals to application_links.**
   zerac-api's 4 deployables share Postgres + Redis + BullMQ queues but
   produced 0 application_links; the exit-point data to detect this already
   exists per `get_exit_points(path, type: database|message)`, it's just not
   cross-referenced across deployables within one repo run.
3. **Deployable-scoped analysis/query surface.** Today all repo-level MCP
   tools (`get_summary`, `get_route_table`, `get_entry_points`, etc.) take a
   `path`, which can already be pointed at a subdirectory
   (`resolve_agent_analysis` returned `apps/mcp-server` as a valid descendant
   analysis with its own node/edge counts during this study) — so this may be
   *mostly* solved already via path-scoped queries. Worth confirming whether
   `get_route_table(path: "zerac-api/apps/admin-api")` returns admin-api-only
   routes or falls back to the whole-repo analysis; not tested in this study
   and should be validated before assuming it's a gap.
4. A stable `deployable_id` naming scheme survives repo moves/renames
   (`app.id` today is `${codebaseId}:app:${name}` — codebaseId is derived from
   path, so moving the repo changes the id; the account-store's Project row
   should key on `subpath` primarily and treat `deployable_id` as a cache/hint,
   not a foreign key, to avoid breakage on re-clone to a new path).

**account-store.ts (product) must add:**
1. `organization`, `organization_user`, `team`, `team_user` tables (net-new).
2. `Workspace.organization_id` (nullable) — currently absent entirely, not
   just unenforced.
3. `Repo` as a first-class entity, decoupled from `Project` (currently
   `repo_url`/`local_path` live directly on `Project`, which is the root
   cause of the 1-repo-1-project assumption).
4. `Project.repo_id` (FK to new Repo) + `Project.deployable_id` +
   `Project.subpath` + `Project.kind` (deployable|library|umbrella) —
   replacing the current `repo_url?/local_path?` strings on Project.
5. `ProjectUser` table for per-project invites, additive to `WorkspaceUser`
   per the reasoning in Section 3.
6. A repo-import flow that calls `run_workspace_analysis` on the connected
   repo and creates one Project per returned `deployable: true` application
   (Section 4, steps 1-5) instead of today's single "create project, point at
   analysis_id" flow.

## 6. Validation evidence (for reproducibility)

- `resolve_agent_analysis(zerac-api)` — pre-existing CAS analysis, 11,378
  nodes, 512 entry points, `profile_kind: backend-service`.
- `run_workspace_analysis(paths: ["zerac-api"])`, saved as
  `zerac-api-entity-model-study` — 10 applications, 4 marked
  `deployable: true` (admin-api, user-api, mcp-api, internal-api), matching
  `ls apps/` and `nest-cli.json`'s `projects` map exactly.
- `get_shared_components(zerac-api)` — returned only intra-app React
  component reuse inside `apps/internal-api/client`, confirming no
  cross-deployable library-sharing surface exists today (G1).
- `get_cross_repo_links(paths: ["zerac-api"])` — `links: []`, confirming G1/G2
  from a second angle (cross_repo_links tool, not just WAS composition).
- `run_workspace_analysis(paths: ["proof-of-concept"])`, saved as
  `poc-entity-model-study` — 9 applications, 4 deployables (api, app,
  marketing-site, mcp-server), 1 library (analyzer-core), 2
  application_links (unlike zerac-api's 0 — inconsistency noted as G2).
- Direct read of `apps/mcp-server/src/account-store.ts` (full file, 392
  lines) and grep of `/api/*` route registrations in
  `remote-analyzer-service.ts` for the current-state schema in Section 2.

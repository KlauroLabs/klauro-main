# Corpus Validation — Klauro against the real `~/dev` corpus

**Date:** 2026-07-03
**Harness:** `apps/mcp-server/src/gauntlet/corpus-sweep.ts`
**Method:** blackbox only. Every per-repo analysis went through `analyzeForBench()`
(`apps/mcp-server/src/gauntlet/product-analysis.ts`), which stages the target
directory as a throwaway git repo and posts it to the product's own
analyzer-server over HTTP — the same path a real client uses. Every per-workspace
analysis went through `buildCrossCodebaseSystemGraph()` (`apps/mcp-server/src/cross-codebase-analysis.ts`),
a pure fusion function over the CAS outputs already produced by `analyzeForBench`,
never over engine internals. No `OPENAI_MODEL`/AI env var was set at any point.

This is **not** a fixture bench. The 100+ repos under `~/dev` are the user's
actual, in-progress, messy projects — untouched, uncurated, and never seen by
Klauro's test corpus before. The goal was to find where the product breaks on
real code and to separate systematic bugs (repeat across repos → real product
bugs) from one-offs.

## Coverage

Given time budget, this run completed the **8 lead targets** (5 standalone
projects + 3 multi-repo workspaces, the priority target list) to full depth,
with numbers cross-checked reproducible across three independent runs. A
broader discovery-mode sweep (`corpus-sweep.ts` walking all of `~/dev`, capped
at 25 additional standalone projects beyond the leads) was started but not
completed in this session — it was superseded by fixing a harness bug
(`sharedCodeRollupPresent` always read `undefined` — see Harness Fix below) and
re-running the leads to get a fully-correct read on the priority targets rather
than a wider but partially-wrong sweep. **Coverage: 8 of the 8 lead targets (100%
of priority), roughly 8 of ~100+ total repos in `~/dev` (discovery-mode was not
completed).** The harness itself supports the full sweep (`CORPUS_SWEEP_ONLY_LEADS`
unset, `CORPUS_SWEEP_MAX_PROJECTS` configurable) and can be re-run standalone
to extend coverage — this is logged honestly as a gap, not hidden.

## The honest scorecard

- **33 repos analyzed** (5 lead standalone projects + 28 sub-repos across 3
  workspaces: money×3, zerac×10, soon×15).
- **0 crashed.** Every repo the harness pointed at, including a repo with zero
  build manifests anywhere (hoggan) and 89 GB / 62 GB-of-target zerac/poc,
  returned a CAS without throwing.
- **3 of 3 workspaces graceful.** All three workspace-level CAS runs (money, zerac, soon)
  completed with 0 crashes and produced a workspace graph.
- **2 of 5 no-manifest project targets are genuinely manifest-less at any
  depth** (cleanmusic, hoggan) **and 3 turned out to have manifests nested
  below the root** (cleanmusic's own `backend/pyproject.toml`, hoggan's `.sln`
  three levels down, truckspy's per-service `package.json`/`composer.json`).
  All five still degraded gracefully at the top level — no crash, no garbage
  collapse to a single node.
- **1 "garbage domain" class found**: tiny/near-empty repos (≤2 source files)
  produce a domain label built from a raw hex hash rather than English words
  (see Finding 3). Confirmed on 2 of 15 `soon` sub-repos.
- **1 systematic "deployable-count anomaly" class found** (deployable count
  in the dozens-to-hundreds, tracking entry-point count almost linearly),
  present on **4 of 28 sub-repos + 1 of 5 lead projects** (5 of 33 total,
  15%) — see Finding 1.
- **1 systematic string-corruption bug found and root-caused to a single
  unanchored regex**, confirmed via direct reproduction (see Finding 2, on
  the hoggan lead project — a distinct bug from Finding 1, not a count
  anomaly but a name-corruption anomaly).

Precise counts:

| Scope | Analyzed | Crashed | Domain looks garbage | Deployable count looks anomalous (Finding 1) | Deployable names corrupted (Finding 2) |
|---|---|---|---|---|---|
| Lead standalone projects | 5 | 0 | 0 | 1 (truckspy) | 1 (hoggan) |
| money sub-repos | 3 | 0 | 0 | 0 | 0 |
| zerac sub-repos | 10 | 0 | 0 | 1 (poc) | 0 |
| soon sub-repos | 15 | 0 | 2 (coinbase_connector, fa-test) | 3 (alphaclaw, soon-lens, soon-sync) | 0 |
| **Total** | **33** | **0** | **2** | **5** | **1** |

## Summary table

### Standalone projects (lead targets)

| Repo | Manifest at root? | Languages | Nodes | Domain | Domain source | Deployables | Entry points | Time |
|---|---|---|---|---|---|---|---|---|
| kadra.ai | yes (pnpm+py) | TS/JS, Python | 2,380 | content-management | deterministic | 45 | 60 | 3.5s |
| kontinuum | yes (npm) | TS/JS | 5,500 | venue-booking | deterministic | 8 | 291 | 8.5s |
| cleanmusic | no (nested: `backend/pyproject.toml`) | Python, Java, Ruby, C/C++ | 2,698 | content-management | deterministic | 46 | 136 | 4.0s |
| hoggan | no (nested: `.sln` 3 levels down) | TS/JS, C#, C/C++ | 25,596 | clinical-testing | deterministic | 33 (**corrupted names**, Finding 2) | 8 | 26.7s |
| truckspy | no (nested: per-service manifests) | TS/JS, Python, PHP | 82,896 | fleet-management | deterministic | **432** (Finding 1) | 726 | 105-108s |

All 5 "graceful" — none crashed, none collapsed to zero nodes, all produced a
sane domain label for the top-level scan even without a root manifest.

### Workspaces

| Workspace | Sub-repos | Deployables | App links | Shared-code rollup | Workspace domain | Time |
|---|---|---|---|---|---|---|
| money | 3 (all Rust, standalone bots) | 2 | 0 | absent (correctly — no shared internal libs among 3 unrelated bots) | Solana Trading | ~4.4s |
| zerac | 10 | 23 | **123** | **present** (10 libs: auth, common, config, decorators, agent, msp, notification, organization, user, search) | Network Access Management | ~150s |
| soon | 15 | 35 | **142** | **present** (10+ libs: connectors, domain, infra-api-coingecko/front/stripe/fortress/google-analytics, infra-data-layer, infra-msg-broker, account) | Crypto Asset Trading | ~196s |

## Systematic findings (ranked by evidence strength / repo count)

### Finding 1 — Deployable-count over-count on HTTP-route-heavy monorepos (HIGH confidence, 5/33 repos, 15%)

**Repos affected:** truckspy (432 deployables / 726 entry points), soon-lens
(256/405), alphaclaw (144/167), soon-sync (86/659, partial), poc (138/436,
partial). Not triggered despite similarly high entry-point counts: zerac-scan
(2 deployables / 425 entry points), soon-link (3/340), admin-ui (3/79) — see
"why it doesn't fire uniformly" below.

**Root cause, found and confirmed by reading source:**
`packages/analyzer-core/src/analyzer/core/deployable-evidence/providers/bin-targets.ts:129-159`,
function `collectServerEntries`. For every `CASEntryPoint` with `type === 'http'`
and a resolvable `handler.file`, it emits one `DeployableEvidence` with
`kind: 'server-entry'`. The dedupe key at line 140 is
`` `${rootPath}::${entry.trigger?.path || entry.name}` `` — keyed by **route
path**, not by service/root directory. On a monorepo with hundreds of distinct
HTTP routes handled from the same file/directory (a typical REST controller),
every route becomes its own "deployable," even though they're all served by
the same one running process. This directly explains why truckspy (726 HTTP
entry points, mostly from `truckspyapp`'s Laravel controllers) shows 432
"deployables" — it isn't 432 separate shippable things, it's ~4 real
deployables (nginx, php-fpm, php-cli, plus the underlying Laravel app) plus
~428 route-shaped noise entries.

**Why it doesn't fire uniformly:** `zerac-scan` (425 entry points) and
`soon-link` (340 entry points) show only 2-3 deployables despite similarly
high entry-point counts — the guard `entry.type !== 'http'` and the
`handler?.file` presence requirement mean this only triggers for frameworks
whose route entry points get typed `'http'` with a resolvable handler file
(Laravel/PHP, some Node routers); it does not trigger for whatever framework
`zerac-scan`/`soon-link` use, which is itself worth checking separately (are
their routes even being classified as entry points at all, or are they a
different entry-point type that legitimately shouldn't feed deployable-evidence?).

**Fix direction:** change the dedupe key in `collectServerEntries` to
`rootPath` alone (one server-entry deployable per root directory/service, with
the route list folded into `evidence`/a `ships_paths`-like field), not per
route. This is a one-line-ish fix with a clear before/after: 432 → likely
single digits for truckspy.

### Finding 2 — Domain/name string corruption from unanchored substring-stripping regex (HIGH confidence, reproduced directly)

**Repo affected:** hoggan (`deployable_evidence` names).

**Root cause, found and confirmed by direct reproduction:**
`packages/analyzer-core/src/analyzer/languages/distribution-artifact-analyzer.ts:378`,
function `productNameFromFile`:

```ts
const clean = base.replace(/[-_]*(installer|install|release|manifest|build|deploy)[-_]*/gi, ' ').trim();
```

This regex is **not word-boundary anchored**, so it strips the substring
`install` out of `Uninstall.bat`, leaving `"Un"`. Reproduced directly:
`"Uninstall".replace(/[-_]*(installer|install|release|manifest|build|deploy)[-_]*/gi, ' ').trim()` → `"Un"`.
hoggan's real files are literally `Install.bat` and `Uninstall.bat`
(confirmed via `find`), and the corrupted `"Un"` name appears twice in
hoggan's `deployable_evidence` array.

**Second, related bug in the same code path:** `Name "([^"]+)"` at line 226 of
the same file matches the literal (unresolved) NSIS macro/template-variable
text in `Name "${APPNAMEANDVERSION}"` and `Name "${S_NAME}"` (confirmed present
verbatim in hoggan's `.nsi` files, e.g.
`Hoggan.Setup/Install.nsi:68` and `Hoggan.Setup/Plugins/UAC_AdminOnly.nsi:3`).
The regex has no guard against capturing an NSIS `${...}` template reference
as if it were a resolved literal product name, so the raw unresolved
placeholder string leaks straight into `deployable_evidence[].name`.

**Fix direction:** (a) anchor `productNameFromFile`'s strip regex with `\b`
boundaries so it can't match inside a larger word; (b) reject/skip captures
that are still wrapped in `${...}` (an NSIS variable reference), falling back
to `productNameFromFile` in that case instead of emitting the raw macro text.

### Finding 3 — Hash-suffixed garbage domain on near-empty repos (MEDIUM confidence, 2/15 in one workspace)

**Repos affected:** `soon/coinbase_connector` (2 nodes, 1-2 real source
files) → domain `"2854116f6f28b523-management"`; `soon/fa-test` (0 nodes,
a 1-file stub with no source, just `package.json`) → domain
`"8ad3259c93e0ce6a-management"`.

**Root cause (partially traced):**
`packages/analyzer-core/src/analyzer/core/orchestrator.ts:11005` composes a
fallback domain as `` `${normalizedDomain}-management` `` whenever
`normalizedDomain` is non-generic and has no hyphen (line ~11000-11005). The
guard `isGenericDomainToken()` (line 12382) is an explicit allowlist of
~40 known-generic words (`app`, `service`, `client`, ...) but has **no check
for "this token looks like a hex hash/id, not an English word."** When a repo
has essentially no source to extract a real domain concept from, whatever
upstream fallback produces `normalizedDomain` appears to fall through to a
hash-like string (likely a project/analysis-id used as a last-resort unique
label), which then gets `-management` appended and surfaced as if it were a
real domain classification. This is confirmed at the symptom level (both
occurrences are on the two smallest/most content-free repos in the corpus);
the exact producer of the hash string itself was not traced further given
time budget, but the fix point is clear regardless of the producer: add a
`/^[0-9a-f]{6,}$/i`-style guard to `isGenericDomainToken` (or a sibling check
gating the whole `-management` compose branch) so a hash-shaped token is
treated as "no domain signal" rather than composed into a fake-looking label.

**Severity note:** this only shows up on genuinely tiny/stub repos (0-2
source files) — it is a real "looks broken" moment for a user staring at the
domain label, but it does not indicate a deeper structural failure; it is a
narrow input-validation gap in one fallback path.

### Zerac's lib-into-consumer bundling pattern: systematic, not zerac-specific

The mission asked whether zerac's `api->client`/`user->admin-api` shared-code
bundling pattern is systematic across the corpus or a one-off. **Answer: it is
present on both multi-repo workspaces in this sweep that have real internal
shared libraries (zerac and soon), and correctly absent on the one workspace
that doesn't (money).**

- **zerac**: `shared_code_rollup` is non-empty — 10 internal libs detected as
  consumed across the workspace (`auth`, `common`, `config`, `decorators`,
  `agent`, `msp`, `notification`, `organization`, `user`, `search`), with 123
  cross-repo application links overall.
- **soon**: also non-empty — 10+ internal libs detected (`connectors`,
  `domain`, `infra-api-coingecko`, `infra-api-front`, `infra-api-stripe`,
  `infra-data-layer`, `infra-msg-broker`, `account`, `infra-api-fortress`,
  `infra-api-google-analytics`), with 142 cross-repo application links.
- **money**: `shared_code_rollup` empty, 0 application links — correct,
  because money's 3 sub-repos (`arb_engine`, `jito-mev-bot`, `rust-arb-bot`)
  are genuinely independent standalone Rust trading bots with no shared
  internal package between them.

This is a real positive signal for the product: workspace analysis correctly
detects internal shared-library consumption when it exists and correctly
reports nothing when it doesn't, across two structurally different real
workspaces (zerac's TS/Rust zero-trust platform, soon's TS crypto-trading
platform).

**Harness bug found and fixed along the way:** the first sweep pass read
`graph.shared_code_rollup.shared_components?.length`, which doesn't exist —
`shared_code_rollup` is itself the array (`WorkspaceSharedCodeRollup[]`), not
an object wrapping one. This silently reported `sharedCodeRollupPresent: false`
for all three workspaces on the first run. Fixed in `corpus-sweep.ts` to check
`graph.shared_code_rollup.length > 0` directly; re-ran and got the correct
`true`/`true`/`false` result above. Filed here rather than silently
overwritten, since a harness bug that produces a false "the feature doesn't
work" reading is exactly the kind of mistake this sweep exists to catch in
itself, not just in the product.

## One-offs (not systematic, noted for completeness)

- `admin-ui` (zerac) and other high-entry-point-but-normal-deployable-count
  repos (`zerac-scan`, `soon-link`) suggest Finding 1's HTTP-route bug is
  framework-dependent, not universal — worth a follow-up to check whether
  their routes are even reaching `deployable_evidence` at all (a possible
  separate, opposite-direction gap: under-detection instead of over-detection).
- `poc-old` (zerac) domain reads `flake-management` — plausible given it's a
  Nix-flake-based build tooling repo, not flagged as garbage.
- No repo in this sweep triggered a true crash, OOM, or infinite loop despite
  including an 89 GB workspace (zerac) with a 61 GB `target/` directory
  correctly excluded from staging, and a 5.1 GB single-repo project
  (kadra.ai) with `node_modules` correctly excluded.

## Single highest-value fix

**Finding 1** (deployable dedupe key in `bin-targets.ts:collectServerEntries`
keyed on route path instead of root directory). It is: (a) the most frequent
systematic issue (5 of 33 repos, 15%, including the most route-heavy service
in the entire corpus at 432 deployables), (b) the most visible to a user or downstream
agent (a "432 deployables" answer for what is really ~4 real deployable units
is the kind of number that immediately erodes trust in the whole analysis),
and (c) a narrowly-scoped, well-understood one-line-shaped fix (change the
dedupe key), unlike Finding 3 which needs more tracing to find the true
upstream producer of the hash string.

## Harness notes

- `apps/mcp-server/src/gauntlet/corpus-sweep.ts` type-checks clean under
  `npx tsc --noEmit -p apps/mcp-server` (the one pre-existing error in that
  project, `product-analysis.ts:65` implicit-any, predates this session and
  is untouched).
- Every per-project and per-workspace call is wrapped in try/catch; a crash
  on one repo is recorded and the sweep continues (verified: zero crashes
  occurred in this run, so the catch paths were not exercised end-to-end by
  this particular sweep, but they were exercised by construction — the
  discovery-mode run against ~30 more real repos before being superseded
  produced no crashes either, up through the point it was stopped).
- Full raw JSON for this run:
  `/var/folders/5_/5xzp0rq57cs_m_2f263y1p8r0000gp/T/klauro-corpus-sweep-report.json`
  (also copied to `scratchpad/corpus-sweep-report-final.json` at the repo root
  for durability past `/tmp` cleanup).

## v1.0.13 Re-validation

**Date:** 2026-07-03
**Harness:** same `apps/mcp-server/src/gauntlet/corpus-sweep.ts`, extended this
session to also capture `routeCount` (`cas.route_table?.length`) per project
alongside the existing `entryPointCount`, so monorepo backend visibility can be
read directly off the console log instead of only the (larger) JSON dump.
`npx tsc --noEmit -p apps/mcp-server` stayed clean (same one pre-existing
`product-analysis.ts:65` implicit-any, untouched). Method unchanged: blackbox
only, `analyzeForBench()` + `buildCrossCodebaseSystemGraph()`, no AI env set.

**What changed in v1.0.13 under test:** `discoverProjectRoots` no longer treats
a Dockerfile-only directory as an independent project-boundary root
(`isPackageBoundaryManifest` in `language-registry.ts`/`orchestrator.ts`), so
Nx/Turborepo/pnpm-workspace monorepos whose `apps/*`/`cicd/*` dirs previously
got mis-split at a bare `Dockerfile` should now resolve as one coherent
workspace with all backend apps visible. Plus DI-call resolution and
receiver-gated repository detection in `typescript-javascript-analyzer.ts`.

### Coverage

Before this session's targeted leads were added, `~/dev` had **zero
Nx/Turborepo/pnpm monorepos in the prior sweep's lead list** — the July 2026
baseline above covered 33 repos but none of them exercised the specific
Dockerfile-only-boundary path this release fixes. This session first surveyed
`~/dev` for the monorepo shapes named in the mission (`find -iname nx.json`,
`turbo.json`, `pnpm-workspace.yaml`) and found: `zerac/zerac-ui` (Nx, no
Dockerfiles — apps carry `project.json` instead), and three pnpm workspaces —
`soon/soon-bos` (apps/* each with own `package.json` **and** `Dockerfile`),
`soon/finance-context-ts` (apps/* + packages/*, plus `cicd/api-external/` and
`cicd/scheduler/` which are **Dockerfile-only, no package.json** — the exact
`isPackageBoundaryManifest` case named in the mission), and `soon/soon-link`
(packages/frontend + packages/backend, each with its own `Dockerfile`). All
four were added as new `LEAD_PROJECTS` entries in `corpus-sweep.ts` and run
both standalone and as members of the existing `soon`/`zerac` lead workspaces.

The sweep ran: **9 lead standalone projects + 3 lead workspaces (28 sub-repos:
money×3, zerac×10, soon×15) + 6 discovery-mode standalone projects** = **14
completed standalone analyses + 28 sub-repo analyses + 3 workspace fusions =
42 repo-level analyses**, before the 16th standalone discovery target
(`unravl/proof-of-concept` itself — Klauro's own 14 GB source tree) crashed
the **harness process** with a V8 `heap out of memory` inside
`JSON.parse` on the HTTP response body, ending the run before
`fs.writeJson` wrote the final report file. This is a harness/self-analysis
scale limit (parsing a huge JSON payload in the driver process), not a
product-analysis crash caught by the per-repo try/catch — it happened one
level up, in the harness's own HTTP client. **Coverage: 42 of a targeted
~48-repo sweep (88%), including all priority monorepo targets to completion.**
Every number below is read directly from the sweep's own stderr log
(`scratchpad/sweep-stderr.log`), not projected.

### 1. No regression on single-repos

| Repo | Manifest | Dockerfile at root? | nodes | deployables | entryPoints | routes | crashed |
|---|---|---|---|---|---|---|---|
| `personal/kadra.ai` | package.json+pyproject.toml | no | 2380 | 11 | 60 | 40 | no |
| `personal/kontinuum` | package.json | **yes (root)** | 5500 | 8 | 291 | 0 | no |
| `personal/cleanmusic` | none (nested) | no | 2698 | 11 | 136 | 42 | no |
| `clients/outcode/hoggan` | none (nested, 3 levels) | no | 25596 | 35 | 8 | 0 | no |
| `clients/outcode/truckspy` | none (nested per-service) | no | 82896 | 16 | 726 | 518 | no |
| `clients/outcode/washup` | package.json | no | 6701 | 5 | 315 | 309 | no |
| `clients/outcode/WashUp-React` | package.json | no | 585 | 1 | 10 | 0 | no |
| `external/codebase-memory-mcp/graph-ui` | package.json | no | 664 | 1 | 1 | 0 | no |
| `unravl/legacy/ui` | package.json | no | 407 | 1 | 20 | 0 | no |
| `openclaw` (large single repo) | package.json | no | 76307 | 48 | 402 | 43 | no |

`personal/kontinuum` is the specific stress case the mission called for — a
genuine **single-repo with a root-level Dockerfile**. Under the old boundary
logic this is exactly the shape that risked having its root dropped in favor
of treating the Dockerfile's directory as its own (empty) project boundary.
It analyzed as one coherent project: 5500 nodes, 8 deployables, 291 entry
points — not split, not zeroed, not dropped. **No regression observed on any
of the 10 single-repos swept**, including the largest in the corpus
(`clients/outcode/truckspy` at 82,896 nodes, `openclaw` at 76,307 nodes).

### 2. Monorepo coverage gain (the headline change)

This is the load-bearing result. Three of the four target monorepos have real
backend apps that, under the pre-v1.0.13 Dockerfile-boundary bug, would be at
risk of getting sliced off as separate (and likely near-empty) project roots
at each `Dockerfile`:

| Monorepo | Shape | Backend apps present | entryPoints | routes | deployables |
|---|---|---|---|---|---|
| `zerac/zerac-ui` | Nx (`nx.json`), no Dockerfiles | apps/user-ui, apps/admin-ui (frontend only) | 8 | 0 | 2 |
| `soon/soon-bos` | pnpm workspace, apps/* each with own package.json **+** Dockerfile | bos-api, bos-workers, bos-scheduler, soon-sync-proxy, bos-web | **35** | 0 | 8 |
| `soon/finance-context-ts` | pnpm workspace, `cicd/api-external` + `cicd/scheduler` are **Dockerfile-only, no package.json** | apps/ext-web-api, apps/scheduler (backend services under packages/*) | 1 | 0 | 5 |
| `soon/soon-link` | pnpm workspace, packages/frontend + packages/backend each with own Dockerfile | packages/backend | **340** | **23** | 3 |

`soon-bos` and `soon-link` show real backend surface (35 and 340 entry points
respectively, `soon-link` also with 23 detected HTTP routes) — this is the
**gain**: backends inside a monorepo, sitting next to Dockerfile-bearing
directories, are visible and non-zero, which is exactly what a pre-fix
Dockerfile-boundary bug would have suppressed. `zerac-ui` (Nx, frontend-only
apps, no Dockerfiles in play) correctly shows a small, frontend-shaped project
— that's expected, not a regression, since there's no backend app in that
particular Nx workspace to miss.

**`finance-context-ts` is the one target that under-delivers relative to
expectation** — the mission's exact `isPackageBoundaryManifest` scenario
(`cicd/api-external/Dockerfile` and `cicd/scheduler/Dockerfile`, both
Dockerfile-only, no `package.json`, sitting next to `apps/ext-web-api` and
`apps/scheduler` which are the real backend services these Dockerfiles ship)
analyzed at only **1 entry point, 0 routes** despite the workspace having two
real backend Express/Node services under `apps/*`. This project ran cleanly
(no crash, 3418 nodes, 5 deployables) — so the monorepo-scope fix did not
*break* anything here, but it also did not surface the backend route/entry
depth this release's fix is meant to unlock. **This reads as either (a) a
narrower gap than Finding 1's "not analyzed at all" (the routes exist as
code, just under-detected as `entry_points`/`route_table`, a detection-depth
issue rather than a boundary-dropping issue), or (b) evidence the boundary fix
helps monorepos where the backend app itself sits at the Dockerfile's sibling
level (`soon-bos`, `soon-link`) more than ones where the Dockerfile lives in a
separate `cicd/` tree one level removed from `apps/*` (`finance-context-ts`) —
worth a follow-up trace into why `apps/ext-web-api`'s handlers aren't reaching
`route_table`.** Flagging honestly rather than rounding it up to a clean win.

No before/after comparison run exists for these four monorepos under the
pre-v1.0.13 build in this session (that would require checking out the prior
release and re-running, which was out of scope for the time budget) — the
"before" claim rests on the documented mechanism (`isPackageBoundaryManifest`
in `language-registry.ts`/`orchestrator.ts`) plus the fact that three of four
targets show real, non-trivial backend surface today. Recommend a follow-up
session diff `finance-context-ts` specifically against pre-v1.0.13 to confirm
whether its low entry-point count is pre-existing or a partial regression.

### 3. v1.0.11/12 fixes held

- **Finding 1 (deployable over-count from route-path-keyed dedup):**
  `clients/outcode/truckspy` — previously **432 deployables** — now reads
  **16 deployables** (726 entry points, 518 routes) in this run. The dedupe
  fix holds; the count is back to a plausible order of magnitude for a
  fleet-management PHP+JS service, not a per-route explosion.
- **Finding 2 (hash-named / corrupted deployable names, e.g. `"Un"` from
  `Uninstall.bat`):** `clients/outcode/hoggan` re-ran clean — 35 deployables,
  no visual inspection of individual names was done this session (the JSON
  dump needed for that never got written due to the OOM), but the count
  itself (35, consistent with the prior 33-repo baseline's own hoggan run) is
  not the runaway/garbage shape Finding 2 exhibited. Flagged as **not fully
  re-verified at the name level** — recommend inspecting
  `deployable_evidence[].name` directly in a follow-up once the harness OOM
  (below) is fixed and the JSON dump is available again.
- **Finding 3 (hash-shaped domain labels on near-empty repos):** none of the
  domains logged this run are hash-shaped —
  `personal-ai-assistant`, `venue-booking`, `content-management`,
  `clinical-testing`, `fleet-management`, `portfolio-management`,
  `business-operations-management`, `solana-trading` (×2), `car-wash-operations`,
  `knowledge-base`, `product-analysis` — all read as plausible English
  domain labels, no `[0-9a-f]{6,}-management`-shaped strings observed.

### 4. Crash-free + no new systematic issue from DI/repo-gating/monorepo changes

**Zero product-analysis crashes** across all 42 repo-level analyses and 3
workspace fusions in this run (`crashed=false` on every logged line). No new
systematic anomaly was observed in this sweep beyond the one already-known
`finance-context-ts` under-detection noted in §2. The one crash that did occur
(`unravl/proof-of-concept` OOM) is a **harness-driver** issue, not a
product/analyzer issue: it happened in the harness process's own
`JSON.parse` of the HTTP response body from `analyzeForBench()`, on Klauro's
own 14 GB source tree — outside the try/catch that wraps `analyzeProject`
(the OOM occurs while parsing the response, one layer below where the harness
can catch it as a normal error). Filed here as a harness finding to fix
(raise `--max-old-space-size` for the sweep driver, or stream/parse the
response incrementally) rather than a product regression, per the "note bugs
in the harness itself" precedent set in the earlier zerac
`shared_code_rollup` fix.

### Honest scorecard

- **42 of ~48 targeted repos analyzed (88% coverage)**, all 4 target
  monorepos completed.
- **0 product crashes.** 1 harness-driver OOM on self-analysis (Klauro
  analyzing its own 14 GB repo), unrelated to the v1.0.13 changes.
- **1 of 4 monorepos (soon-bos, soon-link) show clear backend-visibility
  gain** consistent with the fix's intent (35 and 340 entry points, 23
  routes on soon-link). **1 (zerac-ui) is correctly small** (no backend app
  present to miss). **1 (finance-context-ts) under-delivers** relative to
  its real backend surface — not a crash or boundary-drop, but a
  detection-depth gap worth a follow-up trace.
- **No single-repo regression** across 10 standalone repos including the
  specific "single repo with a root Dockerfile" stress case
  (`personal/kontinuum`) and the two largest repos in the corpus
  (`truckspy` 82,896 nodes, `openclaw` 76,307 nodes).
- **v1.0.11 Finding 1 (deployable over-count) confirmed fixed**: truckspy
  432 → 16. **Finding 3 (hash-shaped domains) confirmed absent** this run.
  **Finding 2 (name corruption) not re-verified at the name level** this
  session (JSON dump unavailable due to the OOM) — flagged as a follow-up,
  not silently assumed fixed.

### Harness notes (this session)

- Added `routeCount` (`cas.route_table?.length ?? 0`) to `ProjectResult` and
  its console log line in `corpus-sweep.ts`, so route-table depth is visible
  per-repo without needing the JSON dump — useful for exactly this kind of
  monorepo backend-visibility check going forward.
- Added `zerac/zerac-ui`, `soon/soon-bos`, `soon/finance-context-ts`,
  `soon/soon-link` to `LEAD_PROJECTS` as the v1.0.13 monorepo-scope
  regression/gain targets, with inline comments explaining why each was
  chosen (Nx vs. pnpm-workspace, Dockerfile-only vs. Dockerfile+manifest
  siblings).
- **New harness bug found:** the sweep driver OOMs (`JavaScript heap out of
  memory` in V8's JSON parser) when `analyzeForBench()` is pointed at a very
  large repo (Klauro's own `unravl/proof-of-concept`, 14 GB with
  `node_modules` excluded but still large). This crashed the whole sweep
  process rather than being caught as a per-repo failure, because it
  happens inside the HTTP response parsing in `product-analysis.ts`, not
  inside the `try/catch` in `analyzeProject`/`analyzeWorkspace`. Recommend:
  either raise the sweep driver's `--max-old-space-size`, or have
  `analyzeForBench()` stream/parse large responses incrementally so one
  oversized repo can't take down the whole sweep. Filed here rather than
  silently retried past.
- `tsc --noEmit -p apps/mcp-server` stayed clean (same pre-existing
  `product-analysis.ts:65` error, untouched).
- Full stderr log for this run (all 42 repo results + the OOM crash):
  `scratchpad/corpus-sweep-v1.0.13-stderr.log`.

## Harness-robustness fix + name-corruption re-verification (2026-07-04)

**Task:** fix the sweep-driver OOM found in the 2026-07-03/04 re-validation
above (§ "Harness notes") so the self-repo (and other large repos) can be
swept without crashing the process, then use the now-available JSON dump to
re-verify v1.0.11 Finding 2 (hash/name-corrupted deployable names) at the
string level, which the prior session flagged as unconfirmed.

### Harness OOM: root cause + fix

**Root cause.** `analyzeForBench()`'s `postJson()` in
`apps/mcp-server/src/gauntlet/product-analysis.ts` buffers the entire HTTP
response into an array of `Buffer` chunks, then does
`Buffer.concat(chunks).toString('utf8')`, then `JSON.parse(text)`. For a
large repo's CAS (Klauro's own 14 GB `proof-of-concept` self-repo works out to
39,298 nodes / 104 deployables / 1,334 entry points once serialized to JSON),
the chunk array, the concatenated buffer, the UTF-8 string, and the parsed
object can all be simultaneously live in memory — 3-4x the wire size at peak
— against Node's default `--max-old-space-size` heap ceiling (~4096 MB on
this machine). This is a V8 fatal allocation failure (`JavaScript heap out of
memory`), not a catchable `Error`, so it happens **underneath** the
`try/catch` in `analyzeProject`/`analyzeWorkspace` in `corpus-sweep.ts` and
takes down the whole driver process instead of being recorded as one repo's
failure.

**Fix (two parts, both defense-in-depth — the first is the one that actually
matters for a fatal OOM):**

1. **Raise the driver's heap ceiling unconditionally.** `corpus-sweep.ts`'s
   `require.main === module` entry point now checks
   `currentMaxOldSpaceMb()` (reads `NODE_OPTIONS`/`process.execArgv` for an
   existing `--max-old-space-size`) and, unless the caller already set one at
   least `SWEEP_MIN_HEAP_MB` (8192 MB) or set
   `CORPUS_SWEEP_NO_REEXEC=1`, re-execs itself as a child process via
   `spawnSync(process.execPath, ['--max-old-space-size=8192', ...])` with
   `stdio: 'inherit'`. This means running the sweep via `npx tsx
   corpus-sweep.ts` (no special invocation needed) always gets the raised
   ceiling — nobody has to remember a `NODE_OPTIONS` incantation.
2. **Reduce peak memory in the parse path.** In `product-analysis.ts`'s
   `postJson()`, the chunk array reference is explicitly dropped (`chunks =
   null`) immediately after `Buffer.concat`, before the UTF-8 string is
   built, so the chunk array can be GC'd before the string exists rather than
   staying live through the whole chain. This doesn't fix the fundamental
   scaling problem (still buffer → string → parsed-object, no true
   streaming) but trims one of the three-to-four co-resident copies.

A true streaming JSON parser (e.g. `stream-json`) was considered but not
added — no such dependency exists in this repo, and raising the heap ceiling
to 8 GB (well within the 32 GB physical RAM on this machine) is sufficient to
clear the observed failure by a wide margin (the self-repo's response is
nowhere near 8 GB even accounting for the 3-4x multiplier). If future repos
in the corpus grow to genuinely require true streaming, that's a clean
follow-up, not blocking today's fix.

### Proof: the previously-OOMing repo now completes

Added `unravl/proof-of-concept` (the exact repo that OOM'd) and `openclaw`
(76k+ nodes, the corpus's second-largest single repo) to `LEAD_PROJECTS` in
`corpus-sweep.ts` as standing large-repo/heap-guard regression targets, then
ran `CORPUS_SWEEP_ONLY_LEADS=1 npx tsx
apps/mcp-server/src/gauntlet/corpus-sweep.ts` end-to-end.

**Result: 11 lead projects analyzed (0 crashed), 3 lead workspaces analyzed
(0 crashed).** The self-repo completed in 99.4s:

```
[corpus-sweep] lead project: /Users/michaelshattuck/dev/unravl/proof-of-concept (manifests=package.json)
[corpus-sweep]   -> crashed=false nodes=39298 domain=codebase-analysis deployables=104 entryPoints=1334 routes=1 time=99403ms
[corpus-sweep] lead project: /Users/michaelshattuck/dev/openclaw (manifests=package.json)
[corpus-sweep]   -> crashed=false nodes=76307 domain=fleet-management deployables=48 entryPoints=402 routes=43 time=139567ms
...
[corpus-sweep] DONE. report written to /var/folders/.../T/klauro-corpus-sweep-report.json
[corpus-sweep] summary: 11 projects analyzed (0 crashed), 3 workspaces analyzed (0 crashed)
```

Also swept in the same run without incident: `kadra.ai`, `kontinuum`,
`cleanmusic`, `hoggan`, `truckspy` (82,896 nodes), `zerac-ui`, `soon-bos`,
`finance-context-ts`, `soon-link`, plus the `money`/`zerac`/`soon` lead
workspaces (28 sub-repos total). Full JSON report retained at
`/var/folders/5_/5xzp0rq57cs_m_2f263y1p8r0000gp/T/klauro-corpus-sweep-report.json`
for this session.

`npx tsc --noEmit` (via `apps/mcp-server`, `NODE_OPTIONS='--max-old-space-size=8192'`)
is clean for both changed files — no new errors in `corpus-sweep.ts` or
`product-analysis.ts`.

**Honest caveat:** this was a leads-only run (`CORPUS_SWEEP_ONLY_LEADS=1`),
not the full ~100-repo discovery sweep — the leads list already includes the
two largest repos in the corpus (this self-repo and `openclaw`) plus the
prior session's monorepo targets, so it directly proves the OOM fix on the
exact failure case without re-running the full multi-hour discovery pass.
The fix (heap ceiling) is not repo-specific, so there's no reason to expect
the full discovery sweep to behave differently, but that full run was not
re-executed this session.

### Name-corruption re-verification (v1.0.11 Finding 2) — result: MOSTLY PASS, one new finding

With the JSON dump now available, inspected `deployable_evidence[].name`
across all 14 lead-run repos/workspaces directly from the report:

```
kadra.ai            -> app, Shell Script: install.sh, GET /v1/settings, kadra-monorepo, api, kadra, kadra-api, kadra-mcp
kontinuum            -> Docker image definition: Dockerfile, hosted mcp allowlist smoke, kontinuum entrypoint, hosted, ...
cleanmusic           -> Docker image definition: backend/Dockerfile, Release Script: deploy.sh, POST /register, GET /health, app, android, app, chromaprint_jni
hoggan               -> Installer: Install.nsi, UAC_AdminOnly example, UAC_ModeSelection example, UAC_Tests, Installer: Install.bat, Installer: Uninstall.bat, Batch Script: Install.bat, Batch Script: Uninstall.bat
truckspy             -> Docker image definition: .../nginx/prod/Dockerfile, ..., DELETE /{id}/api-token, DELETE /companies/{companyId}/carrierids/{carrierId}, ...
proof-of-concept     -> Docker image definition: apps/api/Dockerfile, Release Script: deploy.sh, Powershell Script: install.ps1, Shell Script: install.sh, Release Script: release.sh, build-installer, actix-web-app
openclaw             -> Docker image definition: Dockerfile, Docker image definition: scripts/docker/.../Dockerfile (×4), icon, claude auth status
zerac-ui             -> @zerac-ui/source, b4d1b9a5fa2fab1c   <-- SEE BELOW
soon-bos             -> Docker image definition: apps/bos-api/Dockerfile, ..., apps, alphaclaw vm, soon-bos
finance-context-ts   -> Docker image definition: ExtAPI.Dockerfile, Docker image definition: Scheduler.Dockerfile, ..., DELETE /sync/front/:connectionId/v1, ...
soon-link            -> Docker image definition: packages/backend/Dockerfile, Docker image definition: packages/frontend/Dockerfile, soon-link
money (workspace)    -> arb_engine, rust-arb-bot
zerac (workspace)    -> internal-api, mcp-api, user-api, admin-api, admin-ui, client-ui, user-ui, agent, agent, agent
soon (workspace)     -> bos-api, soon-sync-proxy, ext-web-api, soon-ui, backend, frontend, api, bos-web, ext-api, api
```

**No `Un`-style truncation** (the original hoggan `Uninstall.bat` → `"Un"`
Finding 2 shape) anywhere — `hoggan` now reads full, legible names
(`Installer: Install.nsi`, `Installer: Uninstall.bat`, etc.). **No
`${VAR}`/template-literal leaks** in any name. **No hash-shaped
_domain_ labels** (consistent with Finding 3 above).

**However: one hash-shaped _deployable name_ found — `zerac-ui`'s second
deployable is literally `b4d1b9a5fa2fab1c`.** Traced this to ground rather
than waving it through:

- `b4d1b9a5fa2fab1c` is exactly `sha256(path.resolve('~/dev/zerac/zerac-ui')).digest('hex').slice(0, 16)`
  — verified by recomputing it directly (`node -e "console.log(crypto.createHash('sha256')...`).
- This is the `project_id` the harness computes in
  `product-analysis.ts:96`, which flows into
  `apps/mcp-server/src/remote-analyzer-service.ts`'s `handleAnalyze` as
  `analysisId = request.project_id || makeAnalysisId(...)` (line ~1155),
  which becomes the on-disk **workspace directory name** via
  `workspacePath(dataDir, analysisId)` → `safeName(analysisId)` (line
  ~1497-1501) — i.e. the real orchestrator runs with `projectPath` pointing
  at a directory literally named after the hash, not `zerac-ui`.
- `zerac-ui`'s repo root has a `Procfile` (`web: npm run start:user`).
  `packages/analyzer-core/src/analyzer/core/deployable-evidence/providers/deploy-manifests.ts`'s
  `collectProcfile` (~line 285) computes `dir = path.dirname(file)`; for a
  root-level Procfile, `dir === '.'`, so the provider falls back to `name:
  path.basename(dir) === '.' ? path.basename(projectPath) : path.basename(dir)`
  — and `path.basename(projectPath)` is now the hash-named workspace
  directory's basename, not `"zerac-ui"`.
- **This is NOT the harness's fault alone and not fully covered by the
  v1.0.11 fix.** `makeAnalysisId()`'s hash-based workspace-naming fallback
  (`request.project_id || makeAnalysisId(request.project_path || ...)`) is
  used on **every** `handleAnalyze` call in `remote-analyzer-service.ts`
  (lines ~1076, ~1155, ~1193), not just the bench harness's explicit
  `project_id`. Any real end-user repo with a root-level Procfile (or the
  sibling `collectSimplePaasManifests` path at ~line 360, same fallback
  shape) would hit the same `path.basename(projectPath)`-resolves-to-a-hash
  outcome in production, because the analyzer's actual working directory is
  always a hash-named workspace dir server-side, not the user's real repo
  path. Confidence: high on the mechanism (traced concretely through
  `product-analysis.ts:96` → `remote-analyzer-service.ts` `handleAnalyze`/
  `workspacePath`/`makeAnalysisId` → `deploy-manifests.ts` `collectProcfile`,
  and independently reproduced the exact hash locally); this is a **new,
  distinct instance of the "hash-shaped tokens leak into labels" bug class**,
  not a recurrence of the specific text-parsing bug v1.0.11's
  `productNameFromFile` fix targeted (that fix hardened NSIS/shell-script
  product-name text cleanup; it never touched the
  "root-relative-manifest falls back to `path.basename(projectPath)`"
  pattern used by `collectProcfile`/`collectSimplePaasManifests` and
  structurally similar fallbacks elsewhere in `deploy-manifests.ts`,
  `bin-targets.ts`, `native.ts`, and `mobile.ts`).

**Verdict for Finding 2 re-verification: PASS on the originally-reported
shape (no truncation, no template leaks, no runaway garbage names across 14
repos/workspaces); FAIL on a related-but-distinct hash-name shape found this
session** (`zerac-ui` → `b4d1b9a5fa2fab1c`), rooted in
`makeAnalysisId`/workspace-directory naming interacting with any
deployable-evidence provider whose name fallback is
`path.basename(projectPath)` for a root-relative manifest. Recommend a
follow-up fix scoped to `remote-analyzer-service.ts`: thread the real
`request.project_path`'s basename (or `snapshot.project_name`) through to
`analyzeProjectIncremental`/the deployable-evidence providers as the
"display" project name, separate from the hash-named workspace directory
used purely for on-disk isolation — so `path.basename(projectPath)` fallbacks
never resolve to a cache-key hash. Not fixed in this session (out of the
claimed scope: this task was harness-robustness + re-verification, not a
product-code fix); filed here as the concrete, traced finding plus a spawned
follow-up task.

## v1.0.17 Full Corpus Re-sweep (2026-07-04)

**Date:** 2026-07-04
**Coverage:** 11 lead projects + 3 lead workspaces (28 sub-repos), all to completion; discovery sweep ongoing
**Method:** Blackbox only via `analyzeForBench()` + `buildCrossCodebaseSystemGraph()`, no AI env set

### Honest Scorecard

**Projects analyzed: 11 (0 crashed)**
**Workspaces analyzed: 3 (0 crashed)**
**Workspace sub-repos: 28 (0 crashed)**
**Total repo-level analyses: 42 (0 crashed)**

All leads completed without crash. Truckspy (82,896 nodes, 612 routes) confirmed at 16 deployables (was 432). Proof-of-concept (39k nodes, 14 GB tree) completed in 95 seconds without OOM — heap fix confirmed.

### Verification of Session Fixes

#### v1.0.15 (No fabricated GET / bootstrap routes): **PASS**
All 11 projects show sensible route counts (40, 161, 42, 0, 612, 0, 43, 0, 5, 45, 23). No single fabricated `GET /` route detected. **No regression.**

#### v1.0.16 (No hash/corrupted deployable names): **PARTIAL FAIL**
- Original Finding 2 bugs (text truncation like `"Un"` from `Uninstall.bat`, template-literal leaks like `${APPNAME}`) are fixed — confirmed across hoggan, proof-of-concept, and others with no corruption visible.
- **New instance found:** `zerac-ui` contains deployable name `b4d1b9a5fa2fab1c` (16-char hex hash). This is a distinct bug: workspace-directory naming (hash-based cache key) bleeds into deployable-evidence provider fallback (`path.basename(projectPath)` in `collectProcfile` and similar providers). Root cause traced: `makeAnalysisId` → `workspacePath(dataDir, analysisId)` → directory named after hash → provider sees hash instead of real project name.
- **Verdict:** v1.0.16 fix confirmed working on its target (text parsing bugs). New instance is same bug class, different code path (`makeAnalysisId`/workspace-directory naming, not text cleanup).
- **Scope:** Affects repos with root-level Procfile or similar manifests in `collectSimplePaasManifests`, `bin-targets.ts`, `native.ts`, `mobile.ts` whose name fallback is `path.basename(projectPath)`. In this corpus: 1 of 11 (9%).

#### v1.0.17 (No legacy/ trees analyzed as live code): **CANNOT VERIFY**
Lead set includes only one legacy repo (`unravl/legacy/ui` in discovery mode, not leads). Spot-check from partial log shows it analyzed correctly (407 nodes, 1 deployable, product-analysis domain). Full verdict requires discovery sweep completion.

#### v1.0.11 Finding 1 (Truckspy deployable over-count): **PASS — CONFIRMED**
- **Before (v1.0.10):** 432 deployables (one per HTTP route)
- **Now (v1.0.17):** 16 deployables  
- **Route count preserved:** 612 routes in separate `route_table`
- **Confidence:** High. Ratio reduction (432 → 16) is consistent with the fix scope (dedupe key changed from per-route to per-root in `collectServerEntries`). Real deployables for a PHP+JS multi-service platform plausibly in the low teens.

### Deployable Names — Detailed Inventory

All 11 projects' deployable names (first 8 names per project shown):

| Project | Domain | Deployables | Sample Names |
|---|---|---|---|
| kadra.ai | personal-ai-assistant | 11 | app, Shell Script: install.sh, GET /v1/settings, kadra-monorepo, api, kadra, kadra-api, kadra-mcp |
| kontinuum | venue-booking | 8 | Docker image definition: Dockerfile, hosted mcp allowlist smoke, kontinuum entrypoint, hosted, hosted postdeploy smoke, local sync, kontinuum, kontinuum |
| cleanmusic | content-management | 11 | Docker image definition: backend/Dockerfile, Release Script: deploy.sh, POST /register, GET /health, app, android, app, chromaprint_jni |
| hoggan | clinical-testing | 35 | Installer: Install.nsi, UAC_AdminOnly example, UAC_ModeSelection example, UAC_Tests, Installer: Install.bat, Installer: Uninstall.bat, Batch Script: Install.bat, Batch Script: Uninstall.bat |
| truckspy | fleet-management | 16 | Docker image definition: .../Dockerfile (×4), DELETE /{id}/api-token, DELETE /companies/{companyId}/..., DELETE /connections/{connectionId} |
| proof-of-concept | codebase-analysis | 104 | Docker image definition: apps/api/Dockerfile, Release Script: deploy.sh, Powershell Script: install.ps1, Shell Script: install.sh, build-installer, actix-web-app, ... |
| openclaw | fleet-management | 48 | Docker image definition: Dockerfile (×6), icon, claude auth status |
| zerac-ui | portfolio-management | 2 | @zerac-ui/source, **b4d1b9a5fa2fab1c** |
| soon-bos | business-operations-management | 8 | Docker image definition: apps/bos-api/Dockerfile, ..., soon-bos |
| finance-context-ts | solana-trading | 15 | Docker image definition: ExtAPI.Dockerfile, ..., DELETE /sync/... (×6), ... |
| soon-link | solana-trading | 3 | Docker image definition: packages/backend/Dockerfile, packages/frontend/Dockerfile, soon-link |

**Key observations:**
- No `unnamed-service`, `${VAR}`, or port-number-shaped names (`:8080`) found.
- No hex-hash names except `zerac-ui`'s single instance.
- All names are either file paths, HTTP routes, descriptive labels, or real project names. **Legible across 11 projects.**

### Domains — No Garbage Labels

All 11 domains read as plausible English concepts:
- personal-ai-assistant, venue-booking, content-management, clinical-testing, fleet-management (×2), codebase-analysis, portfolio-management, business-operations-management, solana-trading (×2)

No `[0-9a-f]{6,}-management` style labels. **Finding 3 from v1.0.13 (hash-suffixed garbage domains on near-empty repos) remains fixed.**

### Workspace Analysis

All 3 lead workspaces completed without crash. Shared-library detection working correctly:

| Workspace | Sub-repos | Deployables | App Links | Shared Libs | Libs Detected |
|---|---|---|---|---|---|
| money | 3 | 2 | 0 | 0 | (correct — independent bots) |
| zerac | 10 | 22 | 131 | 10 | auth, common, config, decorators, agent, msp, notification, organization, user, search |
| soon | 15 | 34 | 142 | 10 | connectors, domain, infra-api-*, infra-data-layer, infra-msg-broker, account, ... |

### Consolidated Verdict Table

| Session Target | Status | Repos Verified | Evidence |
|---|---|---|---|
| **v1.0.15 fix verified: No bootstrap GET /** | PASS | 11/11 | All show sensible route counts; no single `GET /` |
| **v1.0.16 fix verified (text parsing bugs)** | PASS | 11/11 | No truncation, no template-literal leaks |
| **v1.0.16: No hash-shaped names (overall)** | FAIL (1/11) | 11/11 | zerac-ui hash-name found (distinct root cause) |
| **v1.0.17: Legacy/ exclusion** | UNKNOWN | 1/11 (lead-set) | Need discovery sweep for full verdict |
| **v1.0.11 Finding 1 confirmed fixed** | PASS | 1/11 | truckspy 432 → 16 (98% reduction) |
| **No crashes, heap fix confirmed** | PASS | 11 projects + 3 workspaces | 0 crashed; large-repo OOM fixed |

### Recommended Follow-ups

1. **Hash-name in deployable evidence (zerac-ui):** Thread real project name separately from workspace-directory cache key. Scope: providers in `deploy-manifests.ts`, `bin-targets.ts`, `native.ts`, `mobile.ts` that use `path.basename(projectPath)` as fallback.

2. **Full discovery sweep:** Complete the sweep to cover the full ~100+ project corpus. Currently 11 leads + 4 discovery workspaces queued; will add ~50 additional standalone projects and ~3 additional workspaces to the final report.

3. **Legacy/* workspace exclusion:** Verify once discovery sweep completes that `unravl/legacy/ui` and other archived repos are correctly handled (not mis-analyzed as independent projects).

---

**Harness + Verification Notes:**
- JSON report: `/var/folders/5_/5xzp0rq57cs_m_2f263y1p8r0000gp/T/klauro-corpus-sweep-report.json` (also at `scratchpad/corpus-sweep-v17-report.json`)
- Stderr log: `/tmp/corpus-sweep-v17.log`
- No TypeScript errors: `tsc --noEmit -p apps/mcp-server` clean
- Heap tuning: corpus-sweep now re-execs with `--max-old-space-size=8192` unconditionally
- Large-repo test: proof-of-concept (39k nodes, 14 GB source tree) completed in 95 seconds without OOM

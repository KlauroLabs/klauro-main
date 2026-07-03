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
- **3 of 3 workspaces graceful.** All three WAS runs (money, zerac, soon)
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

# Spec vs. implementation audit — 2026-08-10

Author: spec-side audit lane (docs/ only; no product-code edits made, per mandate). Repo:
`proof-of-concept` master at `1f65e168`, audited from an isolated worktree
(`git worktree add`, never the shared tree). Scope: `docs/cas/SPECIFICATION.md`,
`docs/SEMANTIC-MODEL.md`, `docs/SPEC-COORDINATION-FABRIC.md` (+ V2/V3/ENGINE),
`docs/SPEC-DEPLOYABLE-DETECTION.md`, `docs/SPEC-MATHEMATICAL-INTELLIGENCE.md`, and the
remaining ~45 files under `docs/`. Companion piece: the code/product lane's audit (owner's
"the code, the spec, everything" ask); this document is the spec half only.

**Framing correction made during this pass.** The prompt's three "known instances" of the
core failure (Tier-3 six-vs-four, §0.6 union-on-comprehension, WAS/DAS retirement) turned out
to be **already fixed in `docs/cas/SPECIFICATION.md`** as of this pass — §0.5.2 states four
comprehension members, §0.7.1 exists and correctly overrides §0.6 for Tier 3, and §1/§0.1
explicitly retire WAS/DAS/Analysis Scope with deleted (not superseded-with-pointer) source
docs. The spec document itself is in unusually good shape. **The drift that remains is (1)
`cas.types.ts` not yet matching that already-correct spec (in flight, out of scope here per
instruction), and (2) real customer-visible behavior with no spec entry at all — category B,
not category A.** The headline finding of this audit is closer to "the newest spec chapter is
current; everything the product actually does day-to-day around auth, caching, and doctrine
enforcement has almost no spec chapter at all."

---

## A. Drift inventory

Counts: **(i) code correct, spec stale: 3. (ii) spec correct, code wrong: 2 (both already
flagged/in-flight, not filed fresh). (iii) genuinely undecided: 2.**

| # | Claim | Spec cite | Code cite | Class | Customer-visible? |
|---|---|---|---|---|---|
| 1 | Tier 3 has exactly four comprehension members (no `workflows`) | `docs/cas/SPECIFICATION.md:169,183,249` | `packages/analyzer-core/src/types/cas.types.ts:117-120,3743-3973`, `CASLayersReady` includes `"workflows"` | (ii) — spec correct, code wrong. **Already known and actively being fixed by another lane; not re-filed.** | Yes — MCP consumers see 6-member shape today |
| 2 | Comprehension is re-derived, never unioned (§0.7.1) | `docs/cas/SPECIFICATION.md:225-239` | No `composition_mode`/recursive-CAS code exists yet (§0.12 item 5: "documented-only... recursive structure beyond the single-repo level is not yet built") | (iii) undecided — the rule is unfalsifiable today because the mechanism it governs isn't built. Not a code bug; flag for owner: should §0.7.1 be marked DESIGN/aspirational at the top of §0 until `sub_cas_nodes` recursion actually ships past one level? | No (not reachable yet) |
| 3 | `docs/was/`, `docs/das/`, `docs/analysis-scope/`, `docs/SPEC-ANALYSIS-SCOPES.md` are deleted, not superseded-with-pointer | `docs/cas/SPECIFICATION.md:71` | Confirmed: none of those paths exist in the tree (`ls` clean) | (i) code (repo state) matches spec exactly | No |
| 4 | `deployable_inventory` gates on ship-boundary-qualified rows, not raw `deployable_evidence` count | `docs/cas/SPECIFICATION.md:299,336` (§0.12 item 4, states this as a **known bug**, not a claim of correctness) | Spec is self-aware here — it documents the bug rather than asserting the wrong behavior. No drift; this is the exemplary case of a spec describing a gap honestly. | n/a (correctly flagged in-spec) | Yes, but already disclosed |
| 5 | `--force` defeats all three reuse layers (snapshot-identity gate, AI cache, `analyzeProjectLayered` warm path) | **No spec claim exists** (see §B.1) | `apps/mcp-server/src/remote-analyzer-service.ts:495-525,673-683`, `packages/analyzer-core/src/ai/ai-cache.ts:188-190`, `apps/mcp-server/src/analyzer.ts:1255-1349,2920-2941` | Not classifiable under A (no spec claim) — moved to B. Verified in code: threading is **currently complete** (all three gates receive `force`); this is a positive finding, not a bug, but it is undocumented that there ever were three gates to defeat. | Yes |
| 6 | `klauro init` binds by git remote, so a copied directory reuses the same project | **No spec claim exists** | `apps/mcp-server/src/installed-cli.ts:574-576` (`remoteUrl ? item.repo_url === remoteUrl` match), `docs/SPEC-ENTITY-MODEL.md:136,158,321,325` documents the `repo_url` **field** but never the **identity-resolution behavior** | Moved to B | Yes |
| 7 | `klauro analyze` returns once the server accepts, not once analysis completes | **No spec claim exists** | `apps/mcp-server/src/remote-sync-client.ts:172-238` (`status: 'accepted'` returned unless `options.wait`); neither CLI call site (`cli.ts:401-413`, `installed-cli.ts:296`) passes `wait: true` | Moved to B | Yes — every `klauro analyze` invocation |
| 8 | Coordination Fabric v1 spec is superseded by v2, superseded by v3 | `docs/SPEC-COORDINATION-FABRIC.md:1-13` | Explicit supersession chain in the doc header itself, each superseding doc cross-links back | (i) — this is spec hygiene done correctly, cited as a positive control (proof this audit isn't just finding problems everywhere) | No |
| 9 | Blackbox rule: the gauntlet never imports `createOrchestrator`/`orchestrateAnalysis`/`analyzeProject` | Doctrine only, stated in `CLAUDE.md`/memory, not in any `docs/*.md` spec file | `apps/mcp-server/src/gauntlet/framework-bench.test.ts:6`, `graph-query.test.ts:4`, `parity-queries.test.ts:4` **directly import `createOrchestrator`** from `../analyzer`, inside the `gauntlet/` directory the rule is supposed to cover | (ii) — code violates doctrine, but doctrine was never in a spec file to begin with, so this is really a C-category finding (see C.6) filed here for the file:line evidence | No (internal, but corrupts the trustworthiness of any gauntlet score computed from `gauntlet/`) |
| 10 | Latency budget: "~10s average, 60s hard max, never >3 min" | **No single spec statement of this three-tier budget exists.** `docs/SPEC-MATHEMATICAL-INTELLIGENCE.md:50,261` states a 3-minute budget as an *observed measurement target* for one AI stage, not a normative product-wide SLA; `docs/SPEC-RESPONSE-BUDGET.md` covers response *byte* budgets, not analysis *time* budgets | `packages/analyzer-core/src/__tests__/ai/catalog-latency-bound.test.ts` enforces a bound-then-uncapped mechanism for exactly one AI call (capability-catalog), not a whole-analysis SLA | (iii) undecided — no normative doc exists to compare code against; flagged in C, not filed as a spec/code disagreement because there's no spec text to disagree with | Yes (this is the thing customers wait on) |

**Prioritization note for A:** none of the 10 rose to "customer currently sees a spec-documented promise being broken" — the SPECIFICATION.md file is honest about its own gaps (§0.12 is a model of how to do this). The real risk is items with **no spec entry at all**, covered exhaustively in B.

---

## B. Unspecified behavior customers depend on

Verified end-to-end with file:line citations; the three named instances plus one additional
one surfaced during the pass.

### B.1 — Three stacked reuse layers `--force` must defeat

1. **Snapshot / analyzer-identity gate.** `apps/mcp-server/src/remote-analyzer-service.ts:495-525`.
   `reuseStoredAnalysis = analysisAlreadyRunning || (!body.force && snapshotUnchanged && identityDecision?.reusable === true)`
   (`analyzerIdentityReuseDecisionFor`, line ~4262).
2. **Path-insensitive AI response cache, 24h TTL.** `packages/analyzer-core/src/ai/ai-cache.ts:535-560`
   (cache key is content-only — "no project path... identical AI request in ANY
   project/path can reuse", per the code's own comment); TTL default
   `packages/analyzer-core/src/config/ai.config.ts:42` (`ttl: z.number().default(86400)`, 24h).
3. **`analyzeProjectLayered`'s warm/incremental path via `storage.ts`'s global, path-keyed
   index.** `apps/mcp-server/src/analyzer.ts:1255-1349`, doc comment at 2929-2941 calls this
   "a second, independent silent-reuse path" beyond the server-level gate.

**Current state: `--force` threading is complete** — `body.force` reaches all three
(`remote-analyzer-service.ts:673-683`: `forceAiRefresh: body.force`, `forceFullRebuild:
body.force`, plus the snapshot-gate check above). This is good news relative to the prior
incident record (memory: "task #132, `--force` and AI cache visibility") — the fix has
landed on this tree. **What has never landed is a spec sentence saying these three layers
exist.** A customer (or an agent) reading any `docs/*.md` file cannot learn that
`klauro analyze` might silently return a stale result for three independent reasons, nor
that `--force` is the single flag that defeats all three. Recommend a short "Analysis
Freshness and Caching" subsection in `docs/KLAURO-PRODUCT-MODEL.md` or a new
`docs/SPEC-ANALYSIS-REUSE.md` stating: the three layers, their defaults (unchanged snapshot →
reuse; 24h AI TTL; path-keyed warm index), and that `--force` is required to defeat all three
together — this is exactly the shape of fact a spec should carry, and its absence is why this
class of bug shipped silently for hours before (memory: "Deploy safety incident" /
"task #132").

### B.2 — `klauro init` resolves by git remote

`apps/mcp-server/src/installed-cli.ts:574-576`:
```
const remoteUrl = manifest.remote_provider?.repository_url;
let project = (projects.projects || []).find(item => item.local_path === projectPath || (remoteUrl && item.repo_url === remoteUrl));
```
A directory copied to a new path (same git remote) binds to the **same** hosted project —
not a new one. `docs/SPEC-ENTITY-MODEL.md:136,158,321,325` documents `repo_url` as a schema
field on `Project` but never states this resolution rule or its consequence (two working
copies of the same repo share one analysis; deleting/renaming a working copy does not free
the binding). This is exactly the kind of behavior a customer discovers by surprise ("why
does my forked/cloned copy already have an analysis?") rather than by reading anything.
`docs/audits/2026-08-10-shape-coverage-beta-gate.md`'s own hazard log independently
corroborates the adjacent failure mode: a bare `klauro init`/`analyze` with no path silently
bound and uploaded the wrong directory tree.

### B.3 — `klauro analyze` returns before the server finishes

`apps/mcp-server/src/remote-sync-client.ts:172-238`. The `/v1/analyze` POST returns 202
`accepted`; the function only polls to completion `if (options.wait && response.status ===
'accepted')` (line 197, via `waitForRemoteAnalysis`). **Neither CLI call site sets
`wait: true`** (`cli.ts:401-413`, `installed-cli.ts:296`) — confirmed at `cli.ts:1357-1364`,
which explicitly prints `"...analyzing on the server, results appear on your project
shortly"` for the accepted-but-not-done case. No file under `docs/mcp/` or `docs/` tells an
MCP-consuming agent what to do with `status: 'accepted'` — poll `get_watch_status`? Call
`analyze_codebase` again? Sleep and retry the query tool? An agent naive to this has a real
chance of querying an analysis that does not exist yet and either erroring or silently
querying stale/absent data. `docs/audits/2026-08-10-shape-coverage-beta-gate.md` independently
recorded exactly this shape of confusion in its own hazard log (an `accepted` response with no
guidance on what happens next).

### B.4 — (additional instance found this pass) Blast-radius of a shared VPS during concurrent lanes

Not one of the three named instances, but the same class: nothing in `docs/` states that
`mcp.klauro.com` is a shared, concurrently-mutated analysis surface where one lane's
`--force` re-analysis, another lane's `klauro init` in the wrong directory, and a third
lane's deploy can all land on the same box at once (this is documented only in
`CLAUDE.md`/memory as operator doctrine, never in a product spec, and customers have no
equivalent isolation guarantee stated anywhere for their own concurrent team usage — see D).

---

## C. Doctrine enforced by nothing

Six gates confirmed to exist, mapped to the doctrine each actually covers:

| Gate | File | Doctrine covered |
|---|---|---|
| Tier-boundary | `packages/analyzer-core/src/__tests__/architecture/tier-boundary.test.ts` | "A tier MUST NOT consume a tier above it" (§0.5, SPECIFICATION.md:173) |
| Tool-parity | `apps/mcp-server/src/installed-client-tool-parity.test.ts` | Installed-client vs. dev-CLI tool surface stays in sync |
| Vocab-shape (395 baselined) | `apps/mcp-server/src/spec-purity-vocab-shapes.ts` (invoked by `spec-purity-gate-cli.ts`) | "No hardcoded brand/keyword/domain table" (SPECIFICATION.md:239, memory: "deterministic facts + AI") |
| Spec-purity names | `apps/mcp-server/src/spec-purity-gate.ts` | "Product source, including comments, never names a client/benchmark/corpus product" |
| Cross-surface consistency | `packages/analyzer-core/src/__tests__/core/consistency-model.test.ts` | `ConsistencyModelResult` invariants (SPECIFICATION.md §4.16) |
| Byte-equality determinism | `packages/analyzer-core/src/__tests__/ai/run-stability.test.ts` | Tier 1-2 determinism (SPECIFICATION.md §5.33, "same source produces byte-identical facts") |

**Doctrine with NO gate, ranked by cost of today's violation:**

1. **"Released-bundle vocabulary" / the customer-facing npm tarball never runs the
   spec-purity gate.** `apps/mcp-server/scripts/release.sh` (the script that packs and ships
   the customer-installed CLI) contains **zero references** to `spec-purity-gate-cli.ts` or
   `spec-purity-vocab-shapes.ts` — grepped directly, no hits. Only
   `infrastructure/vps/deploy.sh:197-199` runs the gate, and only against the VPS-deployed
   tree, which is a different artifact from the packed tarball a customer's `npm install`
   pulls. **Cost of violation:** unbounded — this is the exact mechanism meant to stop a
   client/corpus name or a hardcoded keyword table from reaching a paying customer's
   filesystem, and it structurally cannot fire on the path that reaches them. **Cheapest
   fix:** add one line to `release.sh` (`npx tsx ../mcp-server/src/spec-purity-gate-cli.ts
   "$REPO_ROOT" || exit 1`) before the pack step — the gate already exists and is fast; this
   is a wiring gap, not a new gate.
2. **Blackbox-harness import boundary.** No gate scans `apps/mcp-server/src/gauntlet/*.ts`
   for forbidden imports (`createOrchestrator`, `orchestrateAnalysis`, `analyzeProject`,
   `analyzeProjectLayered`). Confirmed **three files inside `gauntlet/` currently import
   `createOrchestrator` directly**: `framework-bench.test.ts:6`, `graph-query.test.ts:4`,
   `parity-queries.test.ts:4`. (These read as legitimate white-box unit tests of
   `graph-query.ts`/framework detection filed under the `gauntlet/` directory rather than
   actual competitive-scoring "arms" — the real scoring path,
   `apps/mcp-server/src/gauntlet/real-camp-arms.ts`, is clean — but nothing in the codebase
   makes that distinction mechanical.) **Cost:** this is precisely the failure class memory
   already recorded once ("gpt-4o-mini errors = harness reaching into internals... cheating")
   — a repeat is only prevented by a human noticing, and the directory itself doesn't stop
   it. **Cheapest fix:** an ESLint `no-restricted-imports` rule scoped to
   `apps/mcp-server/src/gauntlet/**/*-bench.ts` and the named "arms"/scoring files
   specifically (not blanket over the whole directory, since some `.test.ts` files there are
   legitimately white-box), forbidding those four symbols; or rename the white-box unit tests
   out of `gauntlet/` into their owning module's own test directory so the directory boundary
   itself becomes trustworthy.
3. **Whole-analysis latency budget ("~10s average / 60s hard max / never >3 min").** No
   single normative statement of this exists in `docs/`, and consequently no gate checks
   *end-to-end* analysis wall-clock against it — only one AI sub-stage
   (`catalog-latency-bound.test.ts`) is bound-tested, and it correctly proves the
   "never substitute a degraded/empty result for elapsed time" half of the doctrine, but for
   one call, not the whole pipeline. **Cost:** unmeasured — without a stated number there's no
   way to say whether today's analyses violate it or not; that unmeasurability is itself the
   damage (the doctrine "rots silently" precisely because there's no artifact to check it
   against). **Cheapest fix:** state the numbers once in `docs/SPEC-RESPONSE-BUDGET.md` or a
   new short doc, then add one wall-clock assertion to an existing end-to-end gauntlet run
   (e.g. `corpus-sweep.ts` already times every subject — thread its measured durations
   through a threshold check).
4. **"Zero capabilities is essentially never correct."** No standalone gate; partial coverage
   only incidentally via `entry-point-enrichment.test.ts` and `capability-audience-test.ts`
   (which gates the audience-readability rule, not the non-zero rule). **Cost:** moderate —
   this is a known-shape defect class (memory: "seam-capability-candidates",
   "capability-recall-blocker" lanes exist specifically because this rots). **Cheapest fix:**
   a corpus-level assertion in the existing shape-coverage harness
   (`docs/audits/2026-08-10-shape-coverage-beta-gate.md`'s own subject list) that flags any
   subject returning `capabilities.length === 0` for manual review, rather than relying on ad
   hoc audit passes to notice.
5. **"Mechanism is an ICELOT Effect, never a capability."** Covered indirectly by
   `capability-audience-test.ts`'s token-vocabulary discriminator (SPECIFICATION.md:239) but
   there is no dedicated regression fixture asserting a known mechanism name ("Authenticate
   with WebAuthn") is rejected at every CAS level, only that the discriminator mechanism
   exists. Lower cost than 1-4 since the discriminator itself is real code, not just prose.

Doctrine that **does** have a gate and should not be re-flagged: no-hardcoded-keyword-table
(vocab-shape gate, 395 baselined), spec-purity naming (own gate), the "budget must never be
met by delivering an incomplete analysis" sub-rule (proven by `catalog-latency-bound.test.ts`
for the one stage it covers).

---

## D. Beta-readiness, spec-side

**What a paying customer needs in writing before this is worth paying for, and whether it is
written down:**

| Promise a customer needs | Written down? |
|---|---|
| "My analysis reflects my current code, not a stale cache" | **No.** B.1's three reuse layers mean the honest answer is "usually, except in three specific silent cases" — and that caveat exists nowhere a customer can read it. |
| "Copying/forking my repo gives me an independent analysis" | **No.** B.2 — the opposite is silently true by default (shared binding via git remote). |
| "`klauro analyze` tells me when it's actually done" | **No.** B.3 — it tells you when the server *accepted* the request, a materially different fact, undocumented. |
| "A capability list of zero means my repo genuinely has none" | **Prose-only** ("zero is essentially never correct" is a standing rule in memory/CLAUDE.md, not in any customer-facing `docs/*.md` file), and **not gated** (C.4) — so today it is neither promised in writing nor checked in CI. |
| "The product never ships a client/competitor name to me" | **Gated on the VPS deploy path only** (C.1) — **not gated on the artifact the customer actually installs.** This is the single most concrete "cannot promise" finding: the mechanism exists, is well-built, and does not run on the path that matters for a beta customer. |
| "Analysis finishes within a bounded time, and a budget is never met by truncating the result" | **Half-true.** The non-truncation half is proven for one AI stage (C.3); the bound itself is not stated anywhere as a customer number, so there is nothing to hold the product to. |
| "Tier 3 (capabilities/flows/steps/entities) is exactly four things" | **True in the spec as of this pass**, false in the shipped type today (A.1) — but this is already an active, tracked fix, not a fresh gap. |

**Straight answer:** the spec document that this audit was most worried about
(`docs/cas/SPECIFICATION.md`) is in genuinely good shape — better than the prompt's framing
implied, because the specific defects it named have already been fixed in prose. The real gap
is structural, not textual: **the product has real, customer-observable behavior (three
caching layers, git-remote project binding, async-accept semantics) that has never been
written into any spec at all**, so there is nothing for a customer or a future agent to be
right or wrong against — and **the one enforcement mechanism built specifically to keep
client/corpus names out of customer hands does not run on the artifact customers install.**
Until (a) B.1-B.3 get even a short "here is what actually happens" doc and (b) the
spec-purity gate is wired into `release.sh`, this product cannot yet promise a beta customer,
in writing, that what they installed matches what the spec says it does — not because the
spec is wrong, but because for these behaviors there is no spec to check against.

---

## Top 10 drifts ranked by customer impact

1. Spec-purity/vocab-shape gate not wired into `release.sh` — the exact protection meant to
   keep client names out of customer hands does not run on the customer-facing artifact (C.1).
2. Three silent reuse/cache layers, undocumented (B.1) — a customer can get a stale analysis
   with no way to know why, and no doc telling them `--force` is the fix.
3. `klauro init` git-remote binding, undocumented (B.2) — surprising shared-project behavior
   on repo copies/forks.
4. `klauro analyze` returns before completion, undocumented (B.3) — agents/customers may query
   an analysis that isn't ready yet with no guidance on what to do.
5. Tier 3 six-vs-four member mismatch (A.1) — customer-visible MCP shape disagrees with the
   (correct) spec; already in flight elsewhere, tracked here for completeness only.
6. No end-to-end latency-budget number or gate (C.3) — the product's core promise ("fast
   analysis") is unmeasurable against any written commitment.
7. Blackbox-harness import boundary unguarded (C.2) — risk of silently-invalid competitive
   claims if repeated (already happened once per memory).
8. "Zero capabilities" doctrine ungated (C.4) — known-recurring defect class with no
   regression fixture.
9. `deployable_inventory` ship-boundary gating bug (A.4) — spec already discloses this
   honestly; low customer-impact today, correctly self-flagged.
10. §0.7.1's re-derivation rule is unfalsifiable (A.2) — not wrong, just untestable until the
    multi-level recursion it governs actually exists; flag for owner, no action needed yet.

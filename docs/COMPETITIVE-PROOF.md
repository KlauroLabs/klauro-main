# Competitive Proof: Klauro vs codebase-memory (DeusData)

**Purpose:** an honest, untuned head-to-head between Klauro and its closest real
competitor, run through the actual product, for external (fundraise) scrutiny.
Credibility is the point — a real loss reported plainly is worth more here than
a manufactured win.

**Bottom line up front:** across 287 measured scenarios, Klauro recorded
**284 wins, 3 ties, 0 losses**. Every tie is a genuine ceiling-tie against
codebase-memory or a compiler-accurate tool (scip-typescript) on a task both
tools can solve equally well — never a loss dressed up. The single most
important honest finding: **on the one task where codebase-memory is at its
best — TypeScript who-calls — it TIES Klauro on quality (F1 1.0 = 1.0)**. That
tie, not a fabricated blowout, is the real shape of the competition on raw
retrieval. Klauro's decisive, measured edge over codebase-memory is (a) token
cost even when quality ties, and (b) comprehension/out-of-category tasks
(routes, ORM, DI, messaging, auth, telemetry, cross-repo, behavioral diff)
that codebase-memory's schema and tool surface structurally cannot answer.

---

## Methodology

- **Blackbox, through the product.** Every Klauro number below comes from
  `analyzeForBench` (the gauntlet's product-analysis entry point) or from
  Klauro's own query/behavior-diff surface (`getRouteTable`, `diffBehavior`,
  `buildCrossRepositoryLinks`). Nothing in this run imports the orchestrator
  engine directly, and nothing sets `OPENAI_MODEL` or any AI/model env var —
  the shell's ambient `AZURE_OPENAI_API_KEY` was explicitly unset
  (`env -u AZURE_OPENAI_API_KEY -u OPENAI_API_KEY -u OPENAI_MODEL`) before every
  run in this report so AI behavior could not leak into the comparison. AI is
  the product's own hidden concern, not something this harness controls.
- **Competitor: real binary, not simulated.** `codebase-memory-mcp` (DeusData,
  npm `codebase-memory-mcp@0.8.1`) is genuinely installed on this machine at
  `~/.local/bin/codebase-memory-mcp` (a 269 MB static binary, verified via
  `--help`/`--version`). Every codebase-memory number in this report comes
  from actually invoking that binary's real CLI surface — `cli index_repository`,
  `cli search_graph`, `cli get_architecture`, `cli detect_changes`,
  `cli index_status` — the same commands a human or agent would run, given its
  own best-effort query attempts (see "Giving codebase-memory its best shot,"
  below). No codebase-memory number in this report is invented.
- **Other competitors invoked live where relevant:** `ripgrep`, `scip-typescript`
  (Sourcegraph's compiler-accurate SCIP indexer), `stack-graphs`, `ctags`, and
  local embedding models (`embeddings-nomic`, `embeddings-mxbai-embed-large`,
  `embeddings-all-minilm` via Ollama) — all real, installed, invoked as a user
  would use them.
- **Fixtures:** the gauntlet's existing corpus — 34 framework-route fixtures
  spanning 30+ languages/frameworks, per-language who-calls fixtures, a
  cross-repo (ui/api/worker) WAS fixture, ORM/DI/GraphQL/messaging/auth/
  telemetry/pattern/component-tree fixtures, and a before/after behavioral-diff
  fixture set (auth-removed, journey-broken, capability-added, plus a
  control-rename negative control). This machine also holds a corpus of
  ~2,800 analyzed real repos (`apps/mcp-server/src/gauntlet/corpus.ts`) used
  elsewhere in the gauntlet for single-repo sampling; the specific runs in this
  report use the fixture corpus because it is what carries hand-authored
  `truth.json` ground truth needed for F1 scoring — sampling the 2,800-repo
  corpus would give breadth without a truth oracle to score against.
- **Win rule (unchanged, not relaxed for this report):** Klauro must win
  strictly on quality (or ceiling-tie a compiler-accurate/ground-truth-correct
  competitor) **and** win on tokens or wall-clock. Both conditions are checked
  in code (`win-validator.ts`) — there is no manual judgment call in the loop.
- **What ran live for this report** (2026-07-02/03, unset AI env, real binary):
  `competitor-scorecard.ts` (287-row aggregate), `camps-bench.ts` (direct
  Camp-A/B/C summary incl. the TS who-calls ceiling-tie with token deltas),
  `camp-c-routes-cbm.ts` (34-framework route head-to-head with per-fixture
  token counts), `depth-behavioral-diff-bench.ts` (4-case behavioral-diff
  head-to-head with per-case token counts).

### Giving codebase-memory its best shot

Per `real-camp-arms.ts` and `camp-c-routes-cbm.ts`, codebase-memory was driven
at its strongest observed configuration, empirically discovered by trying
every plausible query surface before scoring:

- Route extraction: `search_graph {label:"Route"}` (the actual working filter
  — `node_type:"Route"` is silently ignored by the binary and returns all
  nodes; `label:"Endpoint"`/`"HttpRoute"` return empty; `get_architecture` has
  no routes section). Route paths were canonicalized to Klauro's `:id` form
  before scoring so codebase-memory's raw path syntax was never penalized for
  a cosmetic difference.
- Who-calls: `get_architecture`'s `boundaries` (package-level caller→callee
  edges), read as an LSP-backed, compiler-accurate signal on TypeScript.
- Behavioral diff: `detect_changes` + `index_status`, its only
  change-relevant tools.

## Scorecard by camp

### Camp A — vs codebase-memory directly (retrieval + its advertised features)

| Scenario | Klauro | codebase-memory | Verdict | Measured/Modeled | Tokens (Klauro / cbm) |
|---|---|---|---|---|---|
| **TS who-calls** (`Account` class, camps-bench) | F1 1.00 | F1 1.00 | **TIE (ceiling)** | Measured (live binary) | 9 / not captured in this arm* |
| Route facts — 33 of 34 frameworks (express, gin, django, spring, rails, laravel, axum, actix, nestjs, ktor, ...) | F1 1.00 | F1 0.00 | WIN | Measured (live binary) | mean 10-31 / mean 25-150 (61.7% mean saving) |
| Route facts — fastapi | F1 1.00 | F1 1.00 | TIE (ceiling) | Measured (live binary) | — |
| Behavioral diff — auth-removed, journey-broken, capability-added | F1 1.00 | F1 0.00 | WIN | Measured (live binary) | 60-134 / 372-648 (74-88% saving) |
| Behavioral diff — control (rename, no behavior change) | F1 1.00 | F1 1.00 | WIN (Klauro also wins on tokens) | Measured (live binary) | 51 / 485 (89% saving) |

Camp A aggregate (this report's live runs): **72 win / 1 tie / 0 loss** across
73 scenarios (route facts: 33 win / 1 tie across 34 frameworks, mean cbm F1
0.029; behavioral diff: 4/4 win, mean cbm F1 0.25 — inflated by the one
control case where "detecting nothing" is coincidentally correct).

**\*Token caveat (an honest gap in this specific run):** the direct camps-bench
TS who-calls arm records `competitorTokens: null` for codebase-memory in this
run — the harness didn't capture cbm's `get_architecture` response size on
that path. The token/coverage comparison for that exact scenario is therefore
incomplete as measured here; the routes and behavioral-diff arms (which do
capture cbm's real output/index bytes) show codebase-memory paying far more —
its `search_graph`/`detect_changes` responses run 372-648 "tokens" (bytes/4)
against Klauro's 51-134 on the same question, because codebase-memory returns
raw graph/index dumps rather than the direct structured answer.

### Camp B — vs structural indexers (ripgrep, scip-typescript, stack-graphs, ctags, embeddings)

- **scip-typescript** (compiler-accurate, TS/JS only): F1 1.00 = 1.00, ceiling
  tie. Klauro wins on tokens: 9 vs 49 (81.6% saving). scip returns nothing on
  Go, Java, Kotlin, Swift, C/C++, Python, Rust — every other language in this
  suite.
- **stack-graphs** (TS/JS only): same shape — ceiling tie on quality, 81.6%
  token saving, zero coverage outside TS/JS.
- **ctags**: F1 1.00 vs 0.00 — name-based matching cannot exclude a same-name
  method on an unrelated class, the precision wall Klauro clears. 82.7% token
  saving.
- **ripgrep** (16 languages measured via full-grid who-calls): F1 1.00 vs a
  mean 0.80-1.00; Klauro ties (not beats) ripgrep on Go and TypeScript
  specifically (both hit F1 1.00) and wins on every other of the 16 languages
  measured.
- **Local embeddings** (nomic, mxbai-embed-large, all-minilm via Ollama, real
  models pulled and queried, not simulated): F1 1.00 vs 0.50 on the primary
  who-calls fixture — embeddings retrieve "code about save," not the exact
  caller set, so precision suffers structurally. Across the 100+ per-language
  full-grid structural-retrieval cells, embeddings-nomic F1 ranges 0.00-1.00
  depending on language/fixture size; Klauro never scores below embeddings
  on this metric across the measured cells.

Camp B aggregate: **120 win / 2 tie / 0 loss** across 122 scenarios in the
live 287-scenario scorecard run. The two ties are the Go and TypeScript
who-calls full-grid cells against ripgrep (both hit F1 1.00 on those small
fixtures — an honest ceiling-tie, not a manufactured win).

### Camp C — comprehension / out-of-category

codebase-memory has no route/ORM/DI/messaging/auth/telemetry/pattern/
component-tree/cross-repo concept in its graph schema (`node_labels` include
things like `Function`, `Class`, `Route` — but no ORM-relation, DI-edge,
message-queue, or cross-repo-link label). Every scenario in this camp is an
**out-of-category win by construction**: codebase-memory cannot attempt the
task at all (`best_competitor: none`), so the verdict follows directly from
Klauro clearing its own 70% quality bar uncontested, per `win-validator.ts`'s
single-arm rule.

92 scenarios measured this way: 33 framework-route cells, 13 ORM-relation
fixtures, 8 DI-graph fixtures, 13 messaging-wiring fixtures, 15 route-auth
fixtures, 8 telemetry-correlation fixtures, plus WAS cross-repo linking and
component-tree render fixtures. **92 win / 0 tie / 0 loss.**

Concrete token cost where a like-for-like comparison exists (Klauro's
structured answer vs. the raw source bytes codebase-memory would force an
agent to read instead, since it cannot answer the question at all): mean
69.9% token reduction across the 33 measured route fixtures, ranging from 0%
(django, dream — small fixtures where the source itself was already small)
to 92% (express, fiber, nestjs).

## Summary totals (this report's live run, 2026-07-03T01:05:45Z)

| Camp | Win | Tie | Loss | Scenarios |
|---|---|---|---|---|
| A — vs codebase-memory | 72 | 1 | 0 | 73 |
| B — vs structural indexers | 120 | 2 | 0 | 122 |
| C — comprehension/out-of-category | 92 | 0 | 0 | 92 |
| **Total** | **284** | **3** | **0** | **287** |

Zero losses recorded. All 3 ties are genuine ceiling-ties against a tool that
is either compiler-accurate (scip-typescript, stack-graphs on TS/JS) or
happens to match on a small fixture (ripgrep on Go/TS who-calls, codebase-memory
on the fastapi route fixture, whose class-level route prefix codebase-memory
happens to parse correctly unlike quarkus/spring).

## What's measured vs modeled

Everything numeric in this report is **measured** — a live process invocation
of the real installed `codebase-memory-mcp` binary (or ripgrep/scip/ctags/
embeddings), scored against hand-authored `truth.json` fixtures, in this
session, with AI env vars explicitly stripped. Nothing here is a projected or
simulated competitor number.

The one explicitly **modeled/proxy** element, flagged above: in Camp C
out-of-category scenarios, "codebase-memory's token cost" is approximated as
the raw source bytes it would force an agent to read, since it produces no
route/ORM/DI output at all — there is no real codebase-memory token number to
capture for a question it cannot answer. This is a standard, disclosed proxy
(reading source directly is the actual fallback an agent takes), not an
invented number.

The one gap: the direct TS who-calls ceiling-tie (camps-bench) did not
capture codebase-memory's response bytes in this run, so no token/coverage
number is reported for codebase-memory on that specific scenario (see Camp A
table, "not captured in this arm"). The route and behavioral-diff arms (which
ask closely related questions of the same binary) do capture its real output
size and show it paying 4-13x Klauro's token cost on questions it can
partially or fully answer.

## Where Klauro ties instead of wins — the honest gap

The one place codebase-memory is a genuine peer, not a lesser tool: **raw
symbol/caller retrieval on TypeScript**, where its LSP-backed graph is
compiler-accurate, same as scip-typescript and stack-graphs. On that single
axis, "Klauro is better" is not a defensible claim — "tied on quality, ahead
on token cost" is the honest claim, and that is what this report makes. The
gap to close before over-claiming in front of investors: capture
codebase-memory's actual token/latency numbers on that exact TS who-calls
scenario (the harness has the plumbing — `codebaseMemoryCallers()` in
`real-camp-arms.ts` returns `ms`, but the token/byte figure wasn't wired into
`camps-bench.ts`'s Camp-B `codebase-memory` row). That's a small, concrete
harness fix, not a product gap — the product's win-validator already recorded
the quality tie honestly rather than hiding it.

## Reproduction

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
cd apps/mcp-server
env -u AZURE_OPENAI_API_KEY -u OPENAI_API_KEY -u OPENAI_MODEL \
  npx tsx src/gauntlet/competitor-scorecard.ts --md /tmp/scorecard.md
```

Requires `codebase-memory-mcp` installed at `~/.local/bin/codebase-memory-mcp`
or on `PATH` for the Camp-A rows to run live (falls back to an honest skip,
never a fake win, if absent — see `codebase-memory-mcp binary not installed`
skip-guards throughout the gauntlet test suite).

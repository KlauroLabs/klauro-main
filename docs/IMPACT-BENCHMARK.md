# Impact Benchmark: Klauro vs Baseline on Real Repos

**Date:** 2026-07-04
**Status:** Honest, small-N pilot. Not a marketing number — a measurement, with a clear negative finding.

## Headline

On this run's 4 real-repo comprehension/tracing tasks, the **baseline (grep + Read only) beat the
Klauro MCP arm on every measured axis**: 43% fewer tool calls, 3.4x less wall-clock time, and equal
task correctness (4/4 vs 4/4). This is the opposite of Klauro's marketed token/speed advantage, and
it is reported here without softening because the mandate for this benchmark was to be brutally
honest about where Klauro does not help.

This is a small sample (4 tasks, 2 repos) chosen for verifiable ground truth, not a statistically
powered study. The three specific tool gaps identified below (not the aggregate percentage) are the
most useful, actionable output of this run.

## Why the methodology changed mid-run (read this first)

The original plan was to drive both arms as real, separate `claude -p` subprocesses (the pattern the
existing gauntlet engine — `apps/mcp-server/src/agent-live-trial.ts`,
`apps/mcp-server/src/gauntlet/multi-arm-trial.ts`, `apps/mcp-server/src/gauntlet/live-driver.ts` — is
built around), giving fully independent processes and provider-reported token counts.

That failed immediately: `claude -p` launched from inside this Claude Desktop agent sandbox reports
`"Not logged in · Please run /login"` and `/login isn't available in this environment` — this is the
exact "sandboxed agent-to-agent CLI call" failure mode already documented in the user's global
CLAUDE.md (OAuth session credentials aren't visible to a plain subprocess in this sandbox; no
`~/.claude/.credentials.json` present). This is an environment limitation, not a retryable error, and
per instructions the correct move is to surface the exact error rather than assume auth is broken and
keep retrying — which is what happened here.

**Adapted methodology:** I acted as both arms myself, in this single session, sequentially:

- **Baseline arm**: grep/Read/find only. No Klauro MCP tools called at any point.
- **Klauro arm**: Klauro MCP tools (`resolve_agent_analysis`, `search_nodes`, `get_callers`,
  `get_coding_context`, `get_file_nodes`, `get_configuration`, `get_security_overview`,
  `assess_change_risk`) used first; grep/Read used only when Klauro's tools were insufficient
  (exactly as a real agent would fall back).

Each arm was run **completely fresh** — for each task I did the baseline discovery first, wall-clock
timed via `date +%s.%N` bracketing, then separately did the Klauro-tool discovery for the same
question, timed the same way. Tool-call counts are exact (every call is logged in this transcript).
Wall-clock times are real elapsed time for that arm's tool-call sequence, not estimated.

**Honest limitation of this adaptation:** because I am the acting agent for both arms, this measures
"how many tool calls / how much wall-clock does it take a competent agent to reach a correct answer
using this toolset," not independent black-box agent runs with separately reported provider token
counts. It does **not** produce a real total-token delta (no per-arm token accounting is possible this
way), so no token-savings percentage is reported — only tool-call count and wall-clock time, which are
directly observable and not fabricated. Anywhere a number could not be honestly measured, it is
omitted rather than estimated.

This deviation from the "live agent subprocess" design is exactly the kind of environment blocker the
CLAUDE.md instructs to surface rather than paper over — flagged here explicitly rather than silently
substituting a weaker methodology.

## Repos and tasks

Two real, unmodified repos from `~/dev`, chosen for size/language variety and for having a
**verifiable ground truth** I could confirm independently before running either arm:

| Repo | Language | Size | Klauro analysis freshness |
|---|---|---|---|
| `zerac/client-ui` | React/TypeScript | ~130 source files, 2136 CAS nodes | fresh (11h old, 0 files changed since) |
| `soon/soon-lens` | NestJS/TypeScript backend | ~4500 files, 26752 CAS nodes | fresh (11h old, 0 files changed since) |

| ID | Repo | Task type | Question | Ground truth |
|---|---|---|---|---|
| t1 | client-ui | find-the-bug / trace-a-flow | Is `tokenManager.getToken()` actually used to supply the auth token to API calls? | Dead code — real flow is `fetch.ts`'s `auth0GetToken`/`initializeAuth0Token` |
| t2 | client-ui | where-is-X-handled | Where is role-based access control enforced? | `require-role.tsx` (`RequireRole`) + `protected-route.tsx` (`ProtectedRoute`), both via `checkPermission()` |
| t3 | soon-lens | trace-a-flow | Is the monthly API quota actually enforced right now? | No — advisory only, gated behind `ENFORCE_API_QUOTAS` env var (default false), and fails open on error |
| t4 | soon-lens | safe-change / blast-radius | Who reads `RateLimits.endpoints` and would break if its shape changed? | `rate-limiter.ts` (real per-request reads) and `subscription-service.ts` (assigns the whole tier object) |

Both `zerac/client-ui` and `soon-lens` had **fresh** Klauro analyses already present (age ~11h, 0
files changed since analysis) — this is close to the best case for Klauro (no re-analysis cost, no
staleness penalty), which makes the result below more notable, not less.

## Results

| Task | Baseline tool calls | Baseline time | Klauro tool calls | Klauro time | Both correct? |
|---|---|---|---|---|---|
| t1 | 5 | 20.4s | 9 | 81.3s | yes / yes |
| t2 | 3 | 10.0s | 3 | 22.7s | yes / yes |
| t3 | 4 | 26.7s | 7 | 69.6s | yes / yes |
| t4 | 2 | 7.9s | 6 | 47.6s | yes / yes |
| **Total** | **14** | **65.0s** | **25** | **221.2s** | **4/4 vs 4/4** |

- **Tool-call delta:** Klauro used **+79% more tool calls** (25 vs 14).
- **Wall-clock delta:** Klauro was **+240% slower** (221.2s vs 65.0s) — roughly 3.4x.
- **Correctness delta:** none. Both arms reached the correct, ground-truth-matching answer on all 4
  tasks. Klauro did not produce any wrong answer or hallucination in this run.
- **Quality nuance:** on t3, Klauro's `search_nodes` found the enforcement class faster than a naive
  grep might have (one well-named search hit vs. multiple greps), but the tools that were supposed to
  supply the *decisive* fact (the env-gate condition, the fail-open behavior) came back empty or
  irrelevant, forcing a `Read` anyway — so the speed advantage of the search hit was fully consumed
  and then some by the follow-up gaps.

## Why Klauro lost here (the real finding)

The aggregate percentage is less useful than the pattern behind it. In every task, Klauro's structural
tools (`get_callers`, `get_configuration`, `get_security_overview`, `assess_change_risk`) were
consulted first as intended, but each surfaced a **specific, reproducible gap** that forced a fallback
to grep/Read — the exact tool sequence the baseline arm used from the start, so Klauro's tool calls
were mostly additive, not substitutive:

1. **Cross-file calls via imported functions are sometimes missed by `get_callers`.** In t1,
   `get_callers` on `initializeAuth0Token` (fetch.ts) returned only the same-file containment edge —
   it missed the real caller in `auth-context.tsx` (a different file, calling the imported function).
   Contrast with t2, where `get_callers` on `checkPermission` correctly found both real cross-file
   callers via `edge:calls` — so this is inconsistent, not a universal rule, which is itself concerning
   (an agent can't safely assume `get_callers` is complete without independent verification).

2. **Cross-file references to exported constants/interface properties are not tracked as call edges
   at all.** In t4, `get_callers` on both a `RateLimits.endpoints` interface property and the
   `TIER_RATE_LIMITS` variable returned nothing beyond same-file containment — `get_file_nodes` on
   the defining file confirmed zero outbound edges besides containment. Two real files
   (`rate-limiter.ts`, `subscription-service.ts`) import and read this exact symbol and were invisible
   to the graph. This directly defeats the "blast radius / safe change" use case, which is arguably
   the single highest-value scenario for an agent to get right before editing.

3. **`get_configuration(affecting_node_id=...)` missed the one env flag that mattered.** In t3, the
   `QuotaEnforcementInterceptor` class directly imports and branches on `ENFORCE_API_QUOTAS`, yet
   `get_configuration` scoped to that exact node returned empty `environment_variables` and
   `feature_flags` arrays. This is the tool's stated purpose ("surface configuration that affects code
   behavior... find config affecting a specific node") failing on a textbook example.

4. **`assess_change_risk` on a property-level node silently returned an irrelevant whole-repo dump
   instead of erroring.** In t4, calling `assess_change_risk` with the `endpoints` property's node_id
   returned `risk: null` plus ~90 unrelated high-risk/untested nodes from across the whole repo. A
   less careful agent could mistake this for a real, scoped answer — a silent-wrong failure mode is
   worse than an honest "not available."

5. **`search_nodes` misses on naive/conceptual queries, hits on named queries.** In t2 and t4, a
   generic conceptual query ("role permission access control route guard"; "TIER_RATE_LIMITS
   endpoints") returned unrelated top-10 results — the real answer was not in the list. A second,
   more specific query (using the actual symbol names) found it immediately. This means `search_nodes`
   underperforms grep specifically when the agent does *not* already suspect the right name — which is
   the exact situation the tool is meant to help with.

6. **`get_security_overview` is too broad to answer a specific enforcement question, and its
   enforced/assumed/missing model has no slot for "enforced-but-conditionally-disabled."** In t3, the
   rate-limiting boundary's enforcement-point sample didn't even list
   `quota-enforcement.interceptor.ts`, and nothing in the response hinted that the interceptor exists
   but is gated off by default — the most important nuance for that exact question.

## What Klauro got right

- `resolve_agent_analysis` correctly found fresh, ready analyses for both repos in one cheap call,
  with useful staleness metadata (0 files changed since analysis) — this part of the onboarding
  sequence worked exactly as designed.
- Named `search_nodes` queries (once the agent already knows or guesses the right symbol name) return
  precise, correctly-ranked hits with useful `risk` and `graph_context` annotations (e.g., flagging
  `QuotaEnforcementInterceptor` and `RequireRole`/`checkPermission` as `risk: "critical"`, which is a
  genuinely useful signal a grep would not surface).
- `get_callers` on `checkPermission` (t2) and on `initializeAuth0Token`/`tokenManager.getToken` (t1,
  the dead-code half) worked correctly and concisely — one call gave a definitive, correctly-filtered
  answer where a human/agent might otherwise need 2-3 greps to be sure of completeness.
- `get_coding_context` bundled useful secondary signal for free (existing test file path, layer,
  pattern) that would otherwise need a separate `find_tests`-equivalent step — this value didn't
  offset the losses in this run's tasks, but it is a real capability worth keeping in mind for
  modify/edit-shaped tasks (which this benchmark did not cover — see Scope below).

## Scope and caveats (read before citing this number)

- **N = 4 tasks, 2 repos, both TypeScript.** This is not a statistically powered study and the
  specific -240%/+79% figures should not be quoted as Klauro's general performance — they are this
  run's honest result on comprehension/read-only tasks, not an edit/modify benchmark.
- **No token counts.** Because the live-subprocess approach was blocked (see Methodology), no
  provider-reported token totals exist for either arm. Only tool-call count and wall-clock are
  reported. Do not infer a token-savings percentage from this document.
- **Single acting agent for both arms**, not independent blind runs — I already knew the ground truth
  before running either arm (necessary to design verifiable tasks), which could bias execution speed
  in either direction; I mitigated this by following the same discovery discipline (don't just recall
  the answer, use only the arm's allowed tools) for both arms.
- **Both tasks were read-only comprehension/tracing tasks**, not add-a-feature or fix-the-bug-with-an-
  edit tasks. Klauro's `get_coding_context`/modification-checklist/test-discovery machinery is
  specifically built for edit-shaped work and was not exercised here in a scenario where it would
  likely pay off more (e.g., "add a field and update every consumer" would probably expose the
  constant-cross-reference gap even harder, while "refactor this function used by 12 callers" would
  probably favor Klauro).
- **The existing gauntlet/live-agent infrastructure is real and was not used as designed.** The right
  next step, once `claude -p` subprocess auth is available outside this sandbox (see Methodology), is
  to rerun this exact task set through `runLiveAgentPair`/`runMultiArmTrial` for real provider token
  counts and truly independent arms.

## Recommendation

Do not use the -240%/+79% numbers as a marketing headline; they are specific to small, well-known
TypeScript comprehension tasks with fresh analyses already available. The actionable output of this
benchmark is the six gaps above, three of which (cross-file constant/property references invisible to
`get_callers`, `get_configuration` missing a directly-branched-on env flag, `assess_change_risk`
returning a silent whole-repo dump instead of erroring on an unsupported node type) are concrete,
reproducible bugs worth fixing before the next benchmark attempt. Re-run this same task set after
fixing them, and also add 2-3 edit/modify-shaped tasks (where Klauro's modification-checklist and
test-discovery are more likely to show a real advantage) to get a fairer overall picture.

---

# Right-Shape Re-benchmark (v1.0.18)

**Date:** 2026-07-04
**Status:** Honest, small-N re-run. Mixed result — real wins, and one of the original bugs
reproduces unchanged even after the "fixed" `get_callers`/references-edge work shipped in v1.0.18.

## Why this re-run exists

The first benchmark above (dated the same day, run before this one) drew a clean negative verdict,
but on the wrong task shape: small, familiar TypeScript repos, read-only comprehension questions
("is X actually used", "where is Y handled") — exactly where grep is cheap and complete. That is not
where a precomputed structural graph is supposed to pay for itself. This re-run deliberately moves to
the shape the mandate specifies: **blast-radius / change-safety / entity-lifecycle on large or
unfamiliar repos**, using the `get_callers` cross-file-reference fix that shipped after the first
benchmark (v1.0.18).

## Methodology

Same adaptation as the first benchmark and for the same reason: `claude -p` subprocesses report "Not
logged in" inside this sandbox, so true independent-arm subprocess trials were not possible. I acted as
both arms myself, sequentially, per task:

- **Ground truth first, independently of either arm.** For every task I ran exhaustive grep passes
  myself before looking at what either arm would report, so the "correct answer" was fixed before
  either arm's output could bias it.
- **Baseline arm:** grep/find/read only, real commands, real wall-clock (`date +%s.%N` bracketing).
- **Klauro arm:** only `mcp__klauro__*` tools, in the sequence a disciplined agent would use
  (`resolve_agent_analysis` once per repo, then `search_nodes`/`get_callers`/`get_data_lineage`/
  `get_coding_context`/`get_summary`/`assess_change_risk`/`query_graph` as each task required).
- Tool-call counts are exact (every call in this transcript). Wall-clock is real elapsed time for that
  arm's command/tool sequence. **No token counts are reported** — this single-acting-agent setup
  cannot honestly produce independent per-arm token totals, so, as in the first benchmark, only
  tool-call count and wall-clock are claimed, and completeness-vs-ground-truth is the primary metric.

## Repos

Both far larger/less familiar than the first benchmark's repos, both with fresh Klauro analyses
already present (age <1h, 0 files changed since analysis — best case for Klauro, not a stale-analysis
excuse):

| Repo | Language | Size | Freshness |
|---|---|---|---|
| `~/dev/clients/outcode/truckspy` | Symfony/PHP + Angular | 82,898 nodes, 128,446 edges, 820 entry points | fresh, 56m old, 0 changed |
| `~/dev/zerac/zerac-api` | NestJS/TypeScript monorepo | 12,821 nodes, 12,543 edges, 524 entry points | fresh, 58m old, 0 changed |

## Tasks and results

| ID | Repo | Task type | Question | Baseline calls / time | Baseline completeness | Klauro calls / time | Klauro completeness | Correct? |
|---|---|---|---|---|---|---|---|---|
| r1 | truckspy | blast-radius | Every file that references `App\Entity\Vehicle` (a core entity class) | 4 greps / ~0.2s | 194/194 files (100%) | 4 calls (`search_nodes`, `get_callers`, `get_coding_context`, `get_data_lineage`) / ~31s | 1/194 files (0.5%) | baseline yes / Klauro no |
| r2 | truckspy | entity-lifecycle | Every reader/writer of the `Trip` entity across the whole monorepo (backend + Angular UI + SOAP client) | 2 greps / ~0.2s | ~67 files, no lifecycle categorization, no cross-language coverage without more passes | 2 calls (`search_nodes` then `get_data_lineage`) / ~13s | 57 writers + reader(s) + auth-boundary + journey data, cross-language (PHP, TS/Angular, SOAP client), lifecycle-tagged (created/updated/deleted/read) in one payload | both technically correct; Klauro's answer is categorically richer |
| r3 | zerac-api | blast-radius / change-safety | Every consumer of the exported `AUTH0_ADMIN_M2M_REQUESTED_SCOPES` const | 1 grep / ~0.04s | 2/2 real consumer files (100%) | 3 calls (`search_nodes`, `get_callers`, `query_graph`) / ~11s | 0/2 (0%) | baseline yes / Klauro no |
| r4 | zerac-api | unfamiliar-repo orientation | What does this repo do, its architecture, and its top capabilities? | README read + 4 commands / ~5s | Reasonable but manually assembled: module names only, no ranked capabilities, no entity list, no entry-point breakdown | 1 call (`get_summary`) / <1s | Full structured answer: primary domain, 10 architectural patterns w/ confidence, 39 ranked capabilities, 41 DB entities, entry points by type (http/cli/route/schedule/test), architecture type | both reasonable; Klauro's answer is materially more complete for the same or less effort |

## The honest aggregate

- **On the two blast-radius tasks (r1, r3), Klauro lost outright, badly, on completeness** — 0.5% and
  0% of real consumers found, using more tool calls and more wall-clock than grep. This is exactly the
  scenario the mandate expected Klauro to win, and it did not. Both failures are for the **same
  underlying reason**, and it is the **exact bug already reported in the first benchmark
  (`~/.klauro/agent-feedback/2026-07-04-impact-benchmark.md`, gap #2) as unfixed**: `get_callers`
  tracks function-call edges but not cross-file references to plain exported variables/constants
  (PHP entity classes referenced via `use` imports; a TS `export const` referenced via ES import). The
  v1.0.18 `get_callers` fix evidently improved some cross-file case (per the mission brief) but did
  **not** cover this specific, very common pattern — an exported entity class or `const` consumed
  elsewhere. This is not a new bug; it is the same one, still open, now reproduced on two different
  languages (PHP, TypeScript) and two different repos.
- **On the entity-lifecycle task (r2), Klauro won decisively** — one `get_data_lineage` call
  (after one `search_nodes` call to resolve the entity_id) produced a cross-language,
  lifecycle-categorized, auth-boundary-annotated answer that grep would need many more passes to even
  partially reconstruct, and grep's reconstruction still wouldn't have the lifecycle/journey semantics
  at all. This is the strongest, most defensible Klauro win in this run.
- **On the orientation task (r4), Klauro won on completeness-per-effort** — one call replaced a
  README read plus several `ls`/`find`/`cat` commands, and returned a strictly more complete,
  structured answer (ranked capabilities, entity list, entry-point type breakdown) than the manually
  assembled baseline view.
- **Silent-wrong compounding on r3:** `assess_change_risk` called on the same `AUTH0_ADMIN_M2M_REQUESTED_SCOPES`
  variable node returned `risk: null` plus ~100 unrelated high-risk nodes from across the whole
  zerac-api repo — reproducing gap #4 from the first benchmark's feedback, verbatim, on a different
  repo. `query_graph` (`MATCH (a)-[:imports]->(b) WHERE b.name = '...'`) also returned zero rows for
  the same symbol, either because the edge type name is wrong (`imports` is a guess; the tool's own
  docs do not enumerate valid edge type strings) or because the underlying edge genuinely does not
  exist — either way it is not a usable escape hatch for this task shape today.
- **`get_call_chain`'s entry_point_id namespace is not the same ID space `search_nodes`/`get_route_table`
  return.** Calling it with the `route_...` node_id from `search_nodes` (type=route) returned an empty
  chain list (`total: 0`) with no error explaining the ID mismatch — a minor but real usability gap
  that cost one wasted call while exploring a 5th/6th task candidate (this task was dropped from the
  final table rather than force-fit, in the interest of not padding the task count with a broken call).

## The strongest defensible claim from this run

**On entity lifecycle across a polyglot monorepo, Klauro answers in 2 calls what grep cannot fully
answer at all** (r2): one `get_data_lineage` call returned 57 categorized writers plus readers,
external-recipient fan-out, and auth-boundary guard status for the `Trip` entity across PHP backend,
Angular frontend, and a SOAP client library — lifecycle semantics and cross-language reach that no
number of additional grep passes would produce, because grep has no concept of "lifecycle:created" vs
"lifecycle:updated" or of which HTTP boundaries guard a given entity's flow.

**But the mandate's headline claim — "Klauro finds all consumers via one `get_callers` call while grep
misses aliased/interface refs" — is not supported by this run.** On both blast-radius tasks (r1, r3),
`get_callers` found at most the containing file and missed 100% of real cross-file consumers that a
single grep found instantly. This is the same open bug from the first benchmark, not a new one, and it
is the single most damaging gap for the "change-safety before I edit" use case specifically because
`get_coding_context`'s `modification_checklist` on r1 said *"1 callers still work correctly"* — a
confident, wrong answer, not an honest "incomplete."

## Verdict

Klauro's value shows clearly and defensibly on **one** of the four task shapes tested here — entity
lifecycle/data-flow tracing across a polyglot monorepo (`get_data_lineage`) — and shows a smaller,
real win on unfamiliar-repo orientation (`get_summary`). It does **not** yet show on blast-radius for
plain exported constants/entity classes, which is arguably the single highest-value "don't break
production" scenario and the one most explicitly named in the mission. The `get_callers` gap reported
in the first benchmark on 2026-07-04 is confirmed still open in this v1.0.18 re-run, now reproduced on
a second, larger, differently-shaped repo and a second language. Do not claim the blast-radius
completeness advantage as a general Klauro strength until this specific gap (function-call edges only,
no plain-variable/entity-class reference edges) is fixed and re-verified with a new task set.

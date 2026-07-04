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

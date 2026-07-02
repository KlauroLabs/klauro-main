# Klauro — Spec: Default-Compact Responses for High-Traffic Onboarding Tools

> **Status: PARTIALLY IMPLEMENTED** as of e1780f62 (2026-07-02) — detail/compact defaults + get_coding_context truncation signal shipped; replay-amplification measured.

> **Audience:** builder agents. Investigation done 2026-07-02 via Klauro MCP tools (dogfooded on
> `proof-of-concept` itself, a 33,932-node / 33,078-edge analyzed repo) + source read confirmation.
> This spec extends the existing byte-budget machinery (`response-budget.ts`) — it does not
> propose a greenfield truncation system. The gap is that the existing budget is generous (20KB
> per call) and per-call-only; on a non-caching model a handful of 5-9KB tool responses replayed
> across ~15 conversation turns is what produces a >10x token blowup, not any single oversized
> response.

---

## 0. Context: the measured problem

A live agent (Llama-3.3-70B via `apps/mcp-server/src/gauntlet/deepinfra-agent.ts` /
`autonomous-mcp-trial.ts`, tracked through `provider_total_tokens` in
`apps/mcp-server/src/gauntlet/large-repo-scenario.ts:135`) doing a task on a 426-file repo
**with** Klauro spent 321k tokens across only 3 tool calls (~107k tokens/call effective) vs 28k
tokens without Klauro — an ~11x blowup — even though task success flipped false→true. `provider_total_tokens`
is a cumulative, conversation-level counter reported by the inference provider; it necessarily
counts every prior turn's content on every subsequent turn for a non-caching model. That is the
mechanism this spec targets.

---

## 1. Is the response budget enforced on the direct onboarding tools, or only the gateway?

**It is enforced universally, on every registered tool, including the direct onboarding tools.**
This is a stronger guarantee than the task brief assumed ("gateway vs direct tools" is not the
right framing — there is no split).

`apps/mcp-server/src/server.ts:172-182` (`recordToolRegistrations`) monkey-patches
`server.registerTool` itself:

```ts
function recordToolRegistrations(server: McpServer, profile: ToolProfile): Map<string, RegisteredToolEntry> {
  const registry = new Map<string, RegisteredToolEntry>();
  const originalRegisterTool = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, config: any, handler: (...args: any[]) => any) => {
    const boundedHandler = withResponseBudget(name, config, handler, profile);   // <-- every tool, unconditionally
    registry.set(name, { config, handler: boundedHandler });
    ...
  };
  return registry;
}
```

`withResponseBudget` → `enforceResponseBudget` (`server.ts:184-218`) runs for **every** tool
call result, checks `Buffer.byteLength(text, 'utf8') <= RESPONSE_BUDGET_BYTES` (20,000 bytes,
`response-budget.ts:1`), and if exceeded calls `boundToolPayload`/`boundToolText`
(`response-budget.ts:170-219`) to shrink arrays/strings in place before re-serializing via
`serializeToolResponse`. This applies identically whether a tool is called directly
(`get_summary`, `search_nodes`, `get_coding_context`, `get_route_table`, `get_callers` — all in
`CORE_TOOL_NAMES`, `server.ts:126-139`) or indirectly through the `klauro_query` gateway
(`server.ts:257-278`). The 20KB ceiling (`RESPONSE_BUDGET_BYTES`) is a hard, tested invariant
(`response-budget.test.ts:44-60`), confirmed by direct measurement below — none of the 8 sampled
responses got anywhere near it.

**There is no `summarizeCas` function anywhere in `query.ts`** (grep-confirmed; 3,792 lines, 40+
exported functions). The task brief's premise about a "gateway ~20k cap distinct from a
`summarizeCas` cap" does not match the code: there is one universal byte cap
(`RESPONSE_BUDGET_BYTES`), applied by one wrapper, at one layer (`server.ts` tool registration),
not per-function inside `query.ts`.

What `query.ts` *does* have, independently of the byte budget, is dozens of hardcoded
**item-count** caps sprinkled through each response builder — e.g. `getCodingContext`
hardcodes `getCallers(cas, targetNode.id, 1, 10)` / `getCallees(cas, targetNode.id, 1, 10)`
(`query.ts:2185-2186`), so even a node with 45 real callers and 520 real callees (confirmed live:
`AnalyzerOrchestrator`, see §2) only ever returns 10 + 10 in `get_coding_context`. These caps are
uncoordinated with the byte budget — they were tuned by feel per-field, not against a token
target — and most are generous relative to what a single-turn agent decision needs (10 callers is
already more than most decisions require; `functions.slice(0, 20)` for naming-convention samples
is oversized for a signal that only needs 5).

The one already-compact format that exists is the **K15/K5 capsule**
(`agent-context-codec.ts:751` `encodeK15`, wired into `get_agent_context` via
`response_profile: "capsule-only"`, documented in `agent-bootstrap.ts:56` and
`agent-defaults.ts:77-298`). It is a custom compact string encoding (not JSON), explicitly built
to be token-minimal. **But it is opt-in and scoped to one tool (`get_agent_context`) — `get_summary`,
`search_nodes`, `get_coding_context`, `get_route_table`, and `get_callers` have no capsule mode and
always return full JSON.**

---

## 2. Measured default response size, this repo (33,932 nodes / 33,078 edges), UTF-8 bytes / 4 ≈ tokens

| Tool | Call | Bytes | Est. tokens | % of 20KB budget |
|---|---|---:|---:|---:|
| `resolve_agent_analysis` | orient on repo root | 6,105 | ~1,526 | 30% |
| `get_summary` | orient on repo root | 8,505 | ~2,126 | 43% |
| `search_nodes` | query "response budget" (25 results) | 8,697 | ~2,174 | 43% |
| `search_nodes` | query "analyzer orchestrator" (25 results) | 9,329 | ~2,332 | 47% |
| `get_coding_context` | target = `orchestrator.ts` (45 real callers / 520 real callees, capped to 10+10) | 5,561 | ~1,390 | 28% |
| `get_coding_context` | target = small single-caller function | 2,550 | ~637 | 13% |
| `get_callers` | target = 5-caller function, depth 2 | 771 | ~192 | 4% |
| `get_route_table` | this repo (no HTTP routes) | 55 | ~13 | 0.3% |

**None of these hit the 20KB budget wrapper on this repo.** The hogs, in order, are
`search_nodes` and `get_summary` (both ~8.5-9.3KB, ~2.1-2.3k tokens), followed by
`resolve_agent_analysis` (~6.1KB) and `get_coding_context` on a high-fanout target (~5.6KB). The
smallest is `get_callers` at well under 1KB. A route-heavy repo would push `get_route_table` much
higher (it's paginated at `limit=50` with no byte trim beyond the universal wrapper — a 50-route
page of method/path/controller/handler/auth/guards/middleware easily reaches several KB per page).

Two structural observations that matter more than the raw numbers:

- **`get_summary` is front-loaded with content most orientation tasks don't need on turn 1**:
  `analysis_phases` (5 verbose objects with `agent_value`/`visualization_value`/`outputs` prose
  each, `get_summary.json` lines for `analysis_phases` alone are ~40% of the payload),
  `architectural_patterns` (10 objects with a `guidance` sentence each), and
  `architectural_inventory_counts`. These are useful for a first-ever orientation but are static
  per-repo and get replayed verbatim on every subsequent turn once in context.
- **`search_nodes` defaults to `limit=25`** with a full `scores` object (4 floats) and
  `graph_context` (4-5 fields) per hit. 25 results is far more than an agent typically consumes
  from one query — most agents read the top 3-5 and move on — so ~80% of a typical `search_nodes`
  payload is discarded context that still gets replayed on every later turn.

---

## 3. Is the 321k/3-calls blowup a per-response-size problem, a replay problem, or both?

**Both, but replay dominates, and the per-response-size problem is smaller than the task brief's
hypothesis on this repo.** Reasoning:

- Direct measurement above shows the 5 sampled onboarding tools return 0.7-9.3KB (≈190-2,330
  tokens) each on a genuinely large (33.9k-node) repo — none anywhere near the 20KB/~5k-token
  budget ceiling, let alone large enough on their own to explain 107k tokens/call.
- 107k tokens/call cannot be one tool's single JSON payload under the current architecture: the
  hard ceiling is `RESPONSE_BUDGET_BYTES` = 20,000 bytes ≈ 5,000 tokens, enforced on literally
  every registered tool (§1). So 107k/call is not "one big response" — it must be `provider_total_tokens`
  counting the **cumulative conversation transcript** at each of the 3 turns, which is exactly what
  `large-repo-scenario.ts:135` reports (`provider_total_tokens` is the provider's running total,
  not a per-message delta).
- Do the arithmetic: if turn 1 nets ~3-9KB (~1-2k tokens) of tool response plus system
  prompt/instructions, and turn 2 replays turn 1's full response *plus* adds its own new
  ~3-9KB response, and turn 3 replays both prior turns plus its own — on a non-caching model that
  quadratic-ish growth from 3 calls each ~2-9k tokens native size can plausibly compound past
  100k by turn 3 once you include the system prompt (Klauro's `SERVER_INSTRUCTIONS`, tool
  descriptions for up to ~160 registered tools with full JSON schemas — itself potentially tens of
  KB — gets replayed on *every* turn too, independent of which tool was called).
  So the 11x blowup is driven by (a) the size of what's returned per call — currently 2-9k tokens
  when it could be 200-1,500 tokens with a compact default — multiplied by (b) how many times that
  payload gets re-sent as prior-turn context on a model with no prompt caching.
- Practical implication: **shrinking default response size has a multiplicative effect on the
  total**, because every byte saved on turn 1 is saved again on turns 2..N. Cutting `get_summary`
  from ~8.5KB to ~1.5KB (≈2,126→375 tokens) does not save ~1,750 tokens once — on a 3-turn
  interaction it saves it 3 times over (once per replay), which is why "default compact, opt-in
  expand" is the right lever even though no single response was hitting the 20KB ceiling.

---

## 4. Design: default-compact, opt-in expand

### Target budgets (net new, tighter than the existing universal 20KB/~5k-token ceiling)

| Tool | Current typical (this repo) | New default target | Expansion path |
|---|---:|---:|---|
| `get_summary` | ~2,126 tok | ≤ 1,500 tok | `detail: "full"` param restores `analysis_phases` full prose + full `architectural_patterns` |
| `search_nodes` | ~2,174-2,332 tok (limit 25) | ≤ 1,000 tok (default `limit` → 8, drop `scores` object by default) | `limit` param already exists — raise it; add `include_scores: true` to opt back into score breakdown |
| `get_coding_context` | ~1,390 tok (capped 10+10) | ≤ 2,000 tok (keep; already reasonable) — but make caller/callee cap configurable | `caller_limit`/`callee_limit` params instead of hardcoded 10 |
| `resolve_agent_analysis` | ~1,526 tok | ≤ 1,000 tok | drop full `candidates[]` list by default when `selected` relation is `exact` — only include candidates when ambiguous |
| `get_route_table` | 0 tok here / unbounded elsewhere | ≤ 1,500 tok/page | default `limit` already 50 — lower to 25, keep pagination |
| `get_callers` / `get_callees` | ~192 tok (small case) | fine as-is | already returns node_id/name/type/depth/via only — good minimal shape |

### Mechanism

1. **Compact-by-default field pruning in the response builders themselves** (`query.ts`), not
   just the universal post-hoc byte shrinker. The universal shrinker in `response-budget.ts` is a
   safety net for pathological cases (huge repos, huge fanout) — it should stay — but it's the
   wrong tool for "make the common case small," because it only engages at 20KB and it truncates
   generically (drops array tail / truncates strings) rather than dropping the *right* low-value
   fields first. Field-level pruning belongs in the builder that knows which fields are
   high-value-per-byte (e.g. `target_node`, `truncated_paths`, `continuation`) vs. low-value
   filler (e.g. `analysis_phases[].agent_value` prose, `scores.structural` precision floats).
2. **A `detail` parameter (`'compact' | 'full'`, default `'compact'`)** on the high-traffic tools
   (`get_summary`, `search_nodes`, `get_coding_context`, `resolve_agent_analysis`), mirroring the
   pattern already established by `get_agent_context`'s `response_profile` (`'standard' |
   'minimal' | 'first-turn' | 'capsule-only'` — `resolve_agent_analysis`'s own input schema
   already has this enum, it's just not wired to trim `get_summary`/`search_nodes` output). Compact
   mode drops prose fields, caps array lengths tighter, and omits secondary scoring detail;
   `'full'` restores today's behavior byte-for-byte, so nothing currently relying on full output
   breaks — it becomes an explicit ask instead of the default.
3. **Continuation-style pointers instead of bodies where cheap to regenerate.** `search_nodes`
   results already carry `node_id` — an agent that wants the full node can call `get_node`. The
   compact default should keep `node_id`, `name`, `type`, `file`, and the single `final` score
   (drop `semantic`/`lexical`/`structural` sub-scores by default — they're diagnostic, not
   decision-relevant for 95% of calls) and drop `graph_context` unless `include_graph_context:
   true`.
4. **Dedupe replayed static content.** `get_summary`'s `analysis_phases` array is identical on
   every call for a given repo+analysis-version — it's static metadata about the analysis
   pipeline, not about the code. It doesn't need to be in the default `get_summary` payload at
   all; move it to a one-time reference the agent fetches only if it explicitly cares how the
   analysis was produced (rare). This alone removes ~40% of `get_summary`'s current payload.
5. **Keep the existing universal 20KB byte-budget wrapper (`response-budget.ts`) unchanged as the
   backstop** for repos/targets where even compact mode overflows (e.g. `get_route_table` on a
   500-route API, `get_coding_context` on a node with thousands of real callers before the
   hardcoded `limit=10` truncation even applies at the query.ts layer for very wide fan-out
   scenarios not covered here). No regression risk: `boundToolPayload`/`boundToolText` still run
   after builder-level compaction, they just have less work to do.

### Implementation plan (ordered)

1. `apps/mcp-server/src/query.ts` — add a `detail` option (default `'compact'`) to `buildSummary`
   (line 46), `searchNodes` (line 315), `getCodingContext` (line 1963). In compact mode: drop
   `analysis_phases` from `buildSummary`'s output (or replace with a one-line pointer + count);
   tighten `architectural_patterns` from `slice(0, 12)`/`slice(0, 20)` to `slice(0, 5)`; in
   `searchNodes`, drop the `scores` sub-object breakdown (keep only `final`) and drop
   `graph_context` unless requested; lower `search_nodes`' effective default `limit` from 25 to 8
   in the tool's registered schema default (not inside `searchNodes` itself, so `full`/explicit
   `limit` callers are unaffected).
2. `apps/mcp-server/src/server.ts` — thread a `detail`/`limit` param through the Zod
   `inputSchema` for `get_summary`, `search_nodes`, `get_coding_context`,
   `resolve_agent_analysis` tool registrations (search each tool's `registerTool(...)` call,
   currently plain objects with no `detail` field); pass through to the `query.ts` calls.
3. `apps/mcp-server/src/query.ts:2185-2186` — replace the hardcoded `getCallers(cas,
   targetNode.id, 1, 10)` / `getCallees(cas, targetNode.id, 1, 10)` with a param the caller can
   raise (`caller_limit`/`callee_limit`, default stays 10).
4. `apps/mcp-server/src/response-budget.ts` — no functional change required; it remains the
   backstop. Optionally lower `RESPONSE_BUDGET_BYTES` for compact-mode calls specifically (e.g.
   pass a tighter `budgetBytes` override per tool in `enforceResponseBudget`'s `options` when
   `detail === 'compact'`) so the backstop and the intentional default agree, rather than leaving
   an 8x gap between "what compact mode targets" (~1.5k tokens) and "what the backstop still
   allows" (~5k tokens) for tools that haven't been field-pruned yet.
5. Update `server.ts`'s `SERVER_INSTRUCTIONS` / tool descriptions to state the new default
   explicitly (mirroring the existing pattern at `server.ts:251`: `` `Responses are bounded to
   ${RESPONSE_BUDGET_BYTES} bytes...` `` — add a sibling line noting onboarding tools default to
   compact mode and how to opt into `detail: "full"`).

### Measurement bench (new)

Add `apps/mcp-server/src/gauntlet/response-size-bench.ts` (+ `.test.ts`) that:
- Resolves the analysis for a designated large fixture repo (this proof-of-concept repo itself is
  a good target — 33.9k nodes is already a strong stress case, no synthetic fixture needed).
- Calls `get_summary`, `search_nodes` (2-3 representative queries), `get_coding_context` (one
  low-fanout target, one high-fanout target like `AnalyzerOrchestrator`), `resolve_agent_analysis`,
  `get_route_table`, `get_callers` directly through `createServer()`'s registered handlers (same
  path a real MCP client takes — not by calling `query.ts` functions directly, to keep the
  universal budget wrapper in the loop).
- Asserts each tool's **default** (no `detail` param passed) response stays under its target from
  the table in §4 — this is a regression guard against the defaults silently growing again as new
  fields get added to `query.ts` builders over time.
- Reports bytes/tokens per tool in a table like §2 so the numbers stay visible in CI output, not
  just asserted pass/fail.

### Re-running the #96 large-repo scenario

Once (1)-(4) land, re-run `apps/mcp-server/src/gauntlet/large-repo-scenario.ts` (already wired to
`autonomous-mcp-trial.ts` / `deepinfra-agent.ts` for live Llama-3.3-70B trials, reporting
`provider_total_tokens` per `large-repo-scenario.ts:135`) against the same 426-file repo. Expected
outcome: `autonomous_klauro.tokens` drops materially below the current ~321k (rough estimate: if
per-call native payload shrinks from ~2-9k tokens to ~0.4-2k tokens, a 3-turn interaction's
replay-amplified total should shrink by a similar multiple, i.e. toward the 30-60k range) while
`task_success` (`autonomous_klauro` vs `baseline` in the same report) stays `true` — the compact
defaults preserve the fields an agent actually needs to act (node ids, files, lines, callers,
tests to run) and only strip prose/diagnostic filler that wasn't decision-relevant.

---

## 5. Klauro tools used for this investigation

`resolve_agent_analysis`, `get_summary`, `search_nodes` (x2), `get_coding_context` (x2: small
target + high-fanout `AnalyzerOrchestrator`), `get_route_table`, `get_callers` — all called
directly against `/Users/michaelshattuck/dev/unravl/proof-of-concept` (33,932 nodes / 33,078
edges / 969 entry points; analysis is currently reported stale — 231 files changed since last
analysis, `resolve_agent_analysis`'s `analysis_freshness.staleness: "stale"` — findings above are
based on the graph as analyzed, file:line citations were confirmed by direct `Read` against
current source, not solely trusted from the graph).

Feedback captured: `~/.klauro/agent-feedback/2026-07-02-response-size.md`

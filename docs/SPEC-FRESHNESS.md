# Klauro — Spec: Always-Fresh-on-Read, Never-Thrash Freshness Guarantee

> **Status: IMPLEMENTED** as of e1780f62 (2026-07-02) — freshness wired into onboarding tools + new-file pickup (git status -uall). This spec's problem-statement describes the PRE-fix state; verify against source, not this doc.

> **Audience:** builder agents. Investigation done 2026-07-02 via Klauro MCP tools (dogfooded on
> `proof-of-concept` itself) + source read confirmation. This spec extends existing incremental
> machinery — it does not propose a greenfield freshness system. The incremental engine
> (`ChangeDetector`, content-hash file cache, `orchestrateIncrementalAnalysis`) is solid and
> should be reused as-is; the gap is entirely in **when it gets invoked**.

---

## 0. Current-state findings (with file:line evidence)

### 1. Is freshness GUARANTEED at the moment an agent starts?

**No. It is guaranteed on only 8 of the ~160 MCP tools, and NOT on the tools the server's own
onboarding instructions tell agents to call first.**

`getFreshAnalysisForAgent(projectPath)` (`apps/mcp-server/src/server.ts:80-90`) is the only
function that checks staleness and transparently triggers an incremental refresh before
returning CAS:

```ts
async function getFreshAnalysisForAgent(projectPath: string) {
  try {
    const cas = await getAnalysis(projectPath);
    const summary = freshness.summarizeAnalysisFreshness(projectPath, cas.analysis_timestamp);
    if (!summary || summary.staleness === 'fresh') return cas;
  } catch { /* falls through */ }
  return (await analyzeProjectIncremental(projectPath)).output;
}
```

It is called from exactly **8 call sites / 8 distinct tools** (confirmed by grep + reading each
registration block in `server.ts`):

- `get_agent_bootstrap` (line 2060)
- `get_agent_doctor` (line 2122)
- `get_agent_default_config` (line 2146)
- `install_agent_default_config` (line 2170)
- `get_agent_start_context` (line 2194)
- `get_agent_tool_plan` (line 2217)
- `get_agent_context` (line 2241)
- `evaluate_agent_task_proof` (lines 2621, 2636)

**Every other tool** — including the ones the server's own `SERVER_INSTRUCTIONS`
(`server.ts:62-78`) tell agents to call FIRST — calls the raw, non-refreshing `getAnalysis(path)`
instead:

- `resolve_agent_analysis` → `agentProjectMap.resolveAgentAnalysis` (`server.ts:2107-2109`,
  impl in `apps/mcp-server/src/agent-project-map.ts`) — reports `analysis_freshness` as an
  advisory field but **returns the stale CAS-derived candidate list regardless**.
- `get_summary` → `getAnalysis(path)` directly (`server.ts:1303-1306`) — **no freshness check at
  all**.
- `search_nodes` (lexical mode) → `getAnalysis(path)` (`server.ts:3130-3137`); semantic/hybrid
  mode goes through `semanticSearch(path, ...)`, which also reads the stored index, not a
  refreshed one.
- `get_coding_context` → `getAnalysis(path)` (`server.ts:3481-3497`) — the tool the server calls
  "THE essential tool for AI coding... call this before writing ANY code" has **zero freshness
  gate**.
- `get_system_overview`, `get_architecture_context`, and the majority of the ~150 other read
  tools (`server.ts` grep for `getAnalysis(path)` returns dozens of call sites) — same pattern.

**Live proof from this session:** `get_analysis_freshness` on this repo right now reports
`status: "stale"`, `modified_since_analysis: 305` of 883 tracked files, `analysis_age_seconds:
159287` (~44h). Yet `resolve_agent_analysis` on the same path happily returned a `status: "pass"`,
`readiness_score: 100` candidate — the freshness field is present in the payload but nothing
gates on it. An agent that follows the server's own documented protocol (`resolve_agent_analysis`
→ `get_summary` → `search_nodes` → `get_coding_context`) **never triggers a refresh** and can
silently work off a two-day-old graph — while the file/line citations it hands back are wrong for
305 changed files.

**The window/gap, precisely:** freshness is opt-in per-tool via a function that only 8 tools call.
`resolve_agent_analysis` — explicitly documented as the mandatory first call — is not one of them.
This is the single highest-leverage fix: it is a wiring gap, not a missing capability.

### 2. What is the CPU cost model?

**The incremental engine itself is cheap and correctly scoped — the risk is elsewhere (in how
staleness is detected, and in what happens once a refresh is triggered).**

- `summarizeAnalysisFreshness` (`apps/mcp-server/src/freshness.ts:292-350`), used for the
  advisory-only staleness field: `git status --porcelain` + `git log --since` to get changed-file
  *candidates*, then verifies each candidate by `stat().mtimeMs` (bounded to 500 files,
  `FRESHNESS_MTIME_VERIFY_LIMIT`), with a non-git fallback that walks the tree capped at 4000
  files (`FRESHNESS_WALK_FILE_LIMIT`). Measured on this repo just now: **92ms**, `bounded: false`.
  Memoized 5s (`FRESHNESS_SUMMARY_CACHE_TTL_MS`). This is cheap and does not itself risk CPU
  thrash — it's a good building block.
- The actual refresh path, `analyzeProjectIncremental` → `runIncrementalAnalysis`
  (`apps/mcp-server/src/analyzer.ts:1017-1120`) → orchestrator's
  `orchestrateIncrementalAnalysis` (`packages/analyzer-core/src/analyzer/core/orchestrator.ts:1540`)
  → `ChangeDetector.detectChanges` (`packages/analyzer-core/src/analyzer/core/change-detector.ts:156-204`):
  genuinely changed-file-only. It layers `git diff --name-status` (committed) + working-tree
  status (uncommitted) to get a candidate set, then `filterUnchangedGitChanges` re-verifies each
  candidate against a stored per-file content hash (`fileHashChanged`, line ~335) so a touched
  file whose content round-trips to the same bytes is **not** treated as changed. Only files that
  survive that filter get re-parsed; results are cached by content hash
  (`loadFileCache`/`saveFileCache` keyed by `contentHash`, `orchestrator.ts:1899-1924`,
  `analyzer.ts:1059-1060`), so re-running analysis over a repo where the same file reappears with
  the same hash costs ~0 (cache hit, no re-parse). Zero changes → early return of the previous
  output untouched (`orchestrator.ts:1588-1597`).
- Serialization is correct: a process-wide `withGlobalAnalysisLock` (`analyzer.ts:1002-1015`,
  explicitly documented as guarding cross-project interleaving on the shared orchestrator
  singleton) plus a per-project `withProjectAnalysisLock` (`apps/mcp-server/src/storage.ts:398`).
  No two analyses race each other; a burst of tool calls queues rather than parallel-thrashes.
- **Full-rebuild triggers exist and are reasonable, but are a real cost cliff**: CAS
  version mismatch, missing graph integrity, missing call chains, `changeSet.requiresFullRebuild`
  (schema drift, threshold-exceeded change volume — `shouldTriggerFullRebuild`), or `>10` files
  aged per `freshness.ts`'s own `FRESHNESS_STALE_CHANGED_FILE_THRESHOLD` (used only for the
  advisory label, not for gating a rebuild, but signals the same regime). A large branch switch
  or rebase that touches hundreds of files (as we're seeing live: 305/883 tracked files changed)
  risks tripping the full-rebuild path on the very first `getFreshAnalysisForAgent` call after
  the gap window closes, which — while safe — is not "cheap." This is expected/acceptable
  behavior (a big enough diff should get a full rebuild), not a bug, but it means the fix for
  answer (1) must be paired with the debounce/coalescing from answer (3) or many rapid-fire
  agent-entry calls right after a big pull could each try to acquire the lock for an expensive
  rebuild before the first one lands.
- **No eager background re-analysis exists today.** The only thing that runs unprompted is
  `start_watch` (`apps/mcp-server/src/watcher.ts:277-332`) — strictly **opt-in**, must be called
  explicitly via the `start_watch`/MCP `startWatch` path; nothing wires it into agent-entry tools
  or server startup. Its debounce is 5s default (`DEFAULT_DEBOUNCE_MS`, `getDebounceMs()` clamps
  env override to 2s–120s), and even its "impact preview" (fast per-change classification, not a
  reanalysis) debounces separately at 250ms. So today there is no CPU-demolishing background
  loop — but there is also nothing keeping the graph warm without an agent explicitly asking for
  it via `start_watch`.

**Summary: the incremental engine is the right cost model already (changed-file-only, content-hash
cached, locked, cheap staleness scan). The gap is not "it's too expensive to check" — the 92ms
git-scan cost proves checking is cheap. The gap is invocation coverage.**

### 3. The gap: what's missing to reach "always fresh on read, never thrash"

1. **Coverage**: `getFreshAnalysisForAgent` (or an equivalent gate) needs to run on every
   agent-entry tool, not just 8 of them — starting with `resolve_agent_analysis`, `get_summary`,
   `search_nodes`, `semantic_search`, and `get_coding_context`, since those are the ones the
   server's own instructions push agents toward.
2. **Granular staleness surface**: today staleness is all-or-nothing at the project level
   (`fresh | aging | stale`) — an agent working near file X has no way to know "only file X is
   stale" vs "everything is stale." `summarizeAnalysisFreshness` already computes the exact
   changed-file list (`files_changed_since_analysis.examples`, capped to 5) — that data exists
   but isn't surfaced per-node/per-file to the agent-entry tools, nor joined against the specific
   `target` an agent is asking about.
3. **Debounce/coalescing for entry-triggered refreshes**: `getFreshAnalysisForAgent` today has no
   in-flight-refresh dedup — if two tool calls land concurrently right after a large diff,
   `withGlobalAnalysisLock` will serialize them but the *second* call still pays for a check
   after the first one already fixed staleness (this is actually fine/cheap thanks to the lock +
   early-return-when-zero-changes path, but there's no explicit "someone's already refreshing,
   just wait" short-circuit, so it's implicit rather than deliberate).
4. **No staleness budget/SLA is declared or enforced.** There's no explicit contract like "no
   agent-entry response is older than N seconds of watched staleness" — it's currently
   check-on-every-call (fine) with no upper bound stated anywhere, and no metric emitted to prove
   it in practice.
5. **Watch mode is fully disconnected from the guarantee.** If it were used as the
   keep-warm mechanism, it should feed into the same freshness bookkeeping the entry-gate reads,
   so an actively-watched project can skip the git-scan (cheap as it is) entirely and trust the
   watcher's last-known-fresh timestamp.

---

## 1. Target invariant

> **On every agent-entry MCP tool call, the returned CAS reflects all committed and
> working-tree changes as of that call, at a bounded, incremental-only cost — and if a refresh
> is running, the agent is told what's still uncertain rather than either blocking indefinitely
> or silently serving stale data.**

Concretely:
- **Freshness guaranteed at read**, not advisory-only.
- **Cost bounded by changed-file count**, never a blanket full-repo re-walk on every call (the
  existing `ChangeDetector` + content-hash cache already delivers this — extend its reach, don't
  replace it).
- **No eager background re-analysis** unless the caller opted into `start_watch`.
- **Progressive serve**: deterministic structural facts return immediately per the existing
  `analyzeProjectDeferred` model (`analyzer.ts:761-821`) — AI enrichment lags in the background,
  never blocking the freshness gate.
- **Legible uncertainty**: when a refresh can't complete synchronously (e.g. full-rebuild
  triggered by a huge diff), the agent gets a structured "these N files/nodes are stale, here's
  what changed" answer instead of an opaque flag.

---

## 2. Design — extend existing pieces

### (a) Fast changed-file detector on every agent-entry tool

Reuse `summarizeAnalysisFreshness` (`freshness.ts:292`) as the gate — it's already the cheap
(92ms, git-diff based, 5s-memoized) check. Wrap it in a single shared entry point and widen
`getFreshAnalysisForAgent`'s caller list from 8 tools to all tools tagged as agent-entry in
`CORE_TOOL_NAMES` (`server.ts:118-131`) plus, at minimum: `resolve_agent_analysis`, `get_summary`,
`search_nodes`, `semantic_search`, `get_coding_context`, `get_system_overview`,
`get_architecture_context`. Longer term, every tool that calls `getAnalysis(path)` directly is a
candidate — but start with the ones in the documented onboarding sequence, since that's the path
every agent actually takes.

Mechanically: rename/generalize `getFreshAnalysisForAgent` → `getFreshAnalysis` (drop the
"ForAgent" framing since it should be the default, not a special agent-only path), and swap
`getAnalysis(path)` for `getFreshAnalysis(path)` at each of those call sites. Because the gate
itself calls `analyzeProjectIncremental` — already changed-file-only and cache-backed — this
doesn't change the cost model, only who benefits from it.

### (b) Incremental re-analysis of only changed files, content-hash-keyed (already exists)

No new work needed — `ChangeDetector.detectChanges` + `filterUnchangedGitChanges` +
`loadFileCache`/`saveFileCache` already deliver this. The one gap: `resolve_agent_analysis`'s
`agentProjectMap.resolveAgentAnalysis` currently computes `analysis_freshness` via
`summarizeAnalysisFreshness` for *display* but doesn't act on it — wire it to call
`getFreshAnalysis` before scoring candidates, so the freshness field it already returns is true
by construction rather than an FYI.

### (c) Surface which files/nodes are stale, not just "whole thing stale"

Extend `AnalysisFreshnessSummary` (`freshness.ts:106-114`) — already carries
`files_changed_since_analysis.examples` — to be consulted by `get_coding_context` when resolving
a `target`: if the target's file is in the changed-file set for *this* call (post-refresh, this
should be empty in the common case since (a) just fixed it, but during an in-progress
full-rebuild it may not be), attach a `may_be_stale: true` + reason to the specific node payload
rather than only a project-wide banner. This directly serves the user's ask: agents should know
exactly what's uncertain, not get an undifferentiated stale/fresh boolean.

### (d) Optional debounced background watcher to keep warm without thrash

`start_watch` (`watcher.ts`) already exists and already debounces (5s files, 250ms impact
preview). Two extensions, both additive:
1. When a watch session is active for a project, `getFreshAnalysis`'s gate should check
   `getWatchStatus(watchId).lastAnalysis` first — if the watcher fired within the debounce window
   and reports no pending changes, skip the git-scan entirely (the watcher's fs-event-driven view
   is already fresher than a git-diff poll). This turns "always fresh on read" from
   poll-per-call into push-then-trust when a watcher is running, without changing default (no
   watcher = poll-per-call, still cheap) behavior.
2. Do NOT make watch mode default-on. It stays opt-in per the CPU-thrash concern — but document
   it as the recommended mode for long agent sessions on large repos, since it amortizes the
   git-diff cost across many tool calls instead of re-polling each time (currently cheap at 92ms,
   but not free at scale/frequency).

### (e) Staleness budget / guarantee

Declare and enforce: **no agent-entry tool response is older than the time since the last
committed or working-tree change**, full stop — because the gate now runs synchronously before
every response. Emit a `freshness_checked_at` / `refresh_triggered: boolean` field on agent-entry
tool responses (most already carry an analogous `ai_enrichment` field for the progressive-serve
contract — mirror that pattern) so the guarantee is machine-verifiable, not just asserted in
docs. Add a bench (see below) that asserts this holds under a synthetic "many small edits between
calls" workload.

---

## 3. Implementation plan (ordered)

1. **`apps/mcp-server/src/server.ts`**: rename `getFreshAnalysisForAgent` → `getFreshAnalysis`
   (or keep the name, but drop the "only for special agent tools" framing in comments). Swap
   `getAnalysis(path)` → `getFreshAnalysis(path)` at the call sites for `resolve_agent_analysis`
   (via `agentProjectMap.resolveAgentAnalysis`, needs a `path`-refresh hook threaded in — see
   step 2), `get_summary`, `search_nodes` (lexical branch), `get_coding_context`,
   `get_system_overview`, `get_architecture_context`. Leave heavier/rarer tools (benchmarks,
   snapshots, cross-codebase) on `getAnalysis` for now — the priority is the documented
   onboarding sequence.
2. **`apps/mcp-server/src/agent-project-map.ts`**: `resolveAgentAnalysis` currently computes
   `analysis_freshness` for display (confirmed via `search_nodes` result
   `function_apps/mcp-server/src/agent-project-map.ts_resolveAgentAnalysis_1`) — add a refresh
   call before scoring so the returned candidates reflect current state, not just a warning about
   stale ones.
3. **`apps/mcp-server/src/freshness.ts`**: extend `AnalysisFreshnessSummary` with an optional
   `stale_node_hint` field keyed by file, computed cheaply from `files_changed_since_analysis`
   (already computed) — no new scan needed, just a shape change consumed by (4).
4. **`apps/mcp-server/src/query.ts`** (`getCodingContext`): when a resolved target's file appears
   in the current call's changed-file set (should be near-empty post-refresh; non-empty only
   under an in-progress full-rebuild scenario), attach `may_be_stale` + reason to the node in the
   response instead of only a project-level banner.
5. **`apps/mcp-server/src/watcher.ts`**: export a cheap `getLatestWatchFreshness(projectPath)`
   helper; wire it into the widened `getFreshAnalysis` gate from step 1 so an active watcher
   short-circuits the git-diff poll when its last-fired timestamp is within the debounce window
   and reports zero pending changes.
6. **Response contract**: add `freshness_checked_at` (ISO timestamp) to the JSON envelope
   `getFreshAnalysis`-gated tools already return, so the guarantee is observable per-call.
7. **Bench** (new, or extend `apps/mcp-server/src/incremental-benchmark.ts` /
   `gauntlet/incremental-gauntlet.ts`, both of which already exist for adjacent incremental-value
   proofs): a scenario that (i) analyzes a fixture repo, (ii) makes N small edits to M<<total
   files, (iii) calls each of the widened gate's tools, (iv) asserts every call reflects the edits
   (freshness_checked_at advances, changed content is visible) AND that wall-clock cost scales
   with M, not total repo size — i.e. prove "always fresh on read" and "changed-file-only cost"
   together, not just one or the other. `run_incremental_gauntlet` and
   `run_incremental_value_benchmark` MCP tools already exist as harness entry points to extend
   rather than build fresh.

---

## 4. What NOT to change

- Do not touch `ChangeDetector`, the content-hash file cache, or `withGlobalAnalysisLock` — they
  are correct and already deliver the changed-file-only cost model this spec targets.
- Do not make `start_watch` default-on. Keep it opt-in; wire it as an *optimization* for the
  entry-gate (step 5 above), not a requirement.
- Do not add a new staleness-scanning mechanism — `summarizeAnalysisFreshness`'s git-diff +
  bounded-mtime-verify approach (92ms on this repo) is already the right cost/precision
  trade-off; the fix is calling it (via the existing incremental path) from more places, not
  building a second one.

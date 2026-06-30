# Klauro Product Model (authoritative)

This is the canonical description of how Klauro behaves as a product. It supersedes
any "local vs remote mode" framing in older docs. If code or docs disagree with
this, this wins.

## One product, no modes

Klauro is one codebase-intelligence product. A customer:

1. Has an account at `app.klauro.com`.
2. Installs the Klauro CLI/MCP and authenticates.
3. Runs `klauro init` in a folder to connect it to Klauro (workspace or project).
4. Works normally; their agent (Claude/Codex) uses the Klauro MCP.

There is **no user-facing "local" vs "remote" mode.** `klauro analyze` is always
"the product": some work runs on the machine (light first-pass indexing), the heavy
parts and **all AI enrichment** run on the VPS, and the canonical analysis **always
lands on the VPS**. The customer never knows or chooses which part ran where — like
IntelliSense.

Consequences:
- **AI is part of the product and runs on the VPS.** If AI isn't working, the product
  isn't working. There is no "local AI." No customer machine needs an OpenAI/DeepInfra/
  Anthropic/Ollama key.
- The legacy `analyzer.mode: 'local' | 'remote'` config field and `--mode` flag are a
  defect being removed from the user surface. The in-process analyzer still exists —
  **the VPS runs it** — but it is not a customer choice. The only internal escapes are
  a self-hosted analyzer-server URL (dev) and graceful degradation when the VPS is
  unreachable (error handling, not a mode).

## Onboarding: both starts converge

- **Start local (no connected repo):** Klauro packages the whole folder (smart-ignore
  defaults built in) and processes it on the VPS.
- **Connect a repo first:** the VPS checks out everything and processes it.

Both end in the same state: `project + branch + commitSHA -> CAS/WAS analysis revision`.
The **only** thing a connected remote adds is automatic re-analysis on each push to the
selected branch. Inviting a teammate shares the same hosted context.

`klauro init` asks workspace or project; a workspace can link an existing one or create
a new one; it detects sub-git-repos / sub-project configs and offers to set up a
workspace with them as members; a workspace cannot contain another workspace.

## Shared context is commit-based

A signed-in CLI user who commits on the selected branch can submit that committed tree
to the hosted project, recorded as a project revision teammates can see (even before
they pull). Remote provider connection is automation + verification, not a different
kind of analysis. Uncommitted changes are never shared project truth — they are private
working-copy assistance (see in-flight below).

## The three analysis types

These define how everything is keyed and cached.

| Type | What | Cache key | Payload | Surfaced |
|---|---|---|---|---|
| **Main** | the project's configured branch (set in app.klauro.com) | `projectId + configuredBranch + commitSHA` | full analysis | yes — the UI truth |
| **Other branches** (committed) | other analyzed commits | `projectId + branch + commitSHA` | **light, diff-only** (just the differences), compressed | no (filterable in UI, hidden by default) |
| **In-flight** | committed-not-pushed AND uncommitted/dirty | `projectId + branch + baseCommitSHA + workingTreeContentHash` | overlay/delta | shareable to anyone on any branch |

- **Other branches** are tracked to detect merge issues, find duplicate concepts worth
  cherry-picking/merging, and provide broader context. They are promoted to a full
  analysis only when someone checks that branch out locally and starts working on it.
- **In-flight is the most powerful concept.** It is shareable to anyone working on any
  branch, so Klauro can eliminate merge conflicts entirely, prevent duplicate effort,
  and share learnings across active work. Sharing = the local CLI publishes the overlay
  to the VPS (opt-in); teammates pick it up through their normal read-through.

For agents, the MCP exposes three tracks: **Working** (your in-flight, private),
**Committed** (shared project truth), **Incoming** (analyzed commits from others/remote
you don't have yet — "you're on stale context / this overlaps incoming work").

## The local cache: `~/.klauro`, revision-keyed, never stale

The local cache lives in **`~/.klauro`** (global, hidden) — never in the repo. It is
invisible to the user, cannot be committed, survives `git clean`, and is shared across
checkouts of the same project. (The only Klauro things in the repo are config:
`.klaurorc` / `.klauroignore`.)

It is a **pure read-through cache over the VPS** (the single source of truth),
**content-addressed by revision identity per the table above** — NOT by resolved project
path (the path-keyed scheme is the one thing that can go stale). Compressed (brotli/zstd)
and bounded/pruned.

**Never out of sync is structural, not a sync job:**
- Committed (main/other) entries are immutable per SHA → a cache hit is provably current.
- In-flight entries are content-hashed → any edit changes the key → a stale entry can't match.
- Every lookup is therefore only ever a **correct hit** or a **miss → fetch from the VPS**.

## Keeping it fresh: adaptive read-through revalidation

Because the cache can't be *wrong*, only *behind*, the question is only *when to
revalidate*. The answer is **lazy read-through revalidation, hotness-adaptive** — never
a background poller, never a VPS→local push socket.

- **Revalidate on read** via a cheap conditional check: "latest analyzed SHA for
  `projectId + branch`?" (a SHA compare, 304-style, no payload). Match → serve cache;
  mismatch → fetch the delta.
- **Adaptive cadence by hotness.** `TTL = clamp(floor≈2s, f(timeSinceActivity), ceiling≈minutes)`.
  Activity (file edits, agent calls, local commits, teammate-push velocity) shrinks the
  interval; idleness grows it. Hot repos revalidate aggressively (cheap pings only);
  cold repos do nothing until the next read.
- **Per-operation freshness.** Cheap orientation reads (`get_summary`) trust the TTL;
  correctness-critical reads (`assess_change_risk`, `validate_change`, conflict checks)
  force a revalidate regardless of TTL.
- **Agent-driven.** The agent's own edits feed hotness; it also has an explicit `force`
  lever (a flag / small `sync` tool) for when it knows it needs current truth ("user
  pulled", "about to do a risky refactor").
- **In-flight** is recomputed on change: debounced file-watcher (~300–800ms after the
  last save), diff-only, content-hash-keyed.
- **Incoming awareness** rides the same cheap SHA check: "base = X, VPS latest = Y →
  you're N commits behind, here's what changed," surfaced in the agent status packet.

Guardrails: clamp the floor + dedupe concurrent checks (≤ ~1 ping/sec/project);
circuit-breaker to back off and serve cache (flagged "possibly behind") if the VPS is
slow/down. "Aggressive" always means more frequent *revalidation* (tiny), never more
frequent *re-analysis* (heavy work happens only on real change).

## Benchmarking (Camp A/B/C are competitor categories, not product modes)

To test "the product," the gauntlet's Klauro side must come from the deployed product
(analyze → VPS → `~/.klauro` cache → MCP serves it), never from an in-process engine
call. Agent tests run through the MCP in two modes: **injected** (pre-load context,
measure lift) and **autonomous** (agent has only the Klauro skill + MCP, watch whether
it adopts Klauro on its own). Competitors: tie-or-beat in Camp A (embeddings) and/or
Camp B (structural, incl. codebase-memory-mcp); **always win Camp C** (comprehension:
what is this / what it does / why it exists).

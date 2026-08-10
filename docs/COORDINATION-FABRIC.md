# The Coordination Fabric

Klauro's coordination fabric lets multiple agents (and humans) — same machine or across
machines — work the same codebase at the same time without silently colliding. It is the
first layer of Klauro's category thesis: Klauro as the coordination fabric / architectural
conscience for **fleets** of AI agents, not just a codebase-search tool for one agent at a
time. See [`SPEC-COORDINATION-FABRIC.md`](SPEC-COORDINATION-FABRIC.md) for the full builder
spec (architecture layers L1-L5, workstreams, sequencing); this document is the user/product-
facing summary of what exists today.

## The problem

Two or more agents (Claude Code, Cursor, Codex, a human, any mix) working the same repo hit
three hazards nothing in the filesystem or Git prevents:

1. **Duplicate work** — two agents independently build the same capability.
2. **Silent clobber** — two agents edit the same file; last write wins with no warning.
3. **Stale contracts** — agent A changes a DTO/route/entity shape mid-flight; agent B keeps
   building against the old shape because it never sees A's uncommitted diff.

Git and the filesystem carry no intent, no reasoning, no "peer is mid-edit," and no
arbitration. The coordination fabric adds that layer on top of Klauro's existing structural
understanding (CAS) and cross-repo understanding (the workspace-level CAS, composed via sub-CAS nodes).

## Two tiers, composed

- **Local tier (same-machine).** All agents on one host share a local, file-backed
  append-only claim/presence log at `~/.klauro/coordination/<workspace_id>/`, watched via
  filesystem events for sub-second local awareness with zero network round-trip. This is the
  common near-term case: one developer running Claude Code + Cursor + Codex, or several
  sessions, against one working tree. It is authoritative for same-machine peers.
- **Remote tier (cross-machine).** The hosted analyzer service exposes the same coordination
  primitives over HTTP so agents on different machines see each other's claims and presence.
  A claim writes to both tiers; reads merge the local active-set with the remote active-set.

MCP itself has no server-push transport (stdio has no way for the server to initiate a
message), so cross-tool awareness over MCP is poll-based: call `get_active_agents` /
`get_in_flight_changes` / `check_collision` again to see deltas. The HTTP layer additionally
offers a real push transport (`GET /v1/coordination/stream`, Server-Sent Events) for clients
that can hold a long-lived connection.

## The MCP tools

All registered in `apps/mcp-server/src/server.ts` under the "Multi-agent coordination" tool
group; full parameter/response reference in
[`mcp/TOOLS.md`](mcp/TOOLS.md#multi-agent-coordination).

| Tool | Purpose |
| --- | --- |
| `claim_work` | Announce intent to work on paths/symbols/a capability. Arbitrated against every other active claim: `granted` (disjoint, proceed), `duplicate` (another claim already covers this — adopt or defer), or `conflict` (path/symbol/blast-radius overlap — coordinate or rebase). |
| `check_collision` | Read-only preflight version of `claim_work` — same detectors, no claim taken. Use before deciding whether to claim at all. |
| `heartbeat_work` | Refresh a claim so it doesn't expire while work is in progress. |
| `release_work` | Mark a claim released (done or handed off), freeing its scope for others. |
| `get_active_agents` | Presence roster: who is currently active in the workspace and what they've claimed. |
| `get_in_flight_changes` | "Who is touching this path right now, and why" — attribution by claim/edit-lock, keyed off a specific file or directory. |
| `subscribe_workspace` | Arm local fs-event awareness for a workspace (same-machine only; MCP has no push, so this is poll-then-confirm, not a held subscription). |

The server's own onboarding instructions (`SERVER_INSTRUCTIONS` in `server.ts`) teach agents
to treat this as mandatory in shared workspaces: *before starting non-trivial work, call
`check_collision` or `claim_work`; on `duplicate`, adopt or defer instead of redoing the work;
on `conflict`, coordinate or rebase instead of silently overwriting; heartbeat while working;
release on completion or handoff.* Prevention only works if agents actually check in — a
write-side tool that nobody calls degrades to a nicer conflict reporter.

## Same-machine hazards this specifically addresses

Even though same-machine agents share a filesystem, the working tree alone tells them
nothing about intent:

- **Silent clobber is worse same-machine** (cross-machine agents are usually isolated on
  branches/clones; a shared working tree has no such isolation) — `claim_work` acts as a
  soft edit-lock other agents can see via `check_collision` before writing.
- **No change attribution in a shared tree** — the working tree doesn't record *who* made an
  uncommitted change or *why*; `get_in_flight_changes` answers that by mapping
  `agent_id ↔ touched_paths ↔ intent` from the local claim log.

## What runs the arbitration

`apps/mcp-server/src/coordination/arbiter.ts` computes overlap between a new claim and every
active claim: path-prefix intersection, symbol-set intersection, capability-name match against
the workspace-level CAS's `workspace_capabilities`, and blast-radius intersection via CAS call-graph edges. It
returns `granted`, `conflict` (with the colliding claim and evidence), or `duplicate` (with the
existing claim that already covers the same capability). `collision.ts` composes the same
signals into a full `CollisionReport` (duplicates, overlaps, in-flight contract drifts, and
cross-agent blast-radius intersections) for `check_collision`'s read-only preflight.

## Cross-machine HTTP surface

For agents on different machines (or any client that prefers HTTP over MCP), the hosted
analyzer service (`apps/mcp-server/src/remote-analyzer-service.ts`) exposes the same
coordination primitives:

| Route | Purpose |
| --- | --- |
| `POST /v1/coordination/claim` | Same semantics as `claim_work`. |
| `POST /v1/coordination/release` | Same semantics as `release_work`. |
| `POST /v1/coordination/heartbeat` | Same semantics as `heartbeat_work`. |
| `GET /v1/coordination/state?workspace=&since=` | Poll fallback: active claims (optionally since a sequence number) plus presence. |
| `GET /v1/coordination/stream?workspace=` | Server-Sent Events: an initial `state` snapshot, then live `claim`/`release`/`heartbeat`/`in-flight` deltas as they happen, with a periodic keep-alive comment. |
| `POST /v1/coordination/in-flight` | Publish an agent's latest uncommitted working-tree diff summary for the workspace so peers can see incoming, not-yet-committed work — tenant-gated and audited. |
| `POST /v1/telemetry/ingest` | Batch runtime telemetry ingestion (OTEL-compatible spans), correlated onto CAS and fused into operational-priority ranking. Not part of coordination proper, but lives on the same service and feeds the same "shared world model" thesis — see `docs/mcp/TELEMETRY-INGESTION.md`. |

Cross-machine in-flight publishing (`/v1/coordination/in-flight`) is gated by tenancy checks
(`assertSameTenant`) and an audit log, because it moves a summary of someone's unpushed code
off their machine — see `docs/SPEC-COORDINATION-FABRIC.md` §WS-F for the full security/privacy
posture (scope control via `.klauroignore`, tenancy/authz, at-rest and in-transit protection,
short TTL + purge on release).

## Current state (grounded against source, 2026-07-02)

- **Built:** the pure arbitration/collision core (`arbiter.ts`, `collision.ts`), the
  local file-backed claim/presence store with fs-watch (`local-store.ts`), the remote HTTP
  store (`remote-store.ts`), the security/tenancy gate (`security.ts`), all 7 MCP tools, and
  the full `/v1/coordination/*` + `/v1/telemetry/ingest` HTTP surface including the SSE
  stream. Test coverage: `coordination.test.ts`, `in-flight-sync.test.ts`,
  `local-store.test.ts`, `remote-store.test.ts`, `security.test.ts`,
  `coordination-sse.test.ts`.
- **Partial:** continuous in-flight working-tree publishing from a running agent session
  (`in-flight-sync.ts` exists; wiring it to fire automatically on every working-tree change
  from a live agent session, versus being invoked explicitly, is still maturing).
- **Not yet built:** telemetry fully fused into the live, always-on CAS stream (telemetry
  ingestion and correlation work today; continuous fusion into a stored, always-current graph
  is the remaining L3 gap — see `SPEC-COORDINATION-FABRIC.md` WS-A), and the recorded
  multi-agent no-collision demo (WS-DEMO).

## How a fleet uses it, end to end

1. Every agent in the workspace installs Klauro (see `docs/mcp/GETTING-STARTED.md`) and picks
   a stable `agent_id`.
2. Before starting non-trivial work, an agent calls `check_collision` (or goes straight to
   `claim_work` if it's confident it wants to commit to the work).
3. On `granted`, the agent proceeds and calls `heartbeat_work` periodically during long tasks.
4. On `duplicate`, it adopts the existing agent's work or defers instead of rebuilding it.
5. On `conflict`, it coordinates directly with the other agent (via `get_in_flight_changes` to
   see their intent and touched paths) or rebases its own plan before proceeding.
6. On completion or handoff, it calls `release_work` so the claim stops blocking others.
7. Any agent can call `get_active_agents` at any point to see the current presence roster for
   the workspace.

This is deliberately advisory-by-default: `claim_work` returns a verdict and the calling agent
decides what to do with it. The value only materializes if every agent in the fleet actually
calls in — that adoption is taught explicitly in the MCP server's own onboarding instructions,
not left implicit.

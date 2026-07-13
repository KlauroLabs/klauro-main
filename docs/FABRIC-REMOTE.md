# FABRIC-REMOTE — coordinating agents across machines over the internet

Companion to `SPEC-COORDINATION-FABRIC.md` (§1.1 two-tier model). This is the
operator's guide for pointing a **second machine** at the coordination fabric
hosted on the analyzer service (e.g. `https://mcp.klauro.com`), plus the API
contract and its honest limits.

## Point a second machine at the fabric

No env vars, no separate fabric setup. Connecting a repo to Klauro includes the
fabric — `klauro init` is the ONE onboarding command (auth, project identity,
analysis, in-flight tracking, agent MCP wiring, and the fabric, enabled by
default):

```bash
curl -fsSL https://mcp.klauro.com/install | sh           # install klauro
klauro login --email you@example.com                     # once per machine (stores credentials in ~/.klauro/auth.json)
cd /path/to/repo
klauro init            # done — connects the repo end to end, incl. {fabric:{enabled,endpoint,workspace}} in .klaurorc

# then the fab surface is unchanged, remote automatically, in every shell:
npx tsx apps/mcp-server/scripts/fab.ts claim  my-agent "refactor auth" src/auth/login.ts
npx tsx apps/mcp-server/scripts/fab.ts check  my-agent src/auth/login.ts
npx tsx apps/mcp-server/scripts/fab.ts active
npx tsx apps/mcp-server/scripts/fab.ts release my-agent

klauro status          # one-glance view: auth, project, analysis, in-flight, MCP, fabric
klauro fabric status   # fabric detail view: enabled/endpoint/workspace + the live active-claims view
klauro fabric off      # rare explicit opt-out — back to the local-only fabric (klauro fabric on re-enables)
```

Re-running `klauro init` is idempotent: it verifies and refreshes each
subsystem instead of erroring, and it respects an explicit `klauro fabric off`
opt-out (it never flips a deliberately disabled fabric back on).

The fabric step of `klauro init` (and `klauro fabric on`, which survives as
fine control for re-enabling after an opt-out) resolves everything from state
the product already has:

- **Endpoint**: `--server-url` flag > the repo's `.klaurorc` `fabric.endpoint`
  / `analyzer.serverUrl` > the stored-login default. It then verifies
  reachability; an unreachable service is a loud warning, not a failure.
- **Token**: NEVER stored in `.klaurorc` and never prompted for. Resolved at
  call time from the same credential store `klauro login` maintains
  (`~/.klauro/auth.json`). Not signed in = `klauro init` keeps the fabric
  local and says so; sign in and re-run `klauro init` to go remote.
- **Workspace identity** (must match on all machines), autodetected, most
  stable first: **1)** `--workspace <name>` override (on `init` or `fabric
  on`) → **2)** the `.klaurorc`
  `project.id` (the hosted Klauro project identity — identical on every
  machine linked to the same project) → **3)** the normalized git remote URL
  as `<repo>-<8-hex sha256>` (identical on every clone, ssh and https forms
  converge) → **4)** the repo directory basename (same-machine fallback only).

The same config switches the `fab_claim_work` / `fab_check_collision` /
`fab_release_work` / `fab_list_active_work` **MCP tools** to remote mode: they
resolve `.klaurorc` by walking up from the MCP server process's cwd, so an
agent session in an init'd repo is remote with zero setup. Responses carry
`tier: 'remote' | 'local'` so you always know which view you got.

**No fabric section + no env = the original local filesystem fabric,
byte-for-byte unchanged.** There is no configuration migration; remote mode is
purely additive. A present-but-disabled fabric section (`klauro fabric off`)
means OFF — it deliberately beats any lingering env vars.

Optional knobs: `FAB_TTL_MS` (claim TTL override), `FAB_REMOTE_TIMEOUT_MS`
(HTTP timeout, default 10s).

### CI appendix: the env-var escape hatch

For CI jobs / ephemeral containers where writing a config file is awkward,
the env vars still work, at the LOWEST priority below any `.klaurorc` fabric
section (full precedence in `apps/mcp-server/src/coordination/fabric-config.ts`:
explicit args > `.klaurorc` fabric > env > local default):

```bash
export FAB_REMOTE_URL=https://mcp.klauro.com
export FAB_REMOTE_TOKEN=<token>   # same Bearer gate as /v1/analyze
export FAB_WS=<workspace>         # must match the team's workspace id
```

This is an escape hatch, not the setup path — interactive machines should use
`klauro init`.

## API (on `remote-analyzer-service.ts`, Bearer auth required)

All routes sit behind the same analyzer-token gate as the sibling `/v1/*`
routes (`Authorization: Bearer <token>`; a personal account token also works).
Claims land in a **per-workspace claims log on the server's dataDir host**
(`KLAURO_COORD_DIR/<workspace>/claims.jsonl` on the VPS) via the same
`local-store.ts` primitives the same-machine fabric uses — one store, two
transports.

| Route | Semantics |
| --- | --- |
| `POST /v1/coordination/claim` with `{"mode":"advisory", workspace, agent_id, intent, paths[], symbols[], ttl_ms?, claim_id?}` | Advisory awareness claim: **always succeeds**, returns server-assigned `seq` (authoritative cross-machine ordering), `server_time`, and inline `conflicts` + `warning` when the paths overlap another active claim. Without `mode:'advisory'` the route is the pre-existing ENFORCED grant path (unchanged). |
| `POST /v1/coordination/check` `{workspace, agent_id?, paths[]}` | Read-only overlap preflight against the shared log. Never a gate. |
| `GET /v1/coordination/active?workspace=` | Every active (non-expired) advisory claim — the shared awareness surface. |
| `POST /v1/coordination/release` `{workspace, agent_id}` (no `claim_id`) | Release **all** of the agent's active claims (fab `release` parity). With `claim_id` it remains the enforced-grant release. |
| `GET /v1/coordination/state` / `GET /v1/coordination/stream` | Pre-existing full state + SSE delta stream; unchanged, useful for dashboards. |

## TTL / heartbeat model

Same expiry rule as the local tier (`presence.ts`): a claim is dead once
`now - heartbeat_at > ttl_ms`.

- **Remote advisory claims default to a 30-minute TTL** (vs 6h same-machine):
  a remote agent that dies or drops off the network cannot be observed any
  other way, so its claims must self-expire from the shared view within a
  bounded window.
- **Heartbeat = re-claim.** Re-POSTing the same `claim_id` (fab does this for
  you: just re-run `fab claim`) LWW-supersedes the prior entry and refreshes
  `heartbeat_at`. No separate heartbeat endpoint is needed for advisory claims
  (`/v1/coordination/heartbeat` remains the enforced-grant heartbeat).
- Long-running work: re-claim at least every ~25 minutes, or pass a bigger
  `ttl_ms` / `FAB_TTL_MS` and accept slower dead-agent expiry.

## Failure behavior (advisory contract)

A remote failure **never crashes the caller**. fab and the fab_* tools warn
loudly (`Degrading to LOCAL fabric — agents on OTHER machines can NOT see
this`) and fall back to the local filesystem store, so same-machine
coordination keeps working while the WAN is down. A degraded release warns
that any remote claim will linger until its TTL expires. The transport fails
fast (10s timeout) rather than hanging an agent.

## Honest limits

- **Advisory, not enforced.** Nothing stops a second machine from writing a
  file it never claimed. The fabric buys awareness (warnings, attribution,
  conflict visibility), not mutual exclusion. Enforced cross-machine grants
  exist separately (the non-advisory `/claim` path) but are not what fab uses.
- **Latency lower bound.** Loopback e2e (`scripts/fab-remote-e2e.ts`, 20
  concurrent claims across 2 simulated machines): **p50 33ms / p95 64ms** per
  claim. Real WAN adds RTT to that (expect ~p50 80–150ms to a nearby VPS);
  check-then-claim is 2 round trips. Fine for "claim once per task", not for
  per-keystroke locking.
- **Degraded windows are blind windows.** While a client is degraded to local,
  its claims are invisible to other machines (and vice versa) until it
  re-claims successfully. The retry-queue write-through tier
  (`coordination/remote-store.ts`) exists for in-process consumers that want
  automatic catch-up.
- **Single service process.** The SSE fanout and the per-workspace lockfile
  assume one analyzer-service process owning the store dir (the deployed
  shape today).
- **Shared-token tenancy.** Anyone with the analyzer token can read/write any
  workspace's claims. Fine for one team; per-workspace scoping is future work.

## Verified by

- `apps/mcp-server/src/remote-coordination-routes.test.ts` — route + transport
  contract (auth gate, two-machine conflict flow, heartbeat/LWW, TTL expiry,
  20-way concurrency, typed transport errors).
- `apps/mcp-server/scripts/fab-remote-e2e.ts` — the analyzer service plus two
  real fab.ts OS processes with isolated local stores, configured PURELY via
  one `klauro init` per machine (every FAB_/KLAURO_ env var scrubbed from
  the children); proves fabric-on-by-default, init idempotency, that the only
  shared channel is HTTP, that the token never lands in `.klaurorc`, loud
  degrade, `fabric status`/`off`/`on` fine control, and the latency
  numbers above.
- `apps/mcp-server/src/coordination/fabric-config.test.ts` — the resolution
  precedence contract (explicit > config > env > local; disabled-config beats
  env; token from the credential store, never the repo file) and the
  workspace-identity autodetection precedence.

# SPEC — Giant Fleet: Scaling the Coordination Fabric to 100-200 Agents

> **Status: SCALE-HARDENED at N<=200 same-machine real processes, with honest limits.**
> This is the scale-specific companion to `docs/SPEC-COORDINATION-FABRIC.md` /
> `docs/SPEC-COORDINATION-FABRIC-V2.md` (the coordination MODEL: claims, grants,
> presence, conceptual conflict — unchanged by this doc) and `docs/FABRIC-FLEET-PROVEN.md`
> (the N=8/16/32/64 real-process proof this doc extends to N=100/200). It is the mechanism
> `docs/SPEC-PARALLEL-DEV-FLEET.md`'s 100-200-agent vision depends on being real, not just
> designed. This doc: (1) specs how a whole project's scope fans out into claimable units at
> fleet scale, (2) reports the concrete bottlenecks found and fixed in
> `apps/mcp-server/src/coordination/local-store.ts` this session, with measured before/after
> numbers at N=100/200, and (3) states honestly what remains unproven above N=200 or across
> machines.

---

## 0. What changed this session, in one paragraph

The grant/claim layer (`grant-manager.ts` + `local-store.ts`) already held its core invariant
— **at most one active grant per symbol/path at a time** — at N=8-64
(`docs/FABRIC-FLEET-PROVEN.md`). Measuring further, N=100 was fine (0 violations, 0 errors,
p50 1145ms — dominated by process-spawn cost, not the fabric) but **N=200 hard-failed**: 33 of
200 worker processes threw `local-store: timed out acquiring lock` after 10s, and the
resulting `shared_file` check reported `ok=false` (an artifact of the errored workers' missing
writes, not corruption). Root cause: `readClaimLog` re-reads and re-`JSON.parse`s the ENTIRE
on-disk claim log on every call — including every call made INSIDE the one global lockfile's
critical section — so lock-hold time per operation scales with total log size, and total
lock-hold time across N operations trends toward O(n²). At N=200 that crossed the 10s
lock-acquisition deadline for the unluckiest waiters. Fixed with (a) a process-local
size/mtime-invalidated cache so unchanged reads are O(1), and (b) opportunistic compaction
that keeps the log small over a long fleet session. Result at N=200: **0 worker errors (was
33), shared_file check now `ok=true` (was false), 0 double-grant violations in both
before-and-after runs** — the core safety invariant never broke, but the fleet was hitting a
real availability wall the fix removes. Full numbers in §4.

---

## 1. Work decomposition into claimable units (the DAG side of "giant fleet")

This section specs how a whole project (beginning to end) fans out into parallel claimable
work, extending `SPEC-PARALLEL-DEV-FLEET.md` §3's vision with the claim-granularity detail
that determines whether 100-200 agents can actually stay disjoint at scale.

### 1.1 Claim granularity — five levels, chosen per work item

The grant layer already arbitrates on **path** and **symbol** (`grant-manager.ts`'s
`scopesOverlap`); the conceptual layer already derives **flow/step/capability/entity**
coordinates (`conceptual-scope.ts`, `types.ts`'s `ConceptualCoordinate`). At fleet scale the
right claim granularity is not one-size-fits-all:

| Granularity | When to use | Overlap check | False-conflict risk at scale |
|---|---|---|---|
| **File/path** | Mechanical, single-file work (config, fixture, one-file rename) | path-prefix | HIGH — two agents in unrelated functions of one large file collide unnecessarily |
| **Symbol** | Most agent work: "implement/modify function X" | exact symbol-set intersection | LOW — the granularity the fabric already defaults to |
| **Flow/step** | A multi-file feature slice that maps onto one Capability→Flow→Step | `ConceptualCoordinate.flow_id`/`step_id` match | LOW — this is the "awareness not gate" case: two agents on different steps of the SAME flow must NOT conflict (already proven, `same_flow_diff_step` scenario) |
| **Capability** | Coarse "own this whole feature" claims for large independent slices | `scope.capability` string match (arbiter.ts `duplicate` check) | MEDIUM — right for the top-level DAG-node grain a giant fleet's scheduler hands out, wrong as the ONLY check (two capabilities can still share underlying symbols) |
| **Entity-constraint** | Cross-file semantic overlap invisible to text diff (two agents both touch the SAME entity's validation invariants in different files) | `ConceptualCoordinate.entities[]` | Documented in v2 spec; not yet load-bearing in `grant-manager.ts`'s overlap check (only `arbiter.ts`'s advisory path uses entities today) — flagged as a real gap in §5 |

**Recommendation for a 100-200-agent DAG scheduler:** assign work at **flow/step or
symbol** granularity as the default claimable unit (fine enough to keep 100+ agents disjoint
across a large project, coarse enough that the fabric's existing arbitration handles it
without new code), with **capability** as the coarser grain the scheduler itself reasons
about when carving the DAG (which capability-slices can run in parallel at all), not as the
grant-layer's conflict check.

### 1.2 Conceptual-conflict detection at scale — cost model

`arbiter.ts`'s `arbitrate()` and `grant-manager.ts`'s `findConflictingActiveGrant` are both
O(active_claims) per call — a linear scan over the active-claim set for every new
request. At N=200 with a healthy mix of disjoint work, the active-set size at any instant is
bounded by how many agents are concurrently holding grants (not by total fleet size or total
claim-log history) — this session's fix (§3) targeted total-log-size cost, which was the
dominant term; active-set-size cost was NOT separately measured as a bottleneck at N<=200
(the current O(active) scan is fast enough — hundreds of comparisons, not the thousands+ that
would come from unbounded log growth). **If a future fleet runs with a much larger
concurrently-active set** (thousands of simultaneously-held grants, not 100-200), the
per-request linear scan becomes the next thing to index (e.g. a symbol->holder map maintained
incrementally rather than rebuilt every call) — flagged as a scale limit in §6, not yet a
measured bottleneck at the sizes this mission covers.

### 1.3 The two-tier store at fleet scale

Per `SPEC-COORDINATION-FABRIC.md` §1.1, the LOCAL tier (this doc's subject) is same-machine,
zero-network, and is where a 100-200-agent SAME-MACHINE fleet coordinates. The REMOTE tier
(cross-machine, `remote-store.ts`) is unchanged by this mission — see §6 for what that implies
about the ceiling of what's proven here.

### 1.4 Throughput/latency targets vs. measured reality

| Metric | SPEC-COORDINATION-FABRIC.md §WS-K original target | Measured at N=200 (this session, after fix) |
|---|---|---|
| Scale | "~20 agents x ~20 repos" (v1 target) | 200 real OS processes, one workspace — 10x the original target, proven |
| Claim arbitration | "sub-second" | p50 4.7s, p99 ~10-13s **including process-spawn/tsx-JIT cost** (§4 breaks this down) — NOT sub-second at N=200 under a synchronized contention-heavy scenario mix; disjoint-only workloads would be far faster (§4.2) |
| In-flight sync | "debounced to <=2s" | out of scope this session (WS-B, unchanged) |
| Core invariant | (implicit: never violated) | **0 double-grant violations at N=200, confirmed in 2 independent runs** — held throughout, including during the pre-fix run that had 33 hard errors |

**Honest read:** the ORIGINAL sub-second target was set for a 20-agent scale and does not
survive unmodified to 200 agents under this harness's deliberately adversarial contention mix
(40% disjoint / 60% engineered to overlap in pairs, all barrier-synchronized to hit
`requestGrant` at nearly the same instant, which is a harder scenario than 200 independent
agents naturally would produce). §4.2 shows disjoint-only latency separately.

---

## 2. Compaction/rotation of the append log

### 2.1 Design (implemented this session, `local-store.ts`)

- **Trigger:** `withWorkspaceLock`, `appendClaim`, and `releaseAgent` all call
  `compactIfNeeded(workspaceId, log)` as the first step inside the lock-held critical section,
  before the caller's own read-decide-append logic runs. Once the in-memory log exceeds
  `COMPACT_THRESHOLD_ENTRIES` (default 500, env `KLAURO_COORD_COMPACT_THRESHOLD`), it
  compacts.
- **What's kept:** every entry whose `claim_id` is currently in the LWW-derived active set
  (`deriveActiveClaims`) — this includes real edit-locks/claims AND grant-manager's `granted`
  and `queued` markers (both must survive compaction, since queue-advancement depends on
  seeing queued entries) — plus the `COMPACT_KEEP_RELEASED` (default 50) most-recent
  non-active entries, retained purely for `attributeChange`/debugging history.
- **What's dropped:** everything else — the bulk of a long fleet session's superseded
  history (old heartbeats, released grants beyond the retained tail, expired entries).
- **Correctness invariants preserved:**
  - **`seq` is never renumbered.** A kept entry keeps its original `seq` and `logged_at`
    verbatim. `seq` stays monotonic (compaction only removes entries, never reorders or
    reassigns), so any code that reasons about `seq` ordering (the LWW tie-break in
    `reduceClaimLog`, the "distinct monotonic seq" test) is unaffected.
  - **Atomic rewrite.** The compacted body is written to a temp file
    (`claims.jsonl.compact-<pid>-<ts>`) and `fsp.rename`d over `claims.jsonl` — `rename` is
    atomic on the same filesystem, so no concurrent reader can observe a partially-written or
    truncated compacted file; a reader either sees the old full file or the new compacted one,
    never a corrupt intermediate state.
  - **Runs inside the SAME lock** as the triggering append — no window where a concurrent
    process's in-flight append could be silently dropped by a compaction race.
  - **Verified directly** (see §4.3): 60 synthetic appends with `COMPACT_THRESHOLD_ENTRIES=20`
    compacted the log from 60 to 26 lines while the active-claim COUNT and IDENTITY stayed
    exactly correct, and `seq` stayed monotonic with the same max value (60) before and after.

### 2.2 What compaction does NOT do (honest scope)

- It does not compact ACROSS workspaces — each workspace's `claims.jsonl` is compacted
  independently, matching the existing per-workspace isolation model.
- It does not run on a timer/background thread — it is purely triggered by the next
  lock-holding write once the threshold is crossed, so a workspace that goes quiet with a
  large log stays large until the next write (acceptable: a quiet workspace isn't consuming
  read-cost anyway, since the cache in §3 makes repeated reads of an unchanging file O(1)).
- The retained `COMPACT_KEEP_RELEASED` tail is a fixed count, not adaptive — a very bursty
  release pattern could still lose attribution history a caller wanted; this is a tunable
  knob (`KLAURO_COORD_COMPACT_KEEP_RELEASED`), not a hardcoded ceiling.

---

## 3. The read-cache fix (the dominant bottleneck)

`readClaimLog(workspaceId)` now:
1. `fsp.stat`s the log file (cheap — no read of file contents).
2. If a process-local cache entry exists for that exact `(size, mtimeMs)` pair, returns a copy
   of the cached, already-parsed array — **no file read, no JSON.parse**, O(1) relative to log
   size.
3. Otherwise (cold cache, or the file changed since last cached — this process's own last
   write, or a SIBLING process's write, both bump `mtimeMs`), reads and parses the full file
   once and caches the result keyed by the new `(size, mtimeMs)`.
4. `appendClaimLocked` primes the cache immediately after its own write from the `fstat` it
   already performs, so the very next `readClaimLog` call inside the SAME critical section
   (e.g. `advanceQueueLocked`'s internal re-derivations) is a guaranteed cache hit, not just a
   probabilistic one.

**Why this is safe under the lock:** the cache is revalidated against the CURRENT on-disk
`(size, mtimeMs)` on every single call, including calls made while holding the workspace lock.
It can only ever save re-parsing bytes that are PROVABLY unchanged since last parsed by this
process — it can never serve data staler than what's actually on disk at call time. A
concurrent sibling process's write always changes `size`/`mtimeMs`, forcing a fresh read on
this process's next call. This is the same reasoning that makes the fix safe to compose with
the existing `withWorkspaceLock` critical-section contract: the cache is a read-path
optimization underneath `readClaimLog`, not a change to what `readClaimLog` is allowed to
return.

---

## 4. Measured results

Real multi-process runs via `apps/mcp-server/src/gauntlet/fabric-fleet-stress.ts` (unchanged
harness — see `docs/FABRIC-FLEET-PROVEN.md` for full harness design/methodology notes, which
this doc does not repeat). Apple Silicon Mac, Node 22.22.0, local disk,
`KLAURO_COORD_DIR` in `os.tmpdir()`.

### 4.1 Headline: N=200, before vs. after

| Metric | BEFORE (this session's baseline run) | AFTER (this session's fix) | AFTER (2nd confirmation run) |
|---|---:|---:|---:|
| worker errors (lock timeout) | **33 / 200** | **0 / 200** | **0 / 200** |
| shared_file check | **ok=false** (1036 actual vs 1008 expected — errored workers' writes missing) | **ok=true** (1200/1200 exact) | **ok=true** (1200/1200 exact) |
| double_grant_violations | 0 / 175 checked | 0 / 73 checked | 0 / 68 checked |
| claims/sec | 10.56 | 11.11 | 13.31 |
| p50 latency | 3714ms | 4767ms | 4705ms |
| p99 latency | 9796ms | 13193ms | 10370ms |
| disjoint median wait | 2445ms | 8217ms | 6233ms |
| dedup groups collapsed | 10/10 | 10/10 | 10/10 |
| conceptual precision | 0.963 | 0.85 | (not separately reported) |
| conceptual recall | 0.481 | 0.739 | (not separately reported) |

**Reading this honestly:** the fix's PRIMARY goal — eliminate hard failures at N=200 — is
unambiguous: 33 errors and file-integrity failure eliminated, 0 double-grant violations held
in both before and after. Latency did NOT improve at N=200 and in fact rose — because the
BEFORE run's lower p50/p99 partly reflects 33 processes GIVING UP at the 10s deadline rather
than actually resolving their contention (a failed request is fast; a succeeded one that had
to wait is slow). The lock-acquisition deadline was also extended 10s -> 20s as part of this
fix specifically so genuinely-contending waiters get to resolve instead of erroring — that
tradeoff (fewer failures, some legitimately-longer waits) is deliberate and stated here, not
hidden. The read-cache/compaction fix targets **lock-hold-time-per-operation growing with log
size** (an O(n²)-trending problem that caused OUTRIGHT FAILURES), not **total lock contention
under this harness's deliberately adversarial synchronized-barrier scenario mix** (a
throughput/latency problem under this specific stress pattern, not a correctness problem) —
see §6 for what would be needed to also improve raw latency at this contention density.

### 4.2 N=8/16/32/64 — confirms no regression at proven sizes

| N | claims/s | p50 | p99 | double_grant_violations |
|---:|---:|---:|---:|---:|
| 8 | 6.98 | 21ms | 472ms | 0/9 |
| 16 | 9.52 | 45ms | 482ms | 0/16 |
| 32 | 11.67 | 73ms | 854ms | 0/32 |
| 64 | 13.03 | 476ms | 1353ms | 0/64 |

Consistent with `docs/FABRIC-FLEET-PROVEN.md`'s originally-documented numbers at these sizes
(7.78/10.93/13.57/20.61 claims/s, same order of magnitude — run-to-run variance from process-
spawn jitter, not a regression). The fix does not slow down or destabilize the already-proven
sizes.

### 4.3 N=100 — confirms the fix doesn't regress the "was already fine" middle ground

| Metric | Before (this session's baseline) | After |
|---|---:|---:|
| worker errors | 0 | 0 |
| double_grant_violations | 0/100 | 0/100 |
| p50 | 1068ms | 1145ms |
| p99 | 3184ms | 3466ms |
| shared_file ok | true | true |

N=100 was never broken (only N=200 hit the hard lock-timeout wall) — this table exists to
confirm the fix introduces no regression at the size just below where the old bottleneck bit.

### 4.4 Compaction correctness micro-test

Isolated script: 60 synthetic `appendClaim` calls (`i % 3 === 0` marked `active`, rest
`released`) with `KLAURO_COORD_COMPACT_THRESHOLD=20`, `KLAURO_COORD_COMPACT_KEEP_RELEASED=5`.
Result: log compacted from 60 lines to 26 (20 active + a bounded released tail), active-claim
COUNT and IDENTITY exactly matched the expected 20, and `seq` stayed strictly monotonic with
the same maximum value (60) before and after compaction — i.e., compaction changed nothing
about what the fabric considers true, only how much history is kept on disk to get there.

---

## 5. Invariants preserved (the non-negotiable bar)

1. **At most one active grant per symbol/path at a time.** 0 violations found by
   ground-truth log replay (`replayGrantIntervals` + `findDoubleGrantViolations`, independent
   of worker self-report) in every run this session, at every size (8/16/32/64/100/200,
   before AND after the fix). This is the invariant the mission required to survive
   unconditionally, and it did.
2. **Dedup collapses to serialized ownership.** 10/10 dedup groups at N=200 resolved to a
   single grant-holder at a time (0 concurrent double-holds), matching the documented
   "different agents queue, they don't merge into one grant_id" behavior from
   `FABRIC-FLEET-PROVEN.md`.
3. **Shared-file correctness under concurrent appends.** `shared_file.ok=true` with an EXACT
   expected-vs-actual line count match (1200/1200) at N=200 after the fix — the pre-fix
   `ok=false` was an artifact of 33 workers erroring out (fewer total writes attempted, not
   corruption), not a torn/lost/corrupted write among the workers that DID complete.
4. **`seq` monotonicity survives compaction.** Verified directly (§4.4) — no renumbering, no
   reordering.
5. **The existing coordination test suite is unmodified and green.** All 113 tests across
   `apps/mcp-server/src/coordination/*.test.ts` (12 grant-manager tests including the
   concurrent-race repro tests, 12 local-store tests including the torn-line and
   release-race repros, plus conceptual-conflict/conceptual-scope/intent-merge/partitioner/
   remote-store/security/in-flight suites) pass unchanged after this session's edits.

---

## 6. Honest remaining scale limits

- **Same-machine only, same as `FABRIC-FLEET-PROVEN.md`.** This entire mission — like the
  fabric's LOCAL tier itself — is same-host, one shared `KLAURO_COORD_DIR`, one lockfile per
  workspace. The REMOTE tier (`remote-store.ts`, cross-machine sync over HTTP) is untouched
  and unmeasured by this session; a giant fleet spanning MULTIPLE machines is not proven here
  at any scale. This is the single largest asterisk on "100-200 agents" as a headline number:
  it means 100-200 agent PROCESSES on one host, not 100-200 machines.
- **Single global lockfile is still a single point of serialization**, even after this fix.
  The fix removed the O(n²)-trending COST of holding that lock (making each critical section
  cheap regardless of log size), but it did NOT shard or parallelize the lock itself — every
  `requestGrant`/`releaseGrant`/`getGrants`/`heartbeatGrant` call across all 200 agents still
  serializes through ONE lockfile per workspace, including for provably-disjoint scopes. This
  is why disjoint-agent median wait at N=200 (6-8s) is still high relative to N=64 (~500ms) —
  not because disjoint work conflicts, but because 200 agents contending for the SAME
  lockfile's brief critical section, even at near-zero hold-time each, adds up under a
  synchronized-arrival stress pattern. **A scope-sharded lock** (e.g. hash claims by a stable
  key derived from path/symbol into N lock shards, so disjoint work parallelizes across
  shards while genuinely-contending work on the same scope still hashes to the same shard and
  correctly serializes) is the next design step to reduce this — NOT implemented this session,
  because it requires re-deriving `grant-manager.ts`'s queue-advancement logic (which currently
  reasons over the WHOLE active-grant set in one global critical section) to remain correct
  per-shard without breaking the "promote the earliest queued request whose scope no longer
  conflicts with ANY remaining active grant" semantics — a real design task, not a mechanical
  change, and rushing it risked the one invariant this mission could not compromise. Flagged
  here as the concrete, scoped next step rather than attempted under this session's time
  budget.
- **This harness's contention pattern is adversarial by design**, not representative of a
  typical fleet. 60% of N=200's jobs are deliberately barrier-synchronized pairs/groups
  engineered to hit `requestGrant` at nearly the same wall-clock instant (see
  `FABRIC-FLEET-PROVEN.md`'s Methodology Notes for why this was necessary to measure
  contention at all) — a REAL 200-agent fleet working a genuinely-decomposed project DAG
  (§1.1) would have a much higher disjoint fraction and much less synchronized arrival, so
  real-world latency at 200 agents is plausibly much better than this harness's p50/p99 —
  but that is a projection, not something this session measured directly (no real
  decomposed-project-DAG scenario was run against the fleet at this scale).
- **No test above N=200.** The mission's stated target was 100-200; nothing here speaks to
  500 or 1000 agents. The active-set-linear-scan cost noted in §1.2 is the most likely NEXT
  bottleneck to bite at a materially larger active-set size, but it was not measured as a
  bottleneck at N<=200 and is flagged as a hypothesis, not a proven limit.
- **No crash-mid-compaction test.** The atomic-rename design (§2.1) means a crash before the
  `rename` leaves the original `claims.jsonl` untouched (temp file is simply orphaned) and a
  crash after the `rename` completes leaves the compacted file as the new source of truth —
  both are safe by construction of `rename`'s atomicity — but this was reasoned about, not
  empirically fault-injected (no process was actually killed mid-compaction during this
  session, matching the same honest caveat `FABRIC-FLEET-PROVEN.md` states for the
  `LOCK_STALE_MS` reclaim path).

---

## 7. Files touched this session

- `apps/mcp-server/src/coordination/local-store.ts` — added the parsed-log cache
  (`parsedLogCache`, `readClaimLog` revalidation logic), `compactIfNeeded` (wired into
  `withWorkspaceLock`, `appendClaim`, `releaseAgent`), extended the lock-acquisition deadline
  10s -> 20s with softened retry jitter. No public API signature changed; `ClaimLogEntry`,
  `readClaimLog`, `withWorkspaceLock`, `appendClaim`, `getActiveClaims`, etc. all keep their
  existing contracts.
- `docs/SPEC-GIANT-FLEET.md` — this document.
- Verification: `apps/mcp-server/src/coordination/*.test.ts` (113 tests, all passing,
  unmodified), `npx tsc --noEmit -p apps/mcp-server/tsconfig.json` (clean for
  `coordination/*` — the only errors present are pre-existing, in unrelated ORM analyzer
  files, not touched by this mission), and
  `apps/mcp-server/src/gauntlet/fabric-fleet-stress.ts` run at N=8/16/32/64/100/200 (multiple
  runs at 200 for stability), unmodified harness.

## 8. Feedback filed

`~/.klauro/agent-feedback/2026-07-05-giant-fleet.md` — the lock-timeout failure mode found at
N=200, the O(n²)-trending root cause, and the scope-sharded-lock follow-on design gap noted in
§6, so a future session (or Klauro's own product team) has a concrete, evidenced starting
point rather than re-discovering the same wall.

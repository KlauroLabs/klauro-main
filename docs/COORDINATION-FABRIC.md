# Fabric Collaboration

Fabric enables humans and agents to collaborate in realtime on any part of a software system, including the same file, function, contract, entity, flow, capability, or overlapping concept. Its organizing principle is shared semantic awareness and continuous reconciliation, not locks, collision avoidance, or serialized ownership.

The authoritative model is `docs/SPEC-COORDINATION-FABRIC-V3.md`.

## Why CAS is the collaboration substrate

Filesystem and Git state show changed text. They do not explain intent, conceptual overlap, downstream behavior, recreated concepts, or a contract another participant is changing but has not committed. Fabric represents each participant's in-flight work as an attributed semantic stream linked to CAS.

That makes overlap interpretable:

- Two participants may edit the same function for compatible reasons.
- Two participants may edit different files while recreating the same capability.
- A producer and consumer may change separate files while their shared contract diverges.
- A new implementation may duplicate knowledge or behavior that already exists in another in-flight stream.

Textual overlap is one signal among many. It is neither required for a conceptual conflict nor sufficient reason to stop work.

## Continuous participant-attributed CAS

Each in-flight stream records participant identity, intent, conceptual coordinates, affected paths and symbols, semantic deltas, contracts, provenance, sequence, and freshness. Local and remote stores preserve distinct participant streams even when they touch the same source object.

Reconciliation continuously compares baseline CAS, each participant's stream, and newly published deltas. Consumers can retrieve a current snapshot or subscribe to updates. The result is an always-updating shared understanding of what exists, what is changing, why it is changing, and where independently reasonable work is beginning to diverge.

## Claims are awareness, never locks

Claims announce intended work so peers can find relevant activity. They do not reserve a path, symbol, or concept and never block another participant from proceeding. A duplicate or overlap verdict is information: adopt shared knowledge, coordinate intent, or intentionally continue with both streams visible.

Heartbeats extend freshness. Release marks a stream complete or handed off. Neither operation grants exclusive ownership. APIs and clients must not turn a claim verdict into an authorization decision.

## What Fabric surfaces

Fabric reports:

- same-concept work in different files;
- different-concept work in the same file;
- recreated capabilities, flows, entities, contracts, and implementations;
- incompatible contract or invariant changes;
- relevant discoveries one participant has made that another is about to rediscover;
- semantic and behavioral divergence before completion;
- missing attribution or stale participant state;
- the reconciliation evidence needed to make integration mechanical.

The objective is not zero overlap. The objective is zero surprise, zero lost work, minimal duplicated effort, and steadily fewer discretionary merge decisions.

## Local and remote operation

The local store provides low-latency awareness between processes on one machine. The remote store publishes the same semantic model across machines with tenant and workspace authorization. Server-Sent Events provide continuous remote updates; polling remains available for clients whose transport cannot receive push messages.

Remote state includes redacted semantic deltas rather than unrestricted source transfer. Source policy, tenancy, retention, and audit boundaries apply before publication.

## Product surfaces

The MCP and HTTP surfaces expose operations for publishing and extending claims, heartbeats, releases, participant state, in-flight semantic streams, overlap and divergence reports, and workspace subscriptions. Tool names preserve compatibility where required, but their semantics follow the V3 model: advisory awareness and reconciliation, never collision enforcement.

The installed client participates in Fabric after `klauro init` binds a workspace. Re-running initialization is idempotent. If remote authorization is unavailable, local collaboration remains explicit and the client reports that remote awareness is unavailable rather than pretending the workspace is synchronized.

## Metrics

Fabric records cumulative metrics that reflect collaboration quality:

- participant and stream attribution coverage;
- reconciliation latency and rounds;
- duplicate and recreation detections;
- contract divergence detections;
- merge-decision count;
- surprise count and rate;
- lost or unattributed changes.

A run with no blocked work is not automatically successful. A run is successful when participants retain their distinct work, relevant knowledge arrives before rediscovery, disagreements are visible early, and final integration requires no surprising human judgment.

## Verification

Focused tests prove same-symbol overlap retains both attributed streams, same-concept/different-file and same-file/different-concept cases remain distinct, remote claim extension works, SSE carries continuous semantic updates, and cumulative metrics survive reconciliation rounds. Fleet proofs exercise mixed human and agent participants under concurrent mutation budgets.

External beta still requires sustained multi-process and cross-machine VPS endurance with no lost work, no attribution gaps, explicit latency budgets, and a complete metric report. `docs/PRODUCT-READINESS.md` owns that acceptance requirement.

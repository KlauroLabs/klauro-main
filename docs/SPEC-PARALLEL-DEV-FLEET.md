# Parallel Development Fleet

The active fleet model is defined by
[Coordination Fabric v3](./SPEC-COORDINATION-FABRIC-V3.md) and the
[Coordination Engine](./SPEC-COORDINATION-ENGINE.md).

Parallel work is the default, including multiple participants working on the same semantic unit.
Planning groups describe relationships and shared context; they do not assign ownership, create
waves, or serialize execution. Acceptance is measured by useful concurrency, retained attributed
streams, knowledge propagation, duplicate-work rate, rework, merge decisions, and surprise—not
collisions prevented.

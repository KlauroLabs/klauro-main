# Fabric Conceptual Proof

The executable proof uses real flow and step identifiers from Klauro’s cached analysis. Run it from
`apps/mcp-server` with:

```bash
npm run fabric-fleet-proof
```

It verifies six properties:

1. Paths and symbols derive conceptual coordinates only when real CAS evidence exists.
2. Participants on different steps of one flow remain active and receive shared flow context.
3. Same-step and cross-flow shared-entity relationships are surfaced even when textual scope differs.
4. Duplicate intent is detected while both attributed streams remain active.
5. Conceptual groups share relevant context without prescribing ownership, routing, or execution order.
6. Conceptual Fabric exposes relationships that file and symbol comparison alone cannot see.

The proof exits nonzero if any property fails. It uses an isolated coordination directory and does not
mutate a user’s Fabric state. Declared entities remain necessary when CAS lacks evidence to derive an
entity coordinate; the proof reports that limitation rather than fabricating one.

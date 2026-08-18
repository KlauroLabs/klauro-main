# Terminality and Capability Absorption

This document replaces the August 2026 investigation that predated recursive parent comprehension. That investigation correctly identified the product rule but incorrectly described the product surface as absent after the implementation landed.

## Current rule

Terminality is a domain-neutral relational signal across entities, flows, capabilities, and recursive CAS nodes. A terminal element has no downstream dependency in the relevant graph. A proximal-terminal element is near that boundary. Those positions help identify what the analyzed system was built to accomplish.

Supporting prerequisites are not product purpose merely because many flows depend on them. Authentication is ordinarily upstream support and should not dominate a product application's purpose. In a system built to provide authentication, auth flows and capabilities become terminal and therefore correctly rank as purpose.

At a parent CAS level, child capabilities are not blindly unioned. Parent comprehension is re-derived from child facts, direct-child seams, dependency direction, terminality, and evidence. A supporting child's behavior can be absorbed into the product behavior that consumes it while remaining visible and valid within the supporting child CAS.

## Required proof

- An ordinary product fixture where authentication is prerequisite and non-terminal.
- An authentication-product fixture where authentication is terminal.
- Entity, flow, capability, and recursive-CAS dependency graphs.
- Contradictory evidence that terminality cannot override.
- Provenance from every parent capability to its child facts and seams.
- No repository names, customer names, or domain allowlists in production inference.

The executable acceptance contract is `TERM-1`, `TERM-2`, and `CAS-4` in `docs/PRODUCT-READINESS.md`. Historical black-box observations remain useful evidence in Git history but are not current-state documentation.

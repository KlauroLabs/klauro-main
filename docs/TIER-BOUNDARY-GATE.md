# Tier-boundary gate

**Status:** live, enforcing. Implements the dependency rule from
`SPEC-ABSTRACTION-TIERS.md` ("a tier may never consume a tier above it") as
an automated test, not just a doctrine.

## What it is

`packages/analyzer-core/src/__tests__/architecture/tier-boundary.test.ts`
classifies every analyzer-core production module and rejects an unregistered
module, a missing module, or a lower-tier import of a higher tier. It reads
source imports directly and runs in the normal analyzer test suite.

`apps/mcp-server/src/mcp-tier-boundary.test.ts` enforces the package-level
continuation of the same rule. Analysis modules cannot consume telemetry or
Fabric, and telemetry cannot consume Fabric. Every production module under the
coordination directory is discovered automatically.

Why a test instead of `dependency-cruiser` or an ESLint
`no-restricted-imports` rule: neither was already wired into this package
(`analyzer-core`'s `package.json` has no `eslint`/`dependency-cruiser`
devDependency, confirmed by a direct grep before choosing this route), and
adding a new lint toolchain mid-decomposition, while multiple lanes are
actively editing `orchestrator.ts` and the surrounding files, is exactly the
kind of large, unrelated-to-the-diff change task #121 was told not to make.
A ~100-line test using only `fs`/`path` (already a project dependency of
everything) gets the same enforcement with zero new dependencies and zero
config-file surface for a concurrent edit to collide with. If the project
later adopts `dependency-cruiser` project-wide, `TIER_REGISTRY` in the test
file translates directly into its `from`/`to` rules — this is not a dead
end, just the lowest-friction version of the same rule today.

The analyzer-core registry is exhaustive rather than opt-in. A new production
module must be assigned a tier in the same change that creates it. The MCP gate
uses explicit boundary-entry modules plus automatic discovery for Fabric's
coordination package.

## Proof it fails on a real violation

Verified by hand during task #121: a one-line import of a tier-3 file
(`capability-detector.ts`) was temporarily added to the tier-2
`system-type.ts`, the gate was re-run, and it failed with:

```
system-type.ts (tier 2) imports capability-detector.ts (tier 3)
```

The line was then reverted and the gate returned to green. This was not
committed — see the task report for the exact commands.

## How to register a newly extracted file

1. Extract the file along a tier boundary (tier 1 = index/graph/ICELOT,
   tier 2 = framework/architecture/library, tier 3 = comprehension
   (capabilities/flows/steps/entities), tier 4 = telemetry attachment).
2. Add `'your-new-file.ts': N` to `TIER_REGISTRY` in
   `tier-boundary.test.ts`, in the same commit as the extraction.
3. Run `npx jest src/__tests__/architecture/tier-boundary.test.ts` (scoped —
   do not run the full `analyzer:test`/`mcp:test` suite on this machine per
   the repo's local-load constraint).

The boundary gate checks dependency direction. Semantic purity, completeness,
and performance remain separate readiness gates.

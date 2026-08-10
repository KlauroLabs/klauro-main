# Tier-boundary gate

**Status:** live, enforcing. Implements the dependency rule from
`SPEC-ABSTRACTION-TIERS.md` ("a tier may never consume a tier above it") as
an automated test, not just a doctrine.

## What it is

`packages/analyzer-core/src/__tests__/architecture/tier-boundary.test.ts`
maintains a hand-registered map of extracted files to their tier (1-4) and
asserts, for each registered file, that none of its own relative imports
resolve to a registered file in a higher tier. It reads source text off
disk directly (no bundler) and is part of the normal `analyzer:test` run —
no separate command, no separate CI step to remember.

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

## Why hand-registered, not glob-based

`orchestrator.ts` itself still holds tier-1/2/3 logic undifferentiated —
that is the entire premise of task #121. A glob over
`packages/analyzer-core/src/analyzer/core/*.ts` would have to either tier
`orchestrator.ts` as something (wrong on every axis — it is currently all
four tiers at once) or hard-code an exclusion for it, which is more fragile
than an explicit allowlist. The registry is deliberately opt-in: a file
extracted along a tier boundary gets added to `TIER_REGISTRY` in the SAME
commit as its extraction. Until a file is registered, the gate has no
opinion about it — this is intentional; it means the gate's coverage grows
exactly as fast as the decomposition itself, and never gives a false sense
of completeness.

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

## Known gap

Tier 4 (telemetry attachment) lives in `apps/mcp-server`
(`telemetry-fusion.ts`, `telemetry-ingestion.ts`, `self-telemetry.ts`), a
separate npm package from `analyzer-core`. Cross-package import direction is
already structurally one-way (`apps/mcp-server` depends on `analyzer-core`,
never the reverse), so `analyzer-core`'s tiers 1-3 cannot import
`apps/mcp-server`'s tier-4 files even by accident — the risky direction this
gate exists to catch cannot occur across that particular package boundary.
An equivalent registry-based test scoped to `apps/mcp-server/src` (checking
that files feeding tier 1-3 CAS assembly there don't reach into telemetry
attachment code) has not been built yet; see the task #121 report for the
remaining decomposition plan.

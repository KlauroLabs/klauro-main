# Analysis Scope Versioning and Compatibility Policy

This document defines how `scope_version` works, which stored analyses a
server accepts, and what customers should expect when they upgrade Klauro
while holding analyses produced under CAS/WAS/DAS or an earlier Analysis
Scope minor line. It follows the same MAJOR.MINOR.PATCH discipline as
`docs/cas/VERSIONING.md`, which this document supersedes.

## The policy

`scope_version` is semver-ish: `MAJOR.MINOR.PATCH`.

- **MAJOR** changes mean the scope shape is not readable across the
  boundary. A server never reads an analysis from a different major line
  without an explicit migration path (§ "Migration lines" below).
- **MINOR** changes add optional fields. Every field addition to
  `AnalysisScope` or any tier payload MUST bump the minor version in the
  same change. Readers treat missing optional fields as "this analysis
  predates the field," keyed off the stored version.
- **PATCH** changes fix content quality without changing shape.

The current version is `2.0.0`.

## Migration lines

`2.0.0` is a MAJOR bump from three predecessor lines, each read through the
compatibility mapping in `docs/analysis-scope/SPECIFICATION.md` §12 rather
than rejected outright:

- CAS `1.x` (floor `1.6.0`, per the prior `MINIMUM_COMPATIBLE_CAS_VERSION`)
  reads as a single leaf `AnalysisScope`.
- WAS `1.0.0` reads as a non-leaf `AnalysisScope` composing its member
  projects' CAS-derived scopes.
- DAS `1.0.0` units read as leaf scopes nested under their owning CAS-derived
  scope.

A server MUST classify a stored pre-2.0.0 analysis at load time exactly as
`docs/cas/VERSIONING.md` describes for `cas_version` (`current` /
`older-compatible` / `newer-compatible` / `unsupported` / `newer-major`),
substituting "reads as a 2.0.0-line scope via §12" for "reads directly" at
every step below the 2.0.0 boundary. The CAS 1.6.0 floor, and its rationale
(no supported deployment ever held a pre-1.6.0 analysis), carries forward
unchanged as the floor for the nested CAS-derived scope's own minimum.

## What tools must do on a migrated analysis

- Every tool reading scope content MUST report `scope_version` and, for a
  migrated pre-2.0.0 analysis, an `analysis_version_notice` stating which
  legacy spec (CAS/WAS/DAS) produced the underlying data and that it is
  being read through the §12 compatibility mapping — not silently presented
  as native 2.0.0 output.
- A tool that reads a 2.0.0-only field (a gap-register field from §16 of the
  specification, once implemented, or `composition_mode`) against a migrated
  analysis MUST degrade with an explicit notice, never silent emptiness,
  matching the existing pillar-field degradation behavior in
  `docs/cas/VERSIONING.md`.
- `analyze_codebase` (or its 2.0.0-line successor) MUST report a
  `version_upgrade: { from, to, note }` block whenever it re-analyzes a
  scope whose stored version predates 2.0.0, including the CAS/WAS/DAS
  line the prior analysis was produced under.
- Re-analysis under 2.0.0 forces a full rebuild exactly as a `cas_version`
  mismatch already forces one under `docs/cas/VERSIONING.md`; there is no
  partial-upgrade state.

## Version history

| Version | Line | Added |
| --- | --- | --- |
| CAS 1.0.0 - 1.11.0 | predecessor | See `docs/cas/VERSIONING.md` for the full per-minor history. |
| WAS 1.0.0 | predecessor | Single release; see `docs/was/SPECIFICATION.md`. |
| DAS 1.0.0 | predecessor | Single release; see `docs/das/SPECIFICATION.md`. |
| 2.0.0 | Analysis Scope | Root shape becomes a recursive `AnalysisScope` tree, replacing three separate root shapes (`CASOutput`, `WorkspaceAnalysis`, `DasUnitSlice`). No field-level content changed incompatibly within a tier; every CAS/WAS/DAS field maps onto a tier payload per `docs/analysis-scope/SPECIFICATION.md` §12.3. `scope_type` enum was considered and rejected in favor of derived properties (`has_children`, leaf, source-backed, ship-backed) — see specification §4.2. |

The per-field rule going forward is unchanged from the CAS policy: adding a
field to any tier payload without bumping `scope_version` in the same change
is a policy violation.

## Verification

Verification for the 2.0.0 line is pending implementation of the recursive
`AnalysisScope` structure (`docs/analysis-scope/SPECIFICATION.md` §12.1
states this status explicitly). The CAS-line precedent this policy follows
(`version-compat.test.ts`, the `version-skew` nightly-eval suite) is the
model a 2.0.0 implementation MUST extend, not replace, so that a stored
CAS/WAS/DAS analysis keeps passing the same class of compatibility test
under its new scope-shaped read path.

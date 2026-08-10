# CAS Versioning and Compatibility Policy

This document defines how `cas_version` works, which stored analyses the MCP server accepts, and what customers should expect when they upgrade Klauro while holding analyses produced by an older version.

Status: implemented. Everything described under "The policy" and "Upgrade semantics" is enforced in code (`apps/mcp-server/src/storage.ts`, `query.ts`, `server.ts`, `analyzer.ts`) and verified by `apps/mcp-server/src/version-compat.test.ts` and the `version-skew` suite in the nightly eval.

## The policy

`cas_version` is semver-ish: `MAJOR.MINOR.PATCH`.

- **MAJOR** changes mean the CAS shape is not readable across the boundary. A server never reads an analysis from a different major line.
- **MINOR** changes add optional fields. Every field addition to `CASOutput` must bump the minor version in the same change. Readers treat missing optional fields as "this analysis predates the field", keyed off the stored version.
- **PATCH** changes fix content quality without changing shape.

The current version is `CAS_VERSION` in `packages/analyzer-core/src/types/cas.types.ts` (currently `2.0.0`).

### 2.0.0 — the recursive CAS, no compatibility path

`2.0.0` collapses the three previously separate specifications (CAS, the Workspace Analysis Specification, the Deployable Analysis Specification) into one recursive structure — see `docs/cas/SPECIFICATION.md` §0. This is treated as an ordinary MAJOR bump under the policy above: a stored `1.x` analysis is `unsupported`/older-major and every tool returns the standard re-analysis instruction. There is no migration mapping, no dual-read of the renamed `das_index` -> `sub_cas_nodes` field, and no special-cased handling of pre-2.0.0 analyses beyond what this table already does for any major-version change. Re-analysis is the only path forward for a stored 1.x analysis.

### Minimum-compatible floor

`MINIMUM_COMPATIBLE_CAS_VERSION` (in `apps/mcp-server/src/storage.ts`) is **1.6.0**. Analyses older than the floor predate the test, intent, change-risk, and security structures that the agent workflow tools assume; no supported customer deployment ever held a pre-1.6.0 analysis, so the server rejects them outright with a re-analysis instruction rather than degrading.

A stored analysis is classified at load time as one of:

| Status | Meaning | Behavior |
| --- | --- | --- |
| `current` | Same version as the server | Full behavior |
| `older-compatible` | Same major, older minor/patch, at or above the floor | Tools work; fields added after the stored version surface an `analysis_version_notice` |
| `newer-compatible` | Same major, newer minor/patch | Readable; unknown fields are ignored |
| `unsupported` | Below the floor, older major, or missing/unparseable version | Every tool returns a clear error: re-run `analyze_codebase` |
| `newer-major` | Newer major than the server | Every tool returns a clear error: upgrade the server or re-analyze |

### How tools behave on older analyses

- `loadAnalysis` tags every loaded analysis with its version classification (non-enumerable `analysis_version_info`; it is never written back to disk). The analysis index also records `cas_version` per project.
- `get_summary` always reports `cas_version`, `analysis_version_status`, and a notice when the analysis is older than the server.
- Tools that read fields added after the stored version **degrade with an explicit notice**, never silent emptiness. `get_user_journeys`, `get_paradigm_conformance`, and `get_data_lineage` on a pre-pillar analysis return empty data plus `analysis_version_notice` ("this analysis predates X; re-run analyze_codebase"). On a current analysis with genuinely no data, there is no notice.
- `get_product_map` keeps its on-demand fallback (`buildProductMap`) for analyses that predate the stored map, and says so in a notice (including in markdown output).
- `diff_behavior` flags a baseline snapshot that predates the behavior pillars, so journey/lineage "added" counts are not misread as code changes.
- Tools that cannot degrade (any tool on an `unsupported` or `newer-major` analysis) return a single clear instruction via the standard tool error path. Nothing throws past the MCP error boundary.

### Upgrade semantics

- `analyze_codebase` reports a `version_upgrade: { from, to, note }` block whenever it re-analyzes a project whose stored analysis was produced by a different `cas_version` (including indexes recorded before versions were tracked, reported as `from: "unknown"`).
- The incremental analyzer already forces a **full rebuild** whenever the stored `cas_version` differs from the server's (`packages/analyzer-core/src/analyzer/core/orchestrator.ts`), so an upgrade re-run always populates all fields of the new version; there is no partial upgrade state.
- Snapshots keep the version they were written with. Behavior diffs across a version boundary carry the notice described above.

## Version history

What each minor version added to `CASOutput`. RFPs live next to this file.

| Version | Added |
| --- | --- |
| 1.0.0 | Core graph: system, nodes, edges, entry/exit points, analyzer contributions |
| 1.1.0 | Perspectives, tags, runtime correlation metadata, external services, cross-repository links, progressive disclosure |
| 1.2.0 | Component analysis additions (see addendum) |
| 1.3.0 | Call graph: `method_calls`, `call_chains`, `decorators` |
| 1.4.0 | Documentation and health: `documentation_summary`, `todos_summary`, `implementation_health`, `system_health` |
| 1.5.0 | Class relationships and pattern analysis |
| 1.6.0 | Test architecture: `test_suites`, `mocks`, `fixtures`, `test_summary` — **compatibility floor** |
| 1.7.0 | Inference intelligence: `intents`, `change_risks`, `data_entities`, `behavioral_invariants`, `security_boundaries`, `flow_coverage`, `temporal_stability`, capabilities/purpose |
| 1.8.0 | Incremental analysis state and change history |
| 1.9.0 | Codebase idiom intelligence: `codebase_idioms`, `idiom_summary`, `idiom_examples`, `idiom_violations` |
| 1.10.0 | Graph-anchored semantic retrieval (`embedding_index`). **Honesty note:** the 1.10.0 line also accumulated, without intermediate version bumps: the behavior pillars (`user_journeys`, `user_journey_summary`, `data_lineage`, `paradigm_conformance`, `product_map`), idiom `provenance`, `secondary_domains` on enhanced system purpose, and the `tenant-isolation`/`rate-limiting` security boundary types. A stored "1.10.0" analysis therefore may or may not contain the pillar fields. |
| 1.11.0 | No new fields. Versioning-policy release: the first version at which every 1.10.0-line field above is guaranteed present when the underlying data exists. Version notices for the pillars key off 1.11.0 (`PILLAR_ATTESTED_CAS_VERSION`) precisely because 1.10.0 is ambiguous. |
| 2.0.0 | MAJOR, breaking. Recursive CAS structure (`docs/cas/SPECIFICATION.md` §0): a CAS MAY have child CAS nodes (`sub_cas_nodes`) to any depth. `das_index` renamed to `sub_cas_nodes` — no alias. Inter-sub-CAS-node communication seams (`seams`, §0.8) specified explicitly across the recursion. No `scope_type`/`analysis_kind` discriminant anywhere. No compatibility path from 1.x. |

The per-field rule going forward: adding a field to `CASOutput` without bumping `CAS_VERSION` in the same change is a policy violation; the 1.10.0 ambiguity above is the cost it avoids.

## Verification

- `npm --prefix apps/mcp-server test` includes `version-compat.test.ts`: a synthesized pre-pillar (1.9.0) analysis run through core and pillar tools, floor rejection, index/version tagging, and the pre-pillar `diff_behavior` baseline notice.
- `npm --prefix apps/mcp-server run nightly-eval` includes the `version-skew` suite so a regression in any of these behaviors fails the nightly scorecard.

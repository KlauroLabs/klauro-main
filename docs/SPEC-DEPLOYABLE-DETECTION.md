# SPEC: Evidence-Based Deployable Detection

> **Status: IMPLEMENTED** as of commit `658e8990` (2026-07-02). The evidence
> collector, resolver, and fixture bench described below are built and live in
> `apps/mcp-server/src/cross-codebase-analysis.ts` +
> `packages/analyzer-core/src/analyzer/core/deployable-evidence/`. This section
> reflects the code as read this session, not the original build plan — treat
> §1-§7 as the current design, not an in-progress proposal. Known resolver gaps
> that shipped alongside this (from `658e8990`'s own commit message) are called
> out in §9.

## 1. Problem

Klauro's workspace/cross-codebase layer currently decides which parts of a
repository are independently-deployable "applications" using a folder-name
regex classifier. The function is `applicationSurfaceFromFile` in
`apps/mcp-server/src/cross-codebase-analysis.ts` (current implementation,
~line 9689):

```ts
function applicationSurfaceFromFile(file: string | undefined): { name: string; pathHint: string; deployableHint: boolean } | undefined {
  const patterns: Array<{ regex: RegExp; deployable: boolean }> = [
    { regex: /^(apps\/[^/]+)/, deployable: true },
    { regex: /^(services\/[^/]+)/, deployable: true },
    { regex: /^(cmd\/[^/]+)/, deployable: true },
    { regex: /^(bin\/[^/]+)/, deployable: true },
    { regex: /^(packages\/[^/]+)/, deployable: false },
    { regex: /^(crates\/[^/]+)/, deployable: false },
    { regex: /^(libs\/[^/]+\/(?!src|lib|test|tests|dist|build|__tests__)[^/]+)/, deployable: false },
    { regex: /^(libs\/[^/]+)/, deployable: false },
  ];
  // ...
}
```

Every subfolder under `apps/` or `services/` (or `cmd/`, `bin/`) is assumed
deployable; every subfolder under `packages/`, `crates/`, `libs/` is assumed
not. This is a hardcoded categorizer of the exact shape Klauro already ripped
out of domain detection (see `klauro-deterministic-facts-plus-ai` memory:
"CARDINAL RULE: deterministic structural facts + AI interpretation, NEVER
hardcoded brand/keyword categorizer"). Folder convention is a naming
convention, not evidence of ship/run behavior. It fails in both directions:

- **False splits.** A folder-per-binary layout produces N "deployables" when
  the real ship unit is 1. Motivating shape: a Rust multi-binary workspace —
  8 Rust `[[bin]]` crates under `crates/*` and `apps/*`, but only 1-2 real
  deployables: a single installer script bundles a `client` binary and a
  `client-service` binary together into one shipped product. Folder-name
  detection reports 8 siblings; reality is 1 ship unit with an internal
  client/service split.
- **False merges / missed splits.** A multi-service workspace with 4
  independently deployed `apps/*` services plus shared `libs/*` packages.
  Folder detection gets the top-level shape right by luck (apps vs libs), but
  has no mechanism to notice when two `apps/*` entries are actually bundled by
  a single Docker Compose stack or CI deploy job (i.e., it can't correctly
  *merge* even when merging would be right), and no mechanism to demote an
  `apps/*` folder that has no runnable entry, no Dockerfile, and no CI job
  (i.e., it can't correctly *decline to count* a folder as deployable).

Symptom in the product: the workspace-level overview
(`get_workspace_summary`, `WorkspaceDeployable[]`) reports the wrong number
of "isolated deployables," inflates or deflates system counts, and gives
agents a boundary model that doesn't match how the software actually ships.

## 2. Principle

> **A deployable is an independent SHIP/RUN artifact.** Multiple runnable
> entries (binaries, processes, servers) can be **members of one ship
> unit** when positive evidence shows they are packaged/deployed together.
> Folder layout is a weak, last-resort tiebreaker — never the primary
> signal.

Two runnable things are the same deployable when something in the repo
*says so* (a Dockerfile COPYs both, a compose service starts both, an
installer bundles both, a CI job deploys both as one artifact). Absent that
evidence, two runnable things are presumed separate deployables even if they
live in sibling folders. Folder name is consulted only to break ties among
candidates that are otherwise evidence-equal — it must never be the sole
basis for either splitting or merging.

## 3. Evidence tiers

Ordered by strength. Higher tiers are near-certain; Tier-4 is a prior, not a
fact.

- **Tier-1 — Ship declarations.** Direct evidence that an artifact is built
  and shipped as a unit:
  - `Dockerfile` (+ its build context — which paths get `COPY`'d in)
  - `docker-compose.yml` / `compose.yaml` service definitions
  - Kubernetes manifests / Helm charts (one Deployment/Service = one ship
    unit; charts that template multiple containers from one values file are
    one unit with N members)
  - Serverless configs (`serverless.yml`, `fly.toml`, `vercel.json`,
    `now.json`), `Procfile`
  - Installer scripts (`install.sh`, NSIS/Inno/pkg scripts, `package.json`
    `"pkg"`/`electron-builder` config) that bundle multiple binaries into
    one distributable — this is the Rust multi-binary client+client-service
    case
  - CI/CD deploy jobs (`.github/workflows/*deploy*`, `.gitlab-ci.yml` deploy
    stage) — a single job that builds+pushes+deploys N artifacts together is
    evidence they ship as one unit
- **Tier-2 — Runnable entries.** Evidence something *can run standalone*,
  but not evidence of how it ships:
  - Rust `Cargo.toml` `[[bin]]` targets
  - `main()` / `fn main` entry functions, language-appropriate equivalents
  - `package.json` `"bin"` field, or a `"start"`/`"server"` script that
    binds a port
  - Port-binding bootstrap code (`.listen(`, `app.run(`, `net.Listen`, etc.)
- **Tier-3 — Package identity.** Evidence of a named, addressable unit with
  no runnable or ship evidence of its own:
  - `package.json` name / `Cargo.toml` `[package] name` / `go.mod` module
    path / `pyproject.toml` name
- **Tier-4 — Folder prior.** The folder-name regex classifier described in
  Section 1 (`apps/`, `services/`, `cmd/`, `bin/` → deployable-leaning;
  `packages/`, `crates/`, `libs/` → library-leaning). Used only as a
  tiebreaker when Tiers 1-3 leave ambiguity (e.g., choosing a display name,
  or nudging confidence when two candidates are otherwise symmetric).

## 4. Algorithm

1. **Collect evidence.** Walk the CAS (nodes, distribution units, manifest
   files) and emit one `DeployableEvidence` record per signal found, tagged
   with its tier. A single root can accumulate evidence across multiple
   tiers (e.g., a Tier-2 `[[bin]]` plus a Tier-1 Dockerfile that names it).
2. **Attribute code to nearest owning root.** For each evidence record,
   attribute it to the nearest containing root by path containment,
   refined by import-closure (a file's owning root is the nearest ancestor
   directory that is itself a candidate root AND whose import graph reaches
   the file without crossing into another candidate root first). This
   produces a set of *candidate roots*, each with its accumulated evidence.
3. **Evidence-gated merge.** For each candidate root R with only Tier-2/3
   evidence (i.e., no Tier-1 ship declaration of its own), check whether R
   should be folded into another candidate root S as a *member*:
   - Merge R into S **only** with positive bundling evidence:
     - R's path appears in S's `ships_paths` (S has a Tier-1 artifact whose
       build context / component list / CI job explicitly includes R), OR
     - R is import- or IPC-coupled to S (R calls into S's code, or R and S
       exchange messages over a documented local channel) **and** R has no
       Tier-1 artifact of its own.
   - If evidence is mixed or absent, R stays a **separate** deployable
     candidate but is flagged `possible_bundle` with the candidate S it was
     considered against, so downstream consumers (and humans) can see the
     ambiguity instead of a silently wrong merge.
   - **Never merge on absence alone.** The lack of a Tier-1 artifact for R
     is necessary but not sufficient — it justifies looking for a bundling
     merge, it never justifies performing one without a positive signal.
     Two sibling folders with no Dockerfiles and no coupling stay two
     separate (lower-confidence) deployables, not one guessed merge.
   - Tier-4 folder evidence never triggers a merge or a split by itself; it
     only breaks ties in naming/confidence among roots that evidence has
     already left ambiguous.
4. **Emit.** Produce one `SystemApplication` per surviving root (merged
   members collapse into the unit they were folded into) with:
   - `bundled_into`: set on a member application, pointing at the ship
     unit's `SystemApplication.id`, when a merge occurred.
   - `boundary_evidence`: the ordered list of evidence strings that
     justified this root's boundary (kept separate, merged, or flagged
     `possible_bundle`), so the decision is auditable, not just asserted.

## 5. Shared contract (as implemented)

`DeployableEvidence` lives in `packages/analyzer-core/src/types/cas.types.ts`
and is produced by a **pluggable `EvidenceProvider` registry**, not a
monolithic collector — see §5a. `SystemApplication` (the resolver's output
type, `bundled_into` at line ~101 / `boundary_evidence` at line ~104 of its
interface) lives in `apps/mcp-server/src/cross-codebase-analysis.ts`:

```ts
/** packages/analyzer-core/src/types/cas.types.ts */
interface DeployableEvidence {
  root_path: string;           // candidate root, repo-relative
  name: string;                // display name inferred from evidence, not folder
  tier: 1 | 2 | 3 | 4;
  kind: 'dockerfile' | 'compose-service' | 'k8s-manifest' | 'serverless-config'
      | 'installer-script' | 'ci-deploy-job'                    // Tier 1
      | 'cargo-bin' | 'main-fn' | 'package-bin' | 'port-bind'   // Tier 2
      | 'package-identity'                                       // Tier 3
      | 'folder-prior';                                          // Tier 4
  evidence: string[];           // human-readable citations (file:line or file)
  entry_files?: string[];       // source/config files that establish this unit's entry boundary
  ships_paths?: string[];       // Tier-1 only: other roots this artifact bundles in
  ports?: string[];
}

/** apps/mcp-server/src/cross-codebase-analysis.ts — SystemApplication (existing type, extended) */
interface SystemApplication {
  // ...existing fields (id, codebase_id, name, kind, deployable, ...)
  bundled_into?: string;         // id of the SystemApplication this one ships inside of
  boundary_evidence?: string[];  // evidence trail for how this boundary was decided
}
```

The resolver (`resolveDeployables`, `apps/mcp-server/src/cross-codebase-analysis.ts`
~line 10129) consumes `DeployableEvidence[]` and populates `bundled_into` /
`boundary_evidence` on `SystemApplication`. Related resolver-side functions
confirmed live in that file: `applicationSurfaceCandidatesFromCas` (candidate
roots from CAS), `applicationSurfaceFromFile` (the original Tier-4
folder-regex classifier — now consulted only as the last-resort tiebreaker
described in §3/§4, not the primary signal), `suppressWorkspaceContainerRoots`
(kills the phantom monorepo-root deployable for workspace-manifest files —
`package.json` workspaces, pnpm/turbo/nx/lerna configs, Cargo `[workspace]`),
and `applyShippedGate` (the shipped-gate, §5b).

### 5a. Pluggable EvidenceProvider registry

The evidence collector is not one function — it's a registry of small,
independent `EvidenceProvider` implementations, one per ecosystem/concern,
under `packages/analyzer-core/src/analyzer/core/deployable-evidence/`:

- `types.ts` — the `EvidenceProvider` interface (`id`, dominant `tier`, a pure
  `collect(ctx)` that returns `DeployableEvidence[]` and never throws) and the
  `EvidenceCollectionContext` shape (partial CAS + project path + convenience
  `nodes`/`exitPoints` arrays).
- `registry.ts` — `BUILTIN_PROVIDERS` (the built-in list, collection order
  preserved for dedupe stability) plus `registerProvider()` / `getProviders()`
  for adding more without touching the resolver.
- `util.ts` — shared helpers used by multiple providers.
- `providers/` — one file per concern, each exporting one `EvidenceProvider`:
  `container.ts`, `installer.ts`, `ci-deploy.ts`, `bin-targets.ts`,
  `package-manifest.ts` (the original five, general-purpose/language-agnostic
  concerns), plus the per-ecosystem breadth providers added this session:
  `python.ts`, `ruby.ts`, `php.ts`, `jvm.ts`, `dotnet.ts`,
  `deploy-manifests.ts` (PaaS: Helm/serverless/Procfile-style configs),
  `native.ts` (C/C++), `mobile.ts`. That is 8 ecosystem-breadth providers on
  top of the original 5, for 13 provider files total as of `658e8990`.

Adding a new ecosystem means writing one `providers/<eco>.ts` file and
registering it — the resolver itself is unchanged and ecosystem-agnostic,
since it only ever consumes the shared `DeployableEvidence[]` shape.

### 5b. Shipped-gate: runnable is not shipped

`applyShippedGate` (added in commit `f8ef1aed`, `cross-codebase-analysis.ts`)
runs after the bundling merge and demotes a Tier-2/3 "runnable" candidate
(e.g. a Cargo `[[bin]]` or a `main()`) to `deployable:false` UNLESS: (a) it
has its own Tier-1 ship artifact, (b) a Tier-1 artifact elsewhere names it in
`ships_paths` (it's a bundle member), or (c) it's the sole runnable in the
workspace (nothing else could possibly be "the" deployable). The gate applies only to a repository that has a Tier-1 ship artifact: a repository with none ships through its runnables, so build targets that only produce an executable (a CMake `add_executable`, a .NET or Gradle application) are each a deployable. A packaged output (an APK from an Android application module, a war or ear, a Compose desktop distribution) is a Tier-1 ship artifact in its own right. Otherwise it's
tagged `boundary_evidence: ['runnable-not-shipped:no-tier1-artifact-references-it', ...]`.
Tier-4 (pure folder-heuristic) candidates are exempt from the gate — gating
them would punish absence of evidence rather than act on positive evidence.
This is the fix for the motivating over-count case: real repos accumulate
test/demo/utility binaries that build fine but never ship, and flagging every
one `deployable:true` produces an unusable list.

## 6. Worked examples

- **Rust multi-binary workspace**: 8 `[[bin]]` crates (Tier-2) under
  `crates/*` and `apps/*`. One installer script (Tier-1, `kind:
  installer-script`) names `client` and `client-service` in its bundle
  list. Result: `client` becomes the ship unit, `client-service` gets
  `bundled_into: client`'s id with `boundary_evidence` citing the installer
  script line. The remaining ~6 bin crates have no Tier-1 evidence and no
  coupling to `client` → they stay separate deployables (or, if genuinely
  dev-only tools, get demoted by existing `looksLikeInternalUtilityApplication`
  heuristics — out of scope for this spec). Net: 1 ship unit with 2 members
  + N separate tool deployables, not 8 flat siblings.
- **Multi-service workspace**: 4 `apps/*` each with their own Dockerfile
  (Tier-1, distinct `ships_paths` — none references another app) → 4
  separate deployables, correctly not merged. `libs/*` packages have only
  Tier-3 package-identity evidence and are referenced via imports by the 4
  apps but have no Tier-1 artifact of their own and no IPC coupling (they're
  compiled in, not processes) → they roll up as non-deployable library
  surfaces attributed to whichever app(s) import them, per existing
  `deployable: false` semantics for `packages/`/`libs/` roots.
- **next-fullstack** (single Next.js app, one Dockerfile, one Vercel
  config): 1 Tier-1 root, no competing Tier-2 candidates outside it → 1
  deployable.
- **Go `cmd/*` layout** (N independent `main()` packages under `cmd/`, each
  with its own `go build` CI step and its own container image): N Tier-1
  roots, no `ships_paths` cross-references → N separate deployables. This is
  the case where Tier-4 folder prior (`cmd/` → deployable-leaning) and the
  evidence-based result happen to agree — folder convention isn't wrong
  here, it's just not sufficient on its own, and this spec's algorithm
  reaches the same answer via Tier-1 evidence instead of by trusting the
  folder name.

## 6a. Real-repo results (as measured this session)

- **Multi-service workspace shape**: confirmed 4 real deployables (per
  `bae5aca6`), matching §6's worked example — 4 `apps/*` each with its own
  Dockerfile, no merges.
- **Rust multi-binary workspace shape**: the shipped-gate (`f8ef1aed`) was
  motivated by a real workspace of this shape over-producing **18**
  "deployables" pre-fix (folder-name detection counting every runnable bin).
  **Verified post-fix (2026-07-02, live probe through `analyzeForBench` +
  `buildCrossCodebaseSystemGraph`): 18 → 4 top-level deployables** (an agent,
  a drop-server, a gateway, and a version utility) + 47 non-deployable libs —
  the unshipped test/demo/utility bins correctly collapsed. **Two honest
  residuals remain** (tracked, not yet fixed): (1) the version utility is a
  false-positive deployable (a utility that spuriously matches a ship
  artifact); (2) multi-artifact primary attribution inverts — it shows
  `client → agent` (agent primary) whereas the product-owner ground truth is
  client-primary-bundles-client-service. So: the gross error (18) is fixed and
  the shipped-gate generalizes to a messy real repo, but the specific
  client-primary relationship is not yet exact. The fixture regression
  (`rust-messy-workspace`: 8 bins, 3 shipped, 4 runnable-not-shipped decoys)
  passes and covers the mechanism on a clean analog.

## 7. Fixture matrix (acceptance bar)

`apps/mcp-server/src/gauntlet/deployable-detection-bench.ts` + `.test.ts` and
its siblings (`deployable-detection-tier1-bench.test.ts`,
`deployable-detection-py-bench.test.ts`,
`deployable-detection-jvm-bench.test.ts`,
`deployable-detection-native-bench.test.ts`,
`deployable-detection-evidence-root-bench.test.ts`) cover the following cases
end to end (per commit messages: core bench 6/6, per-ecosystem benches
reported passing individually — py 3/3, jvm 2/2, native 2/2, tier1 4/4 as of
`658e8990`; re-run the suite directly for current counts rather than trusting
this doc's numbers as they age):

1. **Bundle-via-installer** (Rust multi-binary workspace shape): N runnable
   bins, 1 installer script bundling 2 of them → 1 ship unit with 2 members
   + N-2 separate.
2. **Independent-siblings-with-own-Dockerfiles** (multi-service workspace
   shape): N `apps/*` each with a distinct Dockerfile, no cross-references →
   N separate deployables, 0 merges.
3. **Single-app** (next-fullstack shape): 1 Dockerfile/Vercel config, no
   competing Tier-2 roots → 1 deployable.
4. **Ambiguous-no-evidence**: 2 sibling folders, both Tier-2 only
   (`main()`/`[[bin]]`), no Dockerfile, no coupling → 2 separate
   deployables, both flagged low-confidence / `possible_bundle: null` (must
   NOT silently merge on folder-name alone).
5. **Coupled-no-own-Tier-1** (IPC/import case): root A has a Dockerfile
   (Tier-1); root B has only a `main()` (Tier-2) and imports/calls into A's
   code with no ship artifact of its own → B merges into A as a member with
   `bundled_into` set, citing the import-coupling evidence.

Passing this matrix — including case 4's negative requirement (no merge
without positive evidence) — was the acceptance bar for this spec, and per
the commit history above it has been met (bench suites reported passing at
each landing commit through `658e8990`). Re-run the suites directly for
current pass/fail rather than trusting this doc as it ages.

## 8. Fabric coordination observations (fabric observer report, historical)

This section is a point-in-time log from the build that produced this
feature, kept as historical record — it predates the fabric-v2 spec
(`docs/SPEC-COORDINATION-FABRIC-V2.md`) that the build's own findings
motivated. See the standalone battle-test report for full detail:
`~/.klauro/agent-feedback/2026-07-02-agentF-fabric-observer.md`.

This build ran 6 agents concurrently through Klauro's real coordination
fabric (`workspace_id: deployable-detection-build`), with two deliberate
same-file stress pairs:

- **agent-B + agent-D** both claimed `apps/mcp-server/src/cross-codebase-analysis.ts`
  (agent-B: resolver / `applicationSurfaceFromFile`,
  `applicationSurfaceCandidatesFromCas`, `SystemApplication`; agent-D:
  `workspaceDomainSortScore`, `buildWorkspaceNarrative`,
  `workspaceAiFactSheet` — a disjoint symbol set in the same file).
- **agent-A + agent-E** both claimed `packages/analyzer-core/src/types/cas.types.ts`
  (agent-A: adding `DeployableEvidence`; agent-E: adding fields needed for
  `get_intent` fix) — again a shared file, intended-disjoint edits.

Both pairs took out `edit-lock` claims (`ttl_ms: 300000`, i.e. 5-minute
locks) visible in the ledger at `~/.klauro/coordination/deployable-detection-build/claims.jsonl`,
seq 7 (agent-B lock on cross-codebase-analysis.ts) and seq 8 (agent-E lock
on cas.types.ts). This is exactly the scenario `checkEditLock` exists to
surface: two agents with overlapping file scope but (claimed) disjoint
symbol scope. Final pass/fail verdict — whether either pair clobbered the
other's edit, and whether the lock/overlap surfaced correctly to both
agents in real time — is recorded in the standalone report after the build
window closes, since it depends on observing the ledger across the full
session rather than a single snapshot.

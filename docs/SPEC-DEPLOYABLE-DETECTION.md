# SPEC: Evidence-Based Deployable Detection

Status: **IN PROGRESS** as of this session (2026-07-02). Agents A/B/C are building
the evidence collector, resolver, and fixture bench in parallel against this spec.
Agent-F (this doc's author) is also the fabric observer for the build — see
Part 2 below for the coordination battle-test verdict.

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
  the real ship unit is 1. Motivating case: **zerac/poc** — 8 Rust `[[bin]]`
  crates under `crates/*` and `apps/*`, but only 1-2 real deployables: a
  single installer script bundles the `client` binary and the
  `client-service` binary together into one shipped product. Folder-name
  detection reports 8 siblings; reality is 1 ship unit with an internal
  client/service split.
- **False merges / missed splits.** **zerac-api** has 4 independently
  deployed `apps/*` services plus shared `libs/*` packages. Folder detection
  gets the top-level shape right by luck (apps vs libs), but has no
  mechanism to notice when two `apps/*` entries are actually bundled by a
  single Docker Compose stack or CI deploy job (i.e., it can't correctly
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
    one distributable — this is the zerac/poc client+client-service case
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

## 5. Shared contract

Two shapes are shared across the collector (agent-A), resolver (agent-B),
and bench (agent-C):

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

`bundled_into` and `boundary_evidence` are already present on
`SystemApplication` in `apps/mcp-server/src/cross-codebase-analysis.ts`
(lines 98/101 of the interface as of this session) — agent-B is wiring the
resolver that populates them from agent-A's `DeployableEvidence[]`.

## 6. Worked examples

- **zerac/poc**: 8 `[[bin]]` crates (Tier-2) under `crates/*` and `apps/*`.
  One installer script (Tier-1, `kind: installer-script`) names `client` and
  `client-service` in its bundle list. Result: `client` becomes the ship
  unit, `client-service` gets `bundled_into: client`'s id with
  `boundary_evidence` citing the installer script line. The remaining ~6
  bin crates have no Tier-1 evidence and no coupling to `client` → they stay
  separate deployables (or, if genuinely dev-only tools, get demoted by
  existing `looksLikeInternalUtilityApplication` heuristics — out of scope
  for this spec). Net: 1 ship unit with 2 members + N separate tool
  deployables, not 8 flat siblings.
- **zerac-api**: 4 `apps/*` each with their own Dockerfile (Tier-1, distinct
  `ships_paths` — none references another app) → 4 separate deployables,
  correctly not merged. `libs/*` packages have only Tier-3 package-identity
  evidence and are referenced via imports by the 4 apps but have no Tier-1
  artifact of their own and no IPC coupling (they're compiled in, not
  processes) → they roll up as non-deployable library surfaces attributed
  to whichever app(s) import them, per existing `deployable: false`
  semantics for `packages/`/`libs/` roots.
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

## 7. Fixture matrix (acceptance bar)

Agent-C is building `apps/mcp-server/src/gauntlet/deployable-detection-bench.ts`
+ `.test.ts` covering (at minimum) 5 cases that must each resolve correctly
under this spec's algorithm:

1. **Bundle-via-installer** (zerac/poc shape): N runnable bins, 1 installer
   script bundling 2 of them → 1 ship unit with 2 members + N-2 separate.
2. **Independent-siblings-with-own-Dockerfiles** (zerac-api shape): N
   `apps/*` each with a distinct Dockerfile, no cross-references → N
   separate deployables, 0 merges.
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
without positive evidence) — is the acceptance bar for closing this spec's
IN PROGRESS status.

## 8. Fabric coordination observations (fabric observer report)

See the standalone battle-test report for full detail:
`~/.klauro/agent-feedback/2026-07-02-agentF-fabric-observer.md`. Summary
below; this section will be updated with the final verdict once the build
window closes.

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

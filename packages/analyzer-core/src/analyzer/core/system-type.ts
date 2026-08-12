// Tier 2 — Framework / Architecture / Library. Extracted verbatim from
// orchestrator.ts (task #121, codebase-decomposition cleanup) with NO
// behaviour change; see docs/SPEC-ABSTRACTION-TIERS.md for the tier
// contract this extraction enforces a boundary for.
//
// Tier discipline: reads only Tier-1 facts (CASEntryPoint's closed-vocabulary
// `type`, and DeployableEvidence's `tier`/`kind`/`bundled_into`) already
// present on the CAS before this point in assembly. No comprehension/AI
// output is read, and this module imports nothing from a Tier-3 file.
//
// DEFECT (system.type misclassification): this used to be a node-type
// presence checklist (`types.includes('controller') -> 'service'`, etc.).
// That checklist assumed every request-handling codebase tags its handlers
// with a literal CASNode.type of 'controller' — several web-framework
// analyzers do (Spring Boot, Express, Flask, Django, Rails, Laravel, ...),
// but that tagging is itself framework-specific: a plain framework-less
// HTTP server (e.g. Go's stdlib net/http, with no matching framework
// analyzer) never gets a 'controller' node no matter how many routes it
// serves. Meanwhile the Go and Java analyzers stamp every source
// package/namespace with node.type 'package' (go-analyzer.ts's
// buildPackageHierarchy, java-analyzer.ts) as a plain file-organization
// fact, true of nearly every Go or Java repo regardless of whether it
// ships a library or an HTTP server. Reproduced live: a Go feed-reader
// with 175 HTTP entry points and Docker/RPM/Debian ship artifacts
// reported system.type "library" — the 'controller' branch could never
// fire (no framework analyzer tagged its handlers), so the checklist fell
// through to the 'package' branch, which fires for essentially any Go or
// Java repo.
//
// Fixed by asking the CAS's own evidence instead of guessing from node
// type vocabulary:
//  - independently-deployable Tier-1 ship units (containers,
//    compose-services, k8s manifests, installers, CI-deploy jobs) — more
//    than one top-level unit means this repo ships multiple systems
//    (a monorepo).
//  - live entry points (CASEntryPoint) — something calls into this code
//    at runtime, which a pure library does not have. A network-facing
//    entry type (http/websocket/rpc/graphql/api) is the deployable-
//    service shape specifically.
//  - deployable evidence tiers 1/2 (ship declaration or runnable entry:
//    bin targets, server bootstraps) — proof this repo produces something
//    that runs, as opposed to only something importable.
//  - tier-3 evidence alone (package.json/Cargo.toml/go.mod naming a
//    publishable unit) is NOT sufficient on its own — virtually every
//    repo has a package manifest, including services and applications —
//    so it only tips the verdict to 'library' once every other kind of
//    runtime evidence is absent.
//
// This is exactly the defect the tier-boundary enforcement in this
// decomposition exists to make structurally impossible: this function must
// never import a Tier-3 (comprehension) module, and a lint-time import
// boundary now enforces that (see docs/TIER-BOUNDARY-GATE.md).

import { CASEntryPoint, DeployableEvidence } from '../../types/cas.types';

export function determineSystemType(
  entryPoints: CASEntryPoint[],
  deployableEvidence: DeployableEvidence[]
): string {
  // Same top-level-ship-unit filter used for deployment-topology claims
  // elsewhere in this file (see topLevelShipUnits near
  // collectDeployableEvidence): only Tier-1 declarations that are not
  // themselves bundled into a sibling unit count as independently
  // deployable.
  const topLevelShipUnits = deployableEvidence.filter(
    e => e.tier === 1 && e.kind !== 'build-image' && !e.bundled_into
  );
  if (topLevelShipUnits.length > 1) return 'monorepo';

  const NETWORK_ENTRY_TYPES = new Set<CASEntryPoint['type']>([
    'http', 'websocket', 'rpc', 'graphql', 'api'
  ]);
  // 'test' entry points are excluded — a test harness invoking code is not
  // evidence that the product itself has a runtime entry surface.
  //
  // 'lifecycle' is excluded for the same reason, measured live 2026-08-11: a real
  // npm library (`main`, no `bin`, 300 nodes) had entry_points_by_type exactly
  // `{lifecycle: 2}` — module-init hooks — and those tipped hasRuntimeEntryPoint,
  // so it was typed 'application' and the tier-3 'library' branch below became
  // unreachable. The damage was downstream and customer-visible: the AI was asked
  // to describe an "application" with no way to invoke it, reached for compound
  // modifiers to cover the gap ("interacts-local"), and the grounding gate
  // correctly rejected the fabrication — shipping a BLANK system description and
  // `domain: null` on the most important field in the payload.
  //
  // A lifecycle hook is something the RUNTIME calls during load; it is not a way a
  // user invokes the system, which is what every other type in this ladder means
  // by an entry surface. Excluding it lets a library be recognised as a library
  // from the author's own package declaration, and the narrative then has a
  // grounded type to describe.
  const NON_INVOCATION_ENTRY_TYPES = new Set<CASEntryPoint['type']>(['test', 'lifecycle']);
  const realEntryPoints = entryPoints.filter(e => !NON_INVOCATION_ENTRY_TYPES.has(e.type));
  // A network-facing entry point is itself a live entry point, so this
  // subsumes hasRuntimeEntryPoint below — checked first and returned
  // immediately for clarity of intent (network surface => service shape).
  const hasNetworkEntryPoint = realEntryPoints.some(e => NETWORK_ENTRY_TYPES.has(e.type));
  if (hasNetworkEntryPoint) return 'service';

  const hasRuntimeEntryPoint = realEntryPoints.length > 0;
  const hasShipOrRunnableEvidence = deployableEvidence.some(e => e.tier === 1 || e.tier === 2);
  if (hasRuntimeEntryPoint || hasShipOrRunnableEvidence) {
    return 'application';
  }
  // No runtime entry surface and nothing that ships/runs: package-identity
  // evidence (tier 3) is the only remaining explanation for a structural
  // codebase, i.e. an actual library.
  if (deployableEvidence.some(e => e.tier === 3)) return 'library';

  return 'application';
}

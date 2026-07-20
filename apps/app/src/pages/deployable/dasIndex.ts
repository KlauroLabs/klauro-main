import type { DeployableEvidence } from './dasTypes';

/**
 * Client-side mirror of apps/mcp-server/src/deployable-analysis.ts's
 * promotion rule + stable id derivation (tierQualifiedShipUnits,
 * shouldPromote, buildDeployableRoots/dasUnitIds, bundledMembersOf). The
 * true DAS surface (reachability-closure slicing, orphan accounting) is an
 * MCP-only tool today — GET /api/projects/:id/cas does not expose it — but
 * `deployable_evidence` itself IS in the HTTP payload, and the promotion
 * gate + id scheme are pure functions of that array alone. Reproducing them
 * here (instead of inventing a different picker) means this page's unit ids
 * are the SAME `das:...` ids the MCP das_index would assign, so nothing
 * here is a second algorithm — it's the documented one, run client-side on
 * data the server already shipped.
 */

export interface DasUnitSummary {
  id: string;
  name: string;
  root_path: string;
  member_root_paths: string[];
  tier: 1 | 2 | 3;
  kind: DeployableEvidence['kind'];
  boundary_evidence: string[];
  ships_paths?: string[];
  ports?: number[];
  entrypoint_member?: string;
  base_images?: string[];
  /** This unit's own `dep:...` id plus each bundled member's — the join key
   *  set against `EntryPoint.deployable_id` (see dasScope.ts). A bundled
   *  member gets its OWN dep id from root-path attribution even though it
   *  doesn't count toward promotion, so entry points inside a bundled
   *  member's root_path carry the member's id, not the parent unit's. */
  member_deployable_ids: string[];
}

export interface DasIndexResult {
  promoted: boolean;
  units: DasUnitSummary[];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

/** Same construction as entry-point-deployable.ts's buildDeployableRoots:
 *  `dep:<kind>:<slug(root_path)>:<slug(name)>`, index-disambiguated on
 *  collision. This is also the id already stamped onto each entry point's
 *  `deployable_id` server-side, so unit ids computed here join directly
 *  against `EntryPoint.deployable_id` with no extra lookup table. */
function deployableId(evidence: DeployableEvidence, index: number, seen: Set<string>): string {
  const rootPath = normalizePath(evidence.root_path);
  const base = `dep:${evidence.kind}:${slug(rootPath)}:${slug(evidence.name)}`;
  const id = seen.has(base) ? `${base}:${index}` : base;
  seen.add(id);
  return id;
}

function isTier1(e: DeployableEvidence): boolean {
  return e.tier === 1;
}

/** deployable-analysis.ts's tierQualifiedShipUnits, verbatim rule. */
export function tierQualifiedShipUnits(evidence: DeployableEvidence[]): DeployableEvidence[] {
  const standalone = evidence.filter(e => !e.bundled_into);
  const tier1Units = standalone.filter(isTier1);

  const allRunnable = evidence.filter(e => e.tier === 2 || e.tier === 3);
  const soleRunnable = allRunnable.length <= 1;
  const tier23Units = standalone.filter(e => (e.tier === 2 || e.tier === 3) && e.kind !== 'server-entry' && soleRunnable);

  return [...tier1Units, ...tier23Units];
}

export function bundledMembersOf(unit: DeployableEvidence, allEvidence: DeployableEvidence[]): DeployableEvidence[] {
  return allEvidence.filter(e => e !== unit && e.bundled_into === unit.name);
}

/** deployable-analysis.ts's buildDeployableAnalyses, minus the reachability
 *  slicing this frontend cannot do without the call graph (edges are in the
 *  HTTP payload, but re-implementing the closure algorithm here would be
 *  the "second flow algorithm" LANE-COMMON.md forbids). node_count /
 *  entry_point_count / exit_point_count / orphan accounting are therefore
 *  NOT computed here — see DasOrphanNotice.tsx and DasUnitOverview.tsx for
 *  the honest gap notice. */
export function buildDasIndex(evidence: DeployableEvidence[] | undefined): DasIndexResult {
  const items = evidence ?? [];
  const qualified = tierQualifiedShipUnits(items);
  if (qualified.length < 2) {
    return { promoted: false, units: [] };
  }

  // buildDeployableRoots derives a dep id for EVERY evidence row (not just
  // qualified ones) — a bundled tier-2/3 member gets its own id from its
  // own root_path, same as the real backend attribution.
  const seen = new Set<string>();
  const depIds = items.map((e, i) => deployableId(e, i, seen));

  const units: DasUnitSummary[] = qualified.map(unit => {
    const idx = items.indexOf(unit);
    const ownDepId = depIds[idx];
    const id = `das:${ownDepId.replace(/^dep:/, '')}`;
    const members = bundledMembersOf(unit, items);
    const memberDepIds = members.map(m => depIds[items.indexOf(m)]);
    return {
      id,
      name: unit.name,
      root_path: normalizePath(unit.root_path),
      member_root_paths: members.map(m => normalizePath(m.root_path)),
      tier: unit.tier,
      kind: unit.kind,
      boundary_evidence: unit.evidence,
      ships_paths: unit.ships_paths,
      ports: unit.ports,
      entrypoint_member: unit.entrypoint_member,
      base_images: unit.base_images,
      member_deployable_ids: [ownDepId, ...memberDepIds],
    };
  });

  return { promoted: true, units };
}

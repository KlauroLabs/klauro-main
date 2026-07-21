import type { DeployableEvidence } from './dasTypes';

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

  member_deployable_ids: string[];
}

export interface DasIndexResult {
  promoted: boolean;
  units: DasUnitSummary[];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

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

export function buildDasIndex(evidence: DeployableEvidence[] | undefined): DasIndexResult {
  const items = evidence ?? [];
  const qualified = tierQualifiedShipUnits(items);
  if (qualified.length < 2) {
    return { promoted: false, units: [] };
  }

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

import type { DeployableEvidence } from './dasTypes';

export interface SubCasNodeIndexEntry {
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

export interface SubCasNodeIndex {
  promoted: boolean;
  units: SubCasNodeIndexEntry[];
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

/** Ship-evidence qualification, mirroring apps/mcp-server/src/deployable-
 *  analysis.ts's tierQualifiedShipUnits (which owns the doc comment and the
 *  rationale): standalone AND declaring a ship-or-build artifact of its own —
 *  never "how many other runnables exist". Kept in lockstep with that module so
 *  the web UI's unit list is the same list the API's sub_cas_nodes reports. */
function isBuildTarget(e: DeployableEvidence): boolean {
  return e.tier === 2 && e.kind === 'bin';
}

function normalizeShipToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.(exe|msi|dmg|pkg|deb|rpm|appimage)$/i, '')
    .replace(/[\s_-]+/g, '');
}

/** Does this row's evidence name a concrete entry FILE? Same evidence-grammar
 *  whitelist (and same survivor ranking) as the server module's
 *  DECLARED_ENTRY_FILE_PATTERNS, so both sides pick the same twin. */
function declaresEntryFile(e: DeployableEvidence): boolean {
  return (e.evidence || []).some(line =>
    /^src\/bin entry:\s*\S/.test(line)
    || /^src\/main\.rs present, no \[\[bin\]\] override\s*\(/.test(line)
    || /^package main entry:\s*\S/.test(line));
}

export function tierQualifiedShipUnits(evidence: DeployableEvidence[]): DeployableEvidence[] {
  const qualified = evidence.filter(e => !e.bundled_into && (isTier1(e) || isBuildTarget(e)));

  // One binary declared through two conventions at once (a cargo `[[bin]]` row
  // plus the `src/bin/<name>.rs` row for the same target) is one unit: the row
  // naming a concrete entry file wins, then the longer root_path, then
  // declaration order.
  const outranks = (candidate: DeployableEvidence, incumbent: DeployableEvidence): boolean => {
    const candidateFile = declaresEntryFile(candidate) ? 0 : 1;
    const incumbentFile = declaresEntryFile(incumbent) ? 0 : 1;
    if (candidateFile !== incumbentFile) return candidateFile < incumbentFile;
    return (candidate.root_path || '').length > (incumbent.root_path || '').length;
  };
  const seenBuildTargets = new Map<string, DeployableEvidence>();
  for (const item of qualified) {
    if (!isBuildTarget(item)) continue;
    const key = normalizeShipToken(item.name);
    if (!key) continue;
    const existing = seenBuildTargets.get(key);
    if (!existing || outranks(item, existing)) seenBuildTargets.set(key, item);
  }
  return qualified.filter(item => {
    if (!isBuildTarget(item)) return true;
    const key = normalizeShipToken(item.name);
    if (!key) return true;
    return seenBuildTargets.get(key) === item;
  });
}

export function bundledMembersOf(unit: DeployableEvidence, allEvidence: DeployableEvidence[]): DeployableEvidence[] {
  return allEvidence.filter(e => e !== unit && e.bundled_into === unit.name);
}

export function buildSubCasNodeIndex(evidence: DeployableEvidence[] | undefined): SubCasNodeIndex {
  const items = evidence ?? [];
  const qualified = tierQualifiedShipUnits(items);
  if (qualified.length < 2) {
    return { promoted: false, units: [] };
  }

  const seen = new Set<string>();
  const depIds = items.map((e, i) => deployableId(e, i, seen));

  const units: SubCasNodeIndexEntry[] = qualified.map(unit => {
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

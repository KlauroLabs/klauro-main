import * as path from 'path';
import type { CASEntryPoint, CASExitPoint, CASNode, CASOutput, DeployableEvidence } from '../../types/cas.types';
import { getProviders } from './deployable-evidence/registry';
import type { EvidenceCollectionContext, EvidenceProvider } from './deployable-evidence/types';
import { UNNAMED_SERVICE_PLACEHOLDER } from './deployable-evidence/util';
import { mergeManifestIdentityRows } from './deployable-evidence/manifest-identity';

export type { EvidenceCollectionContext, EvidenceProvider };
export type { DeployableEvidence };

export interface CollectDeployableEvidenceInput {
  projectPath: string;
  nodes: CASNode[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
  displayName?: string;
}
export function collectDeployableEvidence(input: CollectDeployableEvidenceInput): DeployableEvidence[] {
  const { projectPath, nodes, entryPoints, exitPoints, displayName } = input;

  const cas: Partial<CASOutput> = {
    nodes,
    entry_points: entryPoints,
    exit_points: exitPoints,
  };
  const ctx: EvidenceCollectionContext = { cas, projectPath, nodes, exitPoints, displayName };

  const results: DeployableEvidence[] = [];
  for (const provider of getProviders()) {
    try {
      results.push(...provider.collect(ctx));
    } catch (error) {
      console.error(`[deployable-evidence] provider "${provider.id}" threw:`, error);
    }
  }

  const deduped = dedupe(results, projectPath);
  const consolidated = mergeDuplicateNamedInstallerLeaves(deduped);
  const identityJoined = mergeManifestIdentityRows(consolidated);
  const composeAndContainerJoined = joinComposeAndContainerUnits(identityJoined);
  const joined = mergeSameNamedTier1Rows(composeAndContainerJoined);
  const classified = classifyBuildStageContainers(joined);
  const collapsed = collapseWholeRepoPackagingVariants(collapseContainerVariants(classified));
  resolveEvidenceBundling(collapsed);
  rebundleBinsIntoServiceUnits(collapsed);
  return collapsed;
}
function canonicalEvidenceRoot(projectPath: string, rootPath: string): string {
  const normalized = rootPath.replace(/\\/g, '/').replace(/\/$/, '') || '.';
  if (!path.isAbsolute(normalized)) return normalized.replace(/^\.\//, '') || '.';
  const relative = path.relative(projectPath, normalized).replace(/\\/g, '/');
  return relative && !relative.startsWith('../') && !path.isAbsolute(relative) ? relative : normalized;
}

function dedupe(items: DeployableEvidence[], projectPath: string): DeployableEvidence[] {
  const byIdentity = new Map<string, DeployableEvidence>();
  const out: DeployableEvidence[] = [];
  for (const item of items) {
    const canonicalRoot = canonicalEvidenceRoot(projectPath, item.root_path);
    const key = `${item.tier}::${item.kind}::${canonicalRoot}::${item.name}`;
    const existing = byIdentity.get(key);
    if (existing) {
      existing.evidence = [...new Set([...existing.evidence, ...item.evidence])];
      existing.entry_files = unionOptional(existing.entry_files, item.entry_files);
      existing.ships_paths = unionOptional(existing.ships_paths, item.ships_paths);
      existing.ports = unionOptional(existing.ports, item.ports);
      existing.base_images = unionOptional(existing.base_images, item.base_images);
      existing.entrypoint_member ||= item.entrypoint_member;
      existing.bundled_into ||= item.bundled_into;
      continue;
    }
    item.root_path = canonicalRoot;
    byIdentity.set(key, item);
    out.push(item);
  }
  return out;
}
function unionOptional<T>(left: T[] | undefined, right: T[] | undefined): T[] | undefined {
  const values = [...new Set([...(left || []), ...(right || [])])];
  return values.length > 0 ? values : undefined;
}

function normalizeMemberToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.(exe|msi|dmg|pkg|deb|rpm|appimage)$/i, '')
    .replace(/[\s_-]+/g, '');
}

function evidenceNameMatchesShippedToken(shipped: string, candidate: DeployableEvidence): boolean {
  const norm = normalizeMemberToken(shipped);
  if (!norm) return false;
  if (normalizeMemberToken(candidate.name) === norm) return true;
  const rootBase = (candidate.root_path || '').split(/[\\/]/).filter(Boolean).pop() || '';
  if (rootBase && normalizeMemberToken(rootBase) === norm) return true;
  return false;
}

function isInstallerBundleHead(item: DeployableEvidence): boolean {
  return item.tier === 1 && item.kind === 'installer' && (item.ships_paths?.length ?? 0) >= 2;
}

function mergeDuplicateNamedInstallerLeaves(items: DeployableEvidence[]): DeployableEvidence[] {
  const heads = new Set(items.filter(isInstallerBundleHead));
  const leaves = items.filter(item => item.tier === 1 && item.kind === 'installer' && !heads.has(item));
  if (!leaves.length) return items;

  const removed = new Set<DeployableEvidence>();

  const survivorRank = (item: DeployableEvidence): number => {
    if (item.kind === 'bin') return 0;
    if (item.kind === 'server-entry') return 1;
    return 2;
  };

  for (const leaf of leaves) {
    if (removed.has(leaf)) continue;
    const leafKey = normalizeMemberToken(leaf.name);
    if (!leafKey) continue;

    let bestMatch: DeployableEvidence | undefined;
    for (const other of items) {
      if (other === leaf || removed.has(other) || heads.has(other)) continue;
      if (normalizeMemberToken(other.name) !== leafKey) continue;
      if (!bestMatch) { bestMatch = other; continue; }
      const otherRank = survivorRank(other);
      const bestRank = survivorRank(bestMatch);
      if (otherRank < bestRank) { bestMatch = other; continue; }
      if (otherRank === bestRank && other.evidence.length > bestMatch.evidence.length) bestMatch = other;
    }
    if (!bestMatch) continue;
    const survivor = survivorRank(bestMatch) <= survivorRank(leaf) ? bestMatch : leaf;
    const loser = survivor === bestMatch ? leaf : bestMatch;
    survivor.evidence = [...new Set([...survivor.evidence, ...loser.evidence, `merged-duplicate-identity:${loser.kind}:${loser.name}`])];
    survivor.entry_files = unionOptional(survivor.entry_files, loser.entry_files);
    survivor.ships_paths = [...new Set([...(survivor.ships_paths || []), ...(loser.ships_paths || [])])];
    removed.add(loser);
  }

  return removed.size ? items.filter(item => !removed.has(item)) : items;
}

function resolveEvidenceBundling(items: DeployableEvidence[]): void {
  const tier1WithMembers = items.filter(item => item.tier === 1 && (item.ships_paths?.length ?? 0) > 0);
  if (!tier1WithMembers.length) return;

  for (const candidate of items) {
    if (candidate.tier === 1) continue;
    if (candidate.bundled_into) continue;

    for (const unit of tier1WithMembers) {
      if (unit === candidate) continue;
      const hit = (unit.ships_paths || []).find(shipped => evidenceNameMatchesShippedToken(shipped, candidate));
      if (!hit) continue;
      candidate.bundled_into = unit.name;
      candidate.evidence = [
        ...new Set([...candidate.evidence, `bundled-into:${unit.name}`, `positive-bundling-evidence:ships_paths:${hit}`]),
      ];
      break;
    }
  }
}

function stripImageTagAndRegistry(ref: string): string {
  const withoutDigest = ref.split('@')[0];
  const withoutTag = withoutDigest.includes(':') ? withoutDigest.split(':')[0] : withoutDigest;
  const segments = withoutTag.split('/').filter(Boolean);
  return segments[segments.length - 1] || withoutTag;
}

function entrypointTokenMatchesName(entrypointMember: string | undefined, name: string): boolean {
  if (!entrypointMember || !name) return false;
  return normalizeMemberToken(path.basename(entrypointMember)) === normalizeMemberToken(name);
}

function isDockerfileWithinBuildContext(composeRootPath: string, containerRootPath: string): boolean {
  const rel = path.relative(composeRootPath || '.', containerRootPath || '.');
  return !path.isAbsolute(rel) && !rel.startsWith('..');
}

function joinComposeAndContainerUnits(items: DeployableEvidence[]): DeployableEvidence[] {
  const composeRows = items.filter(item => item.tier === 1 && item.kind === 'compose-service');
  const containerRows = items.filter(item => item.tier === 1 && item.kind === 'container');
  if (!composeRows.length || !containerRows.length) return items;

  const merged = new Set<DeployableEvidence>();

  for (const compose of composeRows) {
    const composeKey = normalizeMemberToken(compose.name);
    if (!composeKey) continue;

    const match = containerRows.find(container => {
      if (merged.has(container)) return false;
      const pathAgrees = isDockerfileWithinBuildContext(compose.root_path, container.root_path);
      const entrypointAgrees = entrypointTokenMatchesName(container.entrypoint_member, compose.name);
      if (container.name === UNNAMED_SERVICE_PLACEHOLDER) {
        return pathAgrees || entrypointAgrees;
      }
      if (normalizeMemberToken(container.name) !== composeKey) return false;
      return pathAgrees || entrypointAgrees;
    });
    if (!match) continue;

    compose.evidence = [...new Set([...compose.evidence, ...match.evidence, `merged-container-identity:${match.name}`])];
    compose.entry_files = unionOptional(compose.entry_files, match.entry_files);
    const unionShipsPaths = [...new Set([...(compose.ships_paths || []), ...(match.ships_paths || [])])];
    compose.ships_paths = unionShipsPaths.length ? unionShipsPaths : undefined;
    if (!compose.entrypoint_member && match.entrypoint_member) compose.entrypoint_member = match.entrypoint_member;
    const unionBaseImages = [...new Set([...(compose.base_images || []), ...(match.base_images || [])])];
    compose.base_images = unionBaseImages.length ? unionBaseImages : undefined;
    const unionPorts = [...new Set([...(compose.ports || []), ...(match.ports || [])])];
    compose.ports = unionPorts.length ? unionPorts : undefined;
    merged.add(match);
  }

  return merged.size ? items.filter(item => !merged.has(item)) : items;
}

function mergeSameNamedTier1Rows(items: DeployableEvidence[]): DeployableEvidence[] {
  const groups = new Map<string, DeployableEvidence[]>();
  const passthrough: DeployableEvidence[] = [];
  for (const item of items) {
    if (item.tier !== 1 || item.name === UNNAMED_SERVICE_PLACEHOLDER) {
      passthrough.push(item);
      continue;
    }
    const key = `${item.kind}::${normalizeMemberToken(item.name)}`;
    if (!key || normalizeMemberToken(item.name) === '') {
      passthrough.push(item);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  const out: DeployableEvidence[] = [...passthrough];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const ranked = [...group].sort((a, b) => {
      const evidenceDiff = b.evidence.length - a.evidence.length;
      if (evidenceDiff !== 0) return evidenceDiff;
      return items.indexOf(a) - items.indexOf(b);
    });
    const [survivor, ...rest] = ranked;
    for (const dupe of rest) {
      survivor.evidence = [...new Set([...survivor.evidence, ...dupe.evidence, `merged-same-name-tier1:${dupe.kind}:${dupe.root_path}`])];
      survivor.entry_files = unionOptional(survivor.entry_files, dupe.entry_files);
      survivor.ships_paths = unionOptional(survivor.ships_paths, dupe.ships_paths);
      survivor.ports = unionOptional(survivor.ports, dupe.ports);
      survivor.base_images = unionOptional(survivor.base_images, dupe.base_images);
      survivor.entrypoint_member ||= dupe.entrypoint_member;
    }
    out.push(survivor);
  }
  return out.sort((a, b) => items.indexOf(a) - items.indexOf(b));
}

function classifyBuildStageContainers(items: DeployableEvidence[]): DeployableEvidence[] {
  const containers = items.filter(item => item.tier === 1 && item.kind === 'container');
  if (!containers.length) return items;

  const baseImageSources = items.filter(item => item.tier === 1 && (item.base_images?.length ?? 0) > 0);

  const hasRuntimeEntrypoint = (item: DeployableEvidence): boolean =>
    Boolean(item.entrypoint_member);

  const usedAsBaseElsewhere = (candidate: DeployableEvidence): boolean => {
    const candidateKey = normalizeMemberToken(candidate.name);
    if (!candidateKey || candidateKey.length < 3) return false;
    return baseImageSources.some(other => {
      if (other === candidate) return false;
      return (other.base_images || []).some(ref => {
        const token = normalizeMemberToken(stripImageTagAndRegistry(ref));
        if (!token) return false;
        return token === candidateKey || token.includes(candidateKey) || candidateKey.includes(token);
      });
    });
  };

  const isBuilderShape = (candidate: DeployableEvidence): boolean =>
    !hasRuntimeEntrypoint(candidate) &&
    (candidate.ships_paths?.length ?? 0) >= 2 &&
    (candidate.base_images?.length ?? 0) >= 2;

  const out: DeployableEvidence[] = [];
  for (const item of items) {
    const isBuildInfra =
      item.tier === 1 &&
      item.kind === 'container' &&
      !hasRuntimeEntrypoint(item) &&
      (usedAsBaseElsewhere(item) || isBuilderShape(item));

    if (!isBuildInfra) {
      out.push(item);
      continue;
    }

    const namedTargets = item.ships_paths || [];
    if (!namedTargets.length) continue;

    out.push({
      ...item,
      tier: 3,
      kind: 'build-image',
      bundled_into: namedTargets.length === 1 ? namedTargets[0] : item.bundled_into,
      evidence: [
        ...item.evidence,
        namedTargets.length === 1
          ? `build-infra: excluded from ship-unit tier (builds for ${namedTargets[0]})`
          : `build-infra: excluded from ship-unit tier (builds for ${namedTargets.join(', ')})`,
      ],
    });
  }
  return out;
}

function collapseContainerVariants(items: DeployableEvidence[]): DeployableEvidence[] {
  const groups = new Map<string, DeployableEvidence[]>();
  for (const item of items) {
    if (item.tier !== 1 || item.kind !== 'container' || item.bundled_into) continue;
    const key = normalizeMemberToken(item.entrypoint_member || '');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => {
      const aPort = (a.ports?.length ?? 0) > 0 ? 0 : 1;
      const bPort = (b.ports?.length ?? 0) > 0 ? 0 : 1;
      if (aPort !== bPort) return aPort - bPort;
      return items.indexOf(a) - items.indexOf(b);
    });
    const survivor = ranked[0];
    for (const variant of ranked.slice(1)) {
      variant.bundled_into = survivor.name;
      variant.evidence = [
        ...new Set([
          ...variant.evidence,
          `packaging-variant-of:${survivor.name}`,
          `same entrypoint binary '${survivor.entrypoint_member}' as '${survivor.name}' — build variant, not a distinct deployable`,
        ]),
      ];
    }
  }
  return items;
}

function collapseWholeRepoPackagingVariants(items: DeployableEvidence[]): DeployableEvidence[] {
  const hasRepoRootContext = (item: DeployableEvidence): boolean =>
    item.evidence.includes('build-context: repo-root');

  const wholeRepoContainers = items.filter(
    item => item.tier === 1 && item.kind === 'container' && hasRepoRootContext(item),
  );
  if (wholeRepoContainers.length < 2) return items;

  const runtimeSurvivors = wholeRepoContainers.filter(
    item => !item.bundled_into && item.entrypoint_member,
  );
  const distinctIdentities = new Set(runtimeSurvivors.map(r => normalizeMemberToken(r.entrypoint_member!)));
  if (distinctIdentities.size !== 1) return items;
  const survivor = runtimeSurvivors[0];

  for (const item of wholeRepoContainers) {
    if (item === survivor || item.bundled_into || item.entrypoint_member) continue;
    item.bundled_into = survivor.name;
    item.evidence = [
      ...new Set([
        ...item.evidence,
        `packaging-variant-of:${survivor.name}`,
        `same repo-root build source as '${survivor.name}' (which ships entrypoint binary '${survivor.entrypoint_member}'), no runtime entrypoint of its own — packaging variant, not a distinct deployable`,
      ]),
    ];
  }
  return items;
}

function rebundleBinsIntoServiceUnits(items: DeployableEvidence[]): void {
  const serviceUnits = items.filter(
    item => item.tier === 1 && (item.kind === 'compose-service' || item.kind === 'container' || item.kind === 'k8s'),
  );
  if (!serviceUnits.length) return;

  for (const candidate of items) {
    if (candidate.tier === 1) continue;
    const candidateKey = normalizeMemberToken(candidate.name);
    if (!candidateKey) continue;

    const unit =
      serviceUnits.find(u => normalizeMemberToken(u.name) === candidateKey) ||
      serviceUnits.find(u => entrypointTokenMatchesName(u.entrypoint_member, candidate.name));
    if (!unit || unit.name === candidate.bundled_into) continue;

    candidate.bundled_into = unit.name;
    candidate.evidence = [
      ...new Set([...candidate.evidence, `bundled-into:${unit.name}`, 'positive-bundling-evidence:service-identity-match']),
    ];
  }
}

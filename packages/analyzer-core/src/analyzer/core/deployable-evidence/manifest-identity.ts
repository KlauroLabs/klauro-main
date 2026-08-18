import type { DeployableEvidence } from '../../../types/cas.types';

function identityToken(value: string): string {
  return value.trim().toLowerCase().replace(/\.(exe|msi|dmg|pkg|deb|rpm|appimage)$/i, '').replace(/[\s_-]+/g, '');
}

export function mergeManifestIdentityRows(items: DeployableEvidence[]): DeployableEvidence[] {
  const removed = new Set<DeployableEvidence>();
  for (const manifest of items) {
    if (manifest.tier !== 3 || manifest.kind !== 'package') continue;
    const manifestRoot = manifest.root_path.replace(/\\/g, '/').replace(/\/$/, '') || '.';
    const executable = items.find(candidate =>
      candidate !== manifest &&
      candidate.tier < manifest.tier &&
      candidate.kind !== 'installer' &&
      identityToken(candidate.name) === identityToken(manifest.name) &&
      (candidate.root_path.replace(/\\/g, '/').replace(/\/$/, '') || '.') === manifestRoot
    );
    if (!executable) continue;
    executable.evidence = [...new Set([...executable.evidence, ...manifest.evidence, `merged-manifest-identity:${manifest.name}`])];
    const entryFiles = [...new Set([...(executable.entry_files || []), ...(manifest.entry_files || [])])];
    executable.entry_files = entryFiles.length > 0 ? entryFiles : undefined;
    const paths = [...new Set([...(executable.ships_paths || []), ...(manifest.ships_paths || [])])];
    executable.ships_paths = paths.length > 0 ? paths : undefined;
    removed.add(manifest);
  }
  return removed.size > 0 ? items.filter(item => !removed.has(item)) : items;
}

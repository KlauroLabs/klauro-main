import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { arrayOf, IGNORE_GLOBS, safeGlobSync } from '../util';

/** Installers, desktop entries, service units, install/release scripts (distribution-artifact-analyzer output). */
function collectFromDistributionArtifactNodes(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const out: DeployableEvidence[] = [];

  for (const node of ctx.nodes) {
    const metadata = (node.metadata || {}) as Record<string, any>;
    const artifactKind = String(metadata.artifact_kind || '');
    if (!artifactKind || metadata.topology_surface !== 'distribution-artifacts') continue;

    const file = node.source?.file || '';
    const binaryNames: string[] = arrayOf(metadata.binary_names);
    const evidence: string[] = [`${artifactKind}: ${file}`];
    if (metadata.distribution_role) evidence.push(`role: ${metadata.distribution_role}`);
    if (binaryNames.length) evidence.push(`binaries: ${binaryNames.join(', ')}`);
    const installPaths: string[] = arrayOf(metadata.install_paths);
    if (installPaths.length) evidence.push(`install paths: ${installPaths.join(', ')}`);

    out.push({
      root_path: path.dirname(file) || '.',
      name: String(metadata.product_name || node.name),
      tier: 1,
      kind: artifactKind === 'installer' ? 'installer' : 'installer',
      evidence,
      ships_paths: binaryNames,
    });
  }

  return out;
}

/** Installers / packaging shell scripts (e.g. build-installer.sh) that bundle
 *  multiple binaries into one distribution artifact. Reads `cargo build -p X`
 *  args plus `cp target/release/<bin> ...` copy targets to recover real
 *  membership, independent of whether the Distribution Artifact Analyzer's
 *  own node pipeline fired for this file. */
function collectFromInstallerScripts(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];
  let files: string[] = [];
  try {
    files = safeGlobSync(['**/*installer*.sh', '**/build-installer.sh', '**/*installer*.bash'], {
      cwd: projectPath,
      ignore: IGNORE_GLOBS,
      nodir: true,
      absolute: false,
    });
  } catch {
    return out;
  }

  for (const relativeFile of files) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, relativeFile), 'utf8');
    } catch {
      continue;
    }

    const members = new Set<string>();
    for (const match of content.matchAll(/cargo\s+(?:build|install)\b[^\n]*/g)) {
      for (const pkgMatch of match[0].matchAll(/-p\s+([A-Za-z0-9_-]+)/g)) members.add(pkgMatch[1]);
    }
    for (const match of content.matchAll(/\bcp\s+[^\n]*target\/(?:release|debug)\/([A-Za-z0-9_-]+)/g)) {
      members.add(match[1]);
    }

    if (!members.size) continue;

    out.push({
      root_path: '.',
      name: path.basename(relativeFile, path.extname(relativeFile)),
      tier: 1,
      kind: 'installer',
      evidence: [
        `installer script: ${relativeFile}`,
        `bundles: ${[...members].join(', ')}`,
      ],
      ships_paths: [...members],
    });
  }

  return out;
}

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  return [...collectFromDistributionArtifactNodes(ctx), ...collectFromInstallerScripts(ctx)];
}

export const installerProvider: EvidenceProvider = {
  id: 'installer',
  tier: 1,
  collect,
};

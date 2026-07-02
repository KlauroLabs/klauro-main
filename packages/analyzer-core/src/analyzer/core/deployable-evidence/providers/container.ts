import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { arrayOf, formatPort, numericPorts } from '../util';

/** Parse a Dockerfile's real bundle membership: `cargo build -p X -p Y`
 *  package args, `COPY [--from=stage] .../release/<bin> <dest>` targets, and
 *  the ENTRYPOINT/CMD primary binary. Falls back to no members (caller uses
 *  base images) when the Dockerfile doesn't match any of these patterns. */
export function parseDockerfileMembers(projectPath: string, relativeFile: string): { members: string[]; entrypointMember?: string } {
  if (!relativeFile) return { members: [] };
  let content = '';
  try {
    content = fs.readFileSync(path.join(projectPath, relativeFile), 'utf8');
  } catch {
    return { members: [] };
  }

  const members = new Set<string>();
  for (const match of content.matchAll(/^\s*RUN\s+.*cargo\s+(?:build|install)\b[^\n]*/gim)) {
    for (const pkgMatch of match[0].matchAll(/-p\s+([A-Za-z0-9_-]+)/g)) members.add(pkgMatch[1]);
  }
  for (const match of content.matchAll(/^\s*COPY\s+(?:--from=\S+\s+)?(\S+)\s+(\S+)\s*$/gim)) {
    const source = match[1];
    const dest = match[2];
    const binName = path.basename(source);
    if (/\/(release|debug)\//.test(source) || /^\/usr\/local\/bin\//.test(dest) || /\/bin\//.test(dest)) {
      if (binName && binName !== '.' && !/\.(sh|sql|json|yaml|yml|toml|txt|md)$/i.test(binName)) {
        members.add(binName);
      }
    }
  }

  let entrypointMember: string | undefined;
  const entrypointMatch = content.match(/^\s*ENTRYPOINT\s+(.+)$/im) || content.match(/^\s*CMD\s+(.+)$/im);
  if (entrypointMatch) {
    const jsonArray = entrypointMatch[1].match(/\[\s*"([^"]+)"/);
    const raw = jsonArray ? jsonArray[1] : entrypointMatch[1].trim().split(/\s+/)[0];
    const baseName = path.basename(raw.replace(/["'\[\],]/g, ''));
    if (baseName && members.has(baseName)) entrypointMember = baseName;
    else if (baseName) entrypointMember = baseName;
  }

  return { members: [...members], entrypointMember };
}

/** Dockerfiles (container_image_definition nodes), compose services
 *  (compose_service nodes), and kubernetes_* nodes. */
function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, nodes } = ctx;
  const out: DeployableEvidence[] = [];

  for (const node of nodes) {
    if (node.type === 'container_image_definition') {
      const metadata = (node.metadata || {}) as Record<string, any>;
      const file = node.source?.file || '';
      const evidence: string[] = [`Dockerfile: ${file}`];
      const baseImages: string[] = arrayOf(metadata.base_images);
      if (baseImages.length) evidence.push(`FROM ${baseImages.join(', ')}`);
      if (metadata.command) evidence.push(`entrypoint/cmd: ${metadata.command}`);
      const exposedPorts: string[] = arrayOf(metadata.exposed_ports);
      if (exposedPorts.length) evidence.push(`EXPOSE ${exposedPorts.join(', ')}`);

      // Real bundle membership: parse the Dockerfile itself for what it
      // actually builds/COPYs/ships, rather than base-image lineage (which is
      // useless for membership — every stage in a multi-stage build often
      // shares the same FROM images regardless of what binaries it packages).
      const dockerfileMembers = parseDockerfileMembers(projectPath, file);
      const shipsPaths = dockerfileMembers.members.length ? dockerfileMembers.members : baseImages;
      if (dockerfileMembers.members.length) {
        evidence.push(`builds/copies: ${dockerfileMembers.members.join(', ')}`);
      }
      if (dockerfileMembers.entrypointMember) {
        evidence.push(`entrypoint-member: ${dockerfileMembers.entrypointMember}`);
      }

      out.push({
        root_path: path.dirname(file) || '.',
        name: node.name || file,
        tier: 1,
        kind: 'container',
        evidence,
        ships_paths: shipsPaths,
        ports: numericPorts(exposedPorts),
        entrypoint_member: dockerfileMembers.entrypointMember,
      });
    }

    if (node.type === 'compose_service') {
      const metadata = (node.metadata || {}) as Record<string, any>;
      const file = node.source?.file || '';
      const evidence: string[] = [`compose service: ${metadata.deployment_service_name || node.name} (${file})`];
      if (metadata.image) evidence.push(`image: ${metadata.image}`);
      if (metadata.build) evidence.push(`build: ${metadata.build}`);
      const ports: Array<{ host?: string; container: string }> = Array.isArray(metadata.ports) ? metadata.ports : [];
      if (ports.length) evidence.push(`ports: ${ports.map(formatPort).join(', ')}`);

      out.push({
        root_path: metadata.build ? String(metadata.build) : path.dirname(file) || '.',
        name: String(metadata.deployment_service_name || node.name),
        tier: 1,
        kind: 'compose-service',
        evidence,
        ports: numericPorts(ports.map(p => p.container)),
      });
    }

    if (typeof node.type === 'string' && node.type.startsWith('kubernetes_')) {
      const metadata = (node.metadata || {}) as Record<string, any>;
      const file = node.source?.file || '';
      const evidence: string[] = [`kubernetes ${metadata.kubernetes_kind || node.type}: ${metadata.deployment_service_name || node.name} (${file})`];
      const images: string[] = arrayOf(metadata.images);
      if (images.length) evidence.push(`images: ${images.join(', ')}`);
      const ports: string[] = arrayOf(metadata.ports);
      if (ports.length) evidence.push(`ports: ${ports.join(', ')}`);

      out.push({
        root_path: path.dirname(file) || '.',
        name: String(metadata.deployment_service_name || node.name),
        tier: 1,
        kind: 'k8s',
        evidence,
        ships_paths: images,
        ports: numericPorts(ports),
      });
    }
  }

  // External service exit points recorded by the compose analyzer (image-only
  // services with no own build) are dependencies, not ship-declarations of
  // this workspace — intentionally excluded here.
  void ctx.exitPoints;

  return out;
}

export const containerProvider: EvidenceProvider = {
  id: 'container',
  tier: 1,
  collect,
};

import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { arrayOf, formatPort, numericPorts, safeDeployableName } from '../util';







const WORKLOAD_KUBERNETES_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job']);








function isRealMemberToken(token: string): boolean {
  const t = token.trim();
  if (!t || t.length < 2) return false;

  if (t.includes(':')) return false;
  if (/^\$?\{?[A-Z0-9_]+\}?$/.test(t) && /\$|\{/.test(t)) return false;
  if (/\b(alpine|debian|ubuntu|distroless|scratch|buster|bookworm|slim|busybox)\b/i.test(t)) return false;

  if (/^(--?[a-z].*|&&|\|\||;|\.|\.\.|-p|from|as)$/i.test(t)) return false;

  if (/[.,;]$/.test(t)) return false;












  if (/\.(sh|bash|sql|json|yaml|yml|toml|txt|md|spec|conf)$/i.test(t)) return false;
  return true;
}








function hasWholeRepoBuildContext(content: string): boolean {
  return /^\s*(?:ADD|COPY)\s+\.\s+\S+/m.test(content);
}





export function parseDockerfileMembers(
  projectPath: string,
  relativeFile: string,
): { members: string[]; entrypointMember?: string; wholeRepoBuildContext: boolean } {
  if (!relativeFile) return { members: [], wholeRepoBuildContext: false };
  let content = '';
  try {
    content = fs.readFileSync(path.join(projectPath, relativeFile), 'utf8');
  } catch {
    return { members: [], wholeRepoBuildContext: false };
  }

  const members = new Set<string>();








  const builtBinaries = new Set<string>();
  for (const match of content.matchAll(/^\s*RUN\s+.*cargo\s+(?:build|install)\b[^\n]*/gim)) {
    for (const pkgMatch of match[0].matchAll(/-p\s+([A-Za-z0-9_-]+)/g)) {
      members.add(pkgMatch[1]);
      builtBinaries.add(pkgMatch[1]);
    }
  }
  for (const match of content.matchAll(/^\s*COPY\s+(?:--from=\S+\s+)?(\S+)\s+(\S+)\s*$/gim)) {
    const source = match[1];
    const dest = match[2];
    const binName = path.basename(source);
    const isBuildOutput = /\/(release|debug)\//.test(source);
    if (isBuildOutput || /^\/usr\/local\/bin\//.test(dest) || /\/bin\//.test(dest)) {
      if (binName && binName !== '.' && !/\.(sh|sql|json|yaml|yml|toml|txt|md)$/i.test(binName)) {
        members.add(binName);
        if (isBuildOutput) builtBinaries.add(binName);
      }
    }
  }












  const firstToken = (raw: string): string => {
    const jsonArray = raw.match(/\[\s*"([^"]+)"/);
    const token = jsonArray ? jsonArray[1] : raw.trim().split(/\s+/)[0];
    return path.basename(token.replace(/["'\[\],]/g, ''));
  };
  const entrypointRawMatch = content.match(/^\s*ENTRYPOINT\s+(.+)$/im);
  const cmdRawMatch = content.match(/^\s*CMD\s+(.+)$/im);
  const entrypointBaseName = entrypointRawMatch ? firstToken(entrypointRawMatch[1]) : undefined;
  const cmdBaseName = cmdRawMatch ? firstToken(cmdRawMatch[1]) : undefined;

  let entrypointMember: string | undefined;
  if (entrypointBaseName && members.has(entrypointBaseName)) entrypointMember = entrypointBaseName;
  else if (cmdBaseName && members.has(cmdBaseName)) entrypointMember = cmdBaseName;
  else if (builtBinaries.size === 1) {








    entrypointMember = [...builtBinaries][0];
  } else entrypointMember = entrypointBaseName || cmdBaseName;




  const cleanMembers = [...members].filter(isRealMemberToken);
  const cleanEntrypoint =
    entrypointMember && isRealMemberToken(entrypointMember) ? entrypointMember : undefined;
  return { members: cleanMembers, entrypointMember: cleanEntrypoint, wholeRepoBuildContext: hasWholeRepoBuildContext(content) };
}
















function dockerfileDeployableName(
  file: string,
  metadata: Record<string, any>,
  ctx: EvidenceCollectionContext,
): string {
  const norm = file.replace(/\\/g, '/');
  const base = path.basename(norm);


  const namedStem =
    base !== 'Dockerfile'
      ? base.replace(/\.?dockerfile$/i, '').replace(/^dockerfile\.?/i, '') || ''
      : '';
  if (namedStem) return safeDeployableName(namedStem.toLowerCase());

  const dir = path.dirname(norm).replace(/\/+$/, '');
  const dirBase = dir && dir !== '.' ? path.basename(dir) : '';
  if (dirBase) return safeDeployableName(dirBase);


  const alias = arrayOf(metadata.service_aliases)[0];
  if (alias) return safeDeployableName(alias);
  return safeDeployableName(ctx.displayName || path.basename(ctx.projectPath));
}



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










      const dockerfileMembers = parseDockerfileMembers(projectPath, file);
      const shipsPaths = dockerfileMembers.members;
      if (dockerfileMembers.members.length) {
        evidence.push(`builds/copies: ${dockerfileMembers.members.join(', ')}`);
      }
      if (dockerfileMembers.entrypointMember) {
        evidence.push(`entrypoint-member: ${dockerfileMembers.entrypointMember}`);
      }
      if (dockerfileMembers.wholeRepoBuildContext) {
        evidence.push('build-context: repo-root');
      }

      out.push({
        root_path: path.dirname(file) || '.',
        name: dockerfileDeployableName(file, metadata, ctx),
        tier: 1,
        kind: 'container',
        evidence,
        ships_paths: shipsPaths.length ? shipsPaths : undefined,
        ports: numericPorts(exposedPorts),
        entrypoint_member: dockerfileMembers.entrypointMember,




        base_images: baseImages.length ? baseImages : undefined,
      });
    }

    if (node.type === 'compose_service') {
      const metadata = (node.metadata || {}) as Record<string, any>;
      const file = node.source?.file || '';











      if (!metadata.build) continue;

      const evidence: string[] = [`compose service: ${metadata.deployment_service_name || node.name} (${file})`];
      if (metadata.image) evidence.push(`image: ${metadata.image}`);
      evidence.push(`build: ${metadata.build}`);
      const ports: Array<{ host?: string; container: string }> = Array.isArray(metadata.ports) ? metadata.ports : [];
      if (ports.length) evidence.push(`ports: ${ports.map(formatPort).join(', ')}`);
























      const composeDir = path.dirname(file) || '.';
      const buildContext = String(metadata.build);
      const dockerfilePath = metadata.dockerfile ? String(metadata.dockerfile) : undefined;
      const contextIsUnresolvable = path.isAbsolute(buildContext);
      const rootPath = dockerfilePath
        ? path.normalize(path.dirname(
            path.isAbsolute(dockerfilePath)
              ? dockerfilePath
              : path.join(composeDir === '.' ? '' : composeDir, dockerfilePath),
          )) || '.'
        : contextIsUnresolvable



          ? composeDir
          : path.normalize(path.join(composeDir === '.' ? '' : composeDir, buildContext)) || '.';

      out.push({
        root_path: rootPath,
        name: String(metadata.deployment_service_name || node.name),
        tier: 1,
        kind: 'compose-service',
        evidence,
        ports: numericPorts(ports.map(p => p.container)),
      });
    }

    if (typeof node.type === 'string' && node.type.startsWith('kubernetes_')) {
      const metadata = (node.metadata || {}) as Record<string, any>;
      const attributes = (metadata.attributes || {}) as Record<string, any>;
      const file = node.source?.file || '';
      const kind = String(metadata.kubernetes_kind || attributes.kubernetes_kind || '');









      const isHelmOrigin = metadata.language === 'Helm' || attributes.topology_surface === 'helm';
      if (isHelmOrigin) continue;








      if (!WORKLOAD_KUBERNETES_KINDS.has(kind)) continue;

      const evidence: string[] = [`kubernetes ${kind || node.type}: ${metadata.deployment_service_name || node.name} (${file})`];
      const images: string[] = arrayOf(metadata.images);
      if (images.length) evidence.push(`images: ${images.join(', ')}`);
      const ports: string[] = arrayOf(metadata.ports);
      if (ports.length) evidence.push(`ports: ${ports.join(', ')}`);





      const siblingCitations = nodes
        .filter(sibling =>
          sibling !== node &&
          typeof sibling.type === 'string' &&
          sibling.type.startsWith('kubernetes_') &&
          (sibling.source?.file || '') === file &&
          !WORKLOAD_KUBERNETES_KINDS.has(String((sibling.metadata as any)?.kubernetes_kind || (sibling.metadata as any)?.attributes?.kubernetes_kind || '')),
        )
        .map(sibling => `${(sibling.metadata as any)?.kubernetes_kind || sibling.type}: ${(sibling.metadata as any)?.deployment_service_name || sibling.name}`);
      if (siblingCitations.length) evidence.push(`attached resources: ${siblingCitations.join(', ')}`);

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




  void ctx.exitPoints;

  return out;
}

export const containerProvider: EvidenceProvider = {
  id: 'container',
  tier: 1,
  collect,
};

import type { CASEntryPoint, CASNode, DeployableEvidence } from '../../types/cas.types';
























export interface DeployableRoot {
  deployable_id: string;
  deployable_name: string;
  rootPath: string;
}

export interface DeployableRootEntry {
  evidence: DeployableEvidence;
  root: DeployableRoot;
}








export interface CASEntryPointWithDeployable extends CASEntryPoint {
  deployable_id?: string;
  deployable_name?: string;
}














export function buildDeployableRoots(deployableEvidence: DeployableEvidence[] | undefined): DeployableRoot[] {
  return buildDeployableRootEntries(deployableEvidence).map(entry => entry.root);
}

export function buildDeployableRootEntries(deployableEvidence: DeployableEvidence[] | undefined): DeployableRootEntry[] {
  if (!deployableEvidence || deployableEvidence.length === 0) {
    return [];
  }

  const seenIds = new Set<string>();
  const entries: DeployableRootEntry[] = [];

  const orderedEvidence = deployableEvidence
    .map(evidence => ({ evidence, rootPath: normalizePath(evidence.root_path) }))
    .sort((left, right) =>
      left.rootPath.localeCompare(right.rootPath) ||
      left.evidence.kind.localeCompare(right.evidence.kind) ||
      left.evidence.name.localeCompare(right.evidence.name) ||
      JSON.stringify(left.evidence).localeCompare(JSON.stringify(right.evidence))
    );

  orderedEvidence.forEach(({ evidence, rootPath }, index) => {
    const baseId = `dep:${evidence.kind}:${slug(rootPath)}:${slug(evidence.name)}`;
    let deployable_id = baseId;
    if (seenIds.has(deployable_id)) {
      deployable_id = `${baseId}:${index}`;
    }
    seenIds.add(deployable_id);

    entries.push({
      evidence,
      root: {
        deployable_id,
        deployable_name: evidence.name,
        rootPath,
      },
    });
  });

  return entries;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}























export function extractEntryPointFilePath(ep: CASEntryPoint, nodesById?: Map<string, CASNode>): string | undefined {
  if (ep.handler?.file) {
    const handlerFile = ep.handler.file;
    if (nodesById) {
      const nodeId = ep.handler.node_id || ep.source_node;
      const node = nodeId ? nodesById.get(nodeId) : undefined;
      const nodeFile = node?.source?.file;
      if (nodeFile && nodeFile !== handlerFile && nodeFile.endsWith(`/${handlerFile}`)) {
        return normalizePath(nodeFile);
      }
    }
    return normalizePath(handlerFile);
  }

  const candidates = [ep.source_node, ep.id];


  const pathPattern = /([\w.-]+\/)+[\w.-]+\.\w{1,10}/;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = candidate.match(pathPattern);
    if (match) {
      return normalizePath(match[0]);
    }
  }

  return undefined;
}








export function matchDeployableRoot(filePath: string, roots: DeployableRoot[]): DeployableRoot | undefined {
  let best: DeployableRoot | undefined;
  let bestLength = -1;

  for (const root of roots) {
    if (isPathPrefix(root.rootPath, filePath) && root.rootPath.length > bestLength) {
      best = root;
      bestLength = root.rootPath.length;
    }
  }

  return best;
}

function isPathPrefix(rootPath: string, filePath: string): boolean {
  if (!rootPath || rootPath === '.') {




    return true;
  }
  if (filePath === rootPath) return true;
  return filePath.startsWith(`${rootPath}/`);
}
















export function attachDeployable(
  entryPoints: CASEntryPoint[],
  deployableEvidence: DeployableEvidence[] | undefined,
  nodes?: CASNode[],
): CASEntryPointWithDeployable[] {
  const roots = buildDeployableRoots(deployableEvidence);
  if (roots.length === 0) {
    return entryPoints.map(ep => ({ ...ep }));
  }
  const nodesById = nodes ? new Map(nodes.map(n => [n.id, n])) : undefined;

  return entryPoints.map(ep => {
    const filePath = extractEntryPointFilePath(ep, nodesById);
    if (!filePath) {
      return { ...ep };
    }

    const match = matchDeployableRoot(filePath, roots);
    if (!match) {
      return { ...ep };
    }

    return {
      ...ep,
      deployable_id: match.deployable_id,
      deployable_name: match.deployable_name,
    };
  });
}









export function synthesizeEntryPointDescription(ep: CASEntryPoint): string {
  const name = ep.name || ep.id;

  switch (ep.type) {
    case 'http': {
      const method = ep.trigger?.method && ep.trigger.method !== 'ALL' ? ep.trigger.method : 'HTTP';
      const path = ep.trigger?.path || ep.trigger?.pattern;
      return path
        ? `${method} ${path} endpoint — ${name}`
        : `${method} endpoint — ${name}`;
    }
    case 'schedule': {
      const schedule = ep.trigger?.schedule;
      return schedule
        ? `Scheduled job (${schedule}) — ${name}`
        : `Scheduled job — ${name}`;
    }
    case 'message': {
      return `Handles the ${name} message`;
    }
    case 'event': {
      const event = ep.trigger?.event;
      return event
        ? `Handles the ${event} event — ${name}`
        : `Handles the ${name} event`;
    }
    case 'cli': {
      return `CLI command ${name}`;
    }
    case 'test': {
      return `Test entry point ${name}`;
    }
    default: {
      return `${ep.type} entry point — ${name}`;
    }
  }
}












export function ensureEntryPointDescription(entryPoints: CASEntryPoint[]): CASEntryPoint[] {
  return entryPoints.map(ep => {
    const hasDescription = typeof ep.description === 'string' && ep.description.trim().length > 0;

    if (hasDescription) {
      if (ep.description_source) {
        return { ...ep };
      }
      return { ...ep, description_source: 'deterministic' as const };
    }

    return {
      ...ep,
      description: synthesizeEntryPointDescription(ep),
      description_source: 'deterministic' as const,
    };
  });
}

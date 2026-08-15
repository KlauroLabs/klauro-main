




















import {
  CASNode,
  CASEntryPoint,
  CASExitPoint,
  CASDecorator,
  CASDeclaredDependency,
  CASDependencyManifest,
  CASFrameworkIdentity,
  CASFrameworkRole,
} from '../../types/cas.types';

const WEB_ENTRY_TYPES = new Set(['http', 'websocket', 'route', 'api', 'graphql', 'page']);
const BUILD_ENTRY_TYPES = new Set(['cli', 'task', 'pipeline', 'command', 'notebook-cell', 'train']);
const QUEUE_ENTRY_TYPES = new Set(['schedule', 'message', 'event', 'interrupt']);
const QUEUE_EXIT_TYPES = new Set(['message', 'event']);

function normalizeFrameworkName(value: unknown): string {
  return String(value ?? '').trim().replace(/\s*analyzer$/i, '').replace(/^enhanced\s+/i, '').trim().toLowerCase();
}






function packageNameMatchesFramework(packageName: string, frameworkName: string): boolean {
  const a = packageName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = frameworkName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function findVersion(frameworkName: string, dependencyManifest?: CASDependencyManifest): { version?: string; ecosystem?: CASDeclaredDependency['ecosystem'] } {
  if (!dependencyManifest) return {};


  const exact = dependencyManifest.dependencies.find(dep => packageNameMatchesFramework(dep.name, frameworkName) &&
    dep.name.toLowerCase().replace(/[^a-z0-9]/g, '') === frameworkName.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const loose = exact || dependencyManifest.dependencies.find(dep => packageNameMatchesFramework(dep.name, frameworkName));
  if (!loose) return {};
  return { version: loose.version, ecosystem: loose.ecosystem };
}

export interface FrameworkRoleSignal {
  role: CASFrameworkRole;
  confidence: number;
  evidence: string;
}





export function deriveFrameworkRole(
  frameworkName: string,
  entryTypes: string[],
  exitTypes: string[],
  decoratorCategories: string[],
): FrameworkRoleSignal {
  const entrySet = new Set(entryTypes);
  const exitSet = new Set(exitTypes);
  const decoratorSet = new Set(decoratorCategories);
  const evidenceParts: string[] = [];
  if (entryTypes.length) evidenceParts.push(`entry-point types [${[...new Set(entryTypes)].sort().join(', ')}]`);
  if (exitTypes.length) evidenceParts.push(`exit-point types [${[...new Set(exitTypes)].sort().join(', ')}]`);
  if (decoratorCategories.length) evidenceParts.push(`decorator categories [${[...new Set(decoratorCategories)].sort().join(', ')}]`);
  const cite = (role: CASFrameworkRole) => ({
    role,
    confidence: evidenceParts.length > 0 ? 0.8 : 0.3,
    evidence: evidenceParts.length > 0
      ? `${evidenceParts.join('; ')} produced by '${frameworkName}' contribution nodes`
      : `no entry/exit-point or decorator evidence found for '${frameworkName}'; role left as fallback`,
  });

  if ([...entrySet].some(t => WEB_ENTRY_TYPES.has(t))) return cite('web');
  if (entrySet.has('test')) return cite('test');



  if (decoratorSet.has('injection')) return cite('di');
  if ([...entrySet].some(t => BUILD_ENTRY_TYPES.has(t))) return cite('build');
  if ([...entrySet].some(t => QUEUE_ENTRY_TYPES.has(t)) || [...exitSet].some(t => QUEUE_EXIT_TYPES.has(t))) return cite('queue');
  if (exitSet.has('database')) return cite('orm');
  if (exitSet.has('analytics')) return cite('observability');
  return cite('other');
}

export function deriveFrameworkIdentities(
  frameworkNames: string[],
  nodes: CASNode[],
  entryPoints: CASEntryPoint[],
  exitPoints: CASExitPoint[],
  decorators: CASDecorator[],
  dependencyManifest?: CASDependencyManifest,
): CASFrameworkIdentity[] {
  if (frameworkNames.length === 0) return [];



  const frameworkByNodeId = new Map<string, string>();
  for (const node of nodes) {
    const framework = normalizeFrameworkName((node as any).metadata?.framework);
    if (framework) frameworkByNodeId.set(node.id, framework);
  }

  const identities: CASFrameworkIdentity[] = [];
  for (const displayName of frameworkNames) {
    const normalized = normalizeFrameworkName(displayName);
    const nodeIds = new Set<string>();
    for (const [nodeId, fw] of frameworkByNodeId) {
      if (fw === normalized) nodeIds.add(nodeId);
    }

    const entryTypes: string[] = [];
    for (const entry of entryPoints) {
      const owner = entry.handler?.node_id || entry.source_node;
      if (owner && nodeIds.has(owner)) entryTypes.push(entry.type);
    }
    const exitTypes: string[] = [];
    for (const exit of exitPoints) {
      if (nodeIds.has(exit.source_node)) exitTypes.push(exit.type);
    }
    const decoratorCategories: string[] = [];
    for (const decorator of decorators) {
      if (normalizeFrameworkName(decorator.decorator_info?.framework) === normalized) {
        decoratorCategories.push(decorator.semantic_meaning.category);
      }
    }

    const roleSignal = deriveFrameworkRole(displayName, entryTypes, exitTypes, decoratorCategories);
    const { version, ecosystem } = findVersion(displayName, dependencyManifest);

    identities.push({
      name: displayName,
      ...(version ? { version } : {}),
      ...(ecosystem ? { ecosystem } : {}),
      role: roleSignal.role,
      role_confidence: roleSignal.confidence,
      role_evidence: roleSignal.evidence,
    });
  }

  return identities;
}

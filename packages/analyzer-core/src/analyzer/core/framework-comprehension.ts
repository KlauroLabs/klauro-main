











































export const FRAMEWORK_APPLICATION_SURFACE_TYPES = new Set<string>([
  'application', 'app',
  'react_app', 'functional_component', 'class_component', 'component',
  'hook_usage', 'page', 'layout',
  'route', 'endpoint', 'api_endpoint', 'http_endpoint', 'graphql_endpoint',
  'controller', 'view', 'resolver', 'graphql_resolver',
  'websocket', 'gateway', 'island', 'server_component',
]);















export const FRAMEWORK_APPLICATION_SURFACE_ROLES = new Set<string>(['controller', 'resolver', 'gateway']);

const CONTAINMENT_EDGE_TYPES = new Set(['contains', 'has_method', 'declares']);

interface FrameworkEvidenceNode {
  id?: string;
  type?: string;
  role?: string;
  parent?: string;
  metadata?: { framework?: unknown } & Record<string, unknown>;
  source?: { file?: string };
  analyzers?: string[];
}

interface FrameworkEvidenceEdge {
  type?: string;
  source?: string;
  target?: string;
}

interface FrameworkEvidenceEntryPoint {
  source_node?: string;
  source_analyzer?: string;
  metadata?: { framework?: unknown } & Record<string, unknown>;
}
















function hasApplicationSurfaceEvidence(
  node: FrameworkEvidenceNode,
  nodesById: Map<string, FrameworkEvidenceNode>,
  containmentOwnerByTarget: ReadonlyMap<string, string>,
): boolean {
  if (node.type && FRAMEWORK_APPLICATION_SURFACE_TYPES.has(node.type)) return true;
  if (node.role && FRAMEWORK_APPLICATION_SURFACE_ROLES.has(node.role)) return true;
  if (!node.id) return false;
  const ownerId = node.parent ?? containmentOwnerByTarget.get(node.id);
  if (!ownerId) return false;
  const owner = nodesById.get(ownerId);
  return Boolean(owner?.role && FRAMEWORK_APPLICATION_SURFACE_ROLES.has(owner.role));
}




















export function selectProductFrameworkNames(
  nodes: FrameworkEvidenceNode[],
  edges: FrameworkEvidenceEdge[],
  analyzerTypeById: Map<string, string>,
  isProductNode: (node: FrameworkEvidenceNode) => boolean,
  limit = 10,
  entryPoints: FrameworkEvidenceEntryPoint[] = [],
): string[] {
  const nodesById = new Map(nodes.filter(n => n.id).map(n => [n.id as string, n] as const));
  const containmentOwnerByTarget = new Map<string, string>();
  for (const edge of edges) {
    if (!edge.type || !CONTAINMENT_EDGE_TYPES.has(edge.type) || !edge.target || !edge.source) continue;
    if (!containmentOwnerByTarget.has(edge.target)) containmentOwnerByTarget.set(edge.target, edge.source);
  }

  const surfaceByFramework = new Map<string, boolean>();
  const firstSeenOrder: string[] = [];

  for (const node of nodes) {
    const framework = normalizeFrameworkName(node.metadata?.framework);
    if (!framework) continue;
    const analyzers = Array.isArray(node.analyzers) ? node.analyzers : [];
    const analyzerTypes = analyzers.map(id => analyzerTypeById.get(id));
    const surfaceEvidence = hasApplicationSurfaceEvidence(node, nodesById, containmentOwnerByTarget);







    const isFrameworkAnalyzer = analyzerTypes.includes('framework');
    const isSurfacedLanguageAnalyzer = analyzerTypes.includes('language') && surfaceEvidence;
    if (!isFrameworkAnalyzer && !isSurfacedLanguageAnalyzer) continue;

    if (!isProductNode(node)) continue;

    if (!surfaceByFramework.has(framework)) {
      surfaceByFramework.set(framework, false);
      firstSeenOrder.push(framework);
    }

    if (surfaceEvidence) {
      surfaceByFramework.set(framework, true);
    }
  }

  for (const entryPoint of entryPoints) {
    const analyzerId = String(entryPoint.source_analyzer || '');
    if (analyzerTypeById.get(analyzerId) !== 'framework') continue;
    const owner = entryPoint.source_node ? nodesById.get(entryPoint.source_node) : undefined;
    if (!owner || !isProductNode(owner)) continue;
    const framework = normalizeFrameworkName(entryPoint.metadata?.framework || analyzerId);
    if (!framework) continue;
    if (!surfaceByFramework.has(framework)) firstSeenOrder.push(framework);
    surfaceByFramework.set(framework, true);
  }

  return firstSeenOrder
    .filter(framework => surfaceByFramework.get(framework))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}




export function analyzerTypeMap(
  contributions: Array<{ analyzer_id?: string; analyzer_type?: string; contribution_type?: string }> = [],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const contribution of contributions) {
    const id = contribution.analyzer_id;
    if (!id) continue;
    const type = contribution.analyzer_type || contribution.contribution_type;
    if (type) map.set(id, type);
  }
  return map;
}

function normalizeFrameworkName(value: unknown): string {
  const name = String(value ?? '')
    .trim()
    .replace(/\s*analyzer$/i, '')
    .replace(/^enhanced\s+/i, '')
    .trim();
  if (!name) return '';

  if (/\b(language|ast|analyzer)\b/i.test(name)) return '';
  return name;
}

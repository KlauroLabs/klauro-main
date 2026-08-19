import type { CASNode, CASEdge, CASEntryPoint } from '../../types/cas.types';
import { httpRoutePathsMatch } from './http-route-path';

interface HttpRequestLiteral {
  method: string;
  path: string;
}

function testHttpRequests(node: CASNode): HttpRequestLiteral[] {
  const requests = node.metadata?.attributes?.http_requests;
  if (!Array.isArray(requests)) return [];
  return requests.filter((request): request is HttpRequestLiteral =>
    typeof request === 'object' &&
    request !== null &&
    typeof request.method === 'string' &&
    typeof request.path === 'string'
  );
}

export function linkHttpTestCoverage(
  nodes: CASNode[],
  edges: CASEdge[],
  entryPoints: CASEntryPoint[],
): number {
  const existing = new Set(edges.map(edge => `${edge.source}\0${edge.target}\0${edge.type}`));
  const httpEntries = entryPoints.filter(entryPoint =>
    entryPoint.type === 'http' &&
    typeof entryPoint.trigger?.method === 'string' &&
    typeof entryPoint.trigger?.path === 'string'
  );
  const routeNodes = nodes.filter(node =>
    node.type === 'route' &&
    typeof node.metadata?.attributes?.method === 'string' &&
    typeof node.metadata?.attributes?.path === 'string'
  );
  const routeOwners = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== 'exposes') continue;
    const owners = routeOwners.get(edge.target) || [];
    owners.push(edge.source);
    routeOwners.set(edge.target, owners);
  }
  let linked = 0;
  for (const node of nodes) {
    if (node.type !== 'test' || node.subcategories?.includes('suite')) continue;
    for (const request of testHttpRequests(node)) {
      const matchingRouteNodes = routeNodes.filter(route =>
        request.method.toUpperCase() === String(route.metadata?.attributes?.method).toUpperCase() &&
        httpRoutePathsMatch(request.path, String(route.metadata?.attributes?.path))
      );
      const targets = new Set<string>();
      for (const entryPoint of httpEntries) {
        if (request.method.toUpperCase() !== entryPoint.trigger!.method!.toUpperCase()) continue;
        if (!httpRoutePathsMatch(request.path, entryPoint.trigger!.path!)) continue;
        if (entryPoint.source_node) targets.add(entryPoint.source_node);
        if (entryPoint.handler?.node_id) targets.add(entryPoint.handler.node_id);
      }
      for (const route of matchingRouteNodes) {
        targets.add(route.id);
        for (const owner of routeOwners.get(route.id) || []) targets.add(owner);
      }
      for (const target of targets) {
        const key = `${node.id}\0${target}\0tests`;
        if (existing.has(key)) continue;
        edges.push({
          id: `http_test_${node.id}_${target}`,
          source: node.id,
          target,
          type: 'tests',
          metadata: {
            confidence: 1,
            attributes: {
              evidence: 'http-request-literal',
              exact: true,
              method: request.method.toUpperCase(),
              path: request.path,
            },
          },
        });
        existing.add(key);
        linked++;
      }
    }
  }
  return linked;
}

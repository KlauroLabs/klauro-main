import { CASOutput, CASNode, CASEdge, EntryPoint, ExitPoint, CASCallChain } from '../types';

export interface Domain {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  capabilities: Capability[];
  stats: {
    entryPoints: number;
    exitPoints: number;
    components: number;
    hasDatabase: boolean;
    hasExternalApi: boolean;
    hasAuth: boolean;
  };
}

export interface Capability {
  id: string;
  name: string;
  description: string;
  action: string;
  entryPoint: EntryPoint;
  flow?: CASCallChain;
  flowSteps?: FlowStep[];
  method?: string;
  path?: string;
  requiresAuth: boolean;
}

export interface FlowStep {
  id: string;
  nodeId: string;
  name: string;
  nodeName: string;
  nodeType: string;
  depth: number;
  isEntry: boolean;
  isExit: boolean;
  description: string;
  source?: {
    file: string;
    line: number;
    end_line: number;
  };
}

const DOMAIN_COLORS: Record<string, string> = {
  auth: '#4caf50',
  workspaces: '#2196f3',
  codebases: '#9c27b0',
  analysis: '#ff9800',
  analyze: '#ff9800',
  users: '#e91e63',
  admin: '#f44336',
  health: '#607d8b',
  projects: '#00bcd4',
  organizations: '#795548',
  components: '#3f51b5',
  api: '#009688',
  default: '#757575',
};

const DOMAIN_ICONS: Record<string, string> = {
  auth: 'lock',
  workspaces: 'folder',
  codebases: 'code',
  analysis: 'analytics',
  analyze: 'analytics',
  users: 'people',
  admin: 'admin_panel_settings',
  health: 'monitor_heart',
  projects: 'folder',
  organizations: 'people',
  components: 'category',
  api: 'code',
  default: 'category',
};

function parseHttpEntryPointName(name: string): { method: string; path: string } | null {
  const match = name.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i);
  if (match) {
    return { method: match[1].toUpperCase(), path: match[2] };
  }
  return null;
}

function inferDomainFromPath(path: string): string {
  const cleanPath = path.replace(/^\/api\//, '').replace(/^\//, '');
  const firstSegment = cleanPath.split('/')[0];

  if (!firstSegment || firstSegment.startsWith(':')) {
    return 'general';
  }

  return firstSegment.toLowerCase();
}

function inferAction(method: string, path: string): string {
  const methodLower = method?.toLowerCase() || '';
  const pathParts = path.split('/').filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1];

  if (lastPart?.startsWith(':')) {
    switch (methodLower) {
      case 'get': return 'View';
      case 'put':
      case 'patch': return 'Update';
      case 'delete': return 'Delete';
      default: return 'Manage';
    }
  }

  switch (methodLower) {
    case 'get': return 'List';
    case 'post': return 'Create';
    case 'put':
    case 'patch': return 'Update';
    case 'delete': return 'Delete';
    default: return 'Manage';
  }
}

function generateCapabilityName(method: string, path: string): string {
  const action = inferAction(method, path);
  const pathParts = path.split('/').filter(p => p && !p.startsWith(':'));
  const resource = pathParts[pathParts.length - 1] || pathParts[0] || 'resource';

  const resourceName = resource
    .replace(/-/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();

  return `${action} ${resourceName}`;
}

function generateDescription(domainName: string, capabilities: Capability[]): string {
  const methods = capabilities.map(c => c.method).filter(Boolean);
  const uniqueMethods = [...new Set(methods)];

  if (uniqueMethods.length === 0) {
    return `Manages ${domainName.toLowerCase()} functionality`;
  }

  const hasRead = uniqueMethods.includes('GET');
  const hasWrite = uniqueMethods.some(m => ['POST', 'PUT', 'PATCH'].includes(m || ''));
  const hasDelete = uniqueMethods.includes('DELETE');

  const ops: string[] = [];
  if (hasRead) ops.push('read');
  if (hasWrite) ops.push('write');
  if (hasDelete) ops.push('delete');

  return `${ops.join(', ')} operations for ${domainName.toLowerCase()}`;
}

function buildFlowFromEdges(
  startNodeId: string,
  nodes: CASNode[],
  edges: CASEdge[],
  exitPoints: ExitPoint[],
  maxDepth: number = 10
): FlowStep[] {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const callEdges = edges.filter(e => e.type === 'calls');
  const edgesBySource = new Map<string, CASEdge[]>();

  callEdges.forEach(e => {
    const existing = edgesBySource.get(e.source) || [];
    existing.push(e);
    edgesBySource.set(e.source, existing);
  });

  const exitNodeIds = new Set(exitPoints.map(ep => ep.source?.node_id).filter(Boolean));
  const visited = new Set<string>();
  const steps: FlowStep[] = [];

  function buildEdgeSourceKey(file: string, methodName: string): string[] {
    const keys: string[] = [];
    for (let i = 0; i < 20; i++) {
      keys.push(`function_${file}_${methodName}_${i}`);
    }
    return keys;
  }

  function findEdgeSourceKey(node: CASNode): string | undefined {
    if (edgesBySource.has(node.id)) {
      return node.id;
    }

    const file = node.source?.file || '';
    const name = node.name;

    const possibleKeys = buildEdgeSourceKey(file, name);
    for (const key of possibleKeys) {
      if (edgesBySource.has(key)) {
        return key;
      }
    }

    return undefined;
  }

  function findNodeForEdgeTarget(target: string): CASNode | undefined {
    let node = nodeMap.get(target);
    if (node) return node;

    const match = target.match(/^function_(.+)_([^_]+)_(\d+)$/);
    if (match) {
      const [, file, methodName] = match;
      for (const [, n] of nodeMap) {
        if (n.name === methodName && n.source?.file === file) {
          return n;
        }
      }
    }

    return undefined;
  }

  function findRelatedNodes(node: CASNode): CASNode[] {
    const related: CASNode[] = [];
    const nodeFile = node.source?.file || '';
    const nodeDir = nodeFile.substring(0, nodeFile.lastIndexOf('/'));

    for (const [, n] of nodeMap) {
      if (n.id === node.id) continue;
      if (visited.has(n.id)) continue;

      if (n.type === 'service' && node.type === 'controller') {
        const serviceFile = n.source?.file || '';
        if (serviceFile.includes(nodeDir) || nodeFile.includes(serviceFile.split('/').slice(-2, -1)[0] || '___')) {
          related.push(n);
        }
      }

      if (n.type === 'repository' && node.type === 'service') {
        related.push(n);
      }
    }

    return related;
  }

  function traverse(nodeId: string, depth: number): void {
    if (depth > maxDepth) return;

    const node = nodeMap.get(nodeId);
    if (!node) return;

    if (visited.has(node.id)) return;
    visited.add(node.id);

    const isEntry = depth === 0;
    const isExit = exitNodeIds.has(nodeId);

    const edgeKey = findEdgeSourceKey(node);
    const outgoingEdges = edgeKey ? (edgesBySource.get(edgeKey) || []) : [];

    steps.push({
      id: `step_${node.id}_${depth}`,
      nodeId: node.id,
      name: node.name,
      nodeName: node.name,
      nodeType: node.type,
      depth,
      isEntry,
      isExit: isExit || outgoingEdges.length === 0,
      description: describeStep(node, isEntry, isExit || outgoingEdges.length === 0),
      source: node.source,
    });

    if (!isExit && outgoingEdges.length > 0) {
      const nextEdge = outgoingEdges[0];
      const nextNode = findNodeForEdgeTarget(nextEdge.target);
      if (nextNode && !visited.has(nextNode.id)) {
        traverse(nextNode.id, depth + 1);
      }
    } else if (!isExit && depth < 3) {
      const related = findRelatedNodes(node);
      if (related.length > 0) {
        traverse(related[0].id, depth + 1);
      }
    }
  }

  traverse(startNodeId, 0);
  return steps;
}

function describeStep(node: CASNode | undefined, isEntry: boolean, isExit: boolean): string {
  if (!node) return '';

  if (isEntry) {
    if (node.type === 'controller') {
      return 'Receives the request and validates input';
    }
    return 'Entry point for this operation';
  }

  if (isExit) {
    if (node.type === 'repository') {
      return 'Persists data to the database';
    }
    return 'Final step of this operation';
  }

  switch (node.type) {
    case 'service':
      return 'Handles business logic';
    case 'repository':
      return 'Manages data access';
    case 'guard':
      return 'Checks authorization';
    case 'pipe':
      return 'Transforms or validates data';
    case 'interceptor':
      return 'Modifies request/response';
    default:
      return '';
  }
}

export function extractDomains(cas: CASOutput): Domain[] {
  const entryPoints = cas.entry_points || [];
  const exitPoints = cas.exit_points || [];
  const callChains = cas.call_chains || [];
  const nodes = cas.nodes || [];
  const edges = cas.edges || [];

  const httpEntryPoints = entryPoints.filter(ep => ep.type === 'http');

  const domainMap = new Map<string, {
    entryPoints: EntryPoint[];
    capabilities: Capability[];
  }>();

  httpEntryPoints.forEach(ep => {
    const epAny = ep as any;
    let method = ep.protocol_details?.method || epAny.trigger?.method;
    let path = ep.protocol_details?.path || epAny.trigger?.path;

    if (!method || !path) {
      const parsed = parseHttpEntryPointName(ep.name);
      if (parsed) {
        method = parsed.method;
        path = parsed.path;
      }
    }

    if (!path) return;

    const domainId = inferDomainFromPath(path);

    if (!domainMap.has(domainId)) {
      domainMap.set(domainId, { entryPoints: [], capabilities: [] });
    }

    const domain = domainMap.get(domainId)!;
    domain.entryPoints.push(ep);

    const relatedChain = callChains.find(c =>
      c.entry_point.entry_point_id === ep.id ||
      c.entry_point.node_id === ep.handler?.node_id
    );

    let flowSteps: FlowStep[] | undefined;

    const handlerNodeId = ep.handler?.node_id || (ep as any).source_node;
    const metadata = ep.metadata as any;

    let startNodeId: string | undefined = handlerNodeId;

    const nodeExists = (id: string) => nodes.some(n => n.id === id);

    if (startNodeId && !nodeExists(startNodeId)) {
      startNodeId = undefined;
    }

    if (!startNodeId && metadata?.controller && metadata?.handler) {
      const controllerName = metadata.controller.toLowerCase();
      const handlerName = metadata.handler.toLowerCase();

      const methodNode = nodes.find(n => {
        const validTypes = ['method', 'function', 'controller_method', 'route_handler'];
        if (!validTypes.includes(n.type)) return false;
        if (n.name.toLowerCase() !== handlerName) return false;
        const file = n.source?.file?.toLowerCase() || '';
        return file.includes('controller') &&
               (file.includes(controllerName.replace('controller', '')) ||
                controllerName.includes(file.split('/').pop()?.replace('.controller.ts', '') || ''));
      });

      if (methodNode) {
        startNodeId = methodNode.id;
      }
    }

    if (!startNodeId && metadata?.handler) {
      const handlerName = metadata.handler.toLowerCase();
      const methodNode = nodes.find(n => {
        if (!['method', 'function'].includes(n.type)) return false;
        return n.name.toLowerCase() === handlerName;
      });
      if (methodNode) {
        startNodeId = methodNode.id;
      }
    }

    if (!startNodeId && path) {
      const pathSegments = path.split('/').filter((s: string) => s && !s.startsWith(':'));
      const firstSegment = pathSegments[0]?.toLowerCase();

      if (firstSegment) {
        const controllerNode = nodes.find(n => {
          if (!['controller', 'class', 'method', 'function'].includes(n.type)) return false;
          const file = n.source?.file?.toLowerCase() || '';
          const name = n.name.toLowerCase();
          return (file.includes(`${firstSegment}.controller`) ||
                  file.includes(`${firstSegment}/`) && file.includes('controller') ||
                  name.includes(firstSegment) && (n.type === 'controller' || file.includes('controller')));
        });

        if (controllerNode) {
          startNodeId = controllerNode.id;
        }
      }
    }

    if (!relatedChain && startNodeId) {
      flowSteps = buildFlowFromEdges(startNodeId, nodes, edges, exitPoints);
      if (flowSteps.length === 0) {
        flowSteps = undefined;
      }
    }

    const capability: Capability = {
      id: ep.id,
      name: generateCapabilityName(method || '', path),
      description: ep.description || '',
      action: inferAction(method || '', path),
      entryPoint: ep,
      flow: relatedChain,
      flowSteps,
      method,
      path,
      requiresAuth: ep.authentication?.required || (ep as any).security?.authenticated || false,
    };

    domain.capabilities.push(capability);
  });

  const domains: Domain[] = [];

  domainMap.forEach((data, domainId) => {
    const hasDatabase = data.capabilities.some(c =>
      c.flow?.characteristics.has_database_calls ||
      c.flowSteps?.some(s => s.nodeType === 'repository')
    );
    const hasExternalApi = data.capabilities.some(c =>
      c.flow?.characteristics.has_external_calls ||
      c.flowSteps?.some(s => s.isExit && s.nodeType !== 'repository')
    );
    const hasAuth = data.capabilities.some(c => c.requiresAuth);

    const relatedNodeIds = new Set<string>();
    data.capabilities.forEach(c => {
      if (c.entryPoint.handler?.node_id) {
        relatedNodeIds.add(c.entryPoint.handler.node_id);
      }
      c.flow?.call_path.forEach(step => {
        relatedNodeIds.add(step.node_id);
      });
      c.flowSteps?.forEach(step => {
        relatedNodeIds.add(step.nodeId);
      });
    });

    const relatedExitPoints = exitPoints.filter(ep =>
      relatedNodeIds.has(ep.source?.node_id || '')
    );

    const domainName = domainId
      .replace(/-/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    domains.push({
      id: domainId,
      name: domainName,
      description: generateDescription(domainName, data.capabilities),
      icon: DOMAIN_ICONS[domainId] || DOMAIN_ICONS.default,
      color: DOMAIN_COLORS[domainId] || DOMAIN_COLORS.default,
      capabilities: data.capabilities.sort((a, b) => {
        const methodOrder = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        const aOrder = methodOrder.indexOf(a.method?.toUpperCase() || '');
        const bOrder = methodOrder.indexOf(b.method?.toUpperCase() || '');
        return aOrder - bOrder;
      }),
      stats: {
        entryPoints: data.entryPoints.length,
        exitPoints: relatedExitPoints.length,
        components: relatedNodeIds.size,
        hasDatabase,
        hasExternalApi,
        hasAuth,
      },
    });
  });

  return domains.sort((a, b) => b.stats.entryPoints - a.stats.entryPoints);
}

export function findFlowForCapability(
  capability: Capability,
  callChains: CASCallChain[]
): CASCallChain | undefined {
  return callChains.find(c =>
    c.entry_point.entry_point_id === capability.entryPoint.id ||
    c.entry_point.node_id === capability.entryPoint.handler?.node_id
  );
}

export function buildFlowSteps(
  chain: CASCallChain,
  nodes: CASNode[]
): FlowStep[] {
  return chain.call_path.map((step, index) => {
    const node = nodes.find(n => n.id === step.node_id);
    const isFirst = index === 0;
    const isLast = index === chain.call_path.length - 1;

    return {
      id: step.call_id,
      nodeId: step.node_id,
      name: step.method_name,
      nodeName: node?.name || step.method_name,
      nodeType: node?.type || 'unknown',
      depth: step.depth,
      isEntry: isFirst,
      isExit: isLast,
      description: describeStep(node, isFirst, isLast),
      source: node?.source,
    };
  });
}

import {
  Section,
  SectionCapability,
  SectionType,
  SECTION_TYPE_CONFIG,
  getSectionTypeFromEntryPointType
} from '../types/sections';
import { UICapabilities } from './uiCapabilities';

const SECTION_COLORS: string[] = [
  '#4caf50', '#2196f3', '#9c27b0', '#ff9800', '#e91e63',
  '#00bcd4', '#795548', '#3f51b5', '#009688', '#607d8b',
  '#f44336', '#8bc34a', '#03a9f4', '#673ab7', '#ffc107',
];

function getColorForSection(index: number): string {
  return SECTION_COLORS[index % SECTION_COLORS.length];
}

function inferSectionNameFromPath(path: string, type: SectionType): string {
  if (type === 'api-domain') {
    const cleanPath = path.replace(/^\/api\//, '').replace(/^\//, '');
    const firstSegment = cleanPath.split('/')[0];
    if (firstSegment && !firstSegment.startsWith(':')) {
      return firstSegment
        .replace(/-/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(' ')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }
  }
  return 'General';
}

function inferSectionNameFromCli(name: string): string {
  const parts = name.split(/[\s:]+/);
  if (parts.length > 1) {
    return parts[0]
      .replace(/-/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return 'Commands';
}

function inferSectionNameFromEvent(entryPoint: EntryPoint): string {
  const metadata = entryPoint.metadata as any;
  if (metadata?.event === 'test') {
    const file = entryPoint.handler?.file || '';
    const fileName = file.split('/').pop()?.replace(/\.(test|spec)\.(ts|js|rs)$/, '') || 'Tests';
    return fileName
      .replace(/-/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return metadata?.event || 'Events';
}

function generateCapabilityFromEntryPoint(
  ep: EntryPoint,
  nodes: CASNode[],
  edges: CASEdge[],
  exitPoints: ExitPoint[],
  callChains: CASCallChain[]
): SectionCapability {
  const epAny = ep as any;
  let method = ep.protocol_details?.method || epAny.trigger?.method;
  let path = ep.protocol_details?.path || epAny.trigger?.path;

  if (!method || !path) {
    const parsed = parseHttpEntryPointName(ep.name);
    if (parsed) {
      method = parsed.method;
      path = parsed.path;
    }
  }

  const relatedChain = callChains.find(c =>
    c.entry_point.entry_point_id === ep.id ||
    c.entry_point.node_id === ep.handler?.node_id
  );

  let flowSteps: FlowStep[] | undefined;
  const handlerNodeId = ep.handler?.node_id || epAny.source_node;

  if (!relatedChain && handlerNodeId) {
    const nodeExists = nodes.some(n => n.id === handlerNodeId);
    if (nodeExists) {
      flowSteps = buildFlowFromEdges(handlerNodeId, nodes, edges, exitPoints);
      if (flowSteps.length === 0) {
        flowSteps = undefined;
      }
    }
  }

  let capabilityName = ep.name;
  if (ep.type === 'http' && method && path) {
    capabilityName = generateCapabilityName(method, path);
  }

  return {
    id: ep.id,
    name: capabilityName,
    description: ep.description,
    method,
    path,
    requiresAuth: ep.authentication?.required || epAny.security?.authenticated || false,
    entryPoint: {
      id: ep.id,
      type: ep.type,
      handler: ep.handler ? {
        node_id: ep.handler.node_id,
        method_name: ep.handler.method_name,
      } : undefined,
    },
    flow: relatedChain,
    flowSteps,
    metadata: ep.metadata,
  };
}

export function extractSections(cas: CASOutput, capabilities: UICapabilities): Section[] {
  const entryPoints = cas.entry_points || [];
  const exitPoints = cas.exit_points || [];
  const callChains = cas.call_chains || [];
  const nodes = cas.nodes || [];
  const edges = cas.edges || [];

  const sectionMap = new Map<string, {
    type: SectionType;
    name: string;
    capabilities: SectionCapability[];
    entryPoints: EntryPoint[];
  }>();

  entryPoints.forEach(ep => {
    const sectionType = getSectionTypeFromEntryPointType(ep.type);
    let sectionKey: string;
    let sectionName: string;

    const epAny = ep as any;
    const path = ep.protocol_details?.path || epAny.trigger?.path;

    switch (sectionType) {
      case 'api-domain':
        sectionName = inferSectionNameFromPath(path || '', sectionType);
        sectionKey = `api-${sectionName.toLowerCase().replace(/\s+/g, '-')}`;
        break;
      case 'cli-command':
        sectionName = inferSectionNameFromCli(ep.name);
        sectionKey = `cli-${sectionName.toLowerCase().replace(/\s+/g, '-')}`;
        break;
      case 'event-handler':
        const metadata = ep.metadata as any;
        if (metadata?.event === 'test') {
          sectionName = inferSectionNameFromEvent(ep);
          sectionKey = `test-${sectionName.toLowerCase().replace(/\s+/g, '-')}`;
        } else {
          sectionName = inferSectionNameFromEvent(ep);
          sectionKey = `event-${sectionName.toLowerCase().replace(/\s+/g, '-')}`;
        }
        break;
      case 'scheduled-task':
        sectionName = 'Scheduled Tasks';
        sectionKey = 'scheduled-tasks';
        break;
      case 'page':
      case 'route':
        sectionName = inferSectionNameFromPath(path || ep.name, sectionType);
        sectionKey = `page-${sectionName.toLowerCase().replace(/\s+/g, '-')}`;
        break;
      case 'websocket':
        sectionName = 'WebSocket Handlers';
        sectionKey = 'websocket-handlers';
        break;
      default:
        sectionName = 'Other';
        sectionKey = 'other';
    }

    if (!sectionMap.has(sectionKey)) {
      sectionMap.set(sectionKey, {
        type: sectionType,
        name: sectionName,
        capabilities: [],
        entryPoints: [],
      });
    }

    const section = sectionMap.get(sectionKey)!;
    section.entryPoints.push(ep);

    const capability = generateCapabilityFromEntryPoint(
      ep, nodes, edges, exitPoints, callChains
    );
    section.capabilities.push(capability);
  });

  const sections: Section[] = [];
  let colorIndex = 0;

  sectionMap.forEach((data, sectionKey) => {
    const hasDatabase = data.capabilities.some(c =>
      c.flow?.characteristics.has_database_calls ||
      c.flowSteps?.some(s => s.nodeType === 'repository')
    );
    const hasExternalCalls = data.capabilities.some(c =>
      c.flow?.characteristics.has_external_calls ||
      c.flowSteps?.some(s => s.isExit && s.nodeType !== 'repository')
    );
    const hasAuth = data.capabilities.some(c => c.requiresAuth);

    const typeConfig = SECTION_TYPE_CONFIG[data.type];

    sections.push({
      id: sectionKey,
      type: data.type,
      name: data.name,
      color: getColorForSection(colorIndex++),
      icon: typeConfig.icon,
      capabilities: data.capabilities.sort((a, b) => {
        if (a.method && b.method) {
          const methodOrder = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
          const aOrder = methodOrder.indexOf(a.method.toUpperCase());
          const bOrder = methodOrder.indexOf(b.method.toUpperCase());
          return aOrder - bOrder;
        }
        return a.name.localeCompare(b.name);
      }),
      stats: {
        entryPoints: data.entryPoints.length,
        hasAuth,
        hasDatabase,
        hasExternalCalls,
      },
    });
  });

  return sections.sort((a, b) => b.stats.entryPoints - a.stats.entryPoints);
}

export function groupSectionsByType(sections: Section[]): Map<SectionType, Section[]> {
  const grouped = new Map<SectionType, Section[]>();

  sections.forEach(section => {
    const existing = grouped.get(section.type) || [];
    existing.push(section);
    grouped.set(section.type, existing);
  });

  return grouped;
}

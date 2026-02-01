import { CASOutput, CASNode, EntryPoint } from '../types';

export type SystemType =
  | 'web-api'
  | 'cli-application'
  | 'frontend-app'
  | 'library'
  | 'full-stack'
  | 'hybrid';

export type NodeCategory =
  | 'entry'
  | 'business'
  | 'data'
  | 'infrastructure'
  | 'test'
  | 'utility';

export interface ArchitectureLayer {
  id: string;
  name: string;
  description?: string;
  nodeTypes: string[];
  counts: Record<string, number>;
  totalCount: number;
}

export interface UICapabilities {
  systemType: SystemType;
  hasApiDomains: boolean;
  hasCliCommands: boolean;
  hasTestSuites: boolean;
  hasEventHandlers: boolean;
  hasScheduledTasks: boolean;
  hasPages: boolean;
  hasRoutes: boolean;
  hasWebsockets: boolean;
  detectedNodeTypes: string[];
  detectedPatterns: string[];
  frameworksDetected: string[];
  architectureLayers: ArchitectureLayer[];
  entryPointTypes: string[];
  primaryEntryPointType: string | null;
}

const ENTRY_NODE_TYPES = new Set([
  'controller', 'handler', 'command', 'endpoint', 'route', 'page',
  'resolver', 'subscriber', 'listener', 'cli-command'
]);

const BUSINESS_NODE_TYPES = new Set([
  'service', 'manager', 'processor', 'engine', 'facade', 'provider',
  'use-case', 'interactor', 'domain-service'
]);

const DATA_NODE_TYPES = new Set([
  'repository', 'dao', 'store', 'adapter', 'client', 'query',
  'entity', 'model', 'schema', 'migration'
]);

const INFRASTRUCTURE_NODE_TYPES = new Set([
  'guard', 'middleware', 'interceptor', 'filter', 'pipe', 'config',
  'module', 'plugin', 'extension', 'decorator-class'
]);

const TEST_NODE_TYPES = new Set([
  'test', 'spec', 'fixture', 'mock', 'test-helper', 'test-util'
]);

export function categorizeNodeType(nodeType: string): NodeCategory {
  const normalizedType = nodeType.toLowerCase();

  if (ENTRY_NODE_TYPES.has(normalizedType)) return 'entry';
  if (BUSINESS_NODE_TYPES.has(normalizedType)) return 'business';
  if (DATA_NODE_TYPES.has(normalizedType)) return 'data';
  if (INFRASTRUCTURE_NODE_TYPES.has(normalizedType)) return 'infrastructure';
  if (TEST_NODE_TYPES.has(normalizedType)) return 'test';

  if (normalizedType.includes('controller') || normalizedType.includes('handler')) return 'entry';
  if (normalizedType.includes('service') || normalizedType.includes('manager')) return 'business';
  if (normalizedType.includes('repository') || normalizedType.includes('store')) return 'data';
  if (normalizedType.includes('guard') || normalizedType.includes('middleware')) return 'infrastructure';
  if (normalizedType.includes('test') || normalizedType.includes('spec')) return 'test';

  return 'utility';
}

function inferSystemType(entryPoints: EntryPoint[], nodes: CASNode[]): SystemType {
  const entryTypeCount: Record<string, number> = {};
  entryPoints.forEach(ep => {
    entryTypeCount[ep.type] = (entryTypeCount[ep.type] || 0) + 1;
  });

  const httpCount = entryTypeCount['http'] || 0;
  const cliCount = entryTypeCount['cli'] || 0;
  const eventCount = (entryTypeCount['event'] || 0) + (entryTypeCount['scheduled'] || 0);
  const pageCount = (entryTypeCount['page'] || 0) + (entryTypeCount['route'] || 0);
  const websocketCount = entryTypeCount['websocket'] || 0;

  const totalNonTest = httpCount + cliCount + eventCount + pageCount + websocketCount;

  if (totalNonTest === 0) {
    const hasExports = nodes.some(n => n.metadata?.attributes?.isExported);
    if (hasExports) return 'library';
    return 'hybrid';
  }

  if (httpCount > 0 && pageCount > 0) return 'full-stack';
  if (httpCount > totalNonTest * 0.5) return 'web-api';
  if (cliCount > totalNonTest * 0.5) return 'cli-application';
  if (pageCount > totalNonTest * 0.5) return 'frontend-app';

  return 'hybrid';
}

function buildArchitectureLayers(nodes: CASNode[], systemType: SystemType): ArchitectureLayer[] {
  const nodesByCategory: Record<NodeCategory, Map<string, CASNode[]>> = {
    entry: new Map(),
    business: new Map(),
    data: new Map(),
    infrastructure: new Map(),
    test: new Map(),
    utility: new Map(),
  };

  nodes.forEach(node => {
    const category = categorizeNodeType(node.type);
    const categoryMap = nodesByCategory[category];
    if (!categoryMap.has(node.type)) {
      categoryMap.set(node.type, []);
    }
    categoryMap.get(node.type)!.push(node);
  });

  const layers: ArchitectureLayer[] = [];

  const layerConfigs: Array<{
    category: NodeCategory;
    name: string;
    nameBySystem?: Partial<Record<SystemType, string>>;
    description?: string;
  }> = [
    {
      category: 'entry',
      name: 'Entry Layer',
      nameBySystem: {
        'web-api': 'Presentation Layer',
        'cli-application': 'Command Layer',
        'frontend-app': 'View Layer',
      },
    },
    {
      category: 'business',
      name: 'Business Layer',
    },
    {
      category: 'data',
      name: 'Data Layer',
    },
    {
      category: 'infrastructure',
      name: 'Infrastructure',
    },
    {
      category: 'test',
      name: 'Test Layer',
    },
  ];

  layerConfigs.forEach(config => {
    const categoryMap = nodesByCategory[config.category];
    if (categoryMap.size === 0) return;

    const counts: Record<string, number> = {};
    let totalCount = 0;
    const nodeTypes: string[] = [];

    categoryMap.forEach((nodeList, nodeType) => {
      counts[nodeType] = nodeList.length;
      totalCount += nodeList.length;
      nodeTypes.push(nodeType);
    });

    const layerName = config.nameBySystem?.[systemType] || config.name;

    layers.push({
      id: config.category,
      name: layerName,
      description: config.description,
      nodeTypes,
      counts,
      totalCount,
    });
  });

  return layers;
}

export function detectCapabilities(cas: CASOutput): UICapabilities {
  const entryPoints = cas.entry_points || [];
  const nodes = cas.nodes || [];
  const patterns = cas.patterns || [];

  const entryPointTypes = [...new Set(entryPoints.map(ep => ep.type))];

  const hasApiDomains = entryPoints.some(ep => ep.type === 'http');
  const hasCliCommands = entryPoints.some(ep => ep.type === 'cli');
  const hasTestSuites = entryPoints.some(ep =>
    ep.type === 'event' && ep.metadata?.event === 'test'
  ) || nodes.some(n => n.type === 'test' || n.tags?.includes('test'));
  const hasEventHandlers = entryPoints.some(ep =>
    ep.type === 'event' && ep.metadata?.event !== 'test'
  );
  const hasScheduledTasks = entryPoints.some(ep => ep.type === 'scheduled');
  const hasPages = entryPoints.some(ep => ep.type === 'page' || ep.type === 'route');
  const hasRoutes = hasPages;
  const hasWebsockets = entryPoints.some(ep => ep.type === 'websocket');

  const detectedNodeTypes = [...new Set(nodes.map(n => n.type))];
  const detectedPatterns = patterns.map(p => p.name);

  const systemMeta = cas.system?.metadata as Record<string, any> | undefined;
  const techMeta = systemMeta?.technologies as Record<string, any> | undefined;
  const frameworksDetected = (techMeta?.frameworks as Array<{ name: string }> || [])
    .map(f => f.name);

  const systemType = inferSystemType(entryPoints, nodes);
  const architectureLayers = buildArchitectureLayers(nodes, systemType);

  let primaryEntryPointType: string | null = null;
  if (entryPointTypes.length > 0) {
    const typeCounts = entryPointTypes.map(type => ({
      type,
      count: entryPoints.filter(ep => ep.type === type).length,
    }));
    typeCounts.sort((a, b) => b.count - a.count);
    primaryEntryPointType = typeCounts[0].type;
  }

  return {
    systemType,
    hasApiDomains,
    hasCliCommands,
    hasTestSuites,
    hasEventHandlers,
    hasScheduledTasks,
    hasPages,
    hasRoutes,
    hasWebsockets,
    detectedNodeTypes,
    detectedPatterns,
    frameworksDetected,
    architectureLayers,
    entryPointTypes,
    primaryEntryPointType,
  };
}

export function getSectionTitle(capabilities: UICapabilities): string {
  switch (capabilities.systemType) {
    case 'web-api':
      return 'API Domains';
    case 'cli-application':
      return 'Commands';
    case 'frontend-app':
      return 'Pages';
    case 'library':
      return 'Modules';
    case 'full-stack':
      return capabilities.hasApiDomains ? 'API Domains' : 'Pages';
    case 'hybrid':
    default:
      return 'Entry Points';
  }
}

export function getSectionIcon(capabilities: UICapabilities): string {
  switch (capabilities.systemType) {
    case 'web-api':
      return 'api';
    case 'cli-application':
      return 'terminal';
    case 'frontend-app':
      return 'pages';
    case 'library':
      return 'library';
    default:
      return 'account_tree';
  }
}

export function hasSections(capabilities: UICapabilities): boolean {
  return (
    capabilities.hasApiDomains ||
    capabilities.hasCliCommands ||
    capabilities.hasPages ||
    capabilities.hasEventHandlers ||
    capabilities.hasScheduledTasks
  );
}

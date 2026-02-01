import { NodeCategory, categorizeNodeType } from './uiCapabilities';

export interface NodeStyle {
  color: string;
  backgroundColor: string;
  label: string;
  iconName: string;
}

const CATEGORY_PALETTES: Record<NodeCategory, string[]> = {
  entry: ['#4caf50', '#66bb6a', '#81c784', '#a5d6a7', '#c8e6c9'],
  business: ['#2196f3', '#42a5f5', '#64b5f6', '#90caf9', '#bbdefb'],
  data: ['#9c27b0', '#ab47bc', '#ba68c8', '#ce93d8', '#e1bee7'],
  infrastructure: ['#ff9800', '#ffa726', '#ffb74d', '#ffcc80', '#ffe0b2'],
  test: ['#00bcd4', '#26c6da', '#4dd0e1', '#80deea', '#b2ebf2'],
  utility: ['#607d8b', '#78909c', '#90a4ae', '#b0bec5', '#cfd8dc'],
};

const TYPE_ICONS: Record<string, string> = {
  controller: 'hub',
  handler: 'input',
  command: 'terminal',
  endpoint: 'api',
  route: 'route',
  page: 'web',
  resolver: 'sync_alt',
  subscriber: 'notifications',
  listener: 'hearing',

  service: 'settings',
  manager: 'account_tree',
  processor: 'memory',
  engine: 'engineering',
  facade: 'layers',
  provider: 'cloud',

  repository: 'storage',
  dao: 'database',
  store: 'inventory',
  adapter: 'transform',
  client: 'http',
  query: 'search',
  entity: 'data_object',
  model: 'schema',

  guard: 'security',
  middleware: 'filter_alt',
  interceptor: 'swap_horiz',
  filter: 'filter_list',
  pipe: 'plumbing',
  config: 'tune',
  module: 'view_module',

  test: 'science',
  spec: 'checklist',
  fixture: 'build',
  mock: 'content_copy',

  function: 'code',
  class: 'class',
  interface: 'integration_instructions',
  type: 'category',
  enum: 'list',
  struct: 'grid_view',
  trait: 'extension',
  impl: 'construction',

  default: 'code',
};

const TYPE_LABELS: Record<string, string> = {
  controller: 'Controller',
  handler: 'Handler',
  command: 'Command',
  endpoint: 'Endpoint',
  route: 'Route',
  page: 'Page',
  resolver: 'Resolver',
  subscriber: 'Subscriber',
  listener: 'Listener',

  service: 'Service',
  manager: 'Manager',
  processor: 'Processor',
  engine: 'Engine',
  facade: 'Facade',
  provider: 'Provider',

  repository: 'Repository',
  dao: 'DAO',
  store: 'Store',
  adapter: 'Adapter',
  client: 'Client',
  query: 'Query',
  entity: 'Entity',
  model: 'Model',

  guard: 'Guard',
  middleware: 'Middleware',
  interceptor: 'Interceptor',
  filter: 'Filter',
  pipe: 'Pipe',
  config: 'Config',
  module: 'Module',

  test: 'Test',
  spec: 'Spec',
  fixture: 'Fixture',
  mock: 'Mock',

  function: 'Function',
  class: 'Class',
  interface: 'Interface',
  type: 'Type',
  enum: 'Enum',
  struct: 'Struct',
  trait: 'Trait',
  impl: 'Impl',
};

export class DynamicStyleManager {
  private styleCache: Map<string, NodeStyle> = new Map();
  private categoryColorIndex: Map<NodeCategory, number> = new Map();

  getStyleForNodeType(nodeType: string): NodeStyle {
    const normalizedType = nodeType.toLowerCase();

    if (this.styleCache.has(normalizedType)) {
      return this.styleCache.get(normalizedType)!;
    }

    const category = categorizeNodeType(normalizedType);
    const palette = CATEGORY_PALETTES[category];

    let colorIndex = this.categoryColorIndex.get(category) || 0;
    const color = palette[colorIndex % palette.length];
    this.categoryColorIndex.set(category, colorIndex + 1);

    const backgroundColor = `${color}15`;
    const iconName = TYPE_ICONS[normalizedType] || TYPE_ICONS.default;
    const label = TYPE_LABELS[normalizedType] || this.formatLabel(normalizedType);

    const style: NodeStyle = {
      color,
      backgroundColor,
      label,
      iconName,
    };

    this.styleCache.set(normalizedType, style);
    return style;
  }

  getStylesForTypes(nodeTypes: string[]): Map<string, NodeStyle> {
    const styles = new Map<string, NodeStyle>();
    nodeTypes.forEach(type => {
      styles.set(type, this.getStyleForNodeType(type));
    });
    return styles;
  }

  getCategoryColor(category: NodeCategory): string {
    return CATEGORY_PALETTES[category][0];
  }

  private formatLabel(nodeType: string): string {
    return nodeType
      .replace(/[-_]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  reset(): void {
    this.styleCache.clear();
    this.categoryColorIndex.clear();
  }
}

const defaultStyleManager = new DynamicStyleManager();

export function getStyleForNodeType(nodeType: string): NodeStyle {
  return defaultStyleManager.getStyleForNodeType(nodeType);
}

export function getStylesForTypes(nodeTypes: string[]): Map<string, NodeStyle> {
  return defaultStyleManager.getStylesForTypes(nodeTypes);
}

export function getCategoryColor(category: NodeCategory): string {
  return defaultStyleManager.getCategoryColor(category);
}

export function resetStyles(): void {
  defaultStyleManager.reset();
}

export function getStepColor(nodeType: string): string {
  return getStyleForNodeType(nodeType).color;
}

export const ENTRY_POINT_TYPE_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  http: { icon: 'hub', label: 'HTTP/REST', color: '#4caf50' },
  websocket: { icon: 'dns', label: 'WebSocket', color: '#2196f3' },
  cli: { icon: 'terminal', label: 'CLI', color: '#ff9800' },
  event: { icon: 'notifications', label: 'Event', color: '#9c27b0' },
  scheduled: { icon: 'schedule', label: 'Scheduled', color: '#00bcd4' },
  grpc: { icon: 'cloud', label: 'gRPC', color: '#607d8b' },
  graphql: { icon: 'hub', label: 'GraphQL', color: '#e535ab' },
  message: { icon: 'message', label: 'Message', color: '#795548' },
  startup: { icon: 'play_arrow', label: 'Startup', color: '#4caf50' },
  page: { icon: 'web', label: 'Page', color: '#3f51b5' },
  route: { icon: 'route', label: 'Route', color: '#3f51b5' },
  other: { icon: 'code', label: 'Other', color: '#9e9e9e' },
};

export function getEntryPointTypeConfig(type: string): { icon: string; label: string; color: string } {
  return ENTRY_POINT_TYPE_CONFIG[type] || ENTRY_POINT_TYPE_CONFIG.other;
}

import { FlowStep } from '../utils/domainExtractor';
import { CASCallChain } from '../../../types/cas.types';

export type SectionType =
  | 'api-domain'
  | 'cli-command'
  | 'test-suite'
  | 'event-handler'
  | 'scheduled-task'
  | 'page'
  | 'route'
  | 'module'
  | 'websocket';

export interface SectionCapability {
  id: string;
  name: string;
  description?: string;
  method?: string;
  path?: string;
  requiresAuth: boolean;
  entryPoint?: {
    id: string;
    type: string;
    handler?: {
      node_id: string;
      method_name?: string;
    };
  };
  flow?: CASCallChain;
  flowSteps?: FlowStep[];
  metadata?: Record<string, any>;
}

export interface Section {
  id: string;
  type: SectionType;
  name: string;
  description?: string;
  color: string;
  icon: string;
  capabilities: SectionCapability[];
  stats: {
    entryPoints: number;
    hasAuth: boolean;
    hasDatabase: boolean;
    hasExternalCalls: boolean;
  };
  metadata?: Record<string, any>;
}

export interface TestSection extends Section {
  type: 'test-suite';
  testStats: {
    byType: {
      unit: number;
      integration: number;
      e2e: number;
      acceptance: number;
    };
    bddCount: number;
    mockCount: number;
    coveragePercent?: number;
  };
}

export interface SectionGroup {
  type: SectionType;
  title: string;
  icon: string;
  sections: Section[];
  totalEntryPoints: number;
}

export const SECTION_TYPE_CONFIG: Record<SectionType, { title: string; icon: string; color: string }> = {
  'api-domain': {
    title: 'API Domains',
    icon: 'api',
    color: '#4caf50',
  },
  'cli-command': {
    title: 'Commands',
    icon: 'terminal',
    color: '#ff9800',
  },
  'test-suite': {
    title: 'Test Suites',
    icon: 'science',
    color: '#00bcd4',
  },
  'event-handler': {
    title: 'Event Handlers',
    icon: 'notifications',
    color: '#9c27b0',
  },
  'scheduled-task': {
    title: 'Scheduled Tasks',
    icon: 'schedule',
    color: '#795548',
  },
  'page': {
    title: 'Pages',
    icon: 'web',
    color: '#3f51b5',
  },
  'route': {
    title: 'Routes',
    icon: 'route',
    color: '#3f51b5',
  },
  'module': {
    title: 'Modules',
    icon: 'view_module',
    color: '#607d8b',
  },
  'websocket': {
    title: 'WebSocket Handlers',
    icon: 'sync_alt',
    color: '#2196f3',
  },
};

export function getSectionTypeFromEntryPointType(entryPointType: string): SectionType {
  switch (entryPointType) {
    case 'http':
    case 'grpc':
    case 'graphql':
      return 'api-domain';
    case 'cli':
      return 'cli-command';
    case 'test':
      return 'test-suite';
    case 'event':
      return 'event-handler';
    case 'scheduled':
      return 'scheduled-task';
    case 'page':
      return 'page';
    case 'route':
      return 'route';
    case 'websocket':
      return 'websocket';
    default:
      return 'module';
  }
}

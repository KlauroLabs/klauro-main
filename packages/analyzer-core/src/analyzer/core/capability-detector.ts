import {
  CASEntryPoint,
  CASCallChain,
  CASNode,
  CASEdge,
  CASDomainConcept,
  CASDataEntity,
  CASCapability,
  CASOperation
} from '../../types/cas.types';
import {
  humanizeCapabilityLabel,
  isBareNounCapabilityLabel,
  deriveCapabilityNameFromOperations,
  buildCapabilityDescriptionFromOperations
} from './capability-naming';

const ACTION_WORDS = new Set([
  'create', 'add', 'new', 'register', 'signup', 'submit',
  'update', 'edit', 'modify', 'change', 'patch',
  'delete', 'remove', 'destroy', 'cancel', 'revoke',
  'get', 'find', 'fetch', 'list', 'search', 'query', 'lookup',
  'analyze', 'scan', 'process', 'execute', 'run', 'validate',
  'export', 'import', 'upload', 'download', 'sync',
  'login', 'logout', 'authenticate', 'authorize', 'verify',
  'approve', 'reject', 'confirm', 'complete', 'cancel',
  'start', 'stop', 'pause', 'resume', 'restart', 'restore',
  'enable', 'disable', 'activate', 'deactivate', 'archive', 'unarchive',
  'connect', 'disconnect', 'subscribe', 'unsubscribe',
  'publish', 'broadcast', 'send', 'receive', 'notify',
  'refresh', 'reload', 'reset', 'clear', 'flush',
  'init', 'setup', 'configure', 'health', 'status', 'info',
  'clone', 'fork', 'merge', 'revert', 'rollback', 'undo', 'redo'
]);

const API_PREFIXES = new Set(['api', 'v1', 'v2', 'v3', 'rest', 'graphql']);

interface CapabilityDetectionIndex {
  chainsByEntryPoint: Map<string, CASCallChain[]>;
  chainOrdinal: Map<CASCallChain, number>;
  nodesById: Map<string, CASNode>;
  entities: Array<{ entity: CASDataEntity; lowerName: string }>;
}

export class CapabilityDetector {
  detectCapabilities(
    entryPoints: CASEntryPoint[],
    callChains: CASCallChain[],
    nodes: CASNode[],
    edges: CASEdge[],
    domainConcepts: CASDomainConcept[],
    entities?: CASDataEntity[]
  ): CASCapability[] {
    const groups = this.groupEntryPointsSemantically(entryPoints);
    const chainsByEntryPoint = new Map<string, CASCallChain[]>();
    const chainOrdinal = new Map<CASCallChain, number>();
    for (const [ordinal, chain] of callChains.entries()) {
      chainOrdinal.set(chain, ordinal);
      const entryPointId = chain.entry_point?.entry_point_id;
      if (!entryPointId) continue;
      const chains = chainsByEntryPoint.get(entryPointId) || [];
      chains.push(chain);
      chainsByEntryPoint.set(entryPointId, chains);
    }
    const index: CapabilityDetectionIndex = {
      chainsByEntryPoint,
      chainOrdinal,
      nodesById: new Map(nodes.map(node => [node.id, node])),
      entities: (entities || []).map(entity => ({ entity, lowerName: entity.name.toLowerCase() })),
    };

    const capabilities: CASCapability[] = [];
    for (const groupKey of Array.from(groups.keys())) {
      const eps = groups.get(groupKey)!;
      const capability = this.buildCapability(groupKey, eps, index, edges, entities);
      capabilities.push(capability);
    }

    return capabilities;
  }

  private groupEntryPointsSemantically(entryPoints: CASEntryPoint[]): Map<string, CASEntryPoint[]> {
    const groups = new Map<string, CASEntryPoint[]>();

    for (const ep of entryPoints) {
      const key = this.extractSemanticKey(ep);

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(ep);
    }

    return this.mergeRelatedGroups(groups);
  }

  private extractSemanticKey(ep: CASEntryPoint): string {
    let key: string;
    switch (ep.type) {
      case 'http':
        key = this.extractHttpSemanticKey(ep);
        break;
      case 'cli':
        key = this.extractCliSemanticKey(ep);
        break;
      case 'event':
      case 'message':
        key = this.extractEventSemanticKey(ep);
        break;
      case 'schedule':
        key = this.extractScheduleSemanticKey(ep);
        break;
      case 'route':
      case 'page':
        key = this.extractRouteSemanticKey(ep);
        break;
      case 'websocket':
        key = this.extractWebSocketSemanticKey(ep);
        break;
      default:
        key = this.extractGenericSemanticKey(ep);
    }
    return this.sanitizeSemanticKey(key);
  }

  private sanitizeSemanticKey(key: string): string {
    let sanitized = key
      .toLowerCase()
      .replace(/[<>{}:\[\]\/\\]/g, '')
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (!sanitized || sanitized.length < 2) {
      return 'misc';
    }

    const singleLetterWords = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'];
    if (singleLetterWords.includes(sanitized)) {
      return 'misc';
    }

    return sanitized;
  }

  private extractHttpSemanticKey(ep: CASEntryPoint): string {
    const path = ep.trigger?.path || '';
    const method = (ep.trigger?.method || 'GET').toUpperCase();
    const metadata = ep.metadata || {};

    if (path.includes('/graphql') || metadata.graphql_operation_type) {
      return this.extractGraphQLSemanticKey(ep);
    }

    const segments = path.split('/').filter(s =>
      s && !s.startsWith(':') && !s.startsWith('{') &&
      !API_PREFIXES.has(s.toLowerCase())
    );

    if (segments.length === 0) {
      return 'root';
    }

    const lastSeg = segments[segments.length - 1]?.toLowerCase() || '';
    const isAction = this.isActionWord(lastSeg);

    if (isAction && segments.length > 1) {
      const parentResource = segments[segments.length - 2].toLowerCase();
      return `${parentResource}_${lastSeg}`;
    }

    const resource = lastSeg;

    const methodToAction: Record<string, string> = {
      'POST': 'create',
      'PUT': 'update',
      'PATCH': 'update',
      'DELETE': 'delete',
      'GET': segments.some(s => s.startsWith(':') || s.startsWith('{')) ? 'get' : 'list'
    };

    const action = methodToAction[method] || 'access';

    return `${resource}_${action}`;
  }

  private extractGraphQLSemanticKey(ep: CASEntryPoint): string {
    const metadata = ep.metadata || {};
    const operationType = metadata.graphql_operation_type || 'query';
    const operation = metadata.graphql_operation || ep.name || '';
    const app = metadata.app || '';
    const controller = metadata.controller || '';

    const operationNormalized = operation
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase();

    const parts = operationNormalized.split('_').filter(Boolean);

    const actionWords = ['create', 'update', 'delete', 'get', 'list', 'batch', 'read', 'mutation', 'query'];
    const resourceParts = parts.filter((p: string) => !actionWords.includes(p));

    if (resourceParts.length > 0) {
      return resourceParts[0];
    }

    if (app) {
      return app.toLowerCase().replace(/[^a-z0-9]/g, '_');
    }

    if (controller) {
      const controllerName = controller
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/(type|mutation|query|queries|mutations)$/i, '')
        .trim();
      if (controllerName) {
        return controllerName;
      }
    }

    return operationType === 'mutation' ? 'mutations' : 'queries';
  }

  private extractCliSemanticKey(ep: CASEntryPoint): string {
    const name = ep.name || '';
    const command = ep.trigger?.pattern || name;

    const parts = command.split(/[\s_\-]+/).filter(Boolean);
    if (parts.length === 0) {
      return 'command';
    }

    return parts[0].toLowerCase();
  }

  private extractEventSemanticKey(ep: CASEntryPoint): string {
    const metadata = ep.metadata || {};
    const eventName = ep.trigger?.event || ep.name || '';

    if (metadata.task_type === 'celery' || eventName.includes('celery.task')) {
      return this.extractCeleryTaskSemanticKey(ep);
    }

    const normalized = eventName
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .split(/[.\-_:]+/)
      .filter(Boolean);

    if (normalized.length === 0) {
      return 'event';
    }

    const subject = normalized.find(p => !this.isActionWord(p)) || normalized[0];
    return subject;
  }

  private extractCeleryTaskSemanticKey(ep: CASEntryPoint): string {
    const metadata = ep.metadata || {};
    const taskOperation = metadata.task_operation || ep.name || '';
    const app = metadata.app || '';

    const normalized = taskOperation
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase();

    const parts = normalized.split('_').filter(Boolean);

    const taskPrefixes = ['sync', 'send', 'create', 'update', 'delete', 'process', 'execute', 'run', 'upload', 'download', 'import', 'export'];
    const meaningfulParts = parts.filter((p: string) =>
      !taskPrefixes.includes(p) && p !== 'task' && p !== 'celery'
    );

    if (meaningfulParts.length > 0) {
      return meaningfulParts[0];
    }

    if (app) {
      return app.toLowerCase().replace(/[^a-z0-9]/g, '_');
    }

    return 'celery';
  }

  private extractScheduleSemanticKey(ep: CASEntryPoint): string {
    const name = ep.name || 'scheduled_job';
    const normalized = name
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase();

    const parts = normalized.split(/[_\-\s]+/).filter(Boolean);
    const meaningfulPart = parts.find(p =>
      !['job', 'task', 'scheduled', 'cron', 'run'].includes(p)
    );

    return meaningfulPart || 'scheduled';
  }

  private extractRouteSemanticKey(ep: CASEntryPoint): string {
    const path = ep.trigger?.path || ep.name || '';

    const segments = path.split('/').filter(s =>
      s && !s.startsWith(':') && !s.startsWith('[')
    );

    if (segments.length === 0) {
      return 'home';
    }

    return segments[segments.length - 1].toLowerCase();
  }

  private extractWebSocketSemanticKey(ep: CASEntryPoint): string {
    const eventName = ep.trigger?.event || ep.name || '';
    const normalized = eventName
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase();

    const parts = normalized.split(/[_\-\s:]+/).filter(Boolean);
    const subject = parts.find(p =>
      !['on', 'handle', 'message', 'event', 'ws', 'socket'].includes(p)
    );

    return subject || 'websocket';
  }

  private extractGenericSemanticKey(ep: CASEntryPoint): string {
    const name = ep.name || 'unknown';
    const normalized = name
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase();

    const parts = normalized.split(/[_\-\s]+/).filter(Boolean);
    const meaningfulPart = parts.find(p =>
      !['handler', 'controller', 'service', 'on', 'handle'].includes(p)
    );

    return meaningfulPart || name.toLowerCase();
  }

  private isActionWord(word: string): boolean {
    return ACTION_WORDS.has(word.toLowerCase());
  }

  private mergeRelatedGroups(groups: Map<string, CASEntryPoint[]>): Map<string, CASEntryPoint[]> {
    const merged = new Map<string, CASEntryPoint[]>();
    const processed = new Set<string>();

    const groupKeys = Array.from(groups.keys()).sort();

    for (const key of groupKeys) {
      if (processed.has(key)) continue;

      const eps = groups.get(key)!;
      const parts = key.split('_');
      const resource = parts[0];

      const relatedKeys = groupKeys.filter(k => {
        if (k === key || processed.has(k)) return false;
        return k.startsWith(`${resource}_`);
      });

      if (relatedKeys.length > 0 && this.shouldMerge(key, relatedKeys, groups)) {
        const allEps = [...eps];
        for (const rk of relatedKeys) {
          allEps.push(...groups.get(rk)!);
          processed.add(rk);
        }
        merged.set(resource, allEps);
      } else {
        merged.set(key, eps);
      }
      processed.add(key);
    }

    return merged;
  }

  private shouldMerge(
    key: string,
    relatedKeys: string[],
    groups: Map<string, CASEntryPoint[]>
  ): boolean {
    const allKeys = [key, ...relatedKeys];

    const allCrud = allKeys.every(k => {
      const action = k.split('_').pop() || '';
      return ['create', 'list', 'get', 'update', 'delete'].includes(action);
    });

    if (allCrud) {
      return true;
    }

    const totalEps = allKeys.reduce((sum, k) => sum + (groups.get(k)?.length || 0), 0);
    if (totalEps <= 2) {
      return true;
    }

    return false;
  }

  private buildCapability(
    groupKey: string,
    entryPoints: CASEntryPoint[],
    index: CapabilityDetectionIndex,
    edges: CASEdge[],
    entities?: CASDataEntity[]
  ): CASCapability {
    const entryPointIds = entryPoints.map(ep => ep.id);

    const relevantChains = entryPointIds
      .flatMap(entryPointId => index.chainsByEntryPoint.get(entryPointId) || [])
      .sort((left, right) => (index.chainOrdinal.get(left) ?? 0) - (index.chainOrdinal.get(right) ?? 0));

    const operations = this.buildOperations(entryPoints, index.chainsByEntryPoint);
    const operationPatterns = this.detectOperationPatterns(operations, relevantChains);
    const servicesUsed = this.findServicesUsed(relevantChains, index.nodesById, edges);
    const exitPoints = this.collectExitPoints(relevantChains);
    const entitiesTouched = entities ?
      this.findEntitiesTouched(relevantChains, index.nodesById, index.entities) : undefined;

    const entryTypes = Array.from(new Set(entryPoints.map(ep => ep.type)));
    const primaryType = this.findPrimaryType(entryTypes);

    return {
      id: `capability_${groupKey}`,
      name: this.deriveCapabilityName(groupKey, operations, entryPoints),
      description: this.generateDescription(operations, entryPoints),

      entry_points: entryPointIds,
      entry_point_summary: {
        types: entryTypes,
        count: entryPoints.length,
        primary_type: primaryType
      },

      operations,
      operation_patterns: operationPatterns,

      entities_touched: entitiesTouched,
      services_used: servicesUsed,
      exit_points: exitPoints,

      call_chain_ids: relevantChains.map(c => c.id),
      complexity_profile: {
        avg_depth: this.avgDepth(relevantChains),
        max_depth: this.maxDepth(relevantChains),
        has_external_calls: relevantChains.some(c => c.characteristics?.has_external_calls),
        has_database_calls: relevantChains.some(c => c.characteristics?.has_database_calls),
        has_async_calls: relevantChains.some(c => c.characteristics?.has_async_calls),
        branching_factor: this.computeBranchingFactor(relevantChains)
      },

      classification: 'supporting',
      criticality: 'medium',

      signals: {
        domain_concept_score: 0,
        centrality_score: 0,
        coverage_score: 0,
        complexity_score: 0,
        total_score: 0
      },

      depends_on: [],
      depended_by: []
    };
  }

  private buildOperations(
    entryPoints: CASEntryPoint[],
    chainsByEntryPoint: Map<string, CASCallChain[]>
  ): CASOperation[] {
    const seenOperations = new Set<string>();
    const operations: CASOperation[] = [];

    for (const ep of entryPoints) {
      const operationKey = `${ep.name}_${ep.trigger?.method || ''}_${ep.trigger?.path || ''}`;
      if (seenOperations.has(operationKey)) {
        continue;
      }
      seenOperations.add(operationKey);

      const pattern = this.inferOperationPattern(ep);
      const chainIds = (chainsByEntryPoint.get(ep.id) || []).map(chain => chain.id);

      operations.push({
        id: `op_${ep.id}`,
        name: ep.name,
        pattern,
        entry_point_id: ep.id,
        call_chain_ids: chainIds,
        implementing_nodes: [ep.source_node],
        trigger: this.buildTrigger(ep)
      });
    }

    return operations;
  }

  private inferOperationPattern(ep: CASEntryPoint): CASOperation['pattern'] {
    const method = (ep.trigger?.method || '').toUpperCase();
    const name = ep.name.toLowerCase();
    const path = (ep.trigger?.path || '').toLowerCase();

    if (method === 'POST' || name.includes('create') || name.includes('add')) {
      return 'create';
    }
    if (method === 'PUT' || method === 'PATCH' || name.includes('update') || name.includes('edit')) {
      return 'update';
    }
    if (method === 'DELETE' || name.includes('delete') || name.includes('remove')) {
      return 'delete';
    }
    if (method === 'GET' && (path.includes(':') || path.includes('{'))) {
      return 'read';
    }
    if (method === 'GET' || name.includes('get') || name.includes('find') || name.includes('list')) {
      return 'query';
    }
    if (name.includes('transform') || name.includes('convert') || name.includes('process')) {
      return 'transform';
    }

    return 'action';
  }

  private buildTrigger(ep: CASEntryPoint): CASOperation['trigger'] {
    return {
      type: ep.type,
      method: ep.trigger?.method,
      path: ep.trigger?.path,
      command: ep.trigger?.pattern,
      event_name: ep.trigger?.event
    };
  }

  private detectOperationPatterns(
    operations: CASOperation[],
    callChains: CASCallChain[]
  ): CASCapability['operation_patterns'] {
    const patterns: Set<CASCapability['operation_patterns'][number]> = new Set();

    const hasCreate = operations.some(o => o.pattern === 'create');
    const hasRead = operations.some(o => o.pattern === 'read' || o.pattern === 'query');
    const hasUpdate = operations.some(o => o.pattern === 'update');
    const hasDelete = operations.some(o => o.pattern === 'delete');

    if ((hasCreate || hasUpdate || hasDelete) && hasRead) {
      patterns.add('crud');
    }

    if (operations.some(o => o.pattern === 'query')) {
      patterns.add('query');
    }

    if (operations.some(o => o.pattern === 'action')) {
      patterns.add('command');
    }

    if (operations.some(o => o.pattern === 'transform')) {
      patterns.add('transform');
    }

    const hasEventTrigger = operations.some(o =>
      o.trigger?.type === 'event' || o.trigger?.type === 'message'
    );
    if (hasEventTrigger) {
      patterns.add('event');
    }

    const hasScheduleTrigger = operations.some(o => o.trigger?.type === 'schedule');
    const hasDbCalls = callChains.some(c => c.characteristics?.has_database_calls);
    if (hasScheduleTrigger && hasDbCalls) {
      patterns.add('pipeline');
    }

    return Array.from(patterns);
  }

  private findServicesUsed(
    callChains: CASCallChain[],
    nodesById: Map<string, CASNode>,
    edges: CASEdge[]
  ): string[] {
    const serviceNodeIds = new Set<string>();

    const serviceTypes = new Set([
      'service', 'provider', 'repository', 'helper', 'utility',
      'controller', 'serializer', 'model', 'entity', 'handler', 'resolver'
    ]);

    for (const chain of callChains) {
      for (const step of chain.call_path || []) {
        const node = nodesById.get(step.node_id);
        if (node && serviceTypes.has(node.type)) {
          serviceNodeIds.add(node.id);
        }
      }
    }

    return Array.from(serviceNodeIds);
  }

  private collectExitPoints(callChains: CASCallChain[]): string[] {
    const exitPointIds = new Set<string>();

    for (const chain of callChains) {
      if (chain.exit_point?.exit_point_id) {
        exitPointIds.add(chain.exit_point.exit_point_id);
      }
    }

    return Array.from(exitPointIds);
  }

  private findEntitiesTouched(
    callChains: CASCallChain[],
    nodesById: Map<string, CASNode>,
    entities: Array<{ entity: CASDataEntity; lowerName: string }>
  ): string[] {
    const entityIds = new Set<string>();

    for (const chain of callChains) {
      for (const step of chain.call_path || []) {
        const node = nodesById.get(step.node_id);
        if (node) {
          for (const { entity, lowerName: entityNameLower } of entities) {
            const nodeNameLower = node.name.toLowerCase();
            if (nodeNameLower.includes(entityNameLower) ||
                entityNameLower.includes(nodeNameLower.replace(/service|repository|controller/gi, ''))) {
              entityIds.add(entity.id);
            }
          }
        }
      }
    }

    return Array.from(entityIds);
  }

  private findPrimaryType(types: string[]): string {
    const priority = ['http', 'cli', 'event', 'schedule', 'websocket', 'route', 'page', 'message'];
    for (const p of priority) {
      if (types.includes(p)) return p;
    }
    return types[0] || 'unknown';
  }











  private deriveCapabilityName(
    groupKey: string,
    operations: CASOperation[],
    entryPoints: CASEntryPoint[]
  ): string {
    const subject = humanizeCapabilityLabel(groupKey);
    if (!isBareNounCapabilityLabel(subject)) return subject;
    const hasAnchorEvidence = operations.length > 0 || entryPoints.length > 0;
    return deriveCapabilityNameFromOperations(subject, operations, hasAnchorEvidence) ?? subject;
  }






  private generateDescription(
    operations: CASOperation[],
    entryPoints: CASEntryPoint[]
  ): string {
    const rebuilt = buildCapabilityDescriptionFromOperations(operations);
    if (rebuilt) return rebuilt;
    const count = entryPoints.length;
    return `Covers ${count} entry point${count === 1 ? '' : 's'}.`;
  }

  private avgDepth(chains: CASCallChain[]): number {
    if (chains.length === 0) return 0;
    const total = chains.reduce((sum, c) => sum + (c.characteristics?.max_depth || 0), 0);
    return Math.round((total / chains.length) * 10) / 10;
  }

  private maxDepth(chains: CASCallChain[]): number {
    if (chains.length === 0) return 0;
    return Math.max(...chains.map(c => c.characteristics?.max_depth || 0));
  }

  private computeBranchingFactor(chains: CASCallChain[]): number {
    if (chains.length === 0) return 1;

    const branchingFactors = chains.map(chain => {
      const depth = chain.characteristics?.max_depth || 1;
      const calls = chain.characteristics?.total_calls || 1;
      return depth > 1 ? calls / depth : 1;
    });

    const avg = branchingFactors.reduce((sum, bf) => sum + bf, 0) / branchingFactors.length;
    return Math.round(avg * 10) / 10;
  }
}

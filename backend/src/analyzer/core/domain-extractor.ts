import { CASNode, CASEntryPoint, CASDataEntity, CASDomainConcept } from '../../types/cas.types';

interface ConceptOccurrence {
  name: string;
  normalizedName: string;
  entryPoints: Set<string>;
  entities: Set<string>;
  nodes: Set<string>;
  frequency: number;
}

const GENERIC_INFRASTRUCTURE_HINTS = new Set([
  'logger', 'log', 'cache', 'config',
  'util', 'utils', 'helper', 'common', 'shared', 'base',
  'middleware', 'interceptor', 'guard', 'filter', 'pipe',
  'exception', 'error', 'factory', 'builder', 'provider',
  'decorator', 'constant', 'enum', 'type', 'interface',
  'dto', 'migration', 'seed', 'fixture', 'mock', 'stub'
]);

const GENERIC_PROGRAMMING_TERMS = new Set([
  'get', 'set', 'add', 'remove', 'delete', 'update', 'create', 'find',
  'all', 'one', 'many', 'list', 'item', 'items', 'data', 'result',
  'name', 'id', 'value', 'key', 'index', 'count', 'size', 'length',
  'path', 'file', 'dir', 'line', 'column', 'start', 'end',
  'source', 'target', 'from', 'to', 'input', 'output',
  'method', 'methods', 'function', 'class', 'module', 'service', 'controller',
  'handler', 'callback', 'promise', 'async', 'await',
  'request', 'response', 'body', 'params', 'query', 'headers',
  'options', 'context', 'config', 'settings', 'props',
  'parse', 'stringify', 'format', 'transform', 'convert', 'map', 'reduce',
  'call', 'invoke', 'execute', 'run', 'process', 'handle',
  'init', 'setup', 'cleanup', 'destroy', 'reset', 'clear',
  'enable', 'disable', 'toggle', 'check', 'validate', 'verify',
  'load', 'save', 'read', 'write', 'fetch', 'send', 'receive',
  'open', 'close', 'connect', 'disconnect', 'start', 'stop',
  'true', 'false', 'null', 'undefined', 'void', 'any', 'unknown',
  'string', 'number', 'boolean', 'object', 'array', 'date',
  'info', 'debug', 'warn', 'trace', 'extract', 'build',
  'pattern', 'node', 'edge', 'parent', 'child', 'children',
  'first', 'last', 'next', 'prev', 'current', 'default',
  'status', 'state', 'type', 'types', 'entry', 'entries', 'exit', 'exits',
  'has', 'is', 'can', 'will', 'should', 'must', 'may',
  'time', 'timestamp', 'created', 'updated', 'deleted',
  'new', 'old', 'temp', 'tmp', 'test', 'spec', 'mock'
]);

const GENERIC_CROSS_CUTTING_HINTS = new Set([
  'auth', 'authentication', 'authorization',
  'session', 'token', 'jwt', 'oauth',
  'notification', 'email', 'queue', 'job', 'worker',
  'health', 'metrics', 'telemetry'
]);

export class DomainExtractor {
  private concepts: Map<string, ConceptOccurrence> = new Map();

  extract(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    dataEntities: CASDataEntity[]
  ): CASDomainConcept[] {
    this.concepts.clear();

    this.extractFromNodes(nodes);
    this.extractFromEntryPoints(entryPoints);
    this.extractFromEntities(dataEntities);

    return this.buildDomainConcepts();
  }

  private extractFromNodes(nodes: CASNode[]): void {
    for (const node of nodes) {
      if (node.metadata?.is_test) continue;
      if (node.type === 'import' || node.type === 'module') continue;

      const concepts = this.extractConceptsFromName(node.name);

      for (const concept of concepts) {
        this.recordOccurrence(concept, 'node', node.id);
      }
    }
  }

  private isApplicationEntryPoint(ep: CASEntryPoint): boolean {
    const applicationTypes = new Set([
      'http', 'cli', 'websocket', 'ws_handler', 'message',
      'event', 'scheduled', 'cron', 'queue', 'grpc', 'graphql'
    ]);

    return applicationTypes.has(ep.type);
  }

  private extractFromEntryPoints(entryPoints: CASEntryPoint[]): void {
    for (const ep of entryPoints) {
      if (ep.type === 'test') continue;
      if (!this.isApplicationEntryPoint(ep)) continue;

      const pathConcepts = this.extractConceptsFromPath(ep.trigger?.path || '');
      const nameConcepts = this.extractConceptsFromName(ep.name);

      for (const concept of [...pathConcepts, ...nameConcepts]) {
        this.recordOccurrence(concept, 'entryPoint', ep.id);
      }
    }
  }

  private extractFromEntities(entities: CASDataEntity[]): void {
    for (const entity of entities) {
      const concepts = this.extractConceptsFromName(entity.name);

      for (const concept of concepts) {
        this.recordOccurrence(concept, 'entity', entity.id);
      }

      for (const field of entity.fields || []) {
        const fieldConcepts = this.extractConceptsFromName(field.name);
        for (const concept of fieldConcepts) {
          this.recordOccurrence(concept, 'entity', entity.id);
        }
      }
    }
  }

  private extractConceptsFromName(name: string): string[] {
    const normalized = this.splitCamelCase(name);
    const words = normalized.split(/[\s_\-./]+/).filter(w => w.length > 2);

    return words.map(w => w.toLowerCase());
  }

  private extractConceptsFromPath(path: string): string[] {
    const segments = path.split('/').filter(s => s && !s.startsWith(':') && !s.startsWith('{'));
    const concepts: string[] = [];

    for (const segment of segments) {
      const words = this.splitCamelCase(segment).split(/[\s_\-]+/).filter(w => w.length > 2);
      concepts.push(...words.map(w => w.toLowerCase()));
    }

    return concepts;
  }

  private splitCamelCase(str: string): string {
    return str.replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  private recordOccurrence(
    concept: string,
    source: 'node' | 'entryPoint' | 'entity',
    id: string
  ): void {
    const normalized = concept.toLowerCase();

    if (GENERIC_PROGRAMMING_TERMS.has(normalized)) {
      return;
    }

    if (!this.concepts.has(normalized)) {
      this.concepts.set(normalized, {
        name: concept,
        normalizedName: normalized,
        entryPoints: new Set(),
        entities: new Set(),
        nodes: new Set(),
        frequency: 0
      });
    }

    const occurrence = this.concepts.get(normalized)!;

    switch (source) {
      case 'node':
        occurrence.nodes.add(id);
        break;
      case 'entryPoint':
        occurrence.entryPoints.add(id);
        break;
      case 'entity':
        occurrence.entities.add(id);
        break;
    }

    occurrence.frequency++;
  }

  private buildDomainConcepts(): CASDomainConcept[] {
    const results: CASDomainConcept[] = [];

    for (const [id, occurrence] of this.concepts) {
      if (occurrence.frequency < 2) continue;

      const classification = this.classifyConcept(occurrence);

      results.push({
        id: `concept_${id}`,
        name: occurrence.normalizedName,
        frequency: occurrence.frequency,
        appears_in: {
          entry_points: Array.from(occurrence.entryPoints),
          entities: Array.from(occurrence.entities),
          nodes: Array.from(occurrence.nodes)
        },
        classification
      });
    }

    return results.sort((a, b) => b.frequency - a.frequency);
  }

  private classifyConcept(occurrence: ConceptOccurrence): 'core' | 'supporting' | 'infrastructure' {
    const name = occurrence.normalizedName;

    if (GENERIC_INFRASTRUCTURE_HINTS.has(name)) {
      return 'infrastructure';
    }

    if (GENERIC_CROSS_CUTTING_HINTS.has(name)) {
      return 'supporting';
    }

    const appearsInEntryPoints = occurrence.entryPoints.size > 0;
    const appearsInEntities = occurrence.entities.size > 0;
    const appearsInManyNodes = occurrence.nodes.size > 3;

    const presenceScore =
      (appearsInEntryPoints ? 2 : 0) +
      (appearsInEntities ? 2 : 0) +
      (appearsInManyNodes ? 1 : 0);

    if (presenceScore >= 3) {
      return 'core';
    }

    if (appearsInEntryPoints && appearsInEntities) {
      return 'core';
    }

    if (occurrence.frequency > 10 && appearsInEntryPoints) {
      return 'core';
    }

    if (occurrence.frequency > 5 && presenceScore >= 2) {
      return 'core';
    }

    return 'supporting';
  }

  getCoreConcepts(concepts: CASDomainConcept[]): CASDomainConcept[] {
    return concepts.filter(c => c.classification === 'core');
  }

  inferPrimaryDomain(concepts: CASDomainConcept[]): string {
    const coreConcepts = this.getCoreConcepts(concepts);

    if (coreConcepts.length === 0) {
      return 'unknown';
    }

    const topConcept = coreConcepts[0];
    return topConcept.name;
  }

  inferSystemDescription(
    concepts: CASDomainConcept[],
    systemType: string
  ): string {
    const coreConcepts = this.getCoreConcepts(concepts).slice(0, 5);
    const coreNames = coreConcepts.map(c => c.name);

    if (coreNames.length === 0) {
      return `A ${systemType} system`;
    }

    const domain = coreNames[0];
    const relatedConcepts = coreNames.slice(1, 4).join(', ');

    if (relatedConcepts) {
      return `A ${systemType} system focused on ${domain}, involving ${relatedConcepts}`;
    }

    return `A ${systemType} system focused on ${domain}`;
  }
}

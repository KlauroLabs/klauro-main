import * as fs from 'fs';
import * as path from 'path';
import { CASNode, CASEntryPoint, CASDataEntity, CASDomainConcept, CASEdge } from '../../types/cas.types';
import { isEnglishFunctionWord } from './text-vocabulary';

interface ConceptOccurrence {
  name: string;
  normalizedName: string;
  entryPoints: Set<string>;
  entities: Set<string>;
  nodes: Set<string>;
  files: Set<string>;
  frequency: number;
  entityNames: Set<string>;
  capabilitySubjects: Set<string>;
  entryPointNouns: Set<string>;
  declaredTypeNames: Set<string>;
  proseTerms: Set<string>;
}

interface ConceptStats {
  maxNodeSpread: number;
  maxFrequency: number;
}

export interface DomainExtractionContext {
  capabilityNames?: string[];
}

const MIN_DECLARED_TYPE_RECURRENCE = 3;
const MIN_RETAINED_CONCEPTS = 8;
const MIN_DISTINCT_USAGE_SITES = 2;
const SYSTEM_DESCRIPTION_CORE_CONCEPT_LIMIT = 5;
const SYSTEM_DESCRIPTION_RELATED_CONCEPT_LIMIT = 3;

const DECLARED_TYPE_NODE_TYPES = new Set([
  'class', 'interface', 'type', 'struct', 'enum', 'record', 'trait', 'protocol',
  'entity', 'model', 'dto', 'schema', 'aggregate', 'valueobject', 'union',
]);

const PRESENTATION_LAYER_TERMS = new Set([
  'btn', 'navbar', 'offcanvas', 'popover', 'tooltip', 'dropdown', 'accordion',
  'breadcrumb', 'backdrop', 'popper', 'carousel', 'spinner',
  'stylesheet', 'stylesheets', 'keyframes', 'zindex', 'nowrap', 'flexbox',
  'css', 'scss', 'sass',
  'rounded', 'bordered', 'borderless', 'uppercase', 'lowercase', 'capitalize',
  'colspan', 'rowspan', 'xxl', 'xxs',
  'sprite', 'glyph', 'chevron', 'caret',
]);

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
  'document', 'documents',
  'source', 'target', 'from', 'to', 'input', 'output',
  'method', 'methods', 'function', 'class', 'module', 'modules',
  'service', 'services', 'controller', 'controllers',
  'handler', 'handlers', 'callback', 'callbacks', 'promise', 'async', 'await',
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
  'new', 'old', 'temp', 'tmp', 'test', 'spec', 'mock',
  'constructor', 'error', 'errors', 'logger', 'log', 'logs',
  'event', 'events', 'listener', 'emit', 'emitter',
  'click', 'change', 'submit', 'keydown', 'keyup', 'escape', 'enter',
  'pending', 'loading', 'enabled', 'disabled', 'internal', 'external',
  'getter', 'setter', 'helper', 'helpers', 'instance', 'global',
  'self', 'cls', 'args', 'kwargs', 'kwarg', 'arg', 'argv',
  'dummy', 'foo', 'bar', 'baz', 'qux', 'sample', 'example', 'placeholder',
  'mode', 'active', 'inactive', 'idle', 'unstable', 'stable',
  'ready', 'done', 'success', 'failure', 'valid', 'invalid',
  'empty', 'visible', 'hidden', 'selected', 'focused', 'hover',
  'expanded', 'collapsed', 'dirty', 'clean', 'busy', 'available',
  'option', 'opts', 'meta', 'misc', 'other', 'others',
  'api', 'apis', 'app', 'apps', 'lib', 'libs', 'client', 'clients',
  'backend', 'frontend', 'business', 'portal', 'portals',
  'users', 'dev',
  'page', 'pages', 'layout', 'layouts', 'metadata', 'section', 'sections',
  'navbar', 'nav', 'footer', 'button', 'arrow', 'padding', 'total',
  'home', 'submit', 'rewrites', 'rewrite', 'asset', 'assets', 'generated',
  'gql', 'model', 'models', 'mapping', 'schema', 'server', 'routes', 'web',
  'tablename', 'normalize', 'normalizer'
]);

const GENERIC_CROSS_CUTTING_HINTS = new Set([
  'auth', 'authentication', 'authorization',
  'session', 'token', 'jwt', 'oauth',
  'notification', 'email', 'queue', 'job', 'worker',
  'health', 'metrics', 'telemetry'
]);

const FRAMEWORK_AND_LIBRARY_TERMS = new Set([
  'react', 'angular', 'vue', 'svelte', 'next', 'nuxt', 'nest', 'nestjs',
  'express', 'fastify', 'koa', 'hapi', 'django', 'flask', 'rails', 'spring',
  'redux', 'mobx', 'zustand', 'recoil', 'rxjs', 'graphql', 'apollo',
  'axios', 'fetch', 'lodash', 'underscore', 'ramda', 'moment', 'dayjs',
  'jest', 'mocha', 'chai', 'jasmine', 'vitest', 'cypress', 'playwright',
  'webpack', 'vite', 'rollup', 'babel', 'eslint', 'prettier', 'tsx', 'tsc',
  'typescript', 'javascript', 'node', 'nodejs', 'deno', 'bun', 'npm', 'yarn',
  'php', 'python', 'ruby', 'java', 'csharp', 'golang', 'rust', 'dart',
  'dotnet', 'aspnet', 'mvc', 'sqlalchemy', 'microsoft', 'illuminate',
  'prisma', 'typeorm', 'sequelize', 'mongoose', 'knex', 'drizzle',
  'postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb', 'redis', 'mongo',
  'docker', 'kubernetes', 'k8s', 'terraform', 'ansible',
  'aws', 'gcp', 'azure', 'lambda', 's3', 'ec2', 'dynamodb',
  'tailwind', 'bootstrap', 'mui', 'antd', 'chakra', 'styled',
  'dto', 'dtos', 'entity', 'entities', 'repository', 'repo', 'orm',
  'middleware', 'guard', 'guards', 'interceptor', 'decorator', 'provider',
  'component', 'components', 'hook', 'hooks', 'directive', 'pipe',
  'rack', 'rake', 'turbo', 'stimulus', 'sprockets', 'hotwire',
  'actiontext', 'activestorage', 'actioncable', 'actionmailer', 'actionpack',
  'activerecord', 'activejob', 'activemodel', 'activesupport', 'actionview',
  'importmap', 'webpacker', 'propshaft', 'sidekiq', 'kaminari', 'ransack',
  'devise', 'warden', 'omniauth', 'pundit', 'cancan', 'cancancan', 'doorkeeper',
  'rspec', 'rubocop', 'erb', 'haml', 'gem', 'gems', 'gemfile', 'bundler',
]);

const ENGLISH_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'these', 'those',
  'are', 'was', 'were', 'been', 'being', 'have', 'had', 'does', 'did',
  'not', 'but', 'out', 'off', 'too', 'use', 'via', 'per', 'each',
  'into', 'onto', 'over', 'under', 'about', 'after', 'before',
  'util', 'utils', 'utility', 'utilities', 'helper', 'helpers',
  'base', 'abstract', 'impl', 'common', 'shared', 'core', 'lib',
  'main', 'app', 'src', 'dist', 'common', 'global', 'local',
  'api', 'apis', 'apps', 'libs', 'client', 'clients',
  'backend', 'frontend', 'business', 'portal', 'portals',
  'users', 'dev',
  'wrapper', 'manager', 'factory', 'builder', 'registry',
]);

export class DomainExtractor {
  private concepts: Map<string, ConceptOccurrence> = new Map();
  private projectRoot?: string;
  private compoundSpans: Set<string> = new Set();
  private compoundJoined: Map<string, string> = new Map();
  private proseWords: Set<string> = new Set();
  private declaredTypeNamesByToken: Map<string, Set<string>> = new Map();

  extract(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    dataEntities: CASDataEntity[],
    edges: CASEdge[] = [],
    projectPath?: string,
    context: DomainExtractionContext = {},
  ): CASDomainConcept[] {
    this.concepts.clear();
    this.compoundSpans = new Set();
    this.compoundJoined = new Map();
    this.proseWords = new Set();
    this.declaredTypeNamesByToken = new Map();
    this.projectRoot = projectPath
      ? projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
      : undefined;

    this.readAuthoredProse(projectPath);
    this.indexDeclaredTypeVocabulary(nodes);

    this.extractFromNodes(nodes);
    this.extractFromEntryPoints(entryPoints);
    this.extractFromEntities(dataEntities);
    this.extractFromCapabilities(context.capabilityNames || []);
    this.extractFromGraphRoles(nodes, edges);

    return this.buildDomainConcepts();
  }

  private readAuthoredProse(projectPath?: string): void {
    if (!projectPath) return;
    const authored: string[] = [];
    const compounds = new Set<string>();
    const readText = (file: string, limit: number): string => {
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size === 0) return '';
        return fs.readFileSync(file, 'utf8').slice(0, limit);
      } catch {
        return '';
      }
    };

    const manifestRaw = readText(path.join(projectPath, 'package.json'), 200000);
    if (manifestRaw) {
      try {
        const manifest = JSON.parse(manifestRaw);
        if (manifest?.description) authored.push(String(manifest.description));
        if (manifest?.name) authored.push(String(manifest.name).replace(/^@/, '').replace(/\//g, ' '));
        for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
          for (const dep of Object.keys(manifest?.[section] || {})) {
            const bare = String(dep).replace(/^@[^/]+\//, '');
            if (bare.includes('-')) compounds.add(bare.toLowerCase());
          }
        }
      } catch {   }
    }
    for (const readme of ['README.md', 'README.mdx', 'readme.md', 'Readme.md']) {
      const content = readText(path.join(projectPath, readme), 40000);
      if (content) { authored.push(content); break; }
    }
    for (const manifestFile of ['Cargo.toml', 'pyproject.toml', 'go.mod', 'composer.json', 'Gemfile']) {
      const content = readText(path.join(projectPath, manifestFile), 60000);
      for (const match of content.match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g) || []) {
        compounds.add(match.toLowerCase());
      }
    }

    const proseText = authored.join('\n');
    for (const word of proseText.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []) {
      this.proseWords.add(word);
    }
    for (const match of proseText.toLowerCase().match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g) || []) {
      compounds.add(match);
      this.proseWords.add(match);
    }

    for (const term of compounds) {
      const parts = term.split('-');
      if (parts.length < 2 || parts.length > 3) continue;
      if (!parts.every(part => part.length >= 3 && /^[a-z][a-z0-9]*$/.test(part))) continue;
      this.compoundSpans.add(term);
      this.compoundJoined.set(parts.join(''), term);
    }
  }

  private indexDeclaredTypeVocabulary(nodes: CASNode[]): void {
    for (const node of nodes) {
      if (!DECLARED_TYPE_NODE_TYPES.has(String(node.type || '').toLowerCase())) continue;
      if (node.metadata?.is_test || node.metadata?.is_generated) continue;
      if (this.isInfrastructureNode(node)) continue;
      const declaredName = String(node.name || '');
      if (!declaredName) continue;
      for (const token of this.extractConceptsFromName(declaredName)) {
        let names = this.declaredTypeNamesByToken.get(token);
        if (!names) { names = new Set(); this.declaredTypeNamesByToken.set(token, names); }
        names.add(declaredName);
      }
    }
  }

  private extractFromCapabilities(capabilityNames: string[]): void {
    for (const capabilityName of capabilityNames) {
      const name = String(capabilityName || '');
      if (!name) continue;
      const subject = this.extractConceptsFromName(name).slice(1);
      for (const concept of subject) {
        this.recordEvidence(concept, 'capabilitySubjects', name);
      }
    }
  }

  private extractFromGraphRoles(nodes: CASNode[], edges: CASEdge[]): void {
    const outgoing = new Map<string, number>();
    const incoming = new Map<string, number>();
    for (const edge of edges) {
      outgoing.set(edge.source, (outgoing.get(edge.source) || 0) + 1);
      incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
    }

    for (const node of nodes) {
      if (node.metadata?.is_test || node.metadata?.is_generated) continue;
      if (this.isInfrastructureNode(node)) continue;

      const hasChildren = (node.children || []).length > 0;
      const isTerminal = (outgoing.get(node.id) || 0) === 0 && (incoming.get(node.id) || 0) > 0;
      const isDomainCarrier = this.isLikelyDomainCarrier(node);

      if (!hasChildren && !isTerminal && !isDomainCarrier) continue;

      const relativeFile = this.projectRelativeFilePath(node.source?.file || '');
      const pathConcepts = this.extractConceptsFromPath(relativeFile);

      for (const concept of [...this.extractConceptsFromName(node.name), ...pathConcepts]) {
        this.recordOccurrence(concept, 'node', node.id);
      }
      if (relativeFile) {
        for (const concept of pathConcepts) this.recordFileSpread(concept, relativeFile);
      }
    }
  }

  private recordFileSpread(concept: string, file: string): void {
    const occurrence = this.occurrenceFor(concept);
    if (occurrence) occurrence.files.add(file);
  }

  private isLikelyDomainCarrier(node: CASNode): boolean {
    const text = `${node.type} ${node.name} ${(node.subcategories || []).join(' ')}`.toLowerCase();
    return /\b(class|entity|model|schema|aggregate|valueobject|viewmodel|controller|service|repository|usecase|handler|command|query)\b/.test(text);
  }

  private isInfrastructureNode(node: CASNode): boolean {
    const file = node.source?.file?.toLowerCase() || '';
    const text = `${node.type} ${node.name} ${(node.subcategories || []).join(' ')}`.toLowerCase();
    if (node.type === 'style_rule') return true;
    if (/\.(css|scss|sass|less|styl|stylus)$/.test(file)) return true;
    if (/(^|\/)(migrations?|db\/migrate)(\/|$)/.test(file)) return true;
    return node.type === 'import' ||
      node.type === 'file' ||
      /(^|\/)(test|tests|spec|__tests__|fixtures?|__fixtures__|mocks?|__mocks__|examples?|samples?|docs?|documentation|snippets?|dist|build|node_modules|coverage|vendor|generated)(\/|$)/.test(file) ||
      /\.(min|bundle)\.(js|css)$/.test(file) ||
      /\/lib\/(waypoints|owlcarousel|chart|easing|tempusdominus|bootstrap|jquery)\//.test(file) ||
      /^legacy\//.test(file) ||
      /\.(test|spec|stories|story)\.[a-z0-9]+$/i.test(file) ||
      /\b(config|logger|middleware|guard|interceptor|decorator|provider|factory|builder|util|helper|mock|fixture|test|spec)\b/.test(text);
  }

  private extractFromNodes(nodes: CASNode[]): void {
    for (const node of nodes) {
      if (node.metadata?.is_test) continue;
      if (this.isInfrastructureNode(node)) continue;
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
      if (this.isInfrastructurePath(ep.handler?.file || '')) continue;

      const pathConcepts = this.extractConceptsFromPath(ep.trigger?.path || '');
      const nameConcepts = this.extractConceptsFromName(ep.name);

      for (const concept of [...pathConcepts, ...nameConcepts]) {
        this.recordOccurrence(concept, 'entryPoint', ep.id);
        this.recordEvidence(concept, 'entryPointNouns', ep.trigger?.path || ep.name || ep.id);
      }
    }
  }

  private extractFromEntities(entities: CASDataEntity[]): void {
    for (const entity of entities) {
      for (const concept of this.extractConceptsFromName(entity.name)) {
        this.recordOccurrence(concept, 'entity', entity.id);
        this.recordEvidence(concept, 'entityNames', entity.name);
      }

      for (const field of entity.fields || []) {
        for (const concept of this.extractConceptsFromName(field.name)) {
          this.recordOccurrence(concept, 'entity', entity.id);
        }
      }
    }
  }

  private extractConceptsFromName(name: string): string[] {
    return this.tokenizeWithCompounds(name);
  }

  private tokenizeWithCompounds(raw: string): string[] {
    const words = this.splitCamelCase(String(raw || ''))
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (this.compoundSpans.size === 0 && this.compoundJoined.size === 0) {
      return words.filter(word => word.length > 2);
    }
    const tokens: string[] = [];
    let index = 0;
    while (index < words.length) {
      let matchedSpan = 0;
      for (let span = 3; span >= 2; span--) {
        if (index + span > words.length) continue;
        const candidate = words.slice(index, index + span).join('-');
        if (this.compoundSpans.has(candidate)) {
          tokens.push(candidate);
          matchedSpan = span;
          break;
        }
      }
      if (matchedSpan) { index += matchedSpan; continue; }
      const joined = this.compoundJoined.get(words[index]);
      if (joined) { tokens.push(joined); index++; continue; }
      if (words[index].length > 2) tokens.push(words[index]);
      index++;
    }
    return tokens;
  }

  private projectRelativeFilePath(file: string): string {
    const normalized = file.replace(/\\/g, '/');
    if (this.projectRoot) {
      if (normalized === this.projectRoot) return '';
      if (normalized.startsWith(`${this.projectRoot}/`)) {
        return normalized.slice(this.projectRoot.length + 1);
      }
    }
    if (/^(?:[a-zA-Z]:)?\//.test(normalized)) return '';
    return normalized;
  }

  private extractConceptsFromPath(path: string): string[] {
    const segments = path.split('/').filter(s => s && !s.startsWith(':') && !s.startsWith('{'));
    const concepts: string[] = [];

    for (const segment of segments) {
      const base = segment.replace(/\.[a-z0-9]+$/i, '');
      concepts.push(...this.tokenizeWithCompounds(base));
    }

    return concepts;
  }

  private splitCamelCase(str: string): string {
    return str.replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  private isSuppressedTerm(normalized: string): boolean {
    return (
      /^\d+$/.test(normalized) ||
      GENERIC_PROGRAMMING_TERMS.has(normalized) ||
      FRAMEWORK_AND_LIBRARY_TERMS.has(normalized) ||
      ENGLISH_STOPWORDS.has(normalized) ||
      PRESENTATION_LAYER_TERMS.has(normalized) ||
      isEnglishFunctionWord(normalized)
    );
  }

  private occurrenceFor(concept: string): ConceptOccurrence | undefined {
    const normalized = concept.toLowerCase();
    if (this.isSuppressedTerm(normalized)) return undefined;
    let occurrence = this.concepts.get(normalized);
    if (!occurrence) {
      occurrence = {
        name: concept,
        normalizedName: normalized,
        entryPoints: new Set(),
        entities: new Set(),
        nodes: new Set(),
        files: new Set(),
        frequency: 0,
        entityNames: new Set(),
        capabilitySubjects: new Set(),
        entryPointNouns: new Set(),
        declaredTypeNames: new Set(),
        proseTerms: new Set(),
      };
      this.concepts.set(normalized, occurrence);
    }
    return occurrence;
  }

  private recordOccurrence(
    concept: string,
    source: 'node' | 'entryPoint' | 'entity',
    id: string
  ): void {
    const occurrence = this.occurrenceFor(concept);
    if (!occurrence) return;

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

  private recordEvidence(
    concept: string,
    channel: 'entityNames' | 'capabilitySubjects' | 'entryPointNouns' | 'declaredTypeNames' | 'proseTerms',
    citation: string,
  ): void {
    const occurrence = this.occurrenceFor(concept);
    if (!occurrence || !citation) return;
    occurrence[channel].add(citation);
  }

  private distinctUsageSites(occurrence: ConceptOccurrence): number {
    return occurrence.nodes.size + occurrence.entryPoints.size +
      occurrence.entities.size + occurrence.files.size;
  }

  private distinctivenessEvidence(occurrence: ConceptOccurrence): string[] {
    const cited: string[] = [];
    const sample = (values: Set<string>, limit = 3) => [...values].slice(0, limit).join(', ');
    if (occurrence.entityNames.size > 0) {
      cited.push(`entity name: ${sample(occurrence.entityNames)}`);
    }
    if (occurrence.capabilitySubjects.size > 0) {
      cited.push(`capability subject: ${sample(occurrence.capabilitySubjects, 2)}`);
    }
    if (occurrence.entryPointNouns.size > 0) {
      cited.push(`entry-point noun: ${sample(occurrence.entryPointNouns)}`);
    }
    if (occurrence.declaredTypeNames.size >= MIN_DECLARED_TYPE_RECURRENCE) {
      cited.push(`declared type (${occurrence.declaredTypeNames.size}): ${sample(occurrence.declaredTypeNames)}`);
    }
    if (occurrence.proseTerms.size > 0) {
      cited.push(`authored prose: ${sample(occurrence.proseTerms, 1)}`);
    }
    return cited;
  }

  private distinctivenessScore(occurrence: ConceptOccurrence): number {
    const channels =
      (occurrence.entityNames.size > 0 ? 4 : 0) +
      (occurrence.capabilitySubjects.size > 0 ? 4 : 0) +
      (occurrence.entryPointNouns.size > 0 ? 3 : 0) +
      (occurrence.declaredTypeNames.size >= MIN_DECLARED_TYPE_RECURRENCE ? 2 : 0) +
      (occurrence.proseTerms.size > 0 ? 3 : 0);
    const depth =
      Math.log2(1 + occurrence.entityNames.size) +
      Math.log2(1 + occurrence.capabilitySubjects.size) +
      Math.log2(1 + occurrence.entryPointNouns.size) +
      Math.log2(1 + occurrence.declaredTypeNames.size);
    return channels * 10 + depth * 2 + Math.log2(1 + this.distinctUsageSites(occurrence));
  }

  private mergePluralIntoSingular(): void {
    for (const [plural, occurrence] of [...this.concepts]) {
      const singular = this.singularForm(plural);
      if (singular === plural) continue;
      const target = this.concepts.get(singular);
      if (!target) continue;
      for (const id of occurrence.nodes) target.nodes.add(id);
      for (const id of occurrence.entryPoints) target.entryPoints.add(id);
      for (const id of occurrence.entities) target.entities.add(id);
      for (const file of occurrence.files) target.files.add(file);
      for (const citation of occurrence.entityNames) target.entityNames.add(citation);
      for (const citation of occurrence.capabilitySubjects) target.capabilitySubjects.add(citation);
      for (const citation of occurrence.entryPointNouns) target.entryPointNouns.add(citation);
      for (const citation of occurrence.declaredTypeNames) target.declaredTypeNames.add(citation);
      for (const citation of occurrence.proseTerms) target.proseTerms.add(citation);
      for (const declaredName of this.declaredTypeNamesByToken.get(plural) || []) {
        let names = this.declaredTypeNamesByToken.get(singular);
        if (!names) { names = new Set(); this.declaredTypeNamesByToken.set(singular, names); }
        names.add(declaredName);
      }
      this.concepts.delete(plural);
    }
  }

  private singularForm(word: string): string {
    if (/(ss|us|is|as|os)$/.test(word)) return word;
    if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
    if (/(sses|shes|ches|xes|zes)$/.test(word)) return word.slice(0, -2);
    if (/s$/.test(word) && word.length > 3) return word.slice(0, -1);
    return word;
  }

  private buildDomainConcepts(): CASDomainConcept[] {
    for (const [normalized, occurrence] of this.concepts) {
      for (const declaredName of this.declaredTypeNamesByToken.get(normalized) || []) {
        occurrence.declaredTypeNames.add(declaredName);
      }
      if (this.proseWords.has(normalized)) occurrence.proseTerms.add(normalized);
    }

    this.mergePluralIntoSingular();

    const entries: Array<{ id: string; occurrence: ConceptOccurrence }> = [];
    for (const [id, occurrence] of this.concepts) {
      const sites = this.distinctUsageSites(occurrence);
      if (sites < 1) continue;
      const anchored = occurrence.entityNames.size > 0 || occurrence.capabilitySubjects.size > 0;
      if (sites < MIN_DISTINCT_USAGE_SITES && !anchored) continue;
      occurrence.frequency = sites;
      entries.push({ id, occurrence });
    }

    const stats: ConceptStats = { maxNodeSpread: 0, maxFrequency: 0 };
    for (const { occurrence } of entries) {
      stats.maxNodeSpread = Math.max(stats.maxNodeSpread, occurrence.nodes.size);
      if (!GENERIC_INFRASTRUCTURE_HINTS.has(occurrence.normalizedName)) {
        stats.maxFrequency = Math.max(stats.maxFrequency, occurrence.frequency);
      }
    }

    const occurrenceByName = new Map<string, ConceptOccurrence>();
    const results: CASDomainConcept[] = [];
    for (const { id, occurrence } of entries) {
      occurrenceByName.set(occurrence.normalizedName, occurrence);
      results.push({
        id: `concept_${id}`,
        name: occurrence.normalizedName,
        frequency: occurrence.frequency,
        appears_in: {
          entry_points: Array.from(occurrence.entryPoints).sort(),
          entities: Array.from(occurrence.entities).sort(),
          nodes: Array.from(occurrence.nodes).sort()
        },
        classification: this.classifyConcept(occurrence, stats),
        description: this.describeConcept(occurrence),
        distinctiveness: Math.round(this.distinctivenessScore(occurrence) * 100) / 100,
        distinctiveness_evidence: this.distinctivenessEvidence(occurrence),
      });
    }

    results.sort((left, right) => {
      const byScore =
        this.distinctivenessScore(occurrenceByName.get(right.name)!) -
        this.distinctivenessScore(occurrenceByName.get(left.name)!);
      return byScore || right.frequency - left.frequency || left.name.localeCompare(right.name);
    });

    this.ensureCoreConcepts(results, occurrenceByName);

    return this.retainDistinctiveConcepts(results, occurrenceByName);
  }

  private describeConcept(occurrence: ConceptOccurrence): string {
    const parts: string[] = [];
    if (occurrence.entities.size > 0) {
      parts.push(`${occurrence.entities.size} data ${occurrence.entities.size === 1 ? 'entity' : 'entities'}`);
    }
    if (occurrence.entryPoints.size > 0) {
      parts.push(`${occurrence.entryPoints.size} entry ${occurrence.entryPoints.size === 1 ? 'point' : 'points'}`);
    }
    if (occurrence.nodes.size > 0) {
      parts.push(`${occurrence.nodes.size} code ${occurrence.nodes.size === 1 ? 'unit' : 'units'}`);
    }
    if (occurrence.files.size > 0) {
      parts.push(`${occurrence.files.size} ${occurrence.files.size === 1 ? 'file path' : 'file paths'}`);
    }
    const where = parts.length > 0 ? parts.join(', ') : 'no located references';
    const sites = this.distinctUsageSites(occurrence);
    return `Vocabulary term "${occurrence.name}" appears in ${where} (${sites} distinct usage ${sites === 1 ? 'site' : 'sites'}).`;
  }

  private retainDistinctiveConcepts(
    results: CASDomainConcept[],
    byName: Map<string, ConceptOccurrence>,
  ): CASDomainConcept[] {
    const retained = results.filter(concept => (concept.distinctiveness_evidence || []).length > 0);

    if (retained.length === 0) {
      for (const concept of results) {
        if (retained.length >= MIN_RETAINED_CONCEPTS) break;
        if ((concept.distinctiveness_evidence || []).length > 0) continue;
        const occurrence = byName.get(concept.name);
        if (!occurrence || this.distinctUsageSites(occurrence) < MIN_DISTINCT_USAGE_SITES) continue;
        concept.distinctiveness_evidence = [
          `structural prominence: ${this.distinctUsageSites(occurrence)} usage sites, no channel evidence`,
        ];
        retained.push(concept);
      }
    }

    return retained;
  }

  private classifyConcept(
    occurrence: ConceptOccurrence,
    stats: ConceptStats
  ): 'core' | 'supporting' | 'infrastructure' {
    const name = occurrence.normalizedName;

    if (GENERIC_INFRASTRUCTURE_HINTS.has(name)) {
      return 'infrastructure';
    }

    const appearsInEntryPoints = occurrence.entryPoints.size > 0;
    const appearsInEntities = occurrence.entities.size > 0;
    const appearsInManyNodes = occurrence.nodes.size > 3;

    const presenceScore =
      (appearsInEntryPoints ? 2 : 0) +
      (appearsInEntities ? 2 : 0) +
      (appearsInManyNodes ? 1 : 0);

    const boundaryCore =
      presenceScore >= 4 ||
      (appearsInEntryPoints && appearsInEntities) ||
      occurrence.entityNames.size > 0 ||
      occurrence.capabilitySubjects.size > 0;

    const nodeDominance =
      stats.maxNodeSpread > 0 ? occurrence.nodes.size / stats.maxNodeSpread : 0;
    const frequencyDominance =
      stats.maxFrequency > 0 ? occurrence.frequency / stats.maxFrequency : 0;
    const prominenceCore =
      (occurrence.nodes.size >= 5 && nodeDominance >= 0.5) ||
      (occurrence.frequency >= 3 && frequencyDominance >= 0.6);

    if (boundaryCore || prominenceCore) return 'core';

    if (GENERIC_CROSS_CUTTING_HINTS.has(name)) return 'supporting';

    return 'supporting';
  }

  private prominenceScore(occurrence: ConceptOccurrence): number {
    return (
      occurrence.nodes.size * 2 +
      occurrence.frequency +
      occurrence.entryPoints.size * 3 +
      occurrence.entities.size * 3
    );
  }

  private ensureCoreConcepts(
    results: CASDomainConcept[],
    byName: Map<string, ConceptOccurrence>
  ): void {
    const TARGET_CORE = 1;
    const coreCount = results.filter(c => c.classification === 'core').length;
    if (coreCount >= TARGET_CORE) return;

    const candidates = results
      .filter(c => c.classification === 'supporting')
      .filter(c => {
        const o = byName.get(c.name);
        return !!o && o.frequency >= 3 && (o.nodes.size >= 2 || o.frequency >= 5);
      })
      .sort((a, b) => {
        const oa = byName.get(a.name)!;
        const ob = byName.get(b.name)!;
        return this.prominenceScore(ob) - this.prominenceScore(oa);
      });

    const toPromote = Math.min(TARGET_CORE - coreCount, candidates.length);
    for (let i = 0; i < toPromote; i++) {
      candidates[i].classification = 'core';
    }
  }

  private isInfrastructurePath(path: string): boolean {
    const file = path.replace(/\\/g, '/').toLowerCase();
    return /(^|\/)(test|tests|spec|__tests__|fixtures?|__fixtures__|mocks?|__mocks__|examples?|samples?|docs?|documentation|snippets?|dist|build|node_modules|coverage|vendor|generated)(\/|$)/.test(file) ||
      /\.(min|bundle)\.(js|css)$/.test(file) ||
      /\/lib\/(waypoints|owlcarousel|chart|easing|tempusdominus|bootstrap|jquery)\//.test(file) ||
      /^legacy\//.test(file) ||
      /\.(test|spec|stories|story)\.[a-z0-9]+$/i.test(file);
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
    const coreConcepts = this.getCoreConcepts(concepts).slice(0, SYSTEM_DESCRIPTION_CORE_CONCEPT_LIMIT);
    const coreNames = coreConcepts.map(c => c.name);

    if (coreNames.length === 0) {
      return `A ${systemType} system`;
    }

    const domain = coreNames[0];
    const relatedConcepts = coreNames.slice(1, 1 + SYSTEM_DESCRIPTION_RELATED_CONCEPT_LIMIT).join(', ');

    if (relatedConcepts) {
      return `A ${systemType} system focused on ${domain}, involving ${relatedConcepts}`;
    }

    return `A ${systemType} system focused on ${domain}`;
  }
}

import { CASNode, CASEntryPoint, CASDataEntity, CASDomainConcept, CASEdge } from '../../types/cas.types';
import { isEnglishFunctionWord } from './text-vocabulary';

interface ConceptOccurrence {
  name: string;
  normalizedName: string;
  entryPoints: Set<string>;
  entities: Set<string>;
  nodes: Set<string>;
  frequency: number;
}

interface ConceptStats {
  maxNodeSpread: number;
  maxFrequency: number;
}

const MAX_DOMAIN_CONCEPT_NODE_REFERENCES = 200;
const MAX_DOMAIN_CONCEPT_ENTRY_REFERENCES = 100;
const MAX_DOMAIN_CONCEPT_ENTITY_REFERENCES = 100;
/** Absolute floor for a concept the distribution alone would admit. */
const MIN_DISTINCTIVE_CONCEPT_FREQUENCY = 3;
/**
 * Below this many concepts there is no distribution to reason about, and the
 * list is short enough to be useful as-is.
 */
const MIN_CONCEPTS_FOR_DISTRIBUTION_TRIM = 60;

/**
 * Words of the PRESENTATION LANGUAGE ITSELF — CSS selector conventions,
 * stylesheet mechanics, and utility-class naming shipped by UI frameworks.
 *
 * Deliberately SMALL. The load-bearing fix for stylesheet noise is structural
 * (style-rule nodes and stylesheet files are excluded from concept extraction
 * outright, see isInfrastructureNode); this set only catches the residue that
 * reaches concept extraction through OTHER files' paths and identifiers.
 *
 * Every entry must be a word with no plausible business meaning in any
 * industry, so that suppressing it can never hide a real domain concept.
 * Dual-use words are deliberately absent — `order`, `content`, `header`,
 * `container`, `target`, `media`, `theme`, `alert`, `size`, `weight`, `color`
 * and their kin are all CSS vocabulary AND ordinary domain nouns, and a
 * repository that genuinely deals in them must be able to say so.
 */
const PRESENTATION_LAYER_TERMS = new Set([
  // UI-framework component-class names
  'btn', 'navbar', 'offcanvas', 'popover', 'tooltip', 'dropdown', 'accordion',
  'breadcrumb', 'backdrop', 'popper', 'carousel', 'spinner',
  // stylesheet mechanics
  'stylesheet', 'stylesheets', 'keyframes', 'zindex', 'nowrap', 'flexbox',
  'css', 'scss', 'sass',
  // utility-class morphology
  'rounded', 'bordered', 'borderless', 'uppercase', 'lowercase', 'capitalize',
  'colspan', 'rowspan', 'xxl', 'xxs',
  // icon/sprite plumbing
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

// Framework, library, and tooling names. These show up constantly in
// identifiers and import paths but describe the tech stack, not the
// business domain.
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

// Common English stopwords and structural-noise words that survive the
// length-3 filter but carry no domain meaning.
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

  extract(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    dataEntities: CASDataEntity[],
    edges: CASEdge[] = [],
    projectPath?: string
  ): CASDomainConcept[] {
    this.concepts.clear();
    this.projectRoot = projectPath
      ? projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
      : undefined;

    this.extractFromNodes(nodes);
    this.extractFromEntryPoints(entryPoints);
    this.extractFromEntities(dataEntities);
    this.extractFromGraphRoles(nodes, edges);

    return this.buildDomainConcepts();
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

      const concepts = [
        ...this.extractConceptsFromName(node.name),
        ...this.extractConceptsFromPath(this.projectRelativeFilePath(node.source?.file || '')),
      ];
      const weight = isDomainCarrier ? 3 : hasChildren ? 2 : 1;

      for (const concept of concepts) {
        for (let i = 0; i < weight; i++) {
          this.recordOccurrence(concept, 'node', node.id);
        }
      }
    }
  }

  private isLikelyDomainCarrier(node: CASNode): boolean {
    const text = `${node.type} ${node.name} ${(node.subcategories || []).join(' ')}`.toLowerCase();
    return /\b(class|entity|model|schema|aggregate|valueobject|viewmodel|controller|service|repository|usecase|handler|command|query)\b/.test(text);
  }

  private isInfrastructureNode(node: CASNode): boolean {
    const file = node.source?.file?.toLowerCase() || '';
    const text = `${node.type} ${node.name} ${(node.subcategories || []).join(' ')}`.toLowerCase();
    // STYLE RULES ARE NOT DOMAIN VOCABULARY. A `style_rule` node's name is a
    // CSS SELECTOR (".navbar-expand-sm .offcanvas", ":root, [data-bs-theme]",
    // ".popover .popover-arrow::before"), which is presentation syntax. A
    // single bundled UI framework stylesheet emits thousands of them and, left
    // in, they dominate the concept distribution outright: measured on a real
    // production analysis, 2,720 of 3,684 nodes (74%) were style rules from one
    // vendored CSS bundle, and the resulting `domain_concepts` list was almost
    // entirely selector fragments and utility-class names.
    if (node.type === 'style_rule') return true;
    if (/\.(css|scss|sass|less|styl|stylus)$/.test(file)) return true;
    // Schema-migration files are named by sequence number and table plumbing,
    // not by domain vocabulary; the numbers themselves ("0001".."0016") were
    // surfacing as concepts.
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
    // Identifiers arrive from every supported language and framework, including
    // route templates, qualified type names, namespace separators, and IaC
    // addresses. Tokenize on every non-alphanumeric boundary so punctuation can
    // never become a domain concept ("{id}", ":id", "Route\\Facade").
    const words = normalized.split(/[^A-Za-z0-9]+/).filter(w => w.length > 2);

    return words.map(w => w.toLowerCase());
  }

  /**
   * Filesystem location must never become domain vocabulary. Source-file
   * paths are reduced to their repo-relative form before concept extraction.
   * Absolute file paths that do not sit under the analyzed root (or whose
   * root is unknown) are skipped entirely, so clone locations like
   * /tmp/some-workspace/repo cannot leak workspace names into domain
   * concepts. Only applied to source-file paths; HTTP route paths are
   * extracted unchanged.
   */
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
      // Tokenize on EVERY non-alphanumeric boundary, exactly as
      // extractConceptsFromName does. Splitting only on whitespace/_/-/. left
      // punctuation attached to the token, so syntax debris like "child)",
      // "[data", "arrow::before," and 'theme="light"]' survived intact and was
      // emitted as domain vocabulary.
      const words = this.splitCamelCase(base).split(/[^A-Za-z0-9]+/).filter(w => w.length > 2);
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

    if (
      // Purely numeric tokens are sequence numbers and version stamps
      // (migration ordinals, breakpoint sizes), never domain vocabulary.
      /^\d+$/.test(normalized) ||
      GENERIC_PROGRAMMING_TERMS.has(normalized) ||
      FRAMEWORK_AND_LIBRARY_TERMS.has(normalized) ||
      ENGLISH_STOPWORDS.has(normalized) ||
      PRESENTATION_LAYER_TERMS.has(normalized) ||
      isEnglishFunctionWord(normalized)
    ) {
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
    const entries: Array<{ id: string; occurrence: ConceptOccurrence }> = [];
    for (const [id, occurrence] of this.concepts) {
      if (occurrence.frequency < 2) continue;
      entries.push({ id, occurrence });
    }

    // Global stats let classification scale with the codebase rather than
    // relying on absolute thresholds that over-fire on large repos and
    // never fire on small ones.
    const nonInfra = entries.filter(
      e => !GENERIC_INFRASTRUCTURE_HINTS.has(e.occurrence.normalizedName)
    );
    const stats: ConceptStats = {
      maxNodeSpread: Math.max(0, ...entries.map(e => e.occurrence.nodes.size)),
      maxFrequency: Math.max(0, ...nonInfra.map(e => e.occurrence.frequency)),
    };

    const occurrenceByName = new Map<string, ConceptOccurrence>();
    const results: CASDomainConcept[] = [];
    for (const { id, occurrence } of entries) {
      occurrenceByName.set(occurrence.normalizedName, occurrence);
      results.push({
        id: `concept_${id}`,
        name: occurrence.normalizedName,
        frequency: occurrence.frequency,
        appears_in: {
          entry_points: Array.from(occurrence.entryPoints).slice(0, MAX_DOMAIN_CONCEPT_ENTRY_REFERENCES),
          entities: Array.from(occurrence.entities).slice(0, MAX_DOMAIN_CONCEPT_ENTITY_REFERENCES),
          nodes: Array.from(occurrence.nodes).slice(0, MAX_DOMAIN_CONCEPT_NODE_REFERENCES)
        },
        classification: this.classifyConcept(occurrence, stats),
        description: this.describeConcept(occurrence),
      });
    }

    results.sort((a, b) => b.frequency - a.frequency);

    // Promotion safety net. Repos with no recognized entry points or data
    // entities (CLIs, bots, libraries, data pipelines) can end up with zero
    // `core` concepts even when they have a perfectly clear domain. When that
    // happens, promote the most structurally prominent non-infrastructure
    // concepts so the domain is never left entirely unclassified.
    this.ensureCoreConcepts(results, occurrenceByName);

    return this.retainDistinctiveConcepts(results, occurrenceByName);
  }

  /**
   * Factual, evidence-grounded description of WHERE a concept appears. This is
   * structure (Camp B), not comprehension: it reports counted occurrences and
   * nothing else, so it can never claim a meaning the codebase does not show.
   *
   * `domain_concepts` previously shipped with no description field at all —
   * every consumer that read one got `undefined`, on every entry, in every
   * analysis.
   */
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
    const where = parts.length > 0 ? parts.join(', ') : 'no located references';
    return `Vocabulary term "${occurrence.name}" appears in ${where} (${occurrence.frequency} total occurrences).`;
  }

  /**
   * Keeps only the concepts the repository's own evidence distinguishes.
   *
   * Emitting every token that occurs twice produced lists of hundreds to
   * thousands of entries per repository (measured: 341–5,767 across production
   * analyses) in which the genuinely load-bearing vocabulary was
   * indistinguishable from incidental identifier noise. A surface that long is
   * not a domain model, and downstream consumers that mine it for repository
   * vocabulary were matching on the noise.
   *
   * A concept is retained when the repository's structure singles it out:
   *  - it is anchored at a real boundary (a data entity or an entry point), or
   *  - the classifier judged it `core`, or
   *  - its frequency reaches the distribution's own upper decile.
   *
   * The cutoff is derived from THIS repository's frequency distribution, so it
   * scales with codebase size instead of over-firing on large repositories and
   * never firing on small ones.
   */
  private retainDistinctiveConcepts(
    results: CASDomainConcept[],
    byName: Map<string, ConceptOccurrence>,
  ): CASDomainConcept[] {
    // A percentile over a handful of samples is not a distribution. Small
    // concept sets do not have the problem this trim exists to solve — they
    // are already readable — and trimming them by a cutoff derived from eight
    // data points discards real vocabulary. Leave them intact.
    if (results.length <= MIN_CONCEPTS_FOR_DISTRIBUTION_TRIM) return results;
    const frequencies = results.map(concept => concept.frequency).sort((a, b) => a - b);
    const upperDecile = frequencies[Math.floor(frequencies.length * 0.9)] ?? 0;
    const cutoff = Math.max(MIN_DISTINCTIVE_CONCEPT_FREQUENCY, upperDecile);

    const retained = results.filter(concept => {
      const occurrence = byName.get(concept.name);
      if (occurrence && (occurrence.entities.size > 0 || occurrence.entryPoints.size > 0)) return true;
      if (concept.classification === 'core') return true;
      return concept.frequency >= cutoff;
    });

    // Never return an empty domain model when concepts were found: a tiny
    // repository whose whole distribution sits below the floor still has a
    // most-prominent vocabulary.
    return retained.length > 0 ? retained : results.slice(0, 10);
  }

  /**
   * Classifies a concept by structural prominence. The entry-point / data-
   * entity anchored rules handle web services and APIs well; the relative
   * node-dominance rule additionally catches domains that never surface at a
   * recognized boundary (bot logic, CLI commands, library exports).
   */
  private classifyConcept(
    occurrence: ConceptOccurrence,
    stats: ConceptStats
  ): 'core' | 'supporting' | 'infrastructure' {
    const name = occurrence.normalizedName;

    // Infrastructure terms are always infrastructure.
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

    // Boundary-anchored core (web services, APIs).
    const boundaryCore =
      presenceScore >= 3 ||
      (appearsInEntryPoints && appearsInEntities) ||
      (occurrence.frequency > 10 && appearsInEntryPoints) ||
      (occurrence.frequency > 5 && presenceScore >= 2);

    // Prominence-anchored core (no boundary required). A concept that
    // pervades a large share of the codebase, or recurs far more often than
    // its peers, is core regardless of entry points or entities — this is
    // what surfaces the domain of bots, CLIs, libraries, and pipelines.
    const nodeDominance =
      stats.maxNodeSpread > 0 ? occurrence.nodes.size / stats.maxNodeSpread : 0;
    const frequencyDominance =
      stats.maxFrequency > 0 ? occurrence.frequency / stats.maxFrequency : 0;
    const prominenceCore =
      (occurrence.nodes.size >= 5 && nodeDominance >= 0.5) ||
      (occurrence.frequency >= 5 && frequencyDominance >= 0.6);

    // Prominence overrides the cross-cutting hint: `token`/`session`/`auth`
    // are usually supporting concerns, but in a domain that is genuinely
    // *about* them (a token-trading bot, an auth provider) they dominate the
    // codebase and are correctly core.
    if (boundaryCore || prominenceCore) return 'core';

    if (GENERIC_CROSS_CUTTING_HINTS.has(name)) return 'supporting';

    return 'supporting';
  }

  /**
   * Prominence score used to rank concepts for the promotion safety net.
   * Distinct-node spread is weighted highest because a concept threaded
   * through many code units is a stronger domain signal than one repeated
   * inside a single file.
   */
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
        // Require a minimum footprint so noise is never promoted.
        return !!o && o.frequency >= 3 && (o.nodes.size >= 2 || o.frequency >= 5);
      })
      .sort((a, b) => {
        const oa = byName.get(a.name)!;
        const ob = byName.get(b.name)!;
        return this.prominenceScore(ob) - this.prominenceScore(oa);
      });

    // Promote only when structural classification found NO core concept. A
    // fixed quota fabricates importance on small/polyglot repos by promoting
    // framework and package vocabulary merely to fill five slots.
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

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
  /**
   * Distinct FILES whose repo-relative path contains the term — the repository
   * organizing a module or directory around it. Counted as usage SPREAD, never
   * as distinctiveness evidence: a directory name is how `workbench`/`avatar`
   * would walk back in.
   */
  files: Set<string>;
  frequency: number;
  /**
   * DISTINCTIVENESS EVIDENCE, tracked per channel. Occurrence count is NOT
   * evidence — every token in the repository occurs, and ranking by raw
   * occurrence is what admitted several hundred generic English words as
   * "domain concepts". A term is this system's vocabulary only when the
   * repository's own structure or its authors single it out.
   */
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

/**
 * Authored/structural context the distinctiveness gate needs. Every field is
 * optional: with none of it the extractor still runs, and falls back to the
 * ranked prominence floor rather than emitting an unfiltered token list.
 */
export interface DomainExtractionContext {
  /** System capability names — their subject nouns are domain vocabulary. */
  capabilityNames?: string[];
}

const MAX_DOMAIN_CONCEPT_NODE_REFERENCES = 200;
const MAX_DOMAIN_CONCEPT_ENTRY_REFERENCES = 100;
const MAX_DOMAIN_CONCEPT_ENTITY_REFERENCES = 100;
/**
 * Upper bound on the emitted vocabulary. A domain model is something a person
 * can read and recognize as this system's subject matter; at several hundred
 * entries it is a token dump, and consumers that mine it for repository
 * vocabulary match on the noise. Cap only — never padded to reach it.
 */
const MAX_DOMAIN_CONCEPTS = 40;
/**
 * How many DISTINCT declared type names must contain a token before the type
 * vocabulary counts as evidence for it. One incidental type name is not the
 * system's vocabulary; the same noun recurring across separate declarations is.
 */
const MIN_DECLARED_TYPE_RECURRENCE = 3;
/**
 * Floor for repositories whose vocabulary lives nowhere the evidence channels
 * can see it — a script/CLI/bot codebase of bare functions, with no declared
 * types, entities, capabilities, or authored prose. Rather than emit nothing (or
 * fall back to the whole unfiltered token list), top the retained set up to this
 * many by DISTINCTIVENESS RANK, cited honestly as structural prominence.
 */
const MIN_RETAINED_CONCEPTS = 8;
/** A term must occupy at least this many distinct usage sites to be considered. */
const MIN_DISTINCT_USAGE_SITES = 2;

/**
 * Node types that DECLARE a named shape — the codebase's type vocabulary. A
 * function or variable name is deliberately excluded: those are where incidental
 * English lives (`triggered`, `assigned`, `acknowledged`), and admitting them is
 * indistinguishable from ranking by raw occurrence.
 */
const DECLARED_TYPE_NODE_TYPES = new Set([
  'class', 'interface', 'type', 'struct', 'enum', 'record', 'trait', 'protocol',
  'entity', 'model', 'dto', 'schema', 'aggregate', 'valueobject', 'union',
]);

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
  /** Authored compound terms, kebab form (`tree-sitter`). See readAuthoredProse. */
  private compoundSpans: Set<string> = new Set();
  /** Separator-free form (`treesitter`) -> the kebab term it stands for. */
  private compoundJoined: Map<string, string> = new Map();
  /** Lowercased words appearing in authored prose (README / manifest). */
  private proseWords: Set<string> = new Set();
  /** Token -> distinct declared type names containing it. */
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

    // Authored evidence and the compound lexicon FIRST: tokenization consults
    // the lexicon, so it has to exist before any name is split.
    this.readAuthoredProse(projectPath);
    this.indexDeclaredTypeVocabulary(nodes);

    this.extractFromNodes(nodes);
    this.extractFromEntryPoints(entryPoints);
    this.extractFromEntities(dataEntities);
    this.extractFromCapabilities(context.capabilityNames || []);
    this.extractFromGraphRoles(nodes, edges);

    return this.buildDomainConcepts();
  }

  /**
   * Reads the repository's AUTHORED text — the manifest's own description/name
   * and the README — for two purposes:
   *
   *  1. PROSE EVIDENCE. A word the authors use when explaining the product is
   *     the product's vocabulary, independent of how often it appears in code.
   *  2. THE COMPOUND LEXICON. `tree-sitter` shipped as two concepts, `tree` and
   *     `sitter`, because tokenization split on every non-alphanumeric boundary.
   *     A hyphenated term in authored prose (or a hyphenated dependency name) is
   *     a term the authors treat as ONE word, so tokenization preserves it.
   *     Sourcing the lexicon from PROSE and MANIFEST — never from file names —
   *     is what keeps kebab-case filenames from becoming single giant concepts.
   *
   * Deterministic, bounded (two files), and entirely optional: with no project
   * path (or an unreadable repo) both channels are simply empty.
   */
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
        // Dependency names are authored, hyphenated terms. They join the
        // COMPOUND LEXICON only — they are not prose evidence, so a dependency
        // still has to earn its way in through a real evidence channel.
        for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
          for (const dep of Object.keys(manifest?.[section] || {})) {
            const bare = String(dep).replace(/^@[^/]+\//, '');
            if (bare.includes('-')) compounds.add(bare.toLowerCase());
          }
        }
      } catch { /* an unparseable manifest simply contributes nothing */ }
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
      // A compound the authors WROTE is prose evidence in its own right; one
      // that only appears as a dependency name is not.
      this.proseWords.add(match);
    }

    // Only compounds whose PARTS are all real words are kept — a hyphenated
    // version string or hash fragment is not a term. Spans are capped at three
    // words, which is what tokenizeWithCompounds probes.
    for (const term of compounds) {
      const parts = term.split('-');
      if (parts.length < 2 || parts.length > 3) continue;
      if (!parts.every(part => part.length >= 3 && /^[a-z][a-z0-9]*$/.test(part))) continue;
      this.compoundSpans.add(term);
      this.compoundJoined.set(parts.join(''), term);
    }
  }

  /**
   * Indexes which DECLARED TYPE names contain each token, so the gate can ask
   * whether the codebase's type vocabulary keeps naming this thing rather than
   * whether the token merely occurs.
   */
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

  /**
   * Capability SUBJECTS. A capability name states what the system does to what
   * ("Analyze codebase structure"), and the object of that sentence is domain
   * vocabulary by construction — it is what the product's own capability
   * catalog is about.
   */
  private extractFromCapabilities(capabilityNames: string[]): void {
    for (const capabilityName of capabilityNames) {
      const name = String(capabilityName || '');
      if (!name) continue;
      // The SUBJECT, not the verb. A capability name opens with the action
      // ("Manage organizations and workspaces"), and crediting the leading verb
      // put `manage` in the domain vocabulary of a codebase-analysis product.
      // A verb that is also genuinely this system's subject matter still arrives
      // through its other channels.
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

      // The weighted repeat-recording that used to live here inflated the raw
      // occurrence counter (up to 3 per node) and nothing else; usage SITES are
      // distinct ids, so a node counts once however it is weighted. Structural
      // importance is expressed through the distinctiveness channels instead.
      for (const concept of [...this.extractConceptsFromName(node.name), ...pathConcepts]) {
        this.recordOccurrence(concept, 'node', node.id);
      }
      if (relativeFile) {
        for (const concept of pathConcepts) this.recordFileSpread(concept, relativeFile);
      }
    }
  }

  /** Records that a term names part of a real file path (spread, not evidence). */
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
        // The noun at a real boundary — a route segment or the handler's own
        // name — is what the system exposes, and therefore its vocabulary.
        this.recordEvidence(concept, 'entryPointNouns', ep.trigger?.path || ep.name || ep.id);
      }
    }
  }

  private extractFromEntities(entities: CASDataEntity[]): void {
    for (const entity of entities) {
      for (const concept of this.extractConceptsFromName(entity.name)) {
        this.recordOccurrence(concept, 'entity', entity.id);
        // The entity's NAME is distinctiveness evidence. Its FIELD names below
        // are not: a field list is where a record's incidental attributes live
        // (`timezone`, `locale`, `triggered`), and crediting them is what let
        // ordinary English ride into the vocabulary on an entity's coat-tails.
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
    // Identifiers arrive from every supported language and framework, including
    // route templates, qualified type names, namespace separators, and IaC
    // addresses. Tokenize on every non-alphanumeric boundary so punctuation can
    // never become a domain concept ("{id}", ":id", "Route\\Facade") — then
    // re-join the spans the authors write as ONE term (see compoundLexicon).
    return this.tokenizeWithCompounds(name);
  }

  /**
   * Splits an identifier or path segment into tokens, preserving any span that
   * the compound lexicon says is a single authored term.
   *
   * Word-span rejoining (rather than substring search) keeps this O(tokens): a
   * camelCase `TreeSitterParser` and a kebab `tree-sitter-parser` both reduce to
   * the same word list, so one lookup per span position resolves both forms.
   */
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
      // A compound written with no separator at all (`treesitter`).
      const joined = this.compoundJoined.get(words[index]);
      if (joined) { tokens.push(joined); index++; continue; }
      if (words[index].length > 2) tokens.push(words[index]);
      index++;
    }
    return tokens;
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
      // extractConceptsFromName does — through the SAME tokenizer, so an
      // authored compound survives in a path (`src/cross-parser/…`) just as it
      // does in an identifier. Splitting only on whitespace/_/-/. left
      // punctuation attached to the token, so syntax debris like "child)",
      // "[data", "arrow::before," and 'theme="light"]' survived intact and was
      // emitted as domain vocabulary.
      concepts.push(...this.tokenizeWithCompounds(base));
    }

    return concepts;
  }

  private splitCamelCase(str: string): string {
    return str.replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  /** Vocabulary that is never a domain concept regardless of its evidence. */
  private isSuppressedTerm(normalized: string): boolean {
    return (
      // Purely numeric tokens are sequence numbers and version stamps
      // (migration ordinals, breakpoint sizes), never domain vocabulary.
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

  /**
   * Records a DISTINCTIVENESS citation without inventing a usage site. Evidence
   * answers "why is this a concept"; sites answer "where does it occur". The two
   * are deliberately separate — conflating them is how occurrence count came to
   * stand in for significance.
   */
  private recordEvidence(
    concept: string,
    channel: 'entityNames' | 'capabilitySubjects' | 'entryPointNouns' | 'declaredTypeNames' | 'proseTerms',
    citation: string,
  ): void {
    const occurrence = this.occurrenceFor(concept);
    if (!occurrence || !citation) return;
    occurrence[channel].add(citation);
  }

  /**
   * DISTINCT USAGE SITES — the number of separate places the term is actually
   * used (code units, entry points, entities), not how many times a token was
   * counted. The old `frequency` was a raw occurrence counter that the
   * graph-role pass incremented up to three times per node, and it reported
   * 54,297 for the top term of a 57,356-node repository: a number that cannot
   * distinguish a pervasive domain noun from a common English word, and was
   * nonetheless the ranking key.
   */
  private distinctUsageSites(occurrence: ConceptOccurrence): number {
    return occurrence.nodes.size + occurrence.entryPoints.size +
      occurrence.entities.size + occurrence.files.size;
  }

  /** Cited distinctiveness channels for a term, strongest first. */
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

  /**
   * DISTINCTIVENESS RANK. Channel breadth dominates: a term the entity model,
   * the capability catalog and the authors all name is the system's vocabulary,
   * whatever its token count. Site spread contributes only as a tie-breaker, and
   * logarithmically, so a term cannot climb the list by sheer repetition.
   */
  private distinctivenessScore(occurrence: ConceptOccurrence): number {
    const channels =
      (occurrence.entityNames.size > 0 ? 4 : 0) +
      (occurrence.capabilitySubjects.size > 0 ? 4 : 0) +
      (occurrence.entryPointNouns.size > 0 ? 3 : 0) +
      (occurrence.declaredTypeNames.size >= MIN_DECLARED_TYPE_RECURRENCE ? 2 : 0) +
      (occurrence.proseTerms.size > 0 ? 3 : 0);
    // Breadth WITHIN a channel: many entities/capabilities naming the term is
    // stronger than one, but with diminishing returns.
    const depth =
      Math.log2(1 + occurrence.entityNames.size) +
      Math.log2(1 + occurrence.capabilitySubjects.size) +
      Math.log2(1 + occurrence.entryPointNouns.size) +
      Math.log2(1 + occurrence.declaredTypeNames.size);
    return channels * 10 + depth * 2 + Math.log2(1 + this.distinctUsageSites(occurrence));
  }

  /**
   * `workspace` and `workspaces` are ONE term. Both surface because identifiers
   * and route paths use whichever number reads better, and both were emitted:
   * five of a forty-entry vocabulary were plural twins of another entry, which
   * both wastes the budget and reads as though the system had two concepts.
   * Merged only when BOTH forms are present, so a term that only ever appears
   * plural keeps the form the codebase actually uses.
   */
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

  /** Conservative English singularizer; returns the input when unsure. */
  private singularForm(word: string): string {
    if (/(ss|us|is|as|os)$/.test(word)) return word;
    if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
    if (/(sses|shes|ches|xes|zes)$/.test(word)) return word.slice(0, -2);
    if (/s$/.test(word) && word.length > 3) return word.slice(0, -1);
    return word;
  }

  private buildDomainConcepts(): CASDomainConcept[] {
    // Fold the declared-type index and the prose channel into the occurrences
    // now that every term is known.
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
      // A single site is enough only when the entity model or the capability
      // catalog names the term; otherwise it needs a second site to be a term
      // of this system at all rather than one incidental identifier.
      const anchored = occurrence.entityNames.size > 0 || occurrence.capabilitySubjects.size > 0;
      if (sites < MIN_DISTINCT_USAGE_SITES && !anchored) continue;
      occurrence.frequency = sites;
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
        distinctiveness: Math.round(this.distinctivenessScore(occurrence) * 100) / 100,
        distinctiveness_evidence: this.distinctivenessEvidence(occurrence),
      });
    }

    // Ranked by DISTINCTIVENESS, not by occurrence count. The list's order is
    // what every truncating consumer reads first, so ordering by raw frequency
    // put the most common English word at the top of the domain model.
    results.sort((left, right) => {
      const byScore =
        this.distinctivenessScore(occurrenceByName.get(right.name)!) -
        this.distinctivenessScore(occurrenceByName.get(left.name)!);
      return byScore || right.frequency - left.frequency || left.name.localeCompare(right.name);
    });

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
    if (occurrence.files.size > 0) {
      parts.push(`${occurrence.files.size} ${occurrence.files.size === 1 ? 'file path' : 'file paths'}`);
    }
    const where = parts.length > 0 ? parts.join(', ') : 'no located references';
    const sites = this.distinctUsageSites(occurrence);
    return `Vocabulary term "${occurrence.name}" appears in ${where} (${sites} distinct usage ${sites === 1 ? 'site' : 'sites'}).`;
  }

  /**
   * Keeps only the terms the repository's own evidence DISTINGUISHES.
   *
   * The previous gate retained anything anchored in an entity or entry point,
   * anything the classifier called core, or anything in the frequency
   * distribution's upper decile. Since entity FIELD names counted as an entity
   * anchor and the ranking key was raw occurrence, ordinary English rode in on
   * both routes: a measured production analysis emitted 599 "concepts" whose
   * tail was `triggered, grants, assigned, leave, iteration, ... locale,
   * reproduction`. Frequency is not distinctiveness — every token in the
   * repository occurs.
   *
   * A term is retained only with a CITED channel (see distinctivenessEvidence):
   * it names a data entity, is the subject of a system capability, is a noun at
   * an entry point, recurs across the declared-type vocabulary, or the authors
   * use it in the README/manifest prose.
   */
  private retainDistinctiveConcepts(
    results: CASDomainConcept[],
    byName: Map<string, ConceptOccurrence>,
  ): CASDomainConcept[] {
    const retained = results.filter(concept => (concept.distinctiveness_evidence || []).length > 0);

    // PROMINENCE FLOOR — only when the channels found NOTHING. A repository
    // whose vocabulary lives nowhere they can see it (bare functions, no
    // declared types, no entities, no authored prose) would otherwise report an
    // empty domain model; it gets a small ranked list, labeled honestly.
    //
    // Deliberately NOT a top-up to a quota: a repository that yielded three
    // cited terms HAS three: padding the rest from the rejected tail would
    // reinstate exactly the words the gate exists to remove.
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
      // `results` is already in distinctiveness order; restore that order after
      // the top-up so the floor entries sit where their rank puts them.
      retained.sort((left, right) => results.indexOf(left) - results.indexOf(right));
    }

    return retained.slice(0, MAX_DOMAIN_CONCEPTS);
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

    // Boundary-anchored core (web services, APIs). The absolute
    // frequency thresholds that used to live here (`frequency > 10`,
    // `frequency > 5`) were relics of the raw occurrence counter: on a large
    // repository every retained term clears them, and classification collapsed
    // to "everything is core". What remains is STRUCTURE — how many distinct
    // boundaries name the term — plus the two channels that mean the product's
    // own data model or capability catalog names it.
    // TWO boundaries, or the product's own model/catalog naming it. A single
    // boundary plus "appears in more than three nodes" reached the old
    // presenceScore >= 3 for essentially every retained term on a large
    // repository, which is how `classification` came out as 40-of-40 core and
    // stopped telling consumers anything.
    const boundaryCore =
      presenceScore >= 4 ||
      (appearsInEntryPoints && appearsInEntities) ||
      occurrence.entityNames.size > 0 ||
      occurrence.capabilitySubjects.size > 0;

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
      (occurrence.frequency >= 3 && frequencyDominance >= 0.6);

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

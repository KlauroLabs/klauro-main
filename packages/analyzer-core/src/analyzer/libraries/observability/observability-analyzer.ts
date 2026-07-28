import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import { CASEdge, CASContribution, CASLibrary, CASNode } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';
import { createYieldBudget } from '../../core/event-loop-yield';

type ObservabilityKind = 'telemetry' | 'span' | 'metric' | 'logger';

interface DependencyHit {
  name: string;
  version?: string;
  type: CASLibrary['type'];
  packageManager: string;
}

interface ObservabilityRule {
  id: string;
  displayName: string;
  packages: string[];
  packageManagers: string[];
  imports: string[];
  fileExtensions: string[];
  kind: ObservabilityKind;
  extractors: ObservabilityExtractor[];
  agentGuidance: string;
}

interface ObservabilityExtractor {
  label: string;
  pattern: RegExp;
  kind?: ObservabilityKind;
  defaultIdentifier: string;
}

interface InstrumentationHit {
  ruleId: string;
  displayName: string;
  kind: ObservabilityKind;
  identifier: string;
  operation: string;
  file: string;
  line: number;
  excerpt: string;
  agentGuidance: string;
}

interface PreparedSourceFile {
  content: string;
  imports: string[];
}

const RULES: ObservabilityRule[] = [
  rule('opentelemetry-js', 'OpenTelemetry JS', ['@opentelemetry/api', '@opentelemetry/sdk-node'], ['npm'], ['@opentelemetry/api', '@opentelemetry/sdk-node'], ['ts', 'tsx', 'js', 'jsx'], 'telemetry', [
    extractor('tracer setup', /\b(?:trace\.)?getTracer\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'telemetry', 'otel-tracer'),
    extractor('span start', /\bstartSpan\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'span', 'otel-span'),
    extractor('sdk setup', /\bnew\s+NodeSDK\s*\(/g, 'telemetry', 'otel-sdk'),
  ], 'OpenTelemetry static instrumentation should line up with runtime trace correlation: preserve span names, tracer identity, and SDK setup ownership.'),
  rule('opentelemetry-python', 'OpenTelemetry Python', ['opentelemetry-api', 'opentelemetry-sdk', 'opentelemetry'], ['pip'], ['opentelemetry'], ['py'], 'telemetry', [
    extractor('tracer setup', /\btrace\.get_tracer\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'telemetry', 'otel-tracer'),
    extractor('span start', /\bstart_as_current_span\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'span', 'otel-span'),
  ], 'OpenTelemetry static instrumentation should line up with runtime trace correlation: preserve span names, tracer identity, and SDK setup ownership.'),
  rule('opentelemetry-java', 'OpenTelemetry Java', ['io.opentelemetry', 'opentelemetry-api', 'opentelemetry-sdk'], ['maven', 'gradle'], ['io.opentelemetry'], ['java'], 'telemetry', [
    extractor('tracer setup', /\bgetTracer\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'telemetry', 'otel-tracer'),
    extractor('span builder', /\bspanBuilder\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'span', 'otel-span'),
    extractor('with span annotation', /@WithSpan(?:\s*\(\s*['"`](?<name>[^'"`]+)['"`]\s*\))?/g, 'span', 'with-span'),
  ], 'OpenTelemetry static instrumentation should line up with runtime trace correlation: preserve span names, tracer identity, and SDK setup ownership.'),
  rule('datadog-trace', 'Datadog Trace', ['dd-trace'], ['npm'], ['dd-trace'], ['ts', 'tsx', 'js', 'jsx'], 'telemetry', [
    extractor('tracer setup', /\btracer\.init\s*\(/g, 'telemetry', 'dd-trace-init'),
    extractor('trace span', /\btracer\.trace\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'span', 'dd-trace-span'),
  ], 'Datadog tracing instrumentation should preserve operation names and tracer initialization order.'),
  rule('datadog-browser', 'Datadog Browser SDK', ['@datadog/browser-logs', '@datadog/browser-rum'], ['npm'], ['@datadog/browser-logs', '@datadog/browser-rum'], ['ts', 'tsx', 'js', 'jsx'], 'telemetry', [
    extractor('rum setup', /\bdatadogRum\.init\s*\(/g, 'telemetry', 'dd-rum-init'),
    extractor('logs setup', /\bdatadogLogs\.init\s*\(/g, 'telemetry', 'dd-logs-init'),
    extractor('logger creation', /\bdatadogLogs\.createLogger\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'logger', 'dd-browser-logger'),
    extractor('error capture', /\bdatadogRum\.addError\s*\(\s*(?<name>[A-Za-z0-9_.$]+)/g, 'telemetry', 'dd-rum-error'),
  ], 'Datadog browser RUM/logs init and named loggers feed operational dashboards; preserve service names, logger identities, and captured error context.'),
  rule('datadog-mobile', 'Datadog Mobile React Native', ['@datadog/mobile-react-native'], ['npm'], ['@datadog/mobile-react-native'], ['ts', 'tsx', 'js', 'jsx'], 'telemetry', [
    extractor('sdk setup', /\bDdSdkReactNative\.initialize\s*\(/g, 'telemetry', 'dd-rn-init'),
    extractor('sdk configuration', /\bnew\s+DdSdkReactNativeConfiguration\s*\(/g, 'telemetry', 'dd-rn-config'),
    extractor('log call', /\bDdLogs\.(?:error|warn|info|debug)\s*\(/g, 'logger', 'dd-rn-log-call'),
  ], 'Datadog React Native SDK init and DdLogs calls define the mobile observability surface; preserve configuration flags and log levels.'),
  rule('sentry-js', 'Sentry JS', ['@sentry/node', '@sentry/nextjs', '@sentry/browser'], ['npm'], ['@sentry/node', '@sentry/nextjs', '@sentry/browser'], ['ts', 'tsx', 'js', 'jsx'], 'telemetry', [
    extractor('error reporter setup', /\bSentry\.init\s*\(/g, 'telemetry', 'sentry-init'),
    extractor('exception capture', /\bSentry\.captureException\s*\(\s*(?<name>[A-Za-z0-9_.$]+)/g, 'telemetry', 'captureException'),
    extractor('message capture', /\bSentry\.captureMessage\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'telemetry', 'captureMessage'),
  ], 'Sentry capture sites are operational error boundaries; preserve what is captured and any scope/context attached nearby.'),
  rule('sentry-python', 'Sentry Python', ['sentry-sdk'], ['pip'], ['sentry_sdk'], ['py'], 'telemetry', [
    extractor('error reporter setup', /\bsentry_sdk\.init\s*\(/g, 'telemetry', 'sentry-init'),
    extractor('exception capture', /\bcapture_exception\s*\(\s*(?<name>[A-Za-z0-9_.$]+)/g, 'telemetry', 'capture_exception'),
    extractor('message capture', /\bcapture_message\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'telemetry', 'capture_message'),
  ], 'Sentry capture sites are operational error boundaries; preserve what is captured and any scope/context attached nearby.'),
  rule('rollbar-js', 'Rollbar JS', ['rollbar'], ['npm'], ['rollbar'], ['ts', 'tsx', 'js', 'jsx'], 'telemetry', [
    extractor('error reporter setup', /\bnew\s+Rollbar\s*\(/g, 'telemetry', 'rollbar-init'),
    extractor('exception capture', /\brollbar\.(?:error|critical)\s*\(\s*(?<name>[A-Za-z0-9_.$'"]+)/g, 'telemetry', 'rollbar-error'),
  ], 'Rollbar capture sites are operational error boundaries; preserve payload context and capture severity.'),
  rule('bugsnag-js', 'Bugsnag JS', ['@bugsnag/js', '@bugsnag/node'], ['npm'], ['@bugsnag/js', '@bugsnag/node'], ['ts', 'tsx', 'js', 'jsx'], 'telemetry', [
    extractor('error reporter setup', /\bBugsnag\.start\s*\(/g, 'telemetry', 'bugsnag-start'),
    extractor('exception capture', /\bBugsnag\.notify\s*\(\s*(?<name>[A-Za-z0-9_.$]+)/g, 'telemetry', 'bugsnag-notify'),
  ], 'Bugsnag capture sites are operational error boundaries; preserve notify payloads and release-stage filtering.'),
  rule('prom-client', 'prom-client', ['prom-client'], ['npm'], ['prom-client'], ['ts', 'tsx', 'js', 'jsx'], 'metric', [
    extractor('counter metric', /\bnew\s+Counter\s*\(\s*\{[\s\S]{0,180}?\bname\s*:\s*['"`](?<name>[^'"`]+)['"`]/g, 'metric', 'counter'),
    extractor('gauge metric', /\bnew\s+Gauge\s*\(\s*\{[\s\S]{0,180}?\bname\s*:\s*['"`](?<name>[^'"`]+)['"`]/g, 'metric', 'gauge'),
    extractor('histogram metric', /\bnew\s+Histogram\s*\(\s*\{[\s\S]{0,180}?\bname\s*:\s*['"`](?<name>[^'"`]+)['"`]/g, 'metric', 'histogram'),
    extractor('metric mutation', /\b(?<name>[A-Za-z0-9_.$]+)\.(?:inc|observe|set)\s*\(/g, 'metric', 'prom-client-metric'),
  ], 'Prometheus metrics define runtime cardinality and operational signals; preserve metric names, labels, and bucket choices.'),
  rule('statsd-js', 'StatsD JS', ['hot-shots', 'node-statsd', 'hotshots'], ['npm'], ['hot-shots', 'node-statsd', 'hotshots'], ['ts', 'tsx', 'js', 'jsx'], 'metric', [
    extractor('statsd metric', /\b[A-Za-z0-9_.$]+(?:statsd|StatsD|metrics|client)[A-Za-z0-9_.$]*\.(?:increment|decrement|gauge|histogram|timing)\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'metric', 'statsd-metric'),
  ], 'StatsD metrics define operational signals; preserve metric names, sampling, and tag/cardinality choices.'),
  rule('micrometer-java', 'Micrometer', ['io.micrometer', 'micrometer-core', 'micrometer-registry-prometheus'], ['maven', 'gradle'], ['io.micrometer'], ['java'], 'metric', [
    extractor('counter metric', /\bCounter\.builder\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'metric', 'micrometer-counter'),
    extractor('timer metric', /\bTimer\.builder\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'metric', 'micrometer-timer'),
    extractor('registry metric', /\bmeterRegistry\.(?:counter|gauge|timer|summary)\s*\(\s*['"`](?<name>[^'"`]+)['"`]/g, 'metric', 'micrometer-meter'),
    extractor('timed annotation', /@Timed\s*\(\s*value\s*=\s*['"`](?<name>[^'"`]+)['"`]/g, 'metric', 'micrometer-timed'),
  ], 'Micrometer metrics define runtime cardinality and operational signals; preserve meter names, tags, and registry ownership.'),
  rule('winston', 'Winston', ['winston'], ['npm'], ['winston'], ['ts', 'tsx', 'js', 'jsx'], 'logger', [
    extractor('logger creation', /\b(?:winston\.)?createLogger\s*\(/g, 'logger', 'winston-logger'),
    extractor('error log', /\b[A-Za-z0-9_.$]*logger\.(?:error|warn|info|debug)\s*\(/g, 'logger', 'winston-log-call'),
  ], 'Structured logging is the static operational narrative; preserve logger abstraction, levels, and structured fields.'),
  rule('pino', 'Pino', ['pino'], ['npm'], ['pino'], ['ts', 'tsx', 'js', 'jsx'], 'logger', [
    extractor('logger creation', /\bpino\s*\(/g, 'logger', 'pino-logger'),
    extractor('error log', /\b[A-Za-z0-9_.$]*logger\.(?:error|warn|info|debug)\s*\(/g, 'logger', 'pino-log-call'),
  ], 'Structured logging is the static operational narrative; preserve logger abstraction, levels, and structured fields.'),
  rule('bunyan', 'Bunyan', ['bunyan'], ['npm'], ['bunyan'], ['ts', 'tsx', 'js', 'jsx'], 'logger', [
    extractor('logger creation', /\bbunyan\.createLogger\s*\(/g, 'logger', 'bunyan-logger'),
    extractor('error log', /\b[A-Za-z0-9_.$]*logger\.(?:error|warn|info|debug)\s*\(/g, 'logger', 'bunyan-log-call'),
  ], 'Structured logging is the static operational narrative; preserve logger abstraction, levels, and structured fields.'),
  rule('python-logging', 'Python logging', [], [], ['logging'], ['py'], 'logger', [
    extractor('logger creation', /\blogging\.getLogger\s*\(\s*['"`]?(?<name>[^'"`)\n]+)?['"`]?\s*\)/g, 'logger', 'python-logger'),
    extractor('log call', /\b(?:logger|log)\.(?:exception|error|warning|info|debug)\s*\(/g, 'logger', 'python-log-call'),
  ], 'Structured logging is the static operational narrative; preserve logger names, levels, and contextual fields.'),
  rule('structlog', 'structlog', ['structlog'], ['pip'], ['structlog'], ['py'], 'logger', [
    extractor('logger creation', /\bstructlog\.get_logger\s*\(\s*['"`]?(?<name>[^'"`)\n]+)?['"`]?\s*\)/g, 'logger', 'structlog-logger'),
    extractor('log call', /\b(?:logger|log)\.(?:exception|error|warning|info|debug)\s*\(/g, 'logger', 'structlog-log-call'),
  ], 'Structured logging is the static operational narrative; preserve event names, bound context, and levels.'),
  rule('java-logging', 'Java logging', ['org.slf4j', 'log4j', 'logback-classic', 'ch.qos.logback'], ['maven', 'gradle'], ['org.slf4j', 'org.apache.logging.log4j', 'ch.qos.logback'], ['java'], 'logger', [
    extractor('logger creation', /\bLoggerFactory\.getLogger\s*\(\s*(?<name>[A-Za-z0-9_.$]+)\.class\s*\)/g, 'logger', 'java-logger'),
    extractor('log call', /\blogger\.(?:error|warn|info|debug)\s*\(/g, 'logger', 'java-log-call'),
  ], 'Structured logging is the static operational narrative; preserve logger names, levels, and contextual fields.'),
  rule('go-zap', 'zap', ['go.uber.org/zap'], ['go'], ['go.uber.org/zap'], ['go'], 'logger', [
    extractor('logger creation', /\bzap\.(?:NewProduction|NewDevelopment|NewExample)\s*\(/g, 'logger', 'zap-logger'),
    extractor('log call', /\blogger\.(?:Error|Warn|Info|Debug)\s*\(/g, 'logger', 'zap-log-call'),
  ], 'Structured logging is the static operational narrative; preserve logger names, levels, and structured fields.'),
  rule('go-zerolog', 'zerolog', ['github.com/rs/zerolog'], ['go'], ['github.com/rs/zerolog'], ['go'], 'logger', [
    extractor('logger creation', /\bzerolog\.New\s*\(/g, 'logger', 'zerolog-logger'),
    extractor('log call', /\blog\.(?:Error|Warn|Info|Debug)\s*\(\s*\)/g, 'logger', 'zerolog-log-call'),
  ], 'Structured logging is the static operational narrative; preserve logger names, levels, and structured fields.'),
];

export class ObservabilityAnalyzer extends BaseAnalyzer {
  constructor() {
    super('observability-instrumentation', 'Observability Instrumentation Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const dependencies = await this.readDependencies(projectPath);
    if (RULES.some(ruleDef => dependencies.some(dep => this.ruleMatchesDependency(ruleDef, dep)))) return true;

    const files = await this.sourceFiles({ projectPath });
    for (const file of files.slice(0, 200)) {
      const content = await this.readTextFileIfExists(path.join(projectPath, file));
      if (content && RULES.some(ruleDef => this.fileReferencesRule(content, ruleDef))) return true;
    }
    return false;
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return this.sourceFiles({ projectPath });
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const { nodes, edges, libraries, hits } = await this.analyzeInstrumentation(
      context.projectPath,
      await this.sourceFiles(context),
      true
    );

    const contribution = this.createContribution(nodes, edges, [], [], {
      library_family: 'observability-instrumentation',
      instrumentation_nodes: hits.length,
      spans: hits.filter(hit => hit.kind === 'span').length,
      metrics: hits.filter(hit => hit.kind === 'metric').length,
      loggers: hits.filter(hit => hit.kind === 'logger').length,
      telemetry: hits.filter(hit => hit.kind === 'telemetry').length,
      exception_capture_sites: hits.filter(hit => /capture|error reporter|notify|rollbar/.test(hit.operation)).length,
      logger_abstractions: Array.from(new Set(hits.filter(hit => hit.kind === 'logger').map(hit => hit.displayName))),
      categories: ['observability'],
    });
    contribution.libraries = libraries;
    return contribution;
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const content = await fs.readFile(context.filePath, 'utf8');
    const stat = await fs.stat(context.filePath);
    const { nodes, edges } = await this.analyzeInstrumentation(context.projectPath, [context.relativePath], false);
    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      [],
      [],
      this.extractImports(content),
      nodes.map(node => node.name)
    );
  }

  protected getCapabilities(): string[] {
    return [
      'static-observability-inventory',
      'span-and-tracer-detection',
      'metric-cardinality-surface-detection',
      'error-capture-site-detection',
      'structured-logger-abstraction-detection',
    ];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'observability module' : 'instrumentation';
  }

  private async analyzeInstrumentation(
    projectPath: string,
    sourceFiles: string[],
    includeLibraries: boolean
  ): Promise<{ nodes: CASNode[]; edges: CASEdge[]; libraries: CASLibrary[]; hits: InstrumentationHit[] }> {
    const dependencies = await this.readDependencies(projectPath);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const libraries: CASLibrary[] = [];
    const allHits: InstrumentationHit[] = [];
    const moduleNodes = new Set<string>();
    const preparedFiles = await this.prepareSourceFiles(projectPath, sourceFiles);

    for (const ruleDef of RULES) {
      const dependencyHits = dependencies.filter(dep => this.ruleMatchesDependency(ruleDef, dep));
      const hits = await this.findInstrumentation(sourceFiles, ruleDef, preparedFiles);
      if (dependencyHits.length === 0 && hits.length === 0) continue;
      allHits.push(...hits);

      for (const hit of hits.slice(0, 250)) {
        const moduleNodeId = `observability_module_${this.sanitizeId(hit.file)}`;
        if (!moduleNodes.has(moduleNodeId)) {
          moduleNodes.add(moduleNodeId);
          nodes.push(this.createNode(
            moduleNodeId,
            `${path.basename(hit.file)} observability surface`,
            'module',
            3,
            hit.file,
            1,
            1,
            {
              subcategories: ['observability-module'],
            }
          ));
        }

        const nodeId = `observability_${hit.kind}_${this.sanitizeId(hit.ruleId)}_${this.sanitizeId(hit.identifier)}_${this.sanitizeId(hit.file)}_${hit.line}`;
        nodes.push(this.createNode(
          nodeId,
          `${hit.displayName}: ${hit.identifier}`,
          hit.kind,
          4,
          hit.file,
          hit.line,
          hit.line,
          {
            observability_system: hit.displayName,
            instrumentation_kind: hit.kind,
            identifier: hit.identifier,
            operation: hit.operation,
            excerpt: hit.excerpt,
            agent_guidance: hit.agentGuidance,
            subcategories: ['observability-instrumentation', hit.kind, hit.ruleId],
          }
        ));

        edges.push(this.createEdge(
          `edge_${nodeId}_instruments_${moduleNodeId}`,
          nodeId,
          moduleNodeId,
          'instruments',
          'observability',
          { instrumentation_kind: hit.kind, system: hit.ruleId, file: hit.file, line: hit.line }
        ));
      }

      if (includeLibraries) libraries.push(this.buildLibraryFact(ruleDef, dependencyHits, hits));
    }

    return { nodes, edges, libraries, hits: allHits };
  }

  private async prepareSourceFiles(projectPath: string, files: string[]): Promise<Map<string, PreparedSourceFile>> {
    const prepared = new Map<string, PreparedSourceFile>();
    const maybeYield = createYieldBudget();
    for (const relativeFile of files) {
      await maybeYield();
      const content = await this.readTextFileIfExists(path.join(projectPath, relativeFile));
      if (!content) continue;
      prepared.set(relativeFile, { content, imports: [...(this.sourceImports(content) ?? this.extractImports(content))] });
    }
    return prepared;
  }

  private async findInstrumentation(
    files: string[],
    ruleDef: ObservabilityRule,
    preparedFiles: Map<string, PreparedSourceFile>
  ): Promise<InstrumentationHit[]> {
    const hits: InstrumentationHit[] = [];
    const applicableFiles = files.filter(file => ruleDef.fileExtensions.some(ext => file.endsWith(`.${ext}`)));

    // Budget-yield per file: with the shared file-read cache warm the await
    // resolves in a microtask (no event-loop hop), so this scan ran as one
    // multi-second synchronous block on a whale repo. Results unchanged.
    const maybeYield = createYieldBudget();
    for (const relativeFile of applicableFiles) {
      await maybeYield();
      const prepared = preparedFiles.get(relativeFile);
      if (!prepared || !this.fileReferencesRule(prepared.content, ruleDef, prepared.imports)) continue;
      const { content } = prepared;

      for (const extractorDef of ruleDef.extractors) {
        extractorDef.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = extractorDef.pattern.exec(content)) !== null) {
          const line = this.sourceLineForIndex(content, match.index);
          const identifier = this.normalizeIdentifier(match.groups?.name || extractorDef.defaultIdentifier);
          hits.push({
            ruleId: ruleDef.id,
            displayName: ruleDef.displayName,
            kind: extractorDef.kind || ruleDef.kind,
            identifier,
            operation: extractorDef.label,
            file: relativeFile,
            line,
            excerpt: match[0].replace(/\s+/g, ' ').trim().slice(0, 220),
            agentGuidance: ruleDef.agentGuidance,
          });
          if (extractorDef.pattern.lastIndex === match.index) extractorDef.pattern.lastIndex++;
        }
      }
    }

    return hits;
  }

  private fileReferencesRule(content: string, ruleDef: ObservabilityRule, imports = this.extractImports(content)): boolean {
    if (imports.some(importSource => ruleDef.imports.some(pkg => importSource === pkg || importSource.startsWith(`${pkg}/`)))) {
      return true;
    }

    if (ruleDef.id === 'python-logging') {
      return /^\s*import\s+logging\b/m.test(content) || /^\s*from\s+logging\s+import\b/m.test(content);
    }

    if (ruleDef.fileExtensions.includes('java')) {
      return ruleDef.imports.some(pkg => content.includes(pkg));
    }

    if (ruleDef.fileExtensions.includes('go')) {
      return ruleDef.imports.some(pkg => content.includes(`"${pkg}`));
    }

    return false;
  }

  private buildLibraryFact(ruleDef: ObservabilityRule, dependencyHits: DependencyHit[], hits: InstrumentationHit[]): CASLibrary {
    const dep = this.preferredDependencyHit(ruleDef, dependencyHits);
    return {
      id: `lib_${this.sanitizeId(dep?.name || ruleDef.id)}`,
      name: dep?.name || ruleDef.displayName,
      version: dep?.version,
      type: dep?.type || 'production',
      package_manager: dep?.packageManager || 'built-in',
      category: 'observability',
      description: `${ruleDef.displayName} provides static observability instrumentation. ${ruleDef.agentGuidance}`,
      usage_patterns: ruleDef.extractors.map(extractorDef => ({
        pattern: extractorDef.label,
        occurrences: hits.filter(hit => hit.operation === extractorDef.label).length,
        example_nodes: hits.filter(hit => hit.operation === extractorDef.label).slice(0, 5).map(hit =>
          `observability_${hit.kind}_${this.sanitizeId(hit.ruleId)}_${this.sanitizeId(hit.identifier)}_${this.sanitizeId(hit.file)}_${hit.line}`
        ),
        functions_used: hits.filter(hit => hit.operation === extractorDef.label).slice(0, 5).map(hit => hit.excerpt),
      })),
      usage_statistics: {
        import_count: hits.length,
        usage_frequency: hits.length > 10 ? 'high' : hits.length > 3 ? 'medium' : hits.length > 0 ? 'low' : 'declared-only',
        critical_path: ['telemetry', 'span', 'metric'].includes(ruleDef.kind),
      },
      connected_nodes: hits.slice(0, 20).map(hit =>
        `observability_${hit.kind}_${this.sanitizeId(hit.ruleId)}_${this.sanitizeId(hit.identifier)}_${this.sanitizeId(hit.file)}_${hit.line}`
      ),
      metadata: {
        breaking_changes_risk: ['telemetry', 'span', 'metric'].includes(ruleDef.kind) ? 'medium' : 'low',
      },
    };
  }

  private async sourceFiles(context: AnalysisContext): Promise<string[]> {
    const groundedFiles = this.filesFromExistingAnalysis(
      context,
      source => RULES.some(ruleDef => ruleDef.imports.some(importName =>
        source === importName || source.startsWith(`${importName}/`) || source.startsWith(`${importName}.`)
      )),
      true
    );
    const conventionFiles = await glob([
      '**/*{telemetry,observability,instrumentation,tracing,metrics,logger,logging}*.{ts,tsx,js,jsx,py,java,cs,go}',
    ], {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*', '**/obj/**', '**/bin/**'],
      nodir: true,
      absolute: false,
    });
    const evidenceFiles = [...new Set([...groundedFiles, ...conventionFiles])].sort();
    if ((context.existingAnalysis?.length || 0) > 0 && evidenceFiles.length > 0) {
      return this.capAndPrioritizeSourceFiles(evidenceFiles, 'observability instrumentation candidate files');
    }

    return this.capAndPrioritizeSourceFiles(await glob([
      '**/*.{ts,tsx,js,jsx,py,java,cs,go}',
    ], {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*', '**/obj/**', '**/bin/**'],
      nodir: true,
      absolute: false,
    }), 'observability instrumentation candidate files');
  }

  private async readTextFileIfExists(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  private normalizeIdentifier(value: string): string {
    const normalized = value.trim().replace(/^['"`]|['"`]$/g, '');
    return normalized.length > 0 ? normalized : 'unknown';
  }

  private extractImports(content: string): string[] {
    const imports = new Set<string>();
    for (const line of content.split(/\r?\n/)) {
      const importMatch = line.match(/^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/);
      const requireMatch = line.match(/\brequire\(['"]([^'"]+)['"]\)/);
      // Multi-line named imports put the source on its own `} from '...'` line
      // (the norm in real SPAs/RN apps), which the line-based import match misses.
      const fromMatch = line.match(/^\s*\}?\s*from\s+['"]([^'"]+)['"]/);
      const pythonMatch = line.match(/^\s*(?:from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_.]+))/);
      const value = importMatch?.[1] || requireMatch?.[1] || fromMatch?.[1] || pythonMatch?.[1] || pythonMatch?.[2];
      if (value) imports.add(value);
    }
    return [...imports];
  }

  private ruleMatchesDependency(ruleDef: ObservabilityRule, dep: DependencyHit): boolean {
    if (ruleDef.packageManagers.length > 0 && !ruleDef.packageManagers.includes(dep.packageManager)) return false;
    const name = dep.name.toLowerCase();
    return ruleDef.packages.some(pkg => name === pkg.toLowerCase() || name.includes(pkg.toLowerCase()));
  }

  private preferredDependencyHit(ruleDef: ObservabilityRule, dependencyHits: DependencyHit[]): DependencyHit | undefined {
    return dependencyHits.find(dep =>
      ruleDef.packages.some(pkg => dep.name.toLowerCase() === pkg.toLowerCase())
    ) || dependencyHits[0];
  }

  private async readDependencies(projectPath: string): Promise<DependencyHit[]> {
    return [
      ...await this.readPackageJsonDependencies(projectPath),
      ...await this.readPythonDependencies(projectPath),
      ...await this.readJavaDependencies(projectPath),
      ...await this.readDotnetDependencies(projectPath),
      ...await this.readGoDependencies(projectPath),
    ];
  }

  private async readPackageJsonDependencies(projectPath: string): Promise<DependencyHit[]> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!await fs.pathExists(packageJsonPath)) return [];
    const pkg = await fs.readJson(packageJsonPath);
    const hits: DependencyHit[] = [];
    const add = (deps: Record<string, string> | undefined, type: CASLibrary['type']) => {
      for (const [name, version] of Object.entries(deps || {})) {
        hits.push({ name, version: String(version).replace(/^[\^~>=<]/, ''), type, packageManager: 'npm' });
      }
    };
    add(pkg.dependencies, 'production');
    add(pkg.devDependencies, 'development');
    add(pkg.peerDependencies, 'peer');
    add(pkg.optionalDependencies, 'optional');
    return hits;
  }

  private async readPythonDependencies(projectPath: string): Promise<DependencyHit[]> {
    const hits: DependencyHit[] = [];
    for (const file of ['requirements.txt', 'requirements/base.txt', 'requirements/production.txt', 'pyproject.toml']) {
      const reqPath = path.join(projectPath, file);
      if (!await fs.pathExists(reqPath)) continue;
      const content = await fs.readFile(reqPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const match = line.trim().match(/^["']?([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*"?([^,;\s"]+))?/);
        if (match && /^[a-zA-Z]/.test(match[1])) hits.push({ name: match[1], version: match[2], type: 'production', packageManager: 'pip' });
      }
    }
    return hits;
  }

  private async readJavaDependencies(projectPath: string): Promise<DependencyHit[]> {
    const hits: DependencyHit[] = [];
    const pomPath = path.join(projectPath, 'pom.xml');
    if (await fs.pathExists(pomPath)) {
      const content = await fs.readFile(pomPath, 'utf8');
      const dependencyRegex = /<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?(?:<version>([^<]+)<\/version>)?[\s\S]*?<\/dependency>/g;
      let match: RegExpExecArray | null;
      while ((match = dependencyRegex.exec(content)) !== null) {
        hits.push({ name: `${match[1]}:${match[2]}`, version: match[3], type: 'production', packageManager: 'maven' });
        hits.push({ name: match[1], version: match[3], type: 'production', packageManager: 'maven' });
      }
    }

    const gradleFiles = await glob(['build.gradle', 'build.gradle.kts', '**/build.gradle', '**/build.gradle.kts'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    for (const relativeFile of gradleFiles) {
      const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
      const dependencyRegex = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*(?:\(?\s*)['"]([^:'"]+):([^:'"]+):?([^'"]*)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = dependencyRegex.exec(content)) !== null) {
        hits.push({ name: `${match[1]}:${match[2]}`, version: match[3] || undefined, type: 'production', packageManager: 'gradle' });
        hits.push({ name: match[1], version: match[3] || undefined, type: 'production', packageManager: 'gradle' });
      }
    }
    return hits;
  }

  private async readDotnetDependencies(projectPath: string): Promise<DependencyHit[]> {
    const hits: DependencyHit[] = [];
    const csprojFiles = await glob('**/*.csproj', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    for (const relativeFile of csprojFiles) {
      const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
      const packageRegex = /<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g;
      let match: RegExpExecArray | null;
      while ((match = packageRegex.exec(content)) !== null) {
        hits.push({ name: match[1], version: match[2], type: 'production', packageManager: 'nuget' });
      }
    }
    return hits;
  }

  private async readGoDependencies(projectPath: string): Promise<DependencyHit[]> {
    const goModPath = path.join(projectPath, 'go.mod');
    if (!await fs.pathExists(goModPath)) return [];
    const content = await fs.readFile(goModPath, 'utf8');
    const hits: DependencyHit[] = [];
    const requireRegex = /^\s*(?:require\s+)?([a-zA-Z0-9_.\-/]+)\s+v?([0-9][^\s]*)/gm;
    let match: RegExpExecArray | null;
    while ((match = requireRegex.exec(content)) !== null) {
      hits.push({ name: match[1], version: match[2], type: 'production', packageManager: 'go' });
    }
    return hits;
  }
}

function rule(
  id: string,
  displayName: string,
  packages: string[],
  packageManagers: string[],
  imports: string[],
  fileExtensions: string[],
  kind: ObservabilityKind,
  extractors: ObservabilityExtractor[],
  agentGuidance: string
): ObservabilityRule {
  return { id, displayName, packages, packageManagers, imports, fileExtensions, kind, extractors, agentGuidance };
}

function extractor(label: string, pattern: RegExp, kind: ObservabilityKind, defaultIdentifier: string): ObservabilityExtractor {
  return { label, pattern, kind, defaultIdentifier };
}

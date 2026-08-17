import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASExitPoint } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';















const RXJS_IMPORT = /from\s+['"]rxjs(?:\/[^'"]*)?['"]/;
const RXJS_SUBJECT = /(?:export\s+)?(?:const|let|private|public|readonly)?\s*([\w$]+)\s*(?::\s*[^=]+)?=\s*new\s+(Subject|BehaviorSubject|ReplaySubject|AsyncSubject)\s*(?:<[^>]*>)?\s*\(/g;
const RXJS_OBSERVABLE_DECL = /(?:export\s+)?(?:const|let|private|public|readonly)?\s*([\w$]+)\s*(?::\s*Observable<[^>]*>)?\s*=\s*new\s+Observable\s*(?:<[^>]*>)?\s*\(/g;
const RXJS_PIPE = /([\w$]+)\s*\r?\n?\s*\.pipe\s*\(/g;



const RXJS_SUBSCRIBE = /(?:([\w$]+)|\))\s*\r?\n?\s*\.subscribe\s*\(/g;
const RXJS_OPERATORS = /\b(map|filter|switchMap|mergeMap|concatMap|exhaustMap|debounceTime|throttleTime|distinctUntilChanged|takeUntil|catchError|tap|scan|combineLatest|withLatestFrom|shareReplay|retry|retryWhen)\s*\(/g;

const REACTOR_IMPORT = /import\s+reactor\.core\.publisher\.(Mono|Flux)/;
const REACTOR_DECL = /\b(Mono|Flux)<[^>]*>\s+(\w+)\s*=/g;
const REACTOR_SUBSCRIBE = /(\w+)\s*\r?\n?\s*\.subscribe\s*\(/g;
const REACTOR_OPERATORS = /\.(map|flatMap|filter|switchIfEmpty|doOnNext|doOnError|zipWith|then|onErrorResume|retry|subscribeOn|publishOn)\s*\(/g;

const RXJAVA_IMPORT = /import\s+io\.reactivex[^;]*\.(Observable|Flowable|Single|Maybe|Completable)/;
const RXJAVA_DECL = /\b(Observable|Flowable|Single|Maybe|Completable)<[^>]*>\s+(\w+)\s*=/g;
const RXJAVA_SUBSCRIBE = /(\w+)\s*\r?\n?\s*\.subscribe\s*\(/g;

const COMBINE_IMPORT = /import\s+Combine\b/;
const COMBINE_PUBLISHED = /@Published\s+(?:private\s+|public\s+)?var\s+(\w+)\s*(?::\s*[^=\n]+)?/g;
const COMBINE_PUBLISHER_DECL = /(?:let|var)\s+(\w+)\s*:\s*(?:AnyPublisher|PassthroughSubject|CurrentValueSubject)<[^>]*>/g;
const COMBINE_SINK = /(\w+)\s*\r?\n?\s*\.sink\s*\(/g;
const COMBINE_ASSIGN = /(\w+)\s*\r?\n?\s*\.assign\s*\(/g;

export class ReactiveStreamsAnalyzer extends BaseAnalyzer {
  constructor() {
    super('reactive-streams', 'Reactive Streams Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const npmHit = await this.hasNpmDependency(projectPath, ['rxjs']);
    if (npmHit) return true;

    if (await this.hasJavaDependencyFile(projectPath, /reactor-core|io\.reactivex|rxjava/i)) return true;




    return this.hasSourceEvidence(projectPath);
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const { projectPath } = context;
    const ignorePatterns = this.getIgnorePatterns(context);
    const groundedFiles = this.filesFromExistingAnalysis(
      context,
      source => /^(?:rxjs(?:\/|$)|reactor(?:-core)?(?:[./]|$)|io\.reactivex(?:[./]|$)|Combine(?:[./]|$))/i.test(source)
    );
    const sourceFiles = this.capAndPrioritizeSourceFiles(
      (context.existingAnalysis?.length || 0) > 0
        ? groundedFiles
        : await glob('**/*.{ts,tsx,js,jsx,java,kt,swift}', {
          cwd: projectPath,
          ignore: [...ignorePatterns, '**/*.test.*', '**/*.spec.*'],
          absolute: false,
          nodir: true,
        }),
      'reactive stream candidate files'
    );

    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const exitPoints: CASExitPoint[] = [];
    const seenNodeIds = new Set<string>();

    for (const relativePath of sourceFiles) {
      const absolutePath = path.join(projectPath, relativePath);
      let content: string;
      try {
        content = await fs.readFile(absolutePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }

      const fileNodeId = this.fileNodeIdFromExistingAnalysis(relativePath, context.existingAnalysis);
      const sanitizedPath = relativePath.replace(/[^a-zA-Z0-9]/g, '_');
      const ext = path.extname(relativePath);

      if ((ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') && RXJS_IMPORT.test(content)) {
        this.extractRxJs(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
      }
      if ((ext === '.java' || ext === '.kt') && REACTOR_IMPORT.test(content)) {
        this.extractReactor(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
      }
      if ((ext === '.java' || ext === '.kt') && RXJAVA_IMPORT.test(content)) {
        this.extractRxJava(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
      }
      if (ext === '.swift' && COMBINE_IMPORT.test(content)) {
        this.extractCombine(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
      }
    }

    return this.createContribution(nodes, edges, [], exitPoints, {
      library: 'reactive-streams',
      streamsFound: nodes.filter(n => n.type === 'reactive_stream').length,
      subscriptionSinksFound: exitPoints.length,
    });
  }



  private extractRxJs(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    const streamNames = new Set<string>();

    RXJS_SUBJECT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RXJS_SUBJECT.exec(content)) !== null) {
      const [, name, subjectKind] = match;
      streamNames.add(name);
      this.addStreamNode(nodes, edges, seenNodeIds, {
        nodeId: `rx_subject_${sanitizedPath}_${name}`,
        name, relativePath, fileNodeId,
        library: 'rxjs', kind: subjectKind, streamType: 'subject',
      });
    }

    RXJS_OBSERVABLE_DECL.lastIndex = 0;
    while ((match = RXJS_OBSERVABLE_DECL.exec(content)) !== null) {
      const name = match[1];
      streamNames.add(name);
      this.addStreamNode(nodes, edges, seenNodeIds, {
        nodeId: `rx_observable_${sanitizedPath}_${name}`,
        name, relativePath, fileNodeId,
        library: 'rxjs', kind: 'Observable', streamType: 'observable',
      });
    }

    const operatorsUsed = new Set<string>();
    RXJS_OPERATORS.lastIndex = 0;
    while ((match = RXJS_OPERATORS.exec(content)) !== null) operatorsUsed.add(match[1]);





    const pipeSites: Array<{ index: number; name: string }> = [];
    RXJS_PIPE.lastIndex = 0;
    while ((match = RXJS_PIPE.exec(content)) !== null) {
      const name = match[1];
      pipeSites.push({ index: match.index, name });
      if (fileNodeId && streamNames.has(name)) {
        edges.push(this.createEdge(
          `edge_rx_pipe_${sanitizedPath}_${name}_${match.index}`,
          fileNodeId, `rx_subject_${sanitizedPath}_${name}`, 'pipes', 'behavioral',
          { operators: Array.from(operatorsUsed) }
        ));
      }
    }

    RXJS_SUBSCRIBE.lastIndex = 0;
    while ((match = RXJS_SUBSCRIBE.exec(content)) !== null) {
      let name = match[1];




      if (!name || !streamNames.has(name)) {
        const nearestPipe = [...pipeSites].reverse().find(site => site.index < match!.index && match!.index - site.index < 4000);
        if (nearestPipe) name = nearestPipe.name;
      }
      if (!name) continue;
      const line = content.slice(0, match.index).split(/\r?\n/).length;
      const sourceNodeId = streamNames.has(name)
        ? (nodes.find(n => n.id.endsWith(`_${name}`) && n.source?.file === relativePath)?.id)
        : undefined;
      exitPoints.push(this.createExitPoint(
        `exit_rx_subscribe_${sanitizedPath}_${name}_${line}`,
        sourceNodeId || fileNodeId || `rx_${sanitizedPath}`,
        'event',
        `RxJS subscription: ${name}.subscribe()`,
        `RxJS stream ${name} is subscribed to in ${relativePath}.`,
        { service_id: 'rxjs', resource: name },
        { action: 'subscribe', async: true },
        { library: 'rxjs', stream: name, file: relativePath, line }
      ));
    }
  }



  private extractReactor(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    const streamNames = new Set<string>();

    REACTOR_DECL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REACTOR_DECL.exec(content)) !== null) {
      const [, kind, name] = match;
      streamNames.add(name);
      this.addStreamNode(nodes, edges, seenNodeIds, {
        nodeId: `reactor_${sanitizedPath}_${name}`,
        name, relativePath, fileNodeId,
        library: 'project-reactor', kind, streamType: kind === 'Mono' ? 'mono' : 'flux',
      });
    }

    const operatorsUsed = new Set<string>();
    REACTOR_OPERATORS.lastIndex = 0;
    while ((match = REACTOR_OPERATORS.exec(content))) operatorsUsed.add(match[1]);

    REACTOR_SUBSCRIBE.lastIndex = 0;
    while ((match = REACTOR_SUBSCRIBE.exec(content)) !== null) {
      const name = match[1];
      if (!streamNames.has(name)) continue;
      const line = content.slice(0, match.index).split(/\r?\n/).length;
      exitPoints.push(this.createExitPoint(
        `exit_reactor_subscribe_${sanitizedPath}_${name}_${line}`,
        `reactor_${sanitizedPath}_${name}`,
        'event',
        `Reactor subscription: ${name}.subscribe()`,
        `Reactor stream ${name} is subscribed to in ${relativePath}.`,
        { service_id: 'project-reactor', resource: name },
        { action: 'subscribe', async: true },
        { library: 'project-reactor', stream: name, file: relativePath, line, operators: Array.from(operatorsUsed) }
      ));
    }
  }



  private extractRxJava(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    const streamNames = new Set<string>();

    RXJAVA_DECL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RXJAVA_DECL.exec(content)) !== null) {
      const [, kind, name] = match;
      streamNames.add(name);
      this.addStreamNode(nodes, edges, seenNodeIds, {
        nodeId: `rxjava_${sanitizedPath}_${name}`,
        name, relativePath, fileNodeId,
        library: 'rxjava', kind, streamType: kind.toLowerCase(),
      });
    }

    RXJAVA_SUBSCRIBE.lastIndex = 0;
    while ((match = RXJAVA_SUBSCRIBE.exec(content)) !== null) {
      const name = match[1];
      if (!streamNames.has(name)) continue;
      const line = content.slice(0, match.index).split(/\r?\n/).length;
      exitPoints.push(this.createExitPoint(
        `exit_rxjava_subscribe_${sanitizedPath}_${name}_${line}`,
        `rxjava_${sanitizedPath}_${name}`,
        'event',
        `RxJava subscription: ${name}.subscribe()`,
        `RxJava stream ${name} is subscribed to in ${relativePath}.`,
        { service_id: 'rxjava', resource: name },
        { action: 'subscribe', async: true },
        { library: 'rxjava', stream: name, file: relativePath, line }
      ));
    }
  }



  private extractCombine(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    const streamNames = new Set<string>();

    COMBINE_PUBLISHED.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = COMBINE_PUBLISHED.exec(content)) !== null) {
      const name = match[1];
      streamNames.add(name);
      this.addStreamNode(nodes, edges, seenNodeIds, {
        nodeId: `combine_published_${sanitizedPath}_${name}`,
        name, relativePath, fileNodeId,
        library: 'combine', kind: 'Published', streamType: 'published-property',
      });
    }

    COMBINE_PUBLISHER_DECL.lastIndex = 0;
    while ((match = COMBINE_PUBLISHER_DECL.exec(content)) !== null) {
      const name = match[1];
      streamNames.add(name);
      this.addStreamNode(nodes, edges, seenNodeIds, {
        nodeId: `combine_publisher_${sanitizedPath}_${name}`,
        name, relativePath, fileNodeId,
        library: 'combine', kind: 'Publisher', streamType: 'publisher',
      });
    }

    const sinkFn = (regex: RegExp, action: string) => {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(content)) !== null) {
        const name = m[1];
        if (!streamNames.has(name)) continue;
        const line = content.slice(0, m.index).split(/\r?\n/).length;
        const sourceNode = nodes.find(n => n.source?.file === relativePath && n.name === name)?.id;
        exitPoints.push(this.createExitPoint(
          `exit_combine_${action}_${sanitizedPath}_${name}_${line}`,
          sourceNode || fileNodeId || `combine_${sanitizedPath}`,
          'event',
          `Combine ${action}: ${name}.${action}()`,
          `Combine publisher ${name} is consumed via .${action}() in ${relativePath}.`,
          { service_id: 'combine', resource: name },
          { action, async: true },
          { library: 'combine', stream: name, file: relativePath, line }
        ));
      }
    };
    sinkFn(COMBINE_SINK, 'sink');
    sinkFn(COMBINE_ASSIGN, 'assign');
  }



  private addStreamNode(
    nodes: CASNode[], edges: CASEdge[], seenNodeIds: Set<string>,
    opts: { nodeId: string; name: string; relativePath: string; fileNodeId?: string; library: string; kind: string; streamType: string }
  ): void {
    if (seenNodeIds.has(opts.nodeId)) return;
    seenNodeIds.add(opts.nodeId);
    nodes.push(this.createNode(
      opts.nodeId, opts.name, 'reactive_stream', 3, opts.relativePath, undefined, undefined,
      {
        library: opts.library,
        stream_kind: opts.kind,
        stream_type: opts.streamType,
        subcategories: ['reactive-stream', opts.library],
      }
    ));
    if (opts.fileNodeId) {
      edges.push(this.createEdge(
        `edge_${opts.nodeId}_${opts.fileNodeId}`, opts.nodeId, opts.fileNodeId, 'defined_in', 'structural'
      ));
    }
  }

  private async hasNpmDependency(projectPath: string, names: string[]): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return false;
      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return names.some(name => name in deps);
    } catch {
      return false;
    }
  }

  private async hasJavaDependencyFile(projectPath: string, pattern: RegExp): Promise<boolean> {
    for (const file of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
      const filePath = path.join(projectPath, file);
      if (!await fs.pathExists(filePath)) continue;
      const content = await fs.readFile(filePath, 'utf8');
      if (pattern.test(content)) return true;
    }
    return false;
  }

  private async hasSourceEvidence(projectPath: string): Promise<boolean> {
    try {
      const candidates = await glob('**/*.{java,kt,swift}', {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
        absolute: false,
      });
      const sample = this.capAndPrioritizeSourceFiles(candidates, 'reactive stream evidence scan').slice(0, 200);
      for (const relativeFile of sample) {
        const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8').catch(() => '');
        if (REACTOR_IMPORT.test(content) || RXJAVA_IMPORT.test(content) || COMBINE_IMPORT.test(content)) {
          return true;
        }
      }
    } catch {

    }
    return false;
  }

  protected getCapabilities(): string[] {
    return [
      'reactive-stream-detection',
      'subject-observable-detection',
      'subscription-sink-detection',
      'operator-pipeline-detection',
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return 'unknown';
    }
  }
}

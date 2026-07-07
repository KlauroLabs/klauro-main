import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASEntryPoint, CASContribution, CASExitPoint, FileAnalysisResult } from '../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';

type MediatorSystem = 'mediatr' | 'masstransit' | 'nservicebus' | 'nestjs-cqrs' | 'aws-sqs';

interface HandlerDecl {
  system: MediatorSystem;
  /** The command/query/event/message type the handler is declared for. */
  messageType: string;
  /** The handler class/function name itself. */
  handlerName: string;
  kind: 'command' | 'query' | 'event' | 'message';
  filePath: string;
  line: number;
}

interface DispatchSite {
  system: MediatorSystem;
  messageType: string;
  kind: 'command' | 'query' | 'event' | 'message';
  filePath: string;
  line: number;
}

/**
 * MediatorCqrsAnalyzer
 *
 * Surfaces the CQRS/mediator dispatch architecture that the generic
 * ArchitecturalLibraryAnalyzer only sees as line-level "usage" nodes:
 *   - MediatR (C#): IRequestHandler<TCmd,TRes> / INotificationHandler<T>
 *     declarations resolved to the actual handler class, plus
 *     _mediator.Send(new TCmd(...)) / .Publish(new TEvent(...)) call sites
 *     resolved to that handler by message-type name.
 *   - MassTransit / NServiceBus (C#): IConsumer<T> / IHandleMessages<T>
 *     consumer classes.
 *   - NestJS CQRS (@nestjs/cqrs, TS): @CommandHandler(Cmd)/@QueryHandler(Qry)/
 *     @EventsHandler(Evt) decorated classes resolved from commandBus.execute(new
 *     Cmd(...)) / eventBus.publish(new Evt(...)) call sites.
 *   - AWS SQS/Lambda handlers (TS/Python): exports.handler / def handler
 *     processing an SQS event -> a message entry point (no dispatch edge,
 *     since the producer is typically a different service/account).
 *
 * Each resolved handler becomes a FLOW node + a message/event entry point
 * (a message triggers a flow root), and each dispatch call site that
 * resolves to a declared handler becomes a command/event -> handler edge.
 * Resolution is evidence-based: an edge is only emitted when the dispatched
 * message type name matches a handler actually declared in the codebase;
 * unmatched dispatches are dropped rather than fabricated.
 */
export class MediatorCqrsAnalyzer extends BaseAnalyzer {
  constructor() {
    super('mediator-cqrs-messaging', 'Mediator/CQRS Messaging Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const deps = await this.collectDependencyNames(projectPath);
    const depMarkers = ['mediatr', 'masstransit', 'nservicebus', '@nestjs/cqrs', 'nestjs-cqrs', 'aws-lambda', '@aws-sdk/client-sqs', 'boto3'];
    if (depMarkers.some((m) => [...deps].some(d => d.toLowerCase().includes(m)))) {
      return true;
    }

    const ignorePatterns = this.getIgnorePatterns({ projectPath });
    const files = await glob('**/*.{cs,ts,py}', {
      cwd: projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });

    const sample = files.slice(0, 400);
    const markerRe = /(IRequestHandler|INotificationHandler|IMediator|IConsumer<|IHandleMessages<|@CommandHandler|@QueryHandler|@EventsHandler|commandBus\.|eventBus\.|queryBus\.|SQSEvent|Records\[.*\]\.body|'Records':)/;
    for (const file of sample) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (markerRe.test(content)) return true;
      } catch {
        // ignore unreadable files
      }
    }
    return false;
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    let files: string[] = [];
    try {
      files = await glob('**/*.{cs,ts,tsx,py}', {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
    } catch {
      return [];
    }

    const markerRe = /(IRequestHandler|INotificationHandler|IMediator|mediator\.(Send|Publish)|IConsumer<|IHandleMessages<|@CommandHandler|@QueryHandler|@EventsHandler|commandBus\.|eventBus\.|queryBus\.|SQSEvent|event\.Records|'Records'|"Records")/;
    const relevant: string[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      } catch {
        continue;
      }
      if (markerRe.test(content)) relevant.push(file);
    }
    return relevant.sort();
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();

    let files = await glob('**/*.{cs,ts,tsx,py}', {
      cwd: context.projectPath,
      ignore: this.getIgnorePatterns(context),
      absolute: true,
      nodir: true,
    });
    files = this.capAndPrioritizeSourceFiles(files, 'mediator/cqrs source files');

    const { nodes, edges, entryPoints } = await this.processFiles(files, context.projectPath);

    const systemsFound = new Set<string>();
    for (const n of nodes) {
      const sys = (n.metadata as any)?.system;
      if (sys) systemsFound.add(sys);
    }

    return this.createContribution(nodes, edges, entryPoints, [], {
      systems: Array.from(systemsFound),
      handlersFound: entryPoints.length,
      nodesFound: nodes.length,
      edgesFound: edges.length,
      warnings: this.collectAnalysisWarnings(),
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    // Single-file scope: dispatch -> handler edges to handlers declared in other
    // files under-populate here and re-derive on full analysis.
    const { nodes, edges, entryPoints } = await this.processFiles([context.filePath], context.projectPath);

    const exitPoints: CASExitPoint[] = [];
    const exports = entryPoints.map(ep => ep.name);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      [],
      exports
    );
  }

  private async processFiles(
    files: string[],
    projectPath: string
  ): Promise<{ nodes: CASNode[]; edges: CASEdge[]; entryPoints: CASEntryPoint[] }> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];

    // messageType -> handler node id, keyed per system so a `CreateOrder` command
    // in MediatR doesn't collide with an unrelated `CreateOrder` in NestJS CQRS.
    const handlerNodeIds = new Map<string, string>(); // `${system}:${messageType}` -> nodeId
    const pendingDispatches: DispatchSite[] = [];

    for (const file of files) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      const relativePath = path.relative(projectPath, file);
      const ext = path.extname(file).toLowerCase();
      const lineOf = (index: number): number => content.slice(0, index).split('\n').length;

      if (ext === '.cs') {
        this.extractMediatRHandlers(content, relativePath, nodes, entryPoints, handlerNodeIds, lineOf);
        this.extractMediatRDispatches(content, relativePath, pendingDispatches, lineOf);
        this.extractMassTransitNServiceBus(content, relativePath, nodes, entryPoints, handlerNodeIds, lineOf);
      } else if (ext === '.ts' || ext === '.tsx') {
        this.extractNestCqrsHandlers(content, relativePath, nodes, entryPoints, handlerNodeIds, lineOf);
        this.extractNestCqrsDispatches(content, relativePath, pendingDispatches, lineOf);
        this.extractSqsHandlerTs(content, relativePath, nodes, entryPoints, lineOf);
      } else if (ext === '.py') {
        this.extractSqsHandlerPy(content, relativePath, nodes, entryPoints, lineOf);
      }
    }

    // Resolve dispatch call sites -> edge into the declared handler node.
    for (const dispatch of pendingDispatches) {
      const targetId = handlerNodeIds.get(`${dispatch.system}:${dispatch.messageType}`);
      if (!targetId) continue; // evidence-gated: no fabricated edges for unmatched message types
      const siteId = `flow_${dispatch.system}_dispatch_${this.sanitizeId(dispatch.messageType)}_${dispatch.filePath}_${dispatch.line}`
        .replace(/[\\/]/g, '_');
      nodes.push(
        this.createNode(siteId, `dispatch ${dispatch.messageType}`, 'dispatch', 4, dispatch.filePath, dispatch.line, undefined, {
          system: dispatch.system,
          messageType: dispatch.messageType,
          kind: dispatch.kind,
          subcategories: ['async-flow', 'cqrs', dispatch.system, dispatch.kind],
        })
      );
      edges.push(
        this.createEdge(
          `${siteId}__to__${targetId}`,
          siteId,
          targetId,
          dispatch.kind === 'event' ? 'publishes' : 'dispatches',
          'async-flow',
          { system: dispatch.system, messageType: dispatch.messageType, kind: dispatch.kind }
        )
      );
    }

    return { nodes, edges, entryPoints };
  }

  // ---- MediatR (C#): IRequestHandler<TCmd,TRes> / INotificationHandler<T> ----
  private extractMediatRHandlers(
    content: string,
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    handlerNodeIds: Map<string, string>,
    lineOf: (index: number) => number
  ): void {
    // class OrderCreatedHandler : IRequestHandler<CreateOrderCommand, Result>
    // class OrderCreatedHandler : INotificationHandler<OrderCreatedEvent>
    const classRe =
      /class\s+(\w+)\s*(?::|<)?[^{]*?\b(IRequestHandler|INotificationHandler)\s*<\s*(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = classRe.exec(content)) !== null) {
      const handlerName = m[1];
      const interfaceKind = m[2];
      const messageType = m[3];
      const line = lineOf(m.index);
      const kind = interfaceKind === 'INotificationHandler' ? 'event' : 'command';
      const id = `flow_mediatr_handler_${this.sanitizeId(messageType)}`;
      if (handlerNodeIds.has(`mediatr:${messageType}`)) continue;
      handlerNodeIds.set(`mediatr:${messageType}`, id);
      nodes.push(
        this.createNode(id, handlerName, 'handler', 3, filePath, line, undefined, {
          system: 'mediatr',
          kind,
          messageType,
          subcategories: ['async-flow', 'cqrs', 'mediatr', kind],
        })
      );
      entryPoints.push(
        this.createEntryPoint(
          `ep_${id}`,
          id,
          'message',
          handlerName,
          `MediatR ${kind} handler for ${messageType}`,
          { event: `mediatr:${kind}:${messageType}` },
          undefined,
          { system: 'mediatr', kind, messageType }
        )
      );
    }
  }

  // .Send(new CreateOrderCommand(...))  /  mediator.Publish(new OrderCreatedEvent(...))
  private extractMediatRDispatches(
    content: string,
    filePath: string,
    pendingDispatches: DispatchSite[],
    lineOf: (index: number) => number
  ): void {
    const sendRe = /\b(?:_?mediator|Mediator)\s*\.\s*Send(?:Async)?\s*\(\s*new\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = sendRe.exec(content)) !== null) {
      pendingDispatches.push({ system: 'mediatr', messageType: m[1], kind: 'command', filePath, line: lineOf(m.index) });
    }
    const publishRe = /\b(?:_?mediator|Mediator)\s*\.\s*Publish(?:Async)?\s*\(\s*new\s+(\w+)/g;
    while ((m = publishRe.exec(content)) !== null) {
      pendingDispatches.push({ system: 'mediatr', messageType: m[1], kind: 'event', filePath, line: lineOf(m.index) });
    }
  }

  // ---- MassTransit / NServiceBus (C#): IConsumer<T> / IHandleMessages<T> ----
  private extractMassTransitNServiceBus(
    content: string,
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    handlerNodeIds: Map<string, string>,
    lineOf: (index: number) => number
  ): void {
    const classRe =
      /class\s+(\w+)\s*(?::|<)?[^{]*?\b(IConsumer|IHandleMessages)\s*<\s*(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = classRe.exec(content)) !== null) {
      const handlerName = m[1];
      const interfaceKind = m[2];
      const messageType = m[3];
      const line = lineOf(m.index);
      const system: MediatorSystem = interfaceKind === 'IConsumer' ? 'masstransit' : 'nservicebus';
      const id = `flow_${system}_consumer_${this.sanitizeId(messageType)}`;
      if (handlerNodeIds.has(`${system}:${messageType}`)) continue;
      handlerNodeIds.set(`${system}:${messageType}`, id);
      nodes.push(
        this.createNode(id, handlerName, 'consumer', 3, filePath, line, undefined, {
          system,
          kind: 'message',
          messageType,
          subcategories: ['async-flow', 'cqrs', system, 'consumer'],
        })
      );
      entryPoints.push(
        this.createEntryPoint(
          `ep_${id}`,
          id,
          'message',
          handlerName,
          `${system === 'masstransit' ? 'MassTransit' : 'NServiceBus'} consumer for ${messageType}`,
          { event: `${system}:message:${messageType}` },
          undefined,
          { system, kind: 'message', messageType }
        )
      );
    }
  }

  // ---- NestJS CQRS (@nestjs/cqrs, TS): @CommandHandler / @QueryHandler / @EventsHandler ----
  private extractNestCqrsHandlers(
    content: string,
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    handlerNodeIds: Map<string, string>,
    lineOf: (index: number) => number
  ): void {
    const decoratorRe = /@(CommandHandler|QueryHandler|EventsHandler)\s*\(\s*(\w+)\s*\)[\s\S]{0,120}?class\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = decoratorRe.exec(content)) !== null) {
      const decorator = m[1];
      const messageType = m[2];
      const handlerName = m[3];
      const line = lineOf(m.index);
      const kind = decorator === 'EventsHandler' ? 'event' : decorator === 'QueryHandler' ? 'query' : 'command';
      const id = `flow_nestjs_cqrs_handler_${this.sanitizeId(messageType)}`;
      if (handlerNodeIds.has(`nestjs-cqrs:${messageType}`)) continue;
      handlerNodeIds.set(`nestjs-cqrs:${messageType}`, id);
      nodes.push(
        this.createNode(id, handlerName, 'handler', 3, filePath, line, undefined, {
          system: 'nestjs-cqrs',
          kind,
          messageType,
          subcategories: ['async-flow', 'cqrs', 'nestjs-cqrs', kind],
        })
      );
      entryPoints.push(
        this.createEntryPoint(
          `ep_${id}`,
          id,
          'message',
          handlerName,
          `NestJS CQRS ${kind} handler for ${messageType}`,
          { event: `nestjs-cqrs:${kind}:${messageType}` },
          undefined,
          { system: 'nestjs-cqrs', kind, messageType }
        )
      );
    }
  }

  // commandBus.execute(new CreateOrderCommand(...)) / eventBus.publish(new OrderCreatedEvent(...))
  private extractNestCqrsDispatches(
    content: string,
    filePath: string,
    pendingDispatches: DispatchSite[],
    lineOf: (index: number) => number
  ): void {
    const execRe = /\b(?:commandBus|queryBus)\s*\.\s*execute\s*\(\s*new\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = execRe.exec(content)) !== null) {
      pendingDispatches.push({ system: 'nestjs-cqrs', messageType: m[1], kind: 'command', filePath, line: lineOf(m.index) });
    }
    const publishRe = /\beventBus\s*\.\s*publish\s*\(\s*new\s+(\w+)/g;
    while ((m = publishRe.exec(content)) !== null) {
      pendingDispatches.push({ system: 'nestjs-cqrs', messageType: m[1], kind: 'event', filePath, line: lineOf(m.index) });
    }
  }

  // ---- AWS SQS handlers (TS/JS Lambda) ----
  private extractSqsHandlerTs(
    content: string,
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    lineOf: (index: number) => number
  ): void {
    // export const handler = async (event: SQSEvent) => { ... }
    // export async function handler(event: SQSEvent) { ... }
    const handlerRe =
      /export\s+(?:const|async\s+function)\s+(\w+)\s*[:=]?\s*(?:async\s*)?\(\s*\w+\s*:\s*SQSEvent/g;
    let m: RegExpExecArray | null;
    while ((m = handlerRe.exec(content)) !== null) {
      const name = m[1];
      const line = lineOf(m.index);
      const id = `flow_aws_sqs_handler_${this.sanitizeId(name)}_${this.sanitizeId(filePath)}`;
      nodes.push(
        this.createNode(id, name, 'handler', 3, filePath, line, undefined, {
          system: 'aws-sqs',
          kind: 'message',
          subcategories: ['async-flow', 'cqrs', 'aws-sqs', 'handler'],
        })
      );
      entryPoints.push(
        this.createEntryPoint(
          `ep_${id}`,
          id,
          'message',
          name,
          `AWS SQS Lambda handler ${name}`,
          { event: `aws-sqs:handler:${name}` },
          undefined,
          { system: 'aws-sqs', kind: 'message' }
        )
      );
    }
  }

  // ---- AWS SQS handlers (Python Lambda) ----
  private extractSqsHandlerPy(
    content: string,
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    lineOf: (index: number) => number
  ): void {
    // def lambda_handler(event, context): ... event['Records'] (SQS event shape)
    const defRe = /def\s+(\w*handler\w*)\s*\(\s*event\s*,\s*context\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = defRe.exec(content)) !== null) {
      const name = m[1];
      const line = lineOf(m.index);
      // Gate on SQS-shaped event access nearby so a generic Lambda handler for
      // API Gateway/EventBridge isn't misattributed to SQS.
      const bodySlice = content.slice(m.index, m.index + 800);
      if (!/['"]Records['"]|receiptHandle|eventSourceARN|sqs/i.test(bodySlice)) continue;
      const id = `flow_aws_sqs_handler_${this.sanitizeId(name)}_${this.sanitizeId(filePath)}`;
      nodes.push(
        this.createNode(id, name, 'handler', 3, filePath, line, undefined, {
          system: 'aws-sqs',
          kind: 'message',
          subcategories: ['async-flow', 'cqrs', 'aws-sqs', 'handler'],
        })
      );
      entryPoints.push(
        this.createEntryPoint(
          `ep_${id}`,
          id,
          'message',
          name,
          `AWS SQS Lambda handler ${name}`,
          { event: `aws-sqs:handler:${name}` },
          undefined,
          { system: 'aws-sqs', kind: 'message' }
        )
      );
    }
  }

  private async collectDependencyNames(projectPath: string): Promise<Set<string>> {
    const names = new Set<string>();
    try {
      const pkgPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(pkgPath)) {
        const pkg = await fs.readJson(pkgPath);
        for (const d of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
          names.add(d);
        }
      }
    } catch {
      // ignore
    }
    try {
      const csprojFiles = await glob('**/*.csproj', {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      for (const relativeFile of csprojFiles) {
        const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf-8');
        const packageRegex = /<PackageReference\s+Include="([^"]+)"/g;
        let match: RegExpExecArray | null;
        while ((match = packageRegex.exec(content)) !== null) {
          names.add(match[1]);
        }
      }
    } catch {
      // ignore
    }
    try {
      const reqPath = path.join(projectPath, 'requirements.txt');
      if (await fs.pathExists(reqPath)) {
        const txt = await fs.readFile(reqPath, 'utf-8');
        for (const line of txt.split('\n')) {
          const name = line.split(/[=<>~\[]/)[0].trim().toLowerCase();
          if (name) names.add(name);
        }
      }
    } catch {
      // ignore
    }
    return names;
  }

  protected getCapabilities(): string[] {
    return [
      'mediatr-command-handler-resolution',
      'mediatr-notification-handler-resolution',
      'masstransit-nservicebus-consumer-detection',
      'nestjs-cqrs-handler-resolution',
      'aws-sqs-lambda-handler-detection',
      'cqrs-mediator-async-flows',
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1:
        return 'system';
      case 2:
        return 'architectural';
      case 3:
        return 'code';
      case 4:
        return 'member';
      case 5:
        return 'implementation';
      default:
        return 'unknown';
    }
  }
}

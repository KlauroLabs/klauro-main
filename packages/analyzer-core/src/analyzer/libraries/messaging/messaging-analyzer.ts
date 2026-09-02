import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASEntryPoint, CASContribution, CASExitPoint, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import { createYieldBudget } from '../../core/event-loop-yield';
import { isTestFileName } from '../../core/scaffold-paths';

type MessagingSystem =
  | 'kafkajs'
  | 'node-rdkafka'
  | 'amqplib'
  | 'amqp-connection-manager'
  | 'nestjs-microservice'
  | 'nats'
  | 'redis-pubsub'
  | 'redis-streams'
  | 'bullmq'
  | 'bee-queue'
  | 'aws-sqs'
  | 'aws-sns'
  | 'python-kafka'
  | 'pika'
  | 'celery'
  | 'spring-kafka'
  | 'spring-rabbit'
  | 'sidekiq'
  | 'go-kafka'
  | 'go-nats'
  | 'event-emitter';

type ChannelKind = 'topic' | 'queue' | 'channel' | 'subject' | 'exchange' | 'stream' | 'event';








interface RoutingShape {

  type: 'direct' | 'topic' | 'fanout' | 'headers' | 'pubsub' | 'stream' | 'queue-group' | 'consumer-group' | 'event';

  keys?: string[];

  fanout?: boolean;

  group?: string;

  wildcard?: boolean;
}

interface MessagingFacts {
  nodes: CASNode[];
  edges: CASEdge[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
}

interface ProducerSpec {
  system: MessagingSystem;
  channel: string;
  channelKind: ChannelKind;
  filePath: string;
  line: number;
  name: string;
  action: string;
  payloadType?: string;
  routing?: RoutingShape;
}

interface ConsumerSpec {
  system: MessagingSystem;
  channel: string;
  channelKind: ChannelKind;
  filePath: string;
  line: number;
  name: string;
  handlerName?: string;
  payloadType?: string;
  routing?: RoutingShape;
}

type ChannelEnsurer = (system: MessagingSystem, name: string, kind: ChannelKind, filePath: string, line?: number, routing?: RoutingShape) => string;

export class MessagingAnalyzer extends BaseAnalyzer {
  constructor() {
    super('async-messaging', 'Async Messaging Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const deps = await this.collectDependencyNames(projectPath);
    const depMarkers = [
      'kafkajs',
      'node-rdkafka',
      'amqplib',
      'amqp-connection-manager',
      '@nestjs/microservices',
      'nats',
      'ioredis',
      'redis',
      'bullmq',
      'bee-queue',
      '@aws-sdk/client-sqs',
      '@aws-sdk/client-sns',
      'confluent-kafka',
      'confluent_kafka',
      'kafka-python',
      'pika',
      'celery',
      'spring-kafka',
      'spring-rabbit',
      'sidekiq',
      'github.com/segmentio/kafka-go',
      'github.com/nats-io/nats.go',
    ];
    const depNames = Array.from(deps);
    if (depMarkers.some(marker => depNames.some(dep => dep.toLowerCase().includes(marker)))) {
      return true;
    }

    const files = (await glob('**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,rb,go}', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      absolute: true,
      nodir: true,
    })).filter(file => !isTestFileName(path.basename(file)));

    const importRe = /(from\s+['"]kafkajs['"]|require\(['"]kafkajs['"]\)|from\s+['"]amqplib['"]|require\(['"]amqplib['"]\)|from\s+['"]amqp-connection-manager['"]|require\(['"]amqp-connection-manager['"]\)|from\s+['"]@nestjs\/microservices['"]|@MessagePattern|@EventPattern|from\s+['"]bullmq['"]|require\(['"]bullmq['"]\)|from\s+celery\b|import\s+celery\b|from\s+confluent_kafka\b|from\s+kafka\b|import\s+pika\b|@KafkaListener|KafkaTemplate|@RabbitListener|RabbitTemplate|Sidekiq::Worker|github\.com\/segmentio\/kafka-go|github\.com\/nats-io\/nats\.go)/;
    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (importRe.test(content)) return true;
      } catch {

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
      files = (await glob('**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,rb,go}', {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      })).filter(file => !isTestFileName(path.basename(file)));
    } catch {
      return [];
    }

    const markerRe = /(kafkajs|node-rdkafka|amqplib|from\s+['"]nats['"]|require\(['"]nats['"]\)|ioredis|from\s+['"]redis['"]|require\(['"]redis['"]\)|bullmq|bee-queue|@aws-sdk\/client-sqs|@aws-sdk\/client-sns|confluent_kafka|from\s+kafka\b|import\s+pika\b|from\s+celery\b|@KafkaListener|KafkaTemplate|@RabbitListener|RabbitTemplate|Sidekiq::Worker|perform_async|github\.com\/segmentio\/kafka-go|github\.com\/nats-io\/nats\.go)/;



    const maybeYield = createYieldBudget();
    const relevant: string[] = [];
    for (const file of files) {
      await maybeYield();
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

    let files = (await glob('**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,rb,go}', {
      cwd: context.projectPath,
      ignore: this.getIgnorePatterns(context),
      absolute: true,
      nodir: true,
    })).filter(file => !isTestFileName(path.basename(file)));
    files = this.capAndPrioritizeSourceFiles(files, 'async messaging source files');

    const facts = await this.processFiles(files, context.projectPath);
    const systems = new Set<string>();
    for (const node of facts.nodes) {
      const system = (node.metadata as any)?.system;
      if (system) systems.add(system);
    }

    return this.createContribution(facts.nodes, facts.edges, facts.entryPoints, facts.exitPoints, {
      systems: Array.from(systems).sort(),
      channel_nodes: facts.nodes.filter(node => ['topic', 'queue', 'channel', 'subject'].includes(node.type)).length,
      producer_exit_points: facts.exitPoints.length,
      consumer_entry_points: facts.entryPoints.length,
      warnings: this.collectAnalysisWarnings(),
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);
    const facts = await this.processFiles([context.filePath], context.projectPath);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      facts.nodes,
      facts.edges,
      facts.entryPoints,
      facts.exitPoints,
      this.extractImports(content, context.relativePath),
      facts.entryPoints.map(entryPoint => entryPoint.name)
    );
  }

  private async processFiles(files: string[], projectPath: string): Promise<MessagingFacts> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const channelNodeIds = new Map<string, string>();
    const edgeIds = new Set<string>();
    const celeryTaskNames = await this.collectCeleryTaskNames(files, projectPath);

    const channelNodesById = new Map<string, CASNode>();

    const ensureChannelNode: ChannelEnsurer = (system, name, kind, filePath, line, routing) => {
      const key = `${system}:${kind}:${name}`;
      const existing = channelNodeIds.get(key);
      if (existing) {
        if (routing) this.mergeRoutingIntoChannel(channelNodesById.get(existing), routing);
        return existing;
      }
      const id = `messaging_${system}_${kind}_${this.sanitizeId(name)}`;
      channelNodeIds.set(key, id);
      const node = this.createNode(id, name, kind, 3, filePath, line, undefined, {
        system,
        channel: name,
        channelKind: kind,
        subcategories: ['async-messaging', system, kind],
        ...(routing ? { routing, fanout: routing.fanout === true } : {}),
      });
      channelNodesById.set(id, node);
      nodes.push(node);
      return id;
    };

    const addEdge = (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => {
      const id = `edge_${source}_${type}_${target}`;
      if (edgeIds.has(id)) return;
      edgeIds.add(id);
      edges.push(this.createEdge(id, source, target, type, 'async-messaging', metadata));
    };

    for (const file of files) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      const relativePath = path.relative(projectPath, file);
      const ext = path.extname(file).toLowerCase();
      const imports = this.extractImports(content, relativePath);
      const lineOf = (index: number): number => this.sourceLineForIndex(content, index);

      if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
        this.extractTypeScriptMessaging(content, imports, relativePath, nodes, entryPoints, exitPoints, ensureChannelNode, addEdge, lineOf);
      } else if (ext === '.py') {
        this.extractPythonMessaging(content, imports, celeryTaskNames, relativePath, nodes, entryPoints, exitPoints, ensureChannelNode, addEdge, lineOf);
      } else if (ext === '.java') {
        this.extractJavaMessaging(content, imports, relativePath, nodes, entryPoints, exitPoints, ensureChannelNode, addEdge, lineOf);
      } else if (ext === '.rb') {
        this.extractRubyMessaging(content, imports, relativePath, nodes, entryPoints, exitPoints, ensureChannelNode, addEdge, lineOf);
      } else if (ext === '.go') {
        this.extractGoMessaging(content, imports, relativePath, nodes, entryPoints, exitPoints, ensureChannelNode, addEdge, lineOf);
      }
    }

    return { nodes, edges, entryPoints, exitPoints };
  }

  private extractTypeScriptMessaging(
    content: string,
    imports: string[],
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    const hasImport = (pkg: string): boolean => imports.some(source => source === pkg || source.startsWith(`${pkg}/`));
    const queueVars = this.extractQueueVariables(content, lineOf);

    if (hasImport('kafkajs')) {
      const kafkaGroup = this.extractKafkaGroupId(content);



      this.extractObjectSendProducers(content, filePath, 'kafkajs', 'topic', /\.send(?:Batch)?\s*\(\s*\{[\s\S]{0,240}?topic\s*:\s*(['"`])([^'"`]+)\1/g, 'send', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractTopicConsumers(content, filePath, 'kafkajs', 'topic', /\.subscribe\s*\(\s*\{[\s\S]{0,240}?topic\s*:\s*(['"`])([^'"`]+)\1/g, /eachMessage\s*:\s*(?:async\s*)?\(?\s*([^,\n)=]+)/g, nodes, entryPoints, ensureChannelNode, addEdge, lineOf, kafkaGroup ? { type: 'consumer-group', fanout: false, group: kafkaGroup } : undefined);
    }

    if (hasImport('node-rdkafka')) {
      this.extractCallWithStringProducer(content, filePath, 'node-rdkafka', 'topic', /\.produce\s*\(\s*(['"`])([^'"`]+)\1/g, 'produce', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractCallWithStringConsumer(content, filePath, 'node-rdkafka', 'topic', /\.subscribe\s*\(\s*\[\s*(['"`])([^'"`]+)\1/g, 'rdkafka consumer', nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
    }




    if (hasImport('amqplib') || hasImport('amqp-connection-manager')) {
      const rabbitSystem = hasImport('amqplib') ? 'amqplib' : 'amqp-connection-manager';
      this.extractRabbitExchanges(content, filePath, rabbitSystem, nodes, entryPoints, exitPoints, ensureChannelNode, addEdge, lineOf, {
        assertExchange: /\.assertExchange\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*(['"`])([^'"`]+)\3/g,
        bindQueue: /\.bindQueue\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*(['"`])([^'"`]+)\3\s*(?:,\s*(['"`])([^'"`]*)\5)?/g,
        publish: /\.publish\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*(['"`])([^'"`]*)\3/g,
      });
      this.extractCallWithStringProducer(content, filePath, rabbitSystem, 'queue', /\.sendToQueue\s*\(\s*(['"`])([^'"`]+)\1/g, 'sendToQueue', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractCallWithStringConsumer(content, filePath, rabbitSystem, 'queue', /\.consume\s*\(\s*(['"`])([^'"`]+)\1/g, 'RabbitMQ consumer', nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
    }




    if (hasImport('@nestjs/microservices') || /@(?:Message|Event)Pattern\s*\(/.test(content)) {
      this.extractNestMicroserviceHandlers(content, filePath, nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
      this.extractNestClientProducers(content, filePath, nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
    }

    if (hasImport('nats')) {
      this.extractCallWithStringProducer(content, filePath, 'nats', 'subject', /\.publish\s*\(\s*(['"`])([^'"`]+)\1/g, 'publish', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractNatsSubscribers(content, filePath, 'nats', nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
    }

    if (hasImport('ioredis') || hasImport('redis') || hasImport('@redis/client')) {

      this.extractCallWithStringProducer(content, filePath, 'redis-pubsub', 'channel', /\.publish\s*\(\s*(['"`])([^'"`]+)\1/g, 'publish', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractCallWithStringConsumer(content, filePath, 'redis-pubsub', 'channel', /\.(?:p?subscribe)\s*\(\s*(['"`])([^'"`]+)\1/g, 'Redis subscriber', nodes, entryPoints, ensureChannelNode, addEdge, lineOf);

      this.extractCallWithStringProducer(content, filePath, 'redis-streams', 'stream', /\.xadd\s*\(\s*(['"`])([^'"`]+)\1/g, 'xadd', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractRedisStreamGroups(content, filePath, nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
    }



    this.extractEventEmitter(content, filePath, nodes, entryPoints, exitPoints, ensureChannelNode, addEdge, lineOf);

    if (hasImport('bullmq')) {
      this.extractQueueAdds(content, queueVars, filePath, 'bullmq', nodes, entryPoints, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractNewWorkerConsumers(content, filePath, 'bullmq', nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
    }

    if (hasImport('bee-queue')) {
      this.extractBeeQueue(content, queueVars, filePath, nodes, entryPoints, exitPoints, ensureChannelNode, addEdge, lineOf);
    }

    if (hasImport('@aws-sdk/client-sqs')) {
      this.extractAwsCommandProducer(content, filePath, 'aws-sqs', 'queue', /new\s+SendMessageCommand\s*\(\s*\{[\s\S]{0,500}?QueueUrl\s*:\s*(['"`])([^'"`]+)\1/g, 'SendMessageCommand', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
    }

    if (hasImport('@aws-sdk/client-sns')) {
      this.extractAwsCommandProducer(content, filePath, 'aws-sns', 'topic', /new\s+PublishCommand\s*\(\s*\{[\s\S]{0,500}?TopicArn\s*:\s*(['"`])([^'"`]+)\1/g, 'PublishCommand', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
    }
  }

  private extractPythonMessaging(
    content: string,
    imports: string[],
    celeryTaskNames: Set<string>,
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    const hasImport = (pkg: string): boolean => imports.some(source => source === pkg || source.startsWith(`${pkg}.`));

    if (hasImport('confluent_kafka') || hasImport('kafka')) {
      this.extractCallWithStringProducer(content, filePath, 'python-kafka', 'topic', /\.produce\s*\(\s*(['"`])([^'"`]+)\1/g, 'produce', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractCallWithStringProducer(content, filePath, 'python-kafka', 'topic', /\.send\s*\(\s*(['"`])([^'"`]+)\1/g, 'send', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractCallWithStringConsumer(content, filePath, 'python-kafka', 'topic', /\.subscribe\s*\(\s*\[\s*(['"`])([^'"`]+)\1/g, 'Kafka consumer', nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
      this.extractConstructorTopicConsumers(content, filePath, 'python-kafka', /KafkaConsumer\s*\(\s*(['"`])([^'"`]+)\1/g, nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
    }

    if (hasImport('pika')) {

      const pikaExchangeTypes = new Map<string, RoutingShape['type']>();
      const declRe = /\.exchange_declare\s*\([\s\S]{0,300}?exchange\s*=\s*(['"`])([^'"`]+)\1[\s\S]{0,200}?exchange_type\s*=\s*(['"`])([^'"`]+)\3/g;
      let declMatch: RegExpExecArray | null;
      while ((declMatch = declRe.exec(content)) !== null) {
        const rawType = declMatch[4].toLowerCase();
        const type = (['direct', 'topic', 'fanout', 'headers'] as const).includes(rawType as any) ? (rawType as RoutingShape['type']) : 'direct';
        pikaExchangeTypes.set(declMatch[2], type);
        ensureChannelNode('pika', declMatch[2], 'exchange', filePath, lineOf(declMatch.index), { type, fanout: type === 'fanout', wildcard: type === 'topic' });
      }

      const pubRe = /\.basic_publish\s*\([\s\S]{0,400}?exchange\s*=\s*(['"`])([^'"`]+)\1(?:[\s\S]{0,200}?routing_key\s*=\s*(['"`])([^'"`]*)\3)?/g;
      let pubMatch: RegExpExecArray | null;
      while ((pubMatch = pubRe.exec(content)) !== null) {
        const exchange = pubMatch[2];
        const routingKey = pubMatch[4];
        const type = pikaExchangeTypes.get(exchange) ?? 'direct';
        const routing: RoutingShape = { type, fanout: type === 'fanout', wildcard: type === 'topic' || /[*#]/.test(routingKey || ''), keys: routingKey ? [routingKey] : undefined };
        this.addProducer({ system: 'pika', channel: exchange, channelKind: 'exchange', filePath, line: lineOf(pubMatch.index), name: 'pika.basic_publish', action: 'basic_publish', routing }, nodes, exitPoints, ensureChannelNode, addEdge);
      }
      this.extractKeywordStringConsumer(content, filePath, 'pika', 'queue', /\.basic_consume\s*\([\s\S]{0,300}?queue\s*=\s*(['"`])([^'"`]+)\1/g, 'RabbitMQ consumer', nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
    }

    if (hasImport('celery')) {
      this.extractCelery(content, filePath, nodes, entryPoints, exitPoints, ensureChannelNode, addEdge, lineOf);
    }

    if (celeryTaskNames.size > 0) {
      this.extractCeleryDelayProducers(content, imports, celeryTaskNames, filePath, nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
    }

    if (hasImport('redis')) {
      this.extractCallWithStringProducer(content, filePath, 'redis-pubsub', 'channel', /\.publish\s*\(\s*(['"`])([^'"`]+)\1/g, 'publish', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractCallWithStringConsumer(content, filePath, 'redis-pubsub', 'channel', /\.(?:p?subscribe)\s*\(\s*(['"`])([^'"`]+)\1/g, 'Redis subscriber', nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
    }
  }

  private extractJavaMessaging(
    content: string,
    imports: string[],
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    const hasSpringKafka = imports.some(source => source.includes('springframework.kafka'));
    const hasSpringRabbit = imports.some(source => source.includes('springframework.amqp.rabbit'));

    if (hasSpringKafka) {
      this.extractCallWithStringProducer(content, filePath, 'spring-kafka', 'topic', /\.send\s*\(\s*(['"`])([^'"`]+)\1/g, 'KafkaTemplate.send', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractAnnotationConsumer(content, filePath, 'spring-kafka', 'topic', /@KafkaListener\s*\([\s\S]{0,260}?(?:topics|topicPattern)\s*=\s*(?:\{\s*)?(['"])([^'"]+)\1/g, 'Kafka listener', nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
    }

    if (hasSpringRabbit) {
      this.extractCallWithStringProducer(content, filePath, 'spring-rabbit', 'queue', /\.convertAndSend\s*\(\s*(['"`])([^'"`]+)\1/g, 'RabbitTemplate.convertAndSend', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractAnnotationConsumer(content, filePath, 'spring-rabbit', 'queue', /@RabbitListener\s*\([\s\S]{0,260}?queues\s*=\s*(?:\{\s*)?(['"])([^'"]+)\1/g, 'Rabbit listener', nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
    }
  }

  private extractRubyMessaging(
    content: string,
    imports: string[],
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    if (!imports.includes('sidekiq') && !content.includes('Sidekiq::Worker')) return;

    const workerRe = /class\s+(\w+)[\s\S]{0,260}?include\s+Sidekiq::Worker/g;
    let match: RegExpExecArray | null;
    while ((match = workerRe.exec(content)) !== null) {
      const workerName = match[1];
      const line = lineOf(match.index);
      const queueName = this.extractSidekiqQueueName(content.slice(match.index, match.index + 600)) || workerName;
      this.addConsumer({ system: 'sidekiq', channel: queueName, channelKind: 'queue', filePath, line, name: workerName, handlerName: 'perform' }, nodes, entryPoints, ensureChannelNode, addEdge);
    }

    const enqueueRe = /\b(\w+)\.perform_async\s*\(/g;
    while ((match = enqueueRe.exec(content)) !== null) {
      const workerName = match[1];
      this.addProducer({ system: 'sidekiq', channel: workerName, channelKind: 'queue', filePath, line: lineOf(match.index), name: `${workerName}.perform_async`, action: 'perform_async' }, nodes, exitPoints, ensureChannelNode, addEdge);
    }
  }

  private extractGoMessaging(
    content: string,
    imports: string[],
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    if (imports.includes('github.com/segmentio/kafka-go')) {
      this.extractGoStructFieldProducer(content, filePath, 'go-kafka', 'topic', /kafka\.Writer\s*\{[\s\S]{0,500}?Topic\s*:\s*(['"`])([^'"`]+)\1/g, 'kafka writer', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractGoStructFieldConsumer(content, filePath, 'go-kafka', 'topic', /kafka\.ReaderConfig\s*\{[\s\S]{0,500}?Topic\s*:\s*(['"`])([^'"`]+)\1/g, 'kafka reader', nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
    }

    if (imports.includes('github.com/nats-io/nats.go')) {
      this.extractCallWithStringProducer(content, filePath, 'go-nats', 'subject', /\.Publish\s*\(\s*(['"`])([^'"`]+)\1/g, 'Publish', nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
      this.extractCallWithStringConsumer(content, filePath, 'go-nats', 'subject', /\.Subscribe\s*\(\s*(['"`])([^'"`]+)\1/g, 'NATS subscriber', nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
    }
  }

  private addProducer(
    spec: ProducerSpec,
    nodes: CASNode[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void
  ): string {
    const routing = spec.routing ?? this.defaultRouting(spec.system, spec.channelKind, spec.channel);
    const channelId = ensureChannelNode(spec.system, spec.channel, spec.channelKind, spec.filePath, spec.line, routing);
    const producerId = `messaging_${spec.system}_producer_${this.sanitizeId(spec.channel)}_${this.sanitizeId(spec.filePath)}_${spec.line}`;
    nodes.push(this.createNode(producerId, spec.name, 'producer', 4, spec.filePath, spec.line, undefined, {
      system: spec.system,
      channel: spec.channel,
      channelKind: spec.channelKind,
      action: spec.action,
      payloadType: spec.payloadType,
      routing,
      fanout: routing?.fanout === true,
      subcategories: ['async-messaging', spec.system, 'producer'],
    }));
    addEdge(producerId, channelId, 'produces', {
      system: spec.system,
      channel: spec.channel,
      channelKind: spec.channelKind,
      payloadType: spec.payloadType,
      routing,
      fanout: routing?.fanout === true,
    });
    exitPoints.push(this.createExitPoint(
      `exit_${producerId}`,
      producerId,
      'message',
      `${spec.system} publish to ${spec.channel}`,
      `${spec.name} publishes to ${spec.channelKind} ${spec.channel}${routing?.fanout ? ' (fanout broadcast)' : ''}.`,
      { service_id: spec.system, resource: spec.channel, endpoint: spec.channel },
      { action: spec.action, async: true },
      { system: spec.system, channel: spec.channel, channelKind: spec.channelKind, payloadType: spec.payloadType, routing, fanout: routing?.fanout === true }
    ));
    return producerId;
  }

  private addConsumer(
    spec: ConsumerSpec,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void
  ): string {
    const routing = spec.routing ?? this.defaultRouting(spec.system, spec.channelKind, spec.channel);
    const channelId = ensureChannelNode(spec.system, spec.channel, spec.channelKind, spec.filePath, spec.line, routing);
    const consumerId = `messaging_${spec.system}_consumer_${this.sanitizeId(spec.channel)}_${this.sanitizeId(spec.filePath)}_${spec.line}`;
    nodes.push(this.createNode(consumerId, spec.name, spec.system === 'bullmq' || spec.system === 'bee-queue' || spec.system === 'sidekiq' || spec.system === 'celery' ? 'worker' : (spec.system === 'event-emitter' ? 'listener' : 'consumer'), 4, spec.filePath, spec.line, undefined, {
      system: spec.system,
      channel: spec.channel,
      channelKind: spec.channelKind,
      handlerName: spec.handlerName,
      payloadType: spec.payloadType,
      routing,
      fanout: routing?.fanout === true,
      group: routing?.group,
      subcategories: ['async-messaging', spec.system, spec.system === 'event-emitter' ? 'listener' : 'consumer'],
    }));
    addEdge(channelId, consumerId, 'consumes', {
      system: spec.system,
      channel: spec.channel,
      channelKind: spec.channelKind,
      payloadType: spec.payloadType,
      routing,
      fanout: routing?.fanout === true,
      group: routing?.group,
    });
    entryPoints.push(this.createEntryPoint(
      `ep_${consumerId}`,
      consumerId,
      'message',
      spec.name,
      `${spec.name} consumes ${spec.channelKind} ${spec.channel}${routing?.group ? ` (group ${routing.group})` : routing?.fanout ? ' (broadcast)' : ''}.`,
      { event: `${spec.system}:${spec.channelKind}:${spec.channel}` },
      undefined,
      { system: spec.system, channel: spec.channel, channelKind: spec.channelKind, handlerName: spec.handlerName, payloadType: spec.payloadType, routing, fanout: routing?.fanout === true, group: routing?.group }
    ));
    return consumerId;
  }

  private extractObjectSendProducers(
    content: string,
    filePath: string,
    system: MessagingSystem,
    channelKind: ChannelKind,
    channelRe: RegExp,
    action: string,
    nodes: CASNode[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    let match: RegExpExecArray | null;
    while ((match = channelRe.exec(content)) !== null) {
      const line = lineOf(match.index);
      const payloadType = this.extractPayloadType(content.slice(match.index, match.index + 500));
      this.addProducer({ system, channel: match[2], channelKind, filePath, line, name: `${system}.${action}`, action, payloadType }, nodes, exitPoints, ensureChannelNode, addEdge);
    }
  }

  private extractCallWithStringProducer(
    content: string,
    filePath: string,
    system: MessagingSystem,
    channelKind: ChannelKind,
    callRe: RegExp,
    action: string,
    nodes: CASNode[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    let match: RegExpExecArray | null;
    while ((match = callRe.exec(content)) !== null) {
      const channel = match[2];
      const payloadType = this.extractPayloadType(content.slice(match.index, match.index + 300));
      this.addProducer({ system, channel, channelKind, filePath, line: lineOf(match.index), name: `${system}.${action}`, action, payloadType }, nodes, exitPoints, ensureChannelNode, addEdge);
    }
  }

  private extractAwsCommandProducer(
    content: string,
    filePath: string,
    system: MessagingSystem,
    channelKind: ChannelKind,
    callRe: RegExp,
    action: string,
    nodes: CASNode[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    this.extractCallWithStringProducer(content, filePath, system, channelKind, callRe, action, nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
  }

  private extractCallWithStringConsumer(
    content: string,
    filePath: string,
    system: MessagingSystem,
    channelKind: ChannelKind,
    callRe: RegExp,
    name: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    let match: RegExpExecArray | null;
    while ((match = callRe.exec(content)) !== null) {
      this.addConsumer({ system, channel: match[2], channelKind, filePath, line: lineOf(match.index), name, handlerName: this.extractHandlerName(content.slice(match.index, match.index + 240)) }, nodes, entryPoints, ensureChannelNode, addEdge);
    }
  }

  private extractTopicConsumers(
    content: string,
    filePath: string,
    system: MessagingSystem,
    channelKind: ChannelKind,
    subscribeRe: RegExp,
    handlerRe: RegExp,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number,
    routing?: RoutingShape
  ): void {
    let match: RegExpExecArray | null;
    while ((match = subscribeRe.exec(content)) !== null) {
      const window = content.slice(match.index, match.index + 1000);
      const handlerMatch = handlerRe.exec(window);
      handlerRe.lastIndex = 0;
      this.addConsumer({ system, channel: match[2], channelKind, filePath, line: lineOf(match.index), name: `${system} consumer`, handlerName: handlerMatch?.[1], routing }, nodes, entryPoints, ensureChannelNode, addEdge);
    }
  }

  private extractConstructorTopicConsumers(
    content: string,
    filePath: string,
    system: MessagingSystem,
    constructorRe: RegExp,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    let match: RegExpExecArray | null;
    while ((match = constructorRe.exec(content)) !== null) {
      this.addConsumer({ system, channel: match[2], channelKind: 'topic', filePath, line: lineOf(match.index), name: `${system} consumer` }, nodes, entryPoints, ensureChannelNode, addEdge);
    }
  }






  private extractNestPatternToken(arg: string): string | undefined {
    const strLit = /^\s*(['"`])([^'"`]+)\1/.exec(arg);
    if (strLit) return strLit[2];

    const pairRe = /([A-Za-z_$][\w$]*)\s*:\s*(['"`])([^'"`]+)\2/g;
    const pairs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(arg)) !== null) pairs.push(`${m[1]}=${m[3]}`);
    return pairs.length ? pairs.join(',') : undefined;
  }






  private extractNestMicroserviceHandlers(
    content: string,
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    const decoratorRe = /@(MessagePattern|EventPattern)\s*\(([\s\S]{0,200}?)\)/g;
    let match: RegExpExecArray | null;
    while ((match = decoratorRe.exec(content)) !== null) {
      const kindTag = match[1];
      const token = this.extractNestPatternToken(match[2]);
      if (!token) continue;
      const channelKind: ChannelKind = kindTag === 'EventPattern' ? 'event' : 'queue';

      const after = content.slice(match.index + match[0].length, match.index + match[0].length + 400);
      const handlerMatch = /(?:@[\w.]+\s*(?:\([^)]*\))?\s*)*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(after);
      this.addConsumer({
        system: 'nestjs-microservice',
        channel: token,
        channelKind,
        filePath,
        line: lineOf(match.index),
        name: `@${kindTag}(${token})`,
        handlerName: handlerMatch?.[1],
      }, nodes, entryPoints, ensureChannelNode, addEdge);
    }
  }






  private extractNestClientProducers(
    content: string,
    filePath: string,
    nodes: CASNode[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {



    const callRe = /\.(send|emit)\s*\(\s*((['"`])[^'"`]+\3|\{[\s\S]{0,200}?\})\s*,/g;
    let match: RegExpExecArray | null;
    while ((match = callRe.exec(content)) !== null) {
      const action = match[1];
      const token = this.extractNestPatternToken(match[2]);
      if (!token) continue;
      const channelKind: ChannelKind = action === 'emit' ? 'event' : 'queue';
      this.addProducer({
        system: 'nestjs-microservice',
        channel: token,
        channelKind,
        filePath,
        line: lineOf(match.index),
        name: `client.${action}(${token})`,
        action,
        payloadType: this.extractPayloadType(content.slice(match.index, match.index + 300)),
      }, nodes, exitPoints, ensureChannelNode, addEdge);
    }
  }


  private extractKeywordStringConsumer(
    content: string,
    filePath: string,
    system: MessagingSystem,
    channelKind: ChannelKind,
    callRe: RegExp,
    name: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    this.extractCallWithStringConsumer(content, filePath, system, channelKind, callRe, name, nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
  }

  private extractAnnotationConsumer(
    content: string,
    filePath: string,
    system: MessagingSystem,
    channelKind: ChannelKind,
    annotationRe: RegExp,
    name: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    let match: RegExpExecArray | null;
    while ((match = annotationRe.exec(content)) !== null) {
      const methodMatch = content.slice(match.index, match.index + 500).match(/\b(?:public|private|protected)?\s*(?:void|[\w<>]+)\s+(\w+)\s*\(/);
      this.addConsumer({ system, channel: match[2], channelKind, filePath, line: lineOf(match.index), name: methodMatch?.[1] || name, handlerName: methodMatch?.[1] }, nodes, entryPoints, ensureChannelNode, addEdge);
    }
  }

  private extractGoStructFieldProducer(
    content: string,
    filePath: string,
    system: MessagingSystem,
    channelKind: ChannelKind,
    structRe: RegExp,
    action: string,
    nodes: CASNode[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    this.extractCallWithStringProducer(content, filePath, system, channelKind, structRe, action, nodes, exitPoints, ensureChannelNode, addEdge, lineOf);
  }

  private extractGoStructFieldConsumer(
    content: string,
    filePath: string,
    system: MessagingSystem,
    channelKind: ChannelKind,
    structRe: RegExp,
    name: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    this.extractCallWithStringConsumer(content, filePath, system, channelKind, structRe, name, nodes, entryPoints, ensureChannelNode, addEdge, lineOf);
  }

  private extractQueueAdds(
    content: string,
    queueVars: Map<string, string>,
    filePath: string,
    system: MessagingSystem,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    const addRe = /\b(\w+)\.add\s*\(\s*(['"`])([^'"`]+)\2/g;
    let match: RegExpExecArray | null;
    while ((match = addRe.exec(content)) !== null) {
      const queueName = queueVars.get(match[1]);
      if (!queueName) continue;
      this.addProducer({ system, channel: queueName, channelKind: 'queue', filePath, line: lineOf(match.index), name: `${match[1]}.add`, action: 'add', payloadType: match[3] }, nodes, exitPoints, ensureChannelNode, addEdge);
    }






  }

  private extractNewWorkerConsumers(
    content: string,
    filePath: string,
    system: MessagingSystem,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    const workerRe = /new\s+Worker\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*(?:async\s*)?([^,\n)]+)/g;
    let match: RegExpExecArray | null;
    while ((match = workerRe.exec(content)) !== null) {
      this.addConsumer({ system, channel: match[2], channelKind: 'queue', filePath, line: lineOf(match.index), name: `${system} worker ${match[2]}`, handlerName: match[3]?.trim() }, nodes, entryPoints, ensureChannelNode, addEdge);
    }
  }

  private extractBeeQueue(
    content: string,
    queueVars: Map<string, string>,
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    const createJobRe = /\b(\w+)\.createJob\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = createJobRe.exec(content)) !== null) {
      const queueName = queueVars.get(match[1]);
      if (!queueName) continue;
      this.addProducer({ system: 'bee-queue', channel: queueName, channelKind: 'queue', filePath, line: lineOf(match.index), name: `${match[1]}.createJob`, action: 'createJob' }, nodes, exitPoints, ensureChannelNode, addEdge);
    }

    const processRe = /\b(\w+)\.process\s*\(\s*(?:async\s*)?([^,\n)]+)/g;
    while ((match = processRe.exec(content)) !== null) {
      const queueName = queueVars.get(match[1]);
      if (!queueName) continue;
      this.addConsumer({ system: 'bee-queue', channel: queueName, channelKind: 'queue', filePath, line: lineOf(match.index), name: `bee-queue worker ${queueName}`, handlerName: match[2]?.trim() }, nodes, entryPoints, ensureChannelNode, addEdge);
    }
  }

  private extractCelery(
    content: string,
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    const taskRe = /@(?:app|celery|shared_task)(?:\.task)?(?:\([\s\S]{0,160}?\))?\s*\ndef\s+(\w+)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = taskRe.exec(content)) !== null) {
      const decorator = match[0];
      const queueMatch = decorator.match(/queue\s*=\s*(['"`])([^'"`]+)\1/);
      const taskName = match[1];
      this.addConsumer({ system: 'celery', channel: queueMatch?.[2] || taskName, channelKind: 'queue', filePath, line: lineOf(match.index), name: taskName, handlerName: taskName }, nodes, entryPoints, ensureChannelNode, addEdge);
    }

  }

  private extractCeleryDelayProducers(
    content: string,
    imports: string[],
    celeryTaskNames: Set<string>,
    filePath: string,
    nodes: CASNode[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    const delayRe = /\b(\w+)\.(delay|apply_async)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = delayRe.exec(content)) !== null) {
      const taskName = match[1];
      if (!celeryTaskNames.has(taskName)) continue;
      if (!this.fileImportsSymbol(content, imports, taskName) && !new RegExp(`def\\s+${taskName}\\s*\\(`).test(content)) continue;
      this.addProducer({ system: 'celery', channel: taskName, channelKind: 'queue', filePath, line: lineOf(match.index), name: `${taskName}.${match[2]}`, action: match[2], payloadType: taskName }, nodes, exitPoints, ensureChannelNode, addEdge);
    }
  }

  private extractQueueVariables(content: string, lineOf: (index: number) => number): Map<string, string> {
    const queues = new Map<string, string>();
    const queueRe = /\b(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:Queue|BeeQueue)\s*\(\s*(['"`])([^'"`]+)\2/g;
    let match: RegExpExecArray | null;
    while ((match = queueRe.exec(content)) !== null) {
      if (lineOf(match.index) > 0) queues.set(match[1], match[3]);
    }
    return queues;
  }

  private extractSidekiqQueueName(content: string): string | undefined {
    const queueMatch = content.match(/sidekiq_options\s+[\s\S]{0,160}?queue:\s*(['"`:]?)([A-Za-z0-9_.-]+)/);
    return queueMatch?.[2]?.replace(/^:/, '');
  }

  private extractHandlerName(content: string): string | undefined {
    const arrow = content.match(/,\s*(?:async\s*)?(\w+)\s*=>/);
    if (arrow) return arrow[1];
    const named = content.match(/,\s*(\w+)\s*\)/);
    return named?.[1];
  }

  private extractPayloadType(content: string): string | undefined {
    const explicit = content.match(/\b(?:type|messageType|name|jobName)\s*:\s*(['"`])([^'"`]+)\1/);
    if (explicit) return explicit[2];
    const value = content.match(/\bvalue\s*:\s*(?:JSON\.stringify\s*\(\s*)?([A-Z][A-Za-z0-9_]*)/);
    if (value) return value[1];
    const body = content.match(/\b(?:MessageBody|Body|body|data)\s*:\s*(?:JSON\.stringify\s*\(\s*)?([A-Z][A-Za-z0-9_]*)/);
    return body?.[1];
  }

  private async collectCeleryTaskNames(files: string[], projectPath: string): Promise<Set<string>> {
    const taskNames = new Set<string>();
    for (const file of files) {
      if (path.extname(file).toLowerCase() !== '.py') continue;
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      const imports = this.extractImports(content, file);
      if (!imports.some(source => source === 'celery' || source.startsWith('celery.'))) continue;
      const taskRe = /@(?:app|celery|shared_task)(?:\.task)?(?:\([\s\S]{0,160}?\))?\s*\ndef\s+(\w+)\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = taskRe.exec(content)) !== null) {
        taskNames.add(match[1]);
      }
    }
    return taskNames;
  }

  private fileImportsSymbol(content: string, imports: string[], symbol: string): boolean {
    if (imports.length === 0) return false;
    const fromImportRe = new RegExp(`^\\s*from\\s+[a-zA-Z0-9_.]+\\s+import\\s+[^\\n]*\\b${symbol}\\b`, 'm');
    if (fromImportRe.test(content)) return true;
    const directImportRe = new RegExp(`^\\s*import\\s+.*\\b${symbol}\\b`, 'm');
    return directImportRe.test(content);
  }

  private extractImports(content: string, filePath: string): string[] {
    const flavor = this.sourceImportFlavor(filePath);
    const corpusImports = flavor ? this.sourceImports(content, flavor) : undefined;
    if (corpusImports) return [...corpusImports];
    const imports = new Set<string>();
    for (const line of this.sourceLines(content)) {
      const importMatch = line.match(/^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/);
      const requireMatch = line.match(/\brequire\(['"]([^'"]+)['"]\)/);
      const pythonMatch = line.match(/^\s*(?:from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_.]+))/);
      const javaMatch = line.match(/^\s*import\s+([a-zA-Z0-9_.]+)(?:\.\*)?;/);
      const rubyMatch = line.match(/^\s*require\s+['"]([^'"]+)['"]/);
      const goMatch = line.match(/^\s*["`]([^"`]+)["`]/);
      const value = importMatch?.[1] || requireMatch?.[1] || pythonMatch?.[1] || pythonMatch?.[2] || javaMatch?.[1] || rubyMatch?.[1] || goMatch?.[1];
      if (value) imports.add(value);
    }
    return Array.from(imports);
  }

  private async collectDependencyNames(projectPath: string): Promise<Set<string>> {
    const names = new Set<string>();
    try {
      const pkgPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(pkgPath)) {
        const pkg = await this.readSourceJson<any>(pkgPath);
        for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies })) {
          names.add(name);
        }
      }
    } catch {

    }

    try {
      const reqPath = path.join(projectPath, 'requirements.txt');
      if (await fs.pathExists(reqPath)) {
        const content = await fs.readFile(reqPath, 'utf-8');
        for (const line of content.split(/\r?\n/)) {
          const name = line.trim().split(/[=<>~\[]/)[0].toLowerCase();
          if (name) names.add(name);
        }
      }
    } catch {

    }

    try {
      const pyproject = path.join(projectPath, 'pyproject.toml');
      if (await fs.pathExists(pyproject)) {
        const content = await fs.readFile(pyproject, 'utf-8');
        for (const marker of ['celery', 'confluent-kafka', 'kafka-python', 'pika', 'redis']) {
          if (content.toLowerCase().includes(marker)) names.add(marker);
        }
      }
    } catch {

    }

    try {
      const gemfile = path.join(projectPath, 'Gemfile');
      if (await fs.pathExists(gemfile)) {
        const content = await fs.readFile(gemfile, 'utf-8');
        const gemRe = /^\s*gem\s+['"]([^'"]+)['"]/gm;
        let match: RegExpExecArray | null;
        while ((match = gemRe.exec(content)) !== null) {
          names.add(match[1]);
        }
      }
    } catch {

    }

    try {
      const goMod = path.join(projectPath, 'go.mod');
      if (await fs.pathExists(goMod)) {
        const content = await fs.readFile(goMod, 'utf-8');
        const goDepRe = /^\s*(github\.com\/(?:segmentio\/kafka-go|nats-io\/nats\.go))\s+/gm;
        let match: RegExpExecArray | null;
        while ((match = goDepRe.exec(content)) !== null) {
          names.add(match[1]);
        }
      }
    } catch {

    }

    try {
      const javaFiles = await glob('**/{pom.xml,build.gradle,build.gradle.kts}', {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        absolute: true,
        nodir: true,
      });
      for (const file of javaFiles) {
        const content = await fs.readFile(file, 'utf-8');
        if (content.includes('spring-kafka')) names.add('spring-kafka');
        if (content.includes('spring-rabbit') || content.includes('spring-boot-starter-amqp')) names.add('spring-rabbit');
      }
    } catch {

    }

    return names;
  }

  private extractKafkaGroupId(content: string): string | undefined {
    const m = content.match(/\.consumer\s*\(\s*\{[\s\S]{0,200}?groupId\s*:\s*(['"`])([^'"`]+)\1/);
    return m?.[2];
  }







  private extractRabbitExchanges(
    content: string,
    filePath: string,
    system: MessagingSystem,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number,
    res: { assertExchange: RegExp; bindQueue: RegExp; publish: RegExp }
  ): void {

    const exchangeTypes = new Map<string, RoutingShape['type']>();
    let match: RegExpExecArray | null;
    res.assertExchange.lastIndex = 0;
    while ((match = res.assertExchange.exec(content)) !== null) {
      const name = match[2];
      const rawType = (match[4] || 'direct').toLowerCase();
      const type: RoutingShape['type'] = (['direct', 'topic', 'fanout', 'headers'] as const).includes(rawType as any)
        ? (rawType as RoutingShape['type'])
        : 'direct';
      exchangeTypes.set(name, type);
      ensureChannelNode(system, name, 'exchange', filePath, lineOf(match.index), {
        type,
        fanout: type === 'fanout',
        wildcard: type === 'topic',
      });
    }


    res.bindQueue.lastIndex = 0;
    while ((match = res.bindQueue.exec(content)) !== null) {
      const exchange = match[4];
      const routingKey = match[6];
      const type = exchangeTypes.get(exchange);
      if (!type) continue;
      ensureChannelNode(system, exchange, 'exchange', filePath, lineOf(match.index), {
        type,
        fanout: type === 'fanout',
        wildcard: type === 'topic' || /[*#]/.test(routingKey || ''),
        keys: routingKey ? [routingKey] : undefined,
      });
    }


    res.publish.lastIndex = 0;
    while ((match = res.publish.exec(content)) !== null) {
      const exchange = match[2];
      const routingKey = match[4];
      const type = exchangeTypes.get(exchange) ?? 'direct';
      const routing: RoutingShape = {
        type,
        fanout: type === 'fanout',
        wildcard: type === 'topic' || /[*#]/.test(routingKey || ''),
        keys: routingKey ? [routingKey] : undefined,
      };
      this.addProducer({ system, channel: exchange, channelKind: 'exchange', filePath, line: lineOf(match.index), name: `${system}.publish`, action: 'publish', routing }, nodes, exitPoints, ensureChannelNode, addEdge);
    }






    const dynamicRe = /\.assertExchange\s*\(\s*(?!['"`])([^,]+?)\s*,\s*(['"`])(fanout|topic|direct|headers)\2/g;
    let dyn: RegExpExecArray | null;
    while ((dyn = dynamicRe.exec(content)) !== null) {
      const type = dyn[3] as RoutingShape['type'];
      const nameExpr = dyn[1].trim().slice(0, 40);
      const channelName = `<dynamic:${nameExpr}>`;
      const routing: RoutingShape = { type, fanout: type === 'fanout', wildcard: type === 'topic' };

      this.addProducer({ system, channel: channelName, channelKind: 'exchange', filePath, line: lineOf(dyn.index), name: `${system} ${type} exchange`, action: 'assertExchange', routing }, nodes, exitPoints, ensureChannelNode, addEdge);
    }
  }






  private extractNatsSubscribers(
    content: string,
    filePath: string,
    system: MessagingSystem,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {
    const subRe = /\.subscribe\s*\(\s*(['"`])([^'"`]+)\1\s*(?:,\s*\{([\s\S]{0,120}?)\})?/g;
    let match: RegExpExecArray | null;
    while ((match = subRe.exec(content)) !== null) {
      const subject = match[2];
      const opts = match[3] || '';
      const queueMatch = opts.match(/queue\s*:\s*(['"`])([^'"`]+)\1/);
      const wildcard = /[*>]/.test(subject);
      const routing: RoutingShape = queueMatch
        ? { type: 'queue-group', fanout: false, group: queueMatch[2], wildcard }
        : { type: wildcard ? 'topic' : 'direct', fanout: true, wildcard };
      this.addConsumer({ system, channel: subject, channelKind: 'subject', filePath, line: lineOf(match.index), name: 'NATS subscriber', routing }, nodes, entryPoints, ensureChannelNode, addEdge);
    }
  }





  private extractRedisStreamGroups(
    content: string,
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {

    const groupRe = /\.xreadgroup\s*\(\s*(['"`])GROUP\1\s*,\s*(['"`])([^'"`]+)\2[\s\S]{0,160}?(['"`])STREAMS\4\s*,\s*(['"`])([^'"`]+)\5/gi;
    let match: RegExpExecArray | null;
    while ((match = groupRe.exec(content)) !== null) {
      const group = match[3];
      const stream = match[6];
      this.addConsumer({ system: 'redis-streams', channel: stream, channelKind: 'stream', filePath, line: lineOf(match.index), name: `Redis stream group ${group}`, routing: { type: 'consumer-group', fanout: false, group } }, nodes, entryPoints, ensureChannelNode, addEdge);
    }
  }









  private extractEventEmitter(
    content: string,
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    ensureChannelNode: ChannelEnsurer,
    addEdge: (source: string, target: string, type: 'produces' | 'consumes', metadata: Record<string, any>) => void,
    lineOf: (index: number) => number
  ): void {


    if (!/EventEmitter|extends\s+EventEmitter|new\s+EventEmitter/.test(content)) return;

    const routing: RoutingShape = { type: 'event', fanout: true };

    const listenerRe = /\.(?:on|once|addListener|prependListener)\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*(?:async\s*)?([\w$.]+)?/g;
    let match: RegExpExecArray | null;
    while ((match = listenerRe.exec(content)) !== null) {
      const event = match[2];

      if (/^(error|close|end|data|finish|drain|open|connect|disconnect|message|newListener|removeListener)$/.test(event)) continue;
      this.addConsumer({ system: 'event-emitter', channel: event, channelKind: 'event', filePath, line: lineOf(match.index), name: `on(${event})`, handlerName: match[3]?.trim(), routing }, nodes, entryPoints, ensureChannelNode, addEdge);
    }

    const emitRe = /\.emit\s*\(\s*(['"`])([^'"`]+)\1/g;
    while ((match = emitRe.exec(content)) !== null) {
      const event = match[2];
      if (/^(error|close|end|data|finish|drain|open|connect|disconnect|newListener|removeListener)$/.test(event)) continue;
      this.addProducer({ system: 'event-emitter', channel: event, channelKind: 'event', filePath, line: lineOf(match.index), name: `emit(${event})`, action: 'emit', routing }, nodes, exitPoints, ensureChannelNode, addEdge);
    }
  }






  private mergeRoutingIntoChannel(node: CASNode | undefined, routing: RoutingShape): void {
    if (!node) return;
    const meta = node.metadata as any;
    const existing: RoutingShape | undefined = meta.routing;
    if (!existing) {
      meta.routing = { ...routing };
      meta.fanout = routing.fanout === true;
      return;
    }

    if (routing.type && routing.type !== existing.type) existing.type = routing.type;
    if (routing.fanout !== undefined) existing.fanout = existing.fanout || routing.fanout;
    if (routing.wildcard !== undefined) existing.wildcard = existing.wildcard || routing.wildcard;
    if (routing.group) existing.group = routing.group;
    if (routing.keys?.length) {
      existing.keys = Array.from(new Set([...(existing.keys ?? []), ...routing.keys]));
    }
    meta.fanout = existing.fanout === true;
  }






  private defaultRouting(system: MessagingSystem, kind: ChannelKind, name: string): RoutingShape | undefined {
    const wildcard = /[*#>]|\.\*|\.>/.test(name);
    switch (system) {
      case 'redis-pubsub':
        return { type: 'pubsub', fanout: true, wildcard };
      case 'redis-streams':
        return { type: 'stream', fanout: false };
      case 'aws-sns':
        return { type: 'fanout', fanout: true };
      case 'aws-sqs':
        return { type: 'queue-group', fanout: false };
      case 'nats':
      case 'go-nats':


        return { type: wildcard ? 'topic' : 'direct', fanout: true, wildcard };
      case 'event-emitter':
        return { type: 'event', fanout: true };
      case 'kafkajs':
      case 'python-kafka':
      case 'spring-kafka':
      case 'go-kafka':
      case 'node-rdkafka':


        return { type: 'consumer-group', fanout: false };
      case 'amqplib':
      case 'amqp-connection-manager':
      case 'pika':
      case 'spring-rabbit':


        return kind === 'exchange' ? { type: 'topic', fanout: false } : { type: 'queue-group', fanout: false };
      case 'nestjs-microservice':


        return kind === 'event' ? { type: 'event', fanout: true } : { type: 'queue-group', fanout: false };
      default:
        return undefined;
    }
  }

  protected getCapabilities(): string[] {
    return [
      'message-producer-exit-points',
      'message-consumer-entry-points',
      'broker-channel-node-detection',
      'producer-channel-consumer-graph',
      'kafka-rabbitmq-nats-redis-detection',
      'queue-worker-detection',
      'spring-sidekiq-celery-detection',
      'exchange-routing-shape-detection',
      'fanout-broadcast-seam-detection',
      'consumer-group-competing-consumer-detection',
      'in-process-event-listener-detection',
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1:
        return 'system';
      case 2:
        return 'broker';
      case 3:
        return 'channel';
      case 4:
        return 'messaging endpoint';
      default:
        return 'unknown';
    }
  }
}

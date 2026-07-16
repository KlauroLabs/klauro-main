import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { MessagingAnalyzer } from './messaging-analyzer';

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'messaging-analyzer-'));

  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'messaging-fixture',
    dependencies: {
      kafkajs: '^2.2.4',
      bullmq: '^5.0.0',
      ioredis: '^5.0.0',
    },
  });
  await fs.writeFile(path.join(dir, 'requirements.txt'), 'celery==5.3.0\nredis==5.0.0\n');
  await fs.writeFile(
    path.join(dir, 'build.gradle'),
    "implementation 'org.springframework.kafka:spring-kafka:3.2.0'\n"
  );

  await fs.writeFile(
    path.join(dir, 'kafka.ts'),
    [
      `import { Kafka } from 'kafkajs';`,
      '',
      'const kafka = new Kafka({ clientId: "orders" });',
      'const producer = kafka.producer();',
      'const consumer = kafka.consumer({ groupId: "billing" });',
      '',
      'export async function publishOrderCreated(payload: OrderCreatedEvent) {',
      '  await producer.send({ topic: "orders.created", messages: [{ value: JSON.stringify(OrderCreatedEvent) }] });',
      '}',
      '',
      'export async function startConsumer() {',
      '  await consumer.subscribe({ topic: "orders.created", fromBeginning: false });',
      '  await consumer.run({ eachMessage: async ({ message }) => {} });',
      '}',
      '',
    ].join('\n')
  );

  await fs.writeFile(
    path.join(dir, 'queues.ts'),
    [
      `import { Queue, Worker } from 'bullmq';`,
      `import Redis from 'ioredis';`,
      '',
      `const emails = new Queue('emails');`,
      `emails.add('send-email', { to: 'user@example.com' });`,
      `new Worker('emails', async job => {});`,
      '',
      'const redis = new Redis();',
      `redis.publish('presence', JSON.stringify({ userId: 'u1' }));`,
      `redis.subscribe('presence');`,
      '',
    ].join('\n')
  );

  await fs.writeFile(
    path.join(dir, 'tasks.py'),
    [
      'from celery import shared_task',
      'import redis',
      '',
      '@shared_task(queue="reports")',
      'def render_report(report_id):',
      '    return report_id',
      '',
      'def trigger():',
      '    render_report.delay("r1")',
      "    redis.Redis().publish('report-events', 'ready')",
      "    redis.Redis().pubsub().subscribe('report-events')",
      '',
    ].join('\n')
  );

  await fs.writeFile(
    path.join(dir, 'OrdersListener.java'),
    [
      'import org.springframework.kafka.annotation.KafkaListener;',
      'import org.springframework.kafka.core.KafkaTemplate;',
      '',
      'public class OrdersListener {',
      '  private KafkaTemplate<String, String> kafkaTemplate;',
      '  public void publish(String payload) {',
      '    kafkaTemplate.send("invoices.created", payload);',
      '  }',
      '  @KafkaListener(topics = "invoices.created")',
      '  public void handleInvoice(String payload) {',
      '  }',
      '}',
      '',
    ].join('\n')
  );

  // Fanout exchange (RabbitMQ) — a 1->N broadcast seam, plus a topic exchange.
  await fs.writeFile(
    path.join(dir, 'broadcast.ts'),
    [
      `import * as amqp from 'amqplib';`,
      '',
      'export async function setup(ch: amqp.Channel) {',
      `  await ch.assertExchange('events.fanout', 'fanout', { durable: true });`,
      `  await ch.assertExchange('logs.topic', 'topic', { durable: true });`,
      `  await ch.bindQueue('audit', 'logs.topic', 'order.*');`,
      `  ch.publish('events.fanout', '', Buffer.from('{}'));`,
      `  ch.publish('logs.topic', 'order.created', Buffer.from('{}'));`,
      '}',
      '',
    ].join('\n')
  );

  // In-process Node EventEmitter — emit/on pair over a domain event name.
  await fs.writeFile(
    path.join(dir, 'bus.ts'),
    [
      `import { EventEmitter } from 'events';`,
      '',
      'export class OrderBus extends EventEmitter {}',
      'const bus = new OrderBus();',
      `bus.on('order.placed', handleOrderPlaced);`,
      'function handleOrderPlaced() {}',
      `export function place() { bus.emit('order.placed', { id: 1 }); }`,
      '',
    ].join('\n')
  );

  return dir;
}

test('MessagingAnalyzer emits broker channel nodes, producer exits, consumer entries, and graph edges', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new MessagingAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'canAnalyze should be true');

    const contribution = await analyzer.analyze({ projectPath: dir });
    const nodes = contribution.nodes || [];
    const edges = contribution.edges || [];
    const entryPoints = contribution.entry_points || [];
    const exitPoints = contribution.exit_points || [];

    const kafkaTopic = nodes.find(node => node.type === 'topic' && node.name === 'orders.created' && (node.metadata as any)?.system === 'kafkajs');
    assert.ok(kafkaTopic, 'expected a KafkaJS topic node');
    assert.ok(exitPoints.find(exit => exit.type === 'message' && (exit.metadata as any)?.channel === 'orders.created'), 'expected a KafkaJS producer exit point');
    const kafkaConsumerEntry = entryPoints.find(entry => entry.type === 'message' && (entry.metadata as any)?.channel === 'orders.created');
    assert.ok(kafkaConsumerEntry, 'expected a KafkaJS consumer entry point');
    assert.ok(edges.find(edge => edge.type === 'produces' && edge.target === kafkaTopic!.id), 'expected producer -> Kafka topic edge');
    assert.ok(edges.find(edge => edge.type === 'consumes' && edge.source === kafkaTopic!.id), 'expected Kafka topic -> consumer edge');

    // The message entry point's `source_node` is the consumer node, which
    // BaseAnalyzer.createNode already grounds in a real `source.file`/`line`
    // (kafka.ts, the `consumer.subscribe(...)` call site). The generic
    // handler backfill in BaseAnalyzer.createContribution should mirror that
    // onto entry_point.handler without the analyzer passing it explicitly.
    const consumerNode = nodes.find(node => node.id === kafkaConsumerEntry!.source_node);
    assert.ok(consumerNode?.source?.file, 'expected the backing consumer node to carry a real source file');
    assert.equal(kafkaConsumerEntry!.handler?.node_id, consumerNode!.id);
    assert.equal(kafkaConsumerEntry!.handler?.file, consumerNode!.source!.file);
    assert.equal(kafkaConsumerEntry!.handler?.line, consumerNode!.source!.line);

    const emailQueue = nodes.find(node => node.type === 'queue' && node.name === 'emails' && (node.metadata as any)?.system === 'bullmq');
    assert.ok(emailQueue, 'expected a BullMQ queue node');
    assert.ok(exitPoints.find(exit => (exit.metadata as any)?.system === 'bullmq' && (exit.metadata as any)?.channel === 'emails'), 'expected a BullMQ producer exit point');
    assert.ok(entryPoints.find(entry => (entry.metadata as any)?.system === 'bullmq' && (entry.metadata as any)?.channel === 'emails'), 'expected a BullMQ worker entry point');

    const celeryQueue = nodes.find(node => node.type === 'queue' && node.name === 'reports' && (node.metadata as any)?.system === 'celery');
    assert.ok(celeryQueue, 'expected a Celery queue node from the task decorator');
    assert.ok(entryPoints.find(entry => entry.name === 'render_report' && entry.type === 'message'), 'expected a Celery task message entry point');

    const redisChannel = nodes.find(node => node.type === 'channel' && node.name === 'presence' && (node.metadata as any)?.system === 'redis-pubsub');
    assert.ok(redisChannel, 'expected a Redis pub/sub channel node');

    const javaTopic = nodes.find(node => node.type === 'topic' && node.name === 'invoices.created' && (node.metadata as any)?.system === 'spring-kafka');
    assert.ok(javaTopic, 'expected a Spring Kafka topic node');
    assert.ok(entryPoints.find(entry => entry.name === 'handleInvoice' && (entry.metadata as any)?.channel === 'invoices.created'), 'expected @KafkaListener message entry point');

    const meta = contribution.analyzer_metadata as any;
    assert.equal(meta.producer_exit_points, exitPoints.length);
    assert.equal(meta.consumer_entry_points, entryPoints.length);
    assert.ok(meta.capabilities.includes('producer-channel-consumer-graph'));
  } finally {
    await fs.remove(dir);
  }
});

test('MessagingAnalyzer captures exchange routing shape, fanout broadcast, and in-process event seams', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new MessagingAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: dir });
    const nodes = contribution.nodes || [];
    const edges = contribution.edges || [];
    const entryPoints = contribution.entry_points || [];

    // Fanout exchange -> broadcast seam (1->N), fanout: true on channel + edge.
    const fanoutExchange = nodes.find(n => n.type === 'exchange' && n.name === 'events.fanout' && (n.metadata as any)?.system === 'amqplib');
    assert.ok(fanoutExchange, 'expected a fanout exchange channel node');
    assert.equal((fanoutExchange!.metadata as any)?.routing?.type, 'fanout', 'exchange routing type should be fanout');
    assert.equal((fanoutExchange!.metadata as any)?.fanout, true, 'fanout exchange should be flagged as a broadcast');
    const fanoutEdge = edges.find(e => e.type === 'produces' && e.target === fanoutExchange!.id);
    assert.ok(fanoutEdge, 'expected a producer -> fanout exchange edge');
    assert.equal((fanoutEdge!.metadata as any)?.fanout, true, 'produce edge into a fanout exchange should carry fanout: true');

    // Topic exchange -> pattern routing with the binding key captured.
    const topicExchange = nodes.find(n => n.type === 'exchange' && n.name === 'logs.topic');
    assert.ok(topicExchange, 'expected a topic exchange channel node');
    assert.equal((topicExchange!.metadata as any)?.routing?.type, 'topic', 'exchange routing type should be topic');
    assert.equal((topicExchange!.metadata as any)?.fanout, false, 'a topic exchange is not a blind broadcast');
    assert.ok(((topicExchange!.metadata as any)?.routing?.keys || []).includes('order.*'), 'expected the bindQueue routing key on the exchange');

    // EventEmitter emit/on pair -> a shared event channel with produce + consume edges.
    const eventChannel = nodes.find(n => n.type === 'event' && n.name === 'order.placed' && (n.metadata as any)?.system === 'event-emitter');
    assert.ok(eventChannel, 'expected an in-process event channel node');
    assert.equal((eventChannel!.metadata as any)?.fanout, true, 'event listeners all receive the emit -> broadcast');
    assert.ok(edges.find(e => e.type === 'produces' && e.target === eventChannel!.id), 'expected emit -> event channel edge');
    assert.ok(edges.find(e => e.type === 'consumes' && e.source === eventChannel!.id), 'expected event channel -> listener edge');
    const listener = nodes.find(n => n.type === 'listener' && (n.metadata as any)?.channel === 'order.placed');
    assert.ok(listener, 'expected a listener node for the on() handler');
    assert.ok(entryPoints.find(ep => (ep.metadata as any)?.system === 'event-emitter' && (ep.metadata as any)?.channel === 'order.placed'), 'expected an event-listener entry point');

    // Kafka consumer group -> competing consumers (1->1), fanout: false.
    const kafkaConsumerEntry = entryPoints.find(ep => (ep.metadata as any)?.system === 'kafkajs' && (ep.metadata as any)?.group === 'billing');
    assert.ok(kafkaConsumerEntry, 'expected the Kafka consumer group (billing) captured on the consumer');
    assert.equal((kafkaConsumerEntry!.metadata as any)?.fanout, false, 'a Kafka consumer-group consumer is not a broadcast');

    assert.ok((contribution.analyzer_metadata as any).capabilities.includes('fanout-broadcast-seam-detection'));
  } finally {
    await fs.remove(dir);
  }
});

test('MessagingAnalyzer gates bare publish calls on import evidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'messaging-analyzer-negative-'));
  try {
    await fs.writeFile(
      path.join(dir, 'plain.ts'),
      [
        'function publish(channel: string, value: string) {}',
        `publish('not-a-broker', 'payload');`,
        '',
      ].join('\n')
    );

    const analyzer = new MessagingAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: dir });
    assert.equal((contribution.nodes || []).length, 0, 'expected no broker facts without import evidence');
    assert.equal((contribution.exit_points || []).length, 0, 'expected no message exits without import evidence');
    assert.equal((contribution.entry_points || []).length, 0, 'expected no message entries without import evidence');
  } finally {
    await fs.remove(dir);
  }
});

test('MessagingAnalyzer detects NestJS microservice patterns and amqp-connection-manager', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'messaging-analyzer-nest-'));
  try {
    await fs.writeJson(path.join(dir, 'package.json'), {
      name: 'nest-messaging-fixture',
      dependencies: {
        '@nestjs/microservices': '^10.0.0',
        'amqp-connection-manager': '^4.1.0',
      },
    });

    // NestJS microservice consumers + a ClientProxy producer.
    await fs.writeFile(
      path.join(dir, 'orders.controller.ts'),
      [
        `import { MessagePattern, EventPattern, ClientProxy } from '@nestjs/microservices';`,
        '',
        'export class OrdersController {',
        '  constructor(private readonly client: ClientProxy) {}',
        '',
        `  @MessagePattern({ cmd: 'get_order' })`,
        '  async getOrder(id: string) { return id; }',
        '',
        `  @EventPattern('order.created')`,
        '  async onOrderCreated(payload: OrderCreated) {}',
        '',
        '  async place(dto: PlaceDto) {',
        `    this.client.emit('order.created', dto);`,
        `    return this.client.send({ cmd: 'get_order' }, dto.id);`,
        '  }',
        '}',
        '',
      ].join('\n')
    );

    // amqp-connection-manager wraps amqplib; same channel API inside setup().
    await fs.writeFile(
      path.join(dir, 'rabbit.ts'),
      [
        `import amqp from 'amqp-connection-manager';`,
        '',
        'export function setup() {',
        `  const conn = amqp.connect(['amqp://localhost']);`,
        '  return conn.createChannel({',
        '    setup: (ch: any) => {',
        `      ch.assertExchange('events.fanout', 'fanout', { durable: true });`,
        `      ch.sendToQueue('work.queue', Buffer.from('{}'));`,
        `      ch.consume('work.queue', (msg: any) => {});`,
        '    },',
        '  });',
        '}',
        '',
      ].join('\n')
    );

    const analyzer = new MessagingAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'canAnalyze should be true for Nest/amqp-connection-manager');

    const contribution = await analyzer.analyze({ projectPath: dir });
    const nodes = contribution.nodes || [];
    const entryPoints = contribution.entry_points || [];
    const exitPoints = contribution.exit_points || [];

    // @MessagePattern -> consumer entry point keyed on the pattern token.
    assert.ok(
      entryPoints.find(e => (e.metadata as any)?.system === 'nestjs-microservice' && (e.metadata as any)?.channel === 'cmd=get_order'),
      'expected @MessagePattern consumer entry point'
    );
    // @EventPattern -> broadcast consumer entry point.
    const eventConsumer = entryPoints.find(e => (e.metadata as any)?.system === 'nestjs-microservice' && (e.metadata as any)?.channel === 'order.created' && (e.metadata as any)?.channelKind === 'event');
    assert.ok(eventConsumer, 'expected @EventPattern consumer entry point');
    assert.equal((eventConsumer!.metadata as any)?.fanout, true, '@EventPattern should be a broadcast seam');

    // ClientProxy .emit / .send -> producer exit points.
    assert.ok(
      exitPoints.find(x => (x.metadata as any)?.system === 'nestjs-microservice' && (x.metadata as any)?.channel === 'order.created'),
      'expected client.emit producer exit point'
    );
    assert.ok(
      exitPoints.find(x => (x.metadata as any)?.system === 'nestjs-microservice' && (x.metadata as any)?.channel === 'cmd=get_order'),
      'expected client.send producer exit point'
    );

    // amqp-connection-manager -> RabbitMQ facts under its own system label.
    assert.ok(
      nodes.find(n => n.type === 'exchange' && n.name === 'events.fanout' && (n.metadata as any)?.system === 'amqp-connection-manager'),
      'expected amqp-connection-manager fanout exchange node'
    );
    assert.ok(
      exitPoints.find(x => (x.metadata as any)?.system === 'amqp-connection-manager' && (x.metadata as any)?.channel === 'work.queue'),
      'expected amqp-connection-manager sendToQueue producer'
    );
    assert.ok(
      entryPoints.find(e => (e.metadata as any)?.system === 'amqp-connection-manager' && (e.metadata as any)?.channel === 'work.queue'),
      'expected amqp-connection-manager consume entry point'
    );
  } finally {
    await fs.remove(dir);
  }
});

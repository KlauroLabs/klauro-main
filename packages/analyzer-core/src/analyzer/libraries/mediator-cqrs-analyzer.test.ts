import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { MediatorCqrsAnalyzer } from './mediator-cqrs-analyzer';

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mediator-cqrs-analyzer-'));

  await fs.writeFile(
    path.join(dir, 'Fixture.csproj'),
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <ItemGroup>',
      '    <PackageReference Include="MediatR" Version="12.0.0" />',
      '    <PackageReference Include="MassTransit" Version="8.0.0" />',
      '  </ItemGroup>',
      '</Project>',
      '',
    ].join('\n')
  );

  // MediatR: command handler + notification handler
  await fs.writeFile(
    path.join(dir, 'Handlers.cs'),
    [
      'using MediatR;',
      '',
      'public class CreateOrderHandler : IRequestHandler<CreateOrderCommand, Result>',
      '{',
      '    public async Task<Result> Handle(CreateOrderCommand request, CancellationToken cancellationToken)',
      '    {',
      '        return await Task.FromResult(new Result());',
      '    }',
      '}',
      '',
      'public class OrderCreatedHandler : INotificationHandler<OrderCreatedEvent>',
      '{',
      '    public async Task Handle(OrderCreatedEvent notification, CancellationToken cancellationToken)',
      '    {',
      '        await Task.CompletedTask;',
      '    }',
      '}',
      '',
      'public class ShipmentConsumer : IConsumer<ShipOrderMessage>',
      '{',
      '    public async Task Consume(ConsumeContext<ShipOrderMessage> context)',
      '    {',
      '        await Task.CompletedTask;',
      '    }',
      '}',
      '',
    ].join('\n')
  );

  // MediatR dispatch call sites
  await fs.writeFile(
    path.join(dir, 'OrderController.cs'),
    [
      'using MediatR;',
      '',
      'public class OrderController',
      '{',
      '    private readonly IMediator _mediator;',
      '',
      '    public async Task<Result> Create()',
      '    {',
      '        var result = await _mediator.Send(new CreateOrderCommand());',
      '        await _mediator.Publish(new OrderCreatedEvent());',
      '        return result;',
      '    }',
      '}',
      '',
    ].join('\n')
  );

  // NestJS CQRS: handler + dispatch
  await fs.writeFile(
    path.join(dir, 'nest-cqrs.ts'),
    [
      `import { CommandHandler, EventsHandler } from '@nestjs/cqrs';`,
      '',
      'class CreateOrderCommand {}',
      'class OrderCreatedEvent {}',
      '',
      '@CommandHandler(CreateOrderCommand)',
      'export class CreateOrderCommandHandler {',
      '  async execute(command: CreateOrderCommand): Promise<void> {}',
      '}',
      '',
      '@EventsHandler(OrderCreatedEvent)',
      'export class OrderCreatedEventHandler {',
      '  handle(event: OrderCreatedEvent): void {}',
      '}',
      '',
      'export class OrderService {',
      '  constructor(private commandBus: any, private eventBus: any) {}',
      '  async createOrder() {',
      '    await this.commandBus.execute(new CreateOrderCommand());',
      '    this.eventBus.publish(new OrderCreatedEvent());',
      '  }',
      '}',
      '',
    ].join('\n')
  );

  // AWS SQS Lambda handlers (TS + Python)
  await fs.writeFile(
    path.join(dir, 'sqs-handler.ts'),
    [
      `import { SQSEvent } from 'aws-lambda';`,
      '',
      'export const handler = async (event: SQSEvent) => {',
      '  for (const record of event.Records) {',
      '    console.log(record.body);',
      '  }',
      '};',
      '',
    ].join('\n')
  );
  await fs.writeFile(
    path.join(dir, 'sqs_handler.py'),
    [
      'def process_orders_handler(event, context):',
      "    for record in event['Records']:",
      "        print(record['body'], record['eventSourceARN'])",
      '',
    ].join('\n')
  );

  return dir;
}

test('MediatorCqrsAnalyzer resolves MediatR command/notification handlers + dispatch edges', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new MediatorCqrsAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'canAnalyze should be true');

    const contribution = await analyzer.analyze({ projectPath: dir });
    const { nodes, edges, entry_points: entryPoints } = contribution;

    const commandHandler = nodes.find(
      (n) => n.type === 'handler' && n.name === 'CreateOrderHandler' && (n.metadata as any)?.system === 'mediatr'
    );
    assert.ok(commandHandler, 'expected a MediatR command handler node for CreateOrderHandler');
    assert.equal((commandHandler!.metadata as any)?.kind, 'command');

    const notificationHandler = nodes.find(
      (n) => n.type === 'handler' && n.name === 'OrderCreatedHandler' && (n.metadata as any)?.system === 'mediatr'
    );
    assert.ok(notificationHandler, 'expected a MediatR notification handler node for OrderCreatedHandler');
    assert.equal((notificationHandler!.metadata as any)?.kind, 'event');

    // Entry points: each handler is a message flow root
    const commandEntry = entryPoints?.find((ep) => ep.name === 'CreateOrderHandler' && ep.type === 'message');
    assert.ok(commandEntry, 'expected CreateOrderHandler to be surfaced as a message entry point');

    // Dispatch -> handler edges (command)
    const dispatchEdge = edges.find(
      (e) => e.type === 'dispatches' && e.target === commandHandler!.id && (e.metadata as any)?.messageType === 'CreateOrderCommand'
    );
    assert.ok(dispatchEdge, 'expected a dispatches edge from _mediator.Send(new CreateOrderCommand()) to the handler');

    // Publish -> handler edges (notification)
    const publishEdge = edges.find(
      (e) => e.type === 'publishes' && e.target === notificationHandler!.id && (e.metadata as any)?.messageType === 'OrderCreatedEvent'
    );
    assert.ok(publishEdge, 'expected a publishes edge from _mediator.Publish(new OrderCreatedEvent()) to the handler');
  } finally {
    await fs.remove(dir);
  }
});

test('MediatorCqrsAnalyzer resolves MassTransit consumers', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new MediatorCqrsAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: dir });
    const consumerNode = contribution.nodes.find(
      (n) => n.type === 'consumer' && n.name === 'ShipmentConsumer' && (n.metadata as any)?.system === 'masstransit'
    );
    assert.ok(consumerNode, 'expected a MassTransit consumer node for ShipmentConsumer');
    const consumerEntry = contribution.entry_points?.find((ep) => ep.name === 'ShipmentConsumer');
    assert.ok(consumerEntry, 'expected ShipmentConsumer to be surfaced as a message entry point');
  } finally {
    await fs.remove(dir);
  }
});

test('MediatorCqrsAnalyzer resolves NestJS CQRS handlers + dispatch edges', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new MediatorCqrsAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: dir });
    const { nodes, edges } = contribution;

    const cmdHandler = nodes.find(
      (n) => n.type === 'handler' && n.name === 'CreateOrderCommandHandler' && (n.metadata as any)?.system === 'nestjs-cqrs'
    );
    assert.ok(cmdHandler, 'expected NestJS CQRS command handler node');
    assert.equal((cmdHandler!.metadata as any)?.kind, 'command');

    const evtHandler = nodes.find(
      (n) => n.type === 'handler' && n.name === 'OrderCreatedEventHandler' && (n.metadata as any)?.system === 'nestjs-cqrs'
    );
    assert.ok(evtHandler, 'expected NestJS CQRS event handler node');
    assert.equal((evtHandler!.metadata as any)?.kind, 'event');

    const dispatchEdge = edges.find((e) => e.type === 'dispatches' && e.target === cmdHandler!.id);
    assert.ok(dispatchEdge, 'expected commandBus.execute(new CreateOrderCommand()) to resolve to the handler');

    const publishEdge = edges.find((e) => e.type === 'publishes' && e.target === evtHandler!.id);
    assert.ok(publishEdge, 'expected eventBus.publish(new OrderCreatedEvent()) to resolve to the handler');
  } finally {
    await fs.remove(dir);
  }
});

test('MediatorCqrsAnalyzer surfaces AWS SQS Lambda handlers (TS + Python) as message entry points', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new MediatorCqrsAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: dir });
    const { nodes, entry_points: entryPoints } = contribution;

    const tsHandler = nodes.find(
      (n) => n.type === 'handler' && n.name === 'handler' && (n.metadata as any)?.system === 'aws-sqs'
    );
    assert.ok(tsHandler, 'expected a TS SQS Lambda handler node');

    const pyHandler = nodes.find(
      (n) => n.type === 'handler' && n.name === 'process_orders_handler' && (n.metadata as any)?.system === 'aws-sqs'
    );
    assert.ok(pyHandler, 'expected a Python SQS Lambda handler node');

    assert.ok(
      entryPoints?.some((ep) => ep.name === 'process_orders_handler' && ep.type === 'message'),
      'expected process_orders_handler to be a message entry point'
    );
  } finally {
    await fs.remove(dir);
  }
});

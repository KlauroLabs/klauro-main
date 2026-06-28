import express from 'express';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { Queue, Worker } from 'bullmq';
import { Kafka } from 'kafkajs';
import Redis from 'ioredis';
import { trace } from '@opentelemetry/api';
import OpenAI from 'openai';
import { DataSource, Entity, PrimaryGeneratedColumn, Column } from 'typeorm';
import { PrismaClient } from '@prisma/client';
import { Container, injectable } from 'inversify';
import { CommandBus, CommandHandler, EventBus } from '@nestjs/cqrs';
import { createMachine, interpret } from 'xstate';
import { proxyActivities } from '@temporalio/workflow';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ActorSystem } from 'akkajs';

@Entity()
export class Invoice {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  status!: string;
}

const app = express();
const prisma = new PrismaClient();
const stripe = new Stripe('sk_test_fixture');
const invoiceQueue = new Queue('invoice-settlement');
const kafka = new Kafka({ clientId: 'billing', brokers: ['localhost:9092'] });
const redis = new Redis();
const tracer = trace.getTracer('billing');
const openai = new OpenAI();
const container = new Container();
const commandBus = new CommandBus({} as any);
const eventBus = new EventBus({} as any);
const s3 = new S3Client({ region: 'us-east-1', maxAttempts: 3 });
const actorSystem = new ActorSystem('billing');
const settlementActor = actorSystem.actorOf('settlement-worker' as any);

const settlementMachine = createMachine({
  id: 'invoiceSettlement',
  initial: 'queued',
  states: {
    queued: { on: { SETTLE: 'settling' } },
    settling: { on: { PAID: 'paid', FAILED: 'failed' } },
    paid: {},
    failed: {},
  },
});

const settlementService = interpret(settlementMachine).start();
const activities = proxyActivities<{ writeLedgerEntry(input: { invoiceId: string }): Promise<void> }>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

class SettleInvoiceCommand {
  constructor(readonly invoiceId: string) {}
}

@injectable()
class InvoiceSettlementService {
  async settle(invoiceId: string) {
    await commandBus.execute(new SettleInvoiceCommand(invoiceId));
    eventBus.publish({ type: 'InvoiceSettlementRequested', invoiceId });
  }
}

@CommandHandler(SettleInvoiceCommand)
class SettleInvoiceHandler {
  async execute(command: SettleInvoiceCommand) {
    settlementService.send({ type: 'SETTLE' });
    await activities.writeLedgerEntry({ invoiceId: command.invoiceId });
  }
}

container.bind(InvoiceSettlementService).toSelf().inSingletonScope();

export const dataSource = new DataSource({
  type: 'postgres',
  entities: [Invoice],
} as any);

app.post('/webhooks/stripe', async (req, res) => {
  const event = stripe.webhooks.constructEvent('{}', 'sig', 'secret');
  const workflowId = `invoice-settlement-${event.id}`;
  await invoiceQueue.add('settle-invoice', { invoiceId: 'inv_1' }, {
    attempts: 3,
    backoff: { type: 'exponential' },
  });
  await kafka.producer().send({
    topic: 'billing.events',
    messages: [{ value: JSON.stringify(event) }],
  });
  await redis.set(`invoice:${event.id}`, 'processed', 'EX', 300);
  await prisma.invoice.findMany();
  await tracer.startActiveSpan('stripe.webhook', async span => {
    span.end();
  });
  await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Summarize invoice settlement risk.' }],
    max_tokens: 100,
  });
  await s3.send(new PutObjectCommand({
    Bucket: 'billing-ledger',
    Key: `invoice-${event.id}.json`,
    Body: JSON.stringify(event),
  }));
  settlementActor.tell({ type: 'SettleInvoice', invoiceId: event.id });
  settlementService.send({ type: 'SETTLE', workflowId });
  await container.resolve(InvoiceSettlementService).settle(event.id);
  const claims = jwt.verify('token', 'secret');
  res.json({ ok: true, claims });
});

new Worker('invoice-settlement', async job => {
  await redis.del(`invoice:${job.data.invoiceId}`);
});

export { app };

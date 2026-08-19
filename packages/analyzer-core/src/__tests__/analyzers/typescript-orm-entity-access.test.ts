jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { CASContribution, CASEdge, CASNode } from '../../types/cas.types';
import { createPrismaModelIdentity } from '../../analyzer/libraries/orm/prisma-model-identity';

const ACCESS_EDGE_TYPES = new Set(['creates', 'updates', 'deletes', 'reads']);

describe('TypeScript ORM entity access edges', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-orm-access-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function analyzeProject(files: Record<string, string>): Promise<CASContribution> {
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(tempDir, relativePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content);
    }
    const analyzer = new TypeScriptJavaScriptAnalyzer();
    return analyzer.analyze({ projectPath: tempDir } as any);
  }

  function accessEdges(contribution: CASContribution): CASEdge[] {
    return (contribution.edges || []).filter(edge => ACCESS_EDGE_TYPES.has(edge.type));
  }

  function entityNode(contribution: CASContribution, name: string): CASNode | undefined {
    return (contribution.nodes || []).find(node => node.name === name && node.type === 'entity');
  }

  function edgesTo(contribution: CASContribution, entityName: string): CASEdge[] {
    const entity = entityNode(contribution, entityName);
    if (!entity) return [];
    return accessEdges(contribution).filter(edge => edge.target === entity.id);
  }

  describe('MikroORM', () => {
    const platformConnectionEntity = [
      "import { Entity, PrimaryKey, Property } from '@mikro-orm/core';",
      '',
      '@Entity()',
      'export class PlatformConnection {',
      '  @PrimaryKey()',
      '  id!: string;',
      '',
      '  @Property()',
      '  accessToken!: string;',
      '}',
    ].join('\n');

    it('maps injected repository calls to the entity from the generic type, not the property name', async () => {
      const contribution = await analyzeProject({
        'src/entities/platform-connection.entity.ts': platformConnectionEntity,
        'src/services/connection.service.ts': [
          "import { Injectable } from '@nestjs/common';",
          "import { InjectRepository } from '@mikro-orm/nestjs';",
          "import { EntityRepository } from '@mikro-orm/postgresql';",
          "import { PlatformConnection } from '../entities/platform-connection.entity';",
          '',
          '@Injectable()',
          'export class ConnectionService {',
          '  constructor(',
          '    @InjectRepository(PlatformConnection)',
          '    private readonly connectionRepository: EntityRepository<PlatformConnection>,',
          '  ) {}',
          '',
          '  async listConnections() {',
          '    return this.connectionRepository.find({ active: true });',
          '  }',
          '',
          '  async storeConnection(connection: PlatformConnection) {',
          '    await this.connectionRepository.persistAndFlush(connection);',
          '  }',
          '',
          '  async refreshToken(id: string, token: string) {',
          '    await this.connectionRepository.nativeUpdate({ id }, { accessToken: token });',
          '  }',
          '',
          '  async dropConnection(connection: PlatformConnection) {',
          '    await this.connectionRepository.removeAndFlush(connection);',
          '  }',
          '}',
        ].join('\n'),
      });

      const types = edgesTo(contribution, 'PlatformConnection').map(edge => edge.type).sort();
      expect(types).toEqual(['creates', 'deletes', 'reads', 'updates']);
      const readEdge = edgesTo(contribution, 'PlatformConnection').find(edge => edge.type === 'reads')!;
      expect(readEdge.metadata?.attributes?.reason).toBe('code_level_model_access');
      expect(readEdge.source).toContain('listConnections');
    });

    it('maps EntityManager calls with the entity as first argument', async () => {
      const contribution = await analyzeProject({
        'src/entities/platform-connection.entity.ts': platformConnectionEntity,
        'src/services/admin.service.ts': [
          "import { Injectable } from '@nestjs/common';",
          "import { EntityManager } from '@mikro-orm/postgresql';",
          "import { PlatformConnection } from '../entities/platform-connection.entity';",
          '',
          '@Injectable()',
          'export class AdminService {',
          '  constructor(private readonly em: EntityManager) {}',
          '',
          '  async findConnection(id: string) {',
          '    return this.em.findOneOrFail(PlatformConnection, { id });',
          '  }',
          '',
          '  async registerConnection(data: object) {',
          '    const connection = this.em.create(PlatformConnection, data);',
          '    return connection;',
          '  }',
          '',
          '  async purgeConnection(id: string) {',
          '    await this.em.nativeDelete(PlatformConnection, { id });',
          '  }',
          '}',
        ].join('\n'),
      });

      const types = edgesTo(contribution, 'PlatformConnection').map(edge => edge.type).sort();
      expect(types).toEqual(['creates', 'deletes', 'reads']);
    });

    it('maps query builder mutations to the entity passed to createQueryBuilder', async () => {
      const contribution = await analyzeProject({
        'src/entities/job-queue.entity.ts': [
          "import { Entity, PrimaryKey, Property } from '@mikro-orm/core';",
          '',
          '@Entity()',
          'export class JobQueue {',
          '  @PrimaryKey()',
          '  id!: string;',
          '',
          '  @Property()',
          '  status!: string;',
          '}',
        ].join('\n'),
        'src/services/job.service.ts': [
          "import { Injectable } from '@nestjs/common';",
          "import { EntityManager } from '@mikro-orm/postgresql';",
          "import { JobQueue } from '../entities/job-queue.entity';",
          '',
          '@Injectable()',
          'export class JobService {',
          '  constructor(private readonly em: EntityManager) {}',
          '',
          '  async markStale() {',
          "    await this.em.createQueryBuilder(JobQueue, 'j').update({ status: 'stale' });",
          '  }',
          '}',
        ].join('\n'),
      });

      const types = edgesTo(contribution, 'JobQueue').map(edge => edge.type);
      expect(types).toContain('updates');
    });

    it('marks constructed entities as created when the function persists', async () => {
      const contribution = await analyzeProject({
        'src/entities/cancellation-feedback.entity.ts': [
          "import { Entity, PrimaryKey, Property } from '@mikro-orm/core';",
          '',
          '@Entity()',
          'export class CancellationFeedback {',
          '  @PrimaryKey()',
          '  id!: string;',
          '',
          '  constructor(public reason: string) {}',
          '}',
        ].join('\n'),
        'src/controllers/subscription.controller.ts': [
          "import { Controller, Post, Body } from '@nestjs/common';",
          "import { EntityManager } from '@mikro-orm/postgresql';",
          "import { CancellationFeedback } from '../entities/cancellation-feedback.entity';",
          '',
          "@Controller('subscription')",
          'export class SubscriptionController {',
          '  constructor(private readonly em: EntityManager) {}',
          '',
          "  @Post('cancel')",
          '  async cancelSubscription(@Body() body: { reason: string }) {',
          '    const feedback = new CancellationFeedback(body.reason);',
          '    await this.em.persistAndFlush(feedback);',
          '    return { ok: true };',
          '  }',
          '}',
        ].join('\n'),
      });

      const types = edgesTo(contribution, 'CancellationFeedback').map(edge => edge.type);
      expect(types).toContain('creates');
    });
  });

  describe('TypeORM', () => {
    it('maps injected Repository<T> calls to access edges', async () => {
      const contribution = await analyzeProject({
        'src/entities/order.entity.ts': [
          "import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';",
          '',
          '@Entity()',
          'export class Order {',
          '  @PrimaryGeneratedColumn()',
          '  id!: number;',
          '',
          '  @Column()',
          '  total!: number;',
          '}',
        ].join('\n'),
        'src/services/order.service.ts': [
          "import { Injectable } from '@nestjs/common';",
          "import { InjectRepository } from '@nestjs/typeorm';",
          "import { Repository } from 'typeorm';",
          "import { Order } from '../entities/order.entity';",
          '',
          '@Injectable()',
          'export class OrderService {',
          '  constructor(',
          '    @InjectRepository(Order)',
          '    private readonly orderRepository: Repository<Order>,',
          '  ) {}',
          '',
          '  async listOrders() {',
          '    return this.orderRepository.find();',
          '  }',
          '',
          '  async placeOrder(order: Order) {',
          '    return this.orderRepository.save(order);',
          '  }',
          '',
          '  async cancelOrder(id: number) {',
          '    await this.orderRepository.softDelete(id);',
          '  }',
          '}',
        ].join('\n'),
      });

      const types = edgesTo(contribution, 'Order').map(edge => edge.type).sort();
      expect(types).toEqual(['creates', 'deletes', 'reads']);
    });
  });

  describe('Mongoose', () => {
    it('maps injected Model<T> calls to access edges', async () => {
      const contribution = await analyzeProject({
        'src/schemas/payment.schema.ts': [
          "import { Schema, Prop, SchemaFactory } from '@nestjs/mongoose';",
          '',
          '@Schema()',
          'export class Payment {',
          '  @Prop()',
          '  amount!: number;',
          '}',
          '',
          'export const PaymentSchema = SchemaFactory.createForClass(Payment);',
        ].join('\n'),
        'src/services/payment.service.ts': [
          "import { Injectable } from '@nestjs/common';",
          "import { InjectModel } from '@nestjs/mongoose';",
          "import { Model } from 'mongoose';",
          "import { Payment } from '../schemas/payment.schema';",
          '',
          '@Injectable()',
          'export class PaymentService {',
          '  constructor(',
          '    @InjectModel(Payment.name)',
          '    private readonly paymentModel: Model<Payment>,',
          '  ) {}',
          '',
          '  async recordPayment(data: object) {',
          '    return this.paymentModel.create(data);',
          '  }',
          '',
          '  async getPayment(id: string) {',
          '    return this.paymentModel.findOne({ _id: id });',
          '  }',
          '',
          '  async adjustPayment(id: string, amount: number) {',
          '    await this.paymentModel.updateOne({ _id: id }, { amount });',
          '  }',
          '',
          '  async wipePayments() {',
          '    await this.paymentModel.deleteMany({});',
          '  }',
          '}',
        ].join('\n'),
      });

      const types = edgesTo(contribution, 'Payment').map(edge => edge.type).sort();
      expect(types).toEqual(['creates', 'deletes', 'reads', 'updates']);
    });
  });

  describe('Prisma', () => {
    it('maps prisma client model calls to schema-derived entity ids', async () => {
      const contribution = await analyzeProject({
        'prisma/schema.prisma': [
          'datasource db {',
          '  provider = "postgresql"',
          '  url      = env("DATABASE_URL")',
          '}',
          '',
          'model Order {',
          '  id    Int    @id @default(autoincrement())',
          '  total Int',
          '}',
        ].join('\n'),
        'src/services/order.service.ts': [
          "import { Injectable } from '@nestjs/common';",
          "import { PrismaClient } from '@prisma/client';",
          '',
          '@Injectable()',
          'export class OrderService {',
          '  private readonly prisma = new PrismaClient();',
          '',
          '  async listOrders() {',
          '    return this.prisma.order.findMany();',
          '  }',
          '',
          '  async placeOrder(total: number) {',
          '    return this.prisma.order.create({ data: { total } });',
          '  }',
          '',
          '  async cancelOrders() {',
          '    await this.prisma.order.deleteMany({});',
          '  }',
          '}',
        ].join('\n'),
      });

      const entityId = createPrismaModelIdentity('prisma/schema.prisma', 'Order').nodeId;
      const prismaEdges = accessEdges(contribution).filter(edge => edge.target === entityId);
      const types = prismaEdges.map(edge => edge.type).sort();
      expect(types).toEqual(['creates', 'deletes', 'reads']);
      expect((contribution.nodes || []).some(node => node.id === entityId)).toBe(true);
    });

    it('keeps same-named models and access edges scoped to their nearest schema', async () => {
      const contribution = await analyzeProject({
        'apps/billing/prisma/schema.prisma': 'model Record {\n  id Int @id\n  amount Int\n}\n',
        'apps/billing/src/read.ts': 'const prisma = new PrismaClient();\nexport async function read() { return prisma.record.findMany(); }\n',
        'apps/audit/prisma/schema.prisma': 'model Record {\n  id Int @id\n  event String\n}\n',
        'apps/audit/src/write.ts': 'const prisma = new PrismaClient();\nexport async function write() { return prisma.record.create({ data: { event: "created" } }); }\n',
      });

      const billingId = createPrismaModelIdentity('apps/billing/prisma/schema.prisma', 'Record').nodeId;
      const auditId = createPrismaModelIdentity('apps/audit/prisma/schema.prisma', 'Record').nodeId;
      const edges = accessEdges(contribution);

      expect(billingId).not.toBe(auditId);
      expect(edges.some(edge => edge.type === 'reads' && edge.target === billingId)).toBe(true);
      expect(edges.some(edge => edge.type === 'creates' && edge.target === auditId)).toBe(true);
      expect(edges.every(edge => (contribution.nodes || []).some(node => node.id === edge.target))).toBe(true);
    });
  });

  describe('precision guards', () => {
    it('does not emit access edges for Object.assign or non-entity classes', async () => {
      const contribution = await analyzeProject({
        'src/services/mapper.service.ts': [
          "import { Injectable } from '@nestjs/common';",
          '',
          'export class TransferShape {',
          '  amount!: number;',
          '}',
          '',
          '@Injectable()',
          'export class MapperService {',
          '  merge(base: TransferShape, extra: object) {',
          '    return Object.assign(base, extra);',
          '  }',
          '',
          '  blank() {',
          '    return new TransferShape();',
          '  }',
          '}',
        ].join('\n'),
      });

      expect(accessEdges(contribution)).toHaveLength(0);
    });

    it('does not mark constructed non-persisted entities as created', async () => {
      const contribution = await analyzeProject({
        'src/entities/draft.entity.ts': [
          "import { Entity, PrimaryKey } from '@mikro-orm/core';",
          '',
          '@Entity()',
          'export class Draft {',
          '  @PrimaryKey()',
          '  id!: string;',
          '}',
        ].join('\n'),
        'src/services/draft.service.ts': [
          "import { Draft } from '../entities/draft.entity';",
          '',
          'export class DraftService {',
          '  preview() {',
          '    return new Draft();',
          '  }',
          '}',
        ].join('\n'),
      });

      expect(edgesTo(contribution, 'Draft')).toHaveLength(0);
    });
  });
});

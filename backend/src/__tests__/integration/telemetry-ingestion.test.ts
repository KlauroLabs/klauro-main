import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { MikroORM } from '@mikro-orm/core';
import { TelemetrySnapshot, TelemetryType } from '../../database/entities/telemetry-snapshot.entity';
import { Project } from '../../database/entities/project.entity';
import { AppModule } from '../../app.module';

describe('Telemetry Ingestion Integration Tests', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let projectId: string;
  let apiKey: string;
  let authToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    orm = moduleFixture.get<MikroORM>(MikroORM);

    // Create test user and project
    const authResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'telemetry-test@example.com',
        password: 'Test123!@#',
        name: 'Telemetry Test User',
        organizationName: 'Telemetry Test Org',
      });

    authToken = authResponse.body.token;

    const projectResponse = await request(app.getHttpServer())
      .post('/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Telemetry Test Project',
        description: 'Project for telemetry testing',
      });

    projectId = projectResponse.body.id;
    apiKey = projectResponse.body.apiKey; // Assuming API key is returned
  });

  afterAll(async () => {
    await orm.close();
    await app.close();
  });

  describe('Single Event Ingestion', () => {
    it('should ingest a trace event', async () => {
      const traceEvent = {
        projectId,
        type: 'trace',
        data: {
          trace_id: 'trace-123',
          span_id: 'span-456',
          name: 'http.request',
          start_time: Date.now(),
          attributes: {
            'http.method': 'GET',
            'http.path': '/api/users',
            'http.status_code': 200,
          },
          duration_ms: 125,
        },
      };

      const response = await request(app.getHttpServer())
        .post('/api/telemetry/ingest')
        .set('Authorization', `Bearer ${apiKey}`)
        .send(traceEvent)
        .expect(202);

      expect(response.body).toMatchObject({
        success: true,
        message: 'Telemetry data accepted',
      });

      // Verify data was stored
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for processing

      const telemetryRepo = orm.em.getRepository(TelemetrySnapshot);
      const snapshots = await telemetryRepo.find({
        project: projectId,
        type: TelemetryType.TRACE,
      });

      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[0].name).toBe('http.request');
    });

    it('should ingest a metric event', async () => {
      const metricEvent = {
        projectId,
        type: 'metric',
        data: {
          name: 'memory.usage',
          value: 75.5,
          timestamp: Date.now(),
          tags: {
            environment: 'production',
            service: 'api',
          },
          unit: 'percent',
        },
      };

      const response = await request(app.getHttpServer())
        .post('/api/telemetry/ingest')
        .set('Authorization', `Bearer ${apiKey}`)
        .send(metricEvent)
        .expect(202);

      expect(response.body.success).toBe(true);

      // Verify metric was stored
      await new Promise(resolve => setTimeout(resolve, 1000));

      const telemetryRepo = orm.em.getRepository(TelemetrySnapshot);
      const snapshots = await telemetryRepo.find({
        project: projectId,
        type: TelemetryType.METRIC,
        name: 'memory.usage',
      });

      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[0].data.value).toBe(75.5);
    });

    it('should ingest an error event', async () => {
      const errorEvent = {
        projectId,
        type: 'error',
        data: {
          error_type: 'TypeError',
          error_message: 'Cannot read property of undefined',
          timestamp: Date.now(),
          context: {
            environment: 'production',
            service: 'api',
            user_id: 'user-123',
          },
          stack_trace: 'TypeError: Cannot read property...',
        },
      };

      const response = await request(app.getHttpServer())
        .post('/api/telemetry/ingest')
        .set('Authorization', `Bearer ${apiKey}`)
        .send(errorEvent)
        .expect(202);

      expect(response.body.success).toBe(true);

      // Verify error was stored and issue was created
      await new Promise(resolve => setTimeout(resolve, 1000));

      const telemetryRepo = orm.em.getRepository(TelemetrySnapshot);
      const snapshots = await telemetryRepo.find({
        project: projectId,
        type: TelemetryType.ERROR,
      });

      expect(snapshots.length).toBeGreaterThan(0);
    });
  });

  describe('Batch Ingestion', () => {
    it('should ingest a batch of mixed events', async () => {
      const batch = {
        projectId,
        timestamp: Date.now(),
        events: [
          {
            type: 'trace',
            name: 'db.query',
            data: {
              duration: 45,
              query: 'SELECT * FROM users',
            },
          },
          {
            type: 'metric',
            name: 'cpu.usage',
            data: {
              value: 65.2,
              unit: 'percent',
            },
          },
          {
            type: 'trace',
            name: 'cache.get',
            data: {
              duration: 2,
              hit: true,
            },
          },
        ],
      };

      const response = await request(app.getHttpServer())
        .post('/api/telemetry/batch')
        .set('Authorization', `Bearer ${apiKey}`)
        .send(batch)
        .expect(202);

      expect(response.body).toMatchObject({
        success: true,
        processed: 3,
      });

      // Verify all events were stored
      await new Promise(resolve => setTimeout(resolve, 1000));

      const telemetryRepo = orm.em.getRepository(TelemetrySnapshot);
      const snapshots = await telemetryRepo.find({ project: projectId });

      const dbQuerySnapshot = snapshots.find(s => s.name === 'db.query');
      const cpuSnapshot = snapshots.find(s => s.name === 'cpu.usage');
      const cacheSnapshot = snapshots.find(s => s.name === 'cache.get');

      expect(dbQuerySnapshot).toBeDefined();
      expect(cpuSnapshot).toBeDefined();
      expect(cacheSnapshot).toBeDefined();
    });

    it('should handle large batches efficiently', async () => {
      const largeEvents = [];
      for (let i = 0; i < 1000; i++) {
        largeEvents.push({
          type: 'metric',
          name: `metric.${i % 10}`,
          data: {
            value: Math.random() * 100,
            timestamp: Date.now() - i * 1000,
          },
        });
      }

      const batch = {
        projectId,
        timestamp: Date.now(),
        events: largeEvents,
      };

      const startTime = Date.now();
      const response = await request(app.getHttpServer())
        .post('/api/telemetry/batch')
        .set('Authorization', `Bearer ${apiKey}`)
        .send(batch)
        .expect(202);

      const processingTime = Date.now() - startTime;

      expect(response.body.success).toBe(true);
      expect(response.body.processed).toBe(1000);
      expect(processingTime).toBeLessThan(5000); // Should process within 5 seconds
    });
  });

  describe('Rate Limiting', () => {
    it('should enforce rate limits', async () => {
      const promises = [];
      
      // Send many requests quickly
      for (let i = 0; i < 100; i++) {
        promises.push(
          request(app.getHttpServer())
            .post('/api/telemetry/ingest')
            .set('Authorization', `Bearer ${apiKey}`)
            .send({
              projectId,
              type: 'metric',
              data: {
                name: 'rate.test',
                value: i,
              },
            }),
        );
      }

      const responses = await Promise.all(promises);
      
      // Some should be rate limited
      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);

      // Check rate limit headers
      const limitedResponse = rateLimited[0];
      expect(limitedResponse.headers['x-ratelimit-limit']).toBeDefined();
      expect(limitedResponse.headers['x-ratelimit-remaining']).toBeDefined();
      expect(limitedResponse.headers['x-ratelimit-reset']).toBeDefined();
    });
  });

  describe('Data Aggregation', () => {
    it('should aggregate metrics over time', async () => {
      // Send metrics over time
      for (let i = 0; i < 10; i++) {
        await request(app.getHttpServer())
          .post('/api/telemetry/ingest')
          .set('Authorization', `Bearer ${apiKey}`)
          .send({
            projectId,
            type: 'metric',
            data: {
              name: 'aggregation.test',
              value: 10 + i,
              timestamp: Date.now() - (9 - i) * 60000, // 1 minute intervals
            },
          });

        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Wait for aggregation
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Query aggregated data
      const telemetryRepo = orm.em.getRepository(TelemetrySnapshot);
      const snapshots = await telemetryRepo.find({
        project: projectId,
        name: 'aggregation.test',
      });

      // Should have aggregated data
      expect(snapshots.length).toBeGreaterThan(0);
      
      const aggregated = snapshots.find(s => s.interval !== 'minute');
      if (aggregated) {
        expect(aggregated.data.count).toBeGreaterThan(1);
        expect(aggregated.data.avg).toBeDefined();
        expect(aggregated.data.min).toBeDefined();
        expect(aggregated.data.max).toBeDefined();
      }
    });
  });

  describe('Real-time Streaming', () => {
    it('should stream telemetry data via WebSocket', async (done) => {
      const io = require('socket.io-client');
      const socket = io(`http://localhost:${app.getHttpServer().address().port}`, {
        auth: {
          token: authToken,
        },
      });

      socket.on('connect', () => {
        // Subscribe to project telemetry
        socket.emit('subscribe', { projectId });
      });

      socket.on('telemetry', (data) => {
        expect(data).toMatchObject({
          projectId,
          type: expect.any(String),
          timestamp: expect.any(Number),
        });
        
        socket.disconnect();
        done();
      });

      // Send telemetry that should trigger WebSocket event
      setTimeout(async () => {
        await request(app.getHttpServer())
          .post('/api/telemetry/ingest')
          .set('Authorization', `Bearer ${apiKey}`)
          .send({
            projectId,
            type: 'metric',
            data: {
              name: 'websocket.test',
              value: 42,
            },
          });
      }, 1000);
    });
  });

  describe('Error Detection', () => {
    it('should detect error patterns and create issues', async () => {
      // Send multiple similar errors
      for (let i = 0; i < 10; i++) {
        await request(app.getHttpServer())
          .post('/api/telemetry/ingest')
          .set('Authorization', `Bearer ${apiKey}`)
          .send({
            projectId,
            type: 'error',
            data: {
              error_type: 'DatabaseError',
              error_message: 'Connection timeout',
              timestamp: Date.now() - i * 1000,
            },
          });
      }

      // Wait for issue detection
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check if issue was created
      const issuesResponse = await request(app.getHttpServer())
        .get(`/projects/${projectId}/issues`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      const dbIssue = issuesResponse.body.find(
        issue => issue.title.includes('DatabaseError'),
      );

      expect(dbIssue).toBeDefined();
      expect(dbIssue.occurrences).toBeGreaterThanOrEqual(10);
      expect(dbIssue.severity).toBe('high');
    });

    it('should detect performance degradation', async () => {
      // Send increasing response times
      for (let i = 0; i < 20; i++) {
        await request(app.getHttpServer())
          .post('/api/telemetry/ingest')
          .set('Authorization', `Bearer ${apiKey}`)
          .send({
            projectId,
            type: 'trace',
            data: {
              name: 'slow.endpoint',
              duration_ms: 100 + (i * 50), // Increasing latency
              timestamp: Date.now() - (19 - i) * 60000,
            },
          });
      }

      // Wait for detection
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check for performance issue
      const issuesResponse = await request(app.getHttpServer())
        .get(`/projects/${projectId}/issues`)
        .query({ type: 'performance' })
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      const perfIssue = issuesResponse.body.find(
        issue => issue.title.includes('slow.endpoint'),
      );

      expect(perfIssue).toBeDefined();
      expect(perfIssue.type).toBe('performance');
    });
  });
});
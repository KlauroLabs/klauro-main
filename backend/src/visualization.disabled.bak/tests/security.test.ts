import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import { createVisualizationRouter } from '../../routes/visualization';
import { WebSocketManager } from '../websocket-manager';
import { ValidationService } from '../security/validation-service';
import { AuthService } from '../../auth/auth-service';
import { authConfig } from '../../config/auth.config';

describe('Visualization Security Tests', () => {
  let app: express.Application;
  let pool: Pool;
  let validToken: string;
  let invalidToken: string;
  let wsManager: WebSocketManager;

  beforeAll(async () => {
    // Setup test database connection
    pool = new Pool({
      host: process.env.TEST_DB_HOST || 'localhost',
      port: parseInt(process.env.TEST_DB_PORT || '5432'),
      database: process.env.TEST_DB_NAME || 'unravl_test',
      user: process.env.TEST_DB_USER || 'test',
      password: process.env.TEST_DB_PASSWORD || 'test',
    });

    // Setup Express app
    app = express();
    app.use(express.json());
    app.use('/api/visualization', createVisualizationRouter(pool));

    // Create valid JWT token for testing
    const payload = {
      sub: 'test-user-id',
      email: 'test@example.com',
      organizations: [{ id: 'test-org-id', role: 'admin' }],
      type: 'access',
    };
    validToken = jwt.sign(payload, authConfig.jwt.accessSecret, {
      expiresIn: '15m',
      issuer: authConfig.jwt.issuer,
      audience: authConfig.jwt.audience,
    });

    // Create invalid token
    invalidToken = 'invalid.jwt.token';

    // Initialize WebSocket manager
    wsManager = new WebSocketManager(pool);
  });

  afterAll(async () => {
    wsManager.dispose();
    await pool.end();
  });

  describe('Authentication Tests', () => {
    it('should reject requests without authentication token', async () => {
      const response = await request(app)
        .post('/api/visualization/render')
        .send({
          blueprint: { components: [], connections: [] },
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
    });

    it('should reject requests with invalid token', async () => {
      const response = await request(app)
        .post('/api/visualization/render')
        .set('Authorization', `Bearer ${invalidToken}`)
        .send({
          blueprint: { components: [], connections: [] },
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
    });

    it('should accept requests with valid token', async () => {
      const response = await request(app)
        .post('/api/visualization/render')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          blueprint: {
            components: [{ id: '1', name: 'Test', type: 'service' }],
            connections: [],
            orphanedComponents: [],
          },
        });

      expect(response.status).not.toBe(401);
    });
  });

  describe('Input Validation Tests', () => {
    it('should sanitize XSS attempts in blueprint data', async () => {
      const maliciousBlueprint = {
        components: [
          {
            id: '1',
            name: '<script>alert("XSS")</script>',
            type: 'service',
          },
        ],
        connections: [],
        orphanedComponents: [],
      };

      const response = await request(app)
        .post('/api/visualization/render')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ blueprint: maliciousBlueprint });

      expect(response.status).toBe(200);
      // Verify the script tag was sanitized
      expect(response.body.data).not.toContain('<script>');
    });

    it('should validate file upload content type', async () => {
      const response = await request(app)
        .post('/api/visualization/upload')
        .set('Authorization', `Bearer ${validToken}`)
        .attach('blueprint', Buffer.from('test'), {
          filename: 'test.exe',
          contentType: 'application/x-msdownload',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid file type');
    });

    it('should reject oversized JSON payloads', async () => {
      const largeBlueprint = {
        components: Array(100000).fill({
          id: 'test',
          name: 'Component',
          type: 'service',
        }),
        connections: [],
      };

      const response = await request(app)
        .post('/api/visualization/render')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ blueprint: largeBlueprint });

      expect(response.status).toBe(413); // Payload too large
    });

    it('should validate export format parameter', async () => {
      const response = await request(app)
        .post('/api/visualization/export/exe')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          data: { nodes: [], edges: [] },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation Error');
    });
  });

  describe('Rate Limiting Tests', () => {
    it('should enforce rate limits on render endpoint', async () => {
      const requests = [];
      
      // Send 25 requests (rate limit is 20 per minute)
      for (let i = 0; i < 25; i++) {
        requests.push(
          request(app)
            .post('/api/visualization/render')
            .set('Authorization', `Bearer ${validToken}`)
            .send({
              blueprint: {
                components: [],
                connections: [],
                orphanedComponents: [],
              },
            })
        );
      }

      const responses = await Promise.all(requests);
      const rateLimited = responses.filter(r => r.status === 429);
      
      expect(rateLimited.length).toBeGreaterThan(0);
      expect(rateLimited[0].body.error).toBe('Too Many Requests');
    });
  });

  describe('Authorization Tests', () => {
    it('should check project ownership before rendering', async () => {
      const blueprint = {
        projectId: 'unauthorized-project-id',
        components: [],
        connections: [],
        orphanedComponents: [],
      };

      const response = await request(app)
        .post('/api/visualization/render')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ blueprint });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Forbidden');
    });

    it('should require admin role for cache clearing', async () => {
      // Create token with member role
      const memberPayload = {
        sub: 'member-user-id',
        email: 'member@example.com',
        organizations: [{ id: 'test-org-id', role: 'member' }],
        type: 'access',
      };
      const memberToken = jwt.sign(memberPayload, authConfig.jwt.accessSecret, {
        expiresIn: '15m',
      });

      const response = await request(app)
        .post('/api/visualization/cache/clear')
        .set('Authorization', `Bearer ${memberToken}`);

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('requires at least admin role');
    });
  });

  describe('XSS Prevention Tests', () => {
    it('should sanitize SVG export content', async () => {
      const validationService = new ValidationService();
      
      const maliciousData = {
        nodes: [
          {
            id: '1',
            label: '<img src=x onerror=alert("XSS")>',
            x: 100,
            y: 100,
          },
        ],
        edges: [
          {
            source: '1',
            target: '2',
            label: '<script>alert("XSS")</script>',
          },
        ],
        layout: 'force',
      };

      const response = await request(app)
        .post('/api/visualization/export/svg')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ data: maliciousData });

      expect(response.status).toBe(200);
      
      const svgContent = response.body.toString();
      expect(svgContent).not.toContain('onerror');
      expect(svgContent).not.toContain('<script>');
      expect(svgContent).not.toContain('javascript:');
    });

    it('should escape special characters in text elements', () => {
      const validationService = new ValidationService();
      
      const input = '<>&"\'\\/';
      const escaped = validationService.escapeForSVG(input);
      
      expect(escaped).toBe('&lt;&gt;&amp;&quot;&apos;\\\\/');
      expect(escaped).not.toContain('<');
      expect(escaped).not.toContain('>');
    });
  });

  describe('WebSocket Security Tests', () => {
    it('should validate JWT tokens in WebSocket connections', (done) => {
      const io = require('socket.io-client');
      const socket = io('http://localhost:3000', {
        auth: {
          token: invalidToken,
        },
      });

      socket.on('connect_error', (error: Error) => {
        expect(error.message).toBe('Authentication failed');
        socket.close();
        done();
      });

      socket.on('connect', () => {
        // Should not connect with invalid token
        expect(true).toBe(false);
        socket.close();
        done();
      });
    });

    it('should verify channel access permissions', async () => {
      // Mock unauthorized project access
      const mockQuery = jest.spyOn(pool, 'query');
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: 0 }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const io = require('socket.io-client');
      const socket = io('http://localhost:3000', {
        auth: {
          token: validToken,
        },
      });

      socket.emit('subscribe', {
        type: 'subscribe',
        channel: 'telemetry:unauthorized-project',
      });

      socket.on('error', (error: any) => {
        expect(error.message).toContain('Access denied');
        socket.close();
      });

      mockQuery.mockRestore();
    });
  });

  describe('Memory Management Tests', () => {
    it('should clean up resources after export', async () => {
      const memBefore = process.memoryUsage().heapUsed;
      
      // Generate multiple exports
      for (let i = 0; i < 10; i++) {
        await request(app)
          .post('/api/visualization/export/png')
          .set('Authorization', `Bearer ${validToken}`)
          .send({
            data: {
              nodes: Array(100).fill({ id: 'node', x: 100, y: 100 }),
              edges: [],
              layout: 'force',
            },
            options: { width: 2000, height: 2000 },
          });
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const memAfter = process.memoryUsage().heapUsed;
      const memIncrease = memAfter - memBefore;
      
      // Memory increase should be reasonable (less than 100MB)
      expect(memIncrease).toBeLessThan(100 * 1024 * 1024);
    });

    it('should clean up WebSocket resources on disconnect', (done) => {
      const io = require('socket.io-client');
      const socket = io('http://localhost:3000', {
        auth: {
          token: validToken,
        },
      });

      socket.on('connect', () => {
        const clientId = socket.id;
        
        socket.disconnect();
        
        setTimeout(() => {
          // Verify client is removed from manager
          const clientInfo = wsManager.getClientInfo(clientId);
          expect(clientInfo).toBeUndefined();
          done();
        }, 100);
      });
    });
  });

  describe('Content Type Validation Tests', () => {
    it('should validate Content-Type header', async () => {
      const response = await request(app)
        .post('/api/visualization/render')
        .set('Authorization', `Bearer ${validToken}`)
        .set('Content-Type', 'text/plain')
        .send('invalid data');

      expect(response.status).toBe(400);
    });

    it('should reject malformed JSON', async () => {
      const response = await request(app)
        .post('/api/visualization/render')
        .set('Authorization', `Bearer ${validToken}`)
        .set('Content-Type', 'application/json')
        .send('{ invalid json }');

      expect(response.status).toBe(400);
    });
  });
});
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { MikroORM } from '@mikro-orm/core';
import { Project } from '../../database/entities/project.entity';
import { AnalysisRun } from '../../database/entities/analysis-run.entity';
import { AnalysisResult } from '../../database/entities/analysis-result.entity';
import { Component } from '../../database/entities/component.entity';
import { AppModule } from '../../app.module';

describe('Analysis Pipeline Integration Tests', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let projectId: string;
  let authToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    orm = moduleFixture.get<MikroORM>(MikroORM);

    // Create test user and get auth token
    const authResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'test@example.com',
        password: 'Test123!@#',
        name: 'Test User',
        organizationName: 'Test Org',
      });

    authToken = authResponse.body.token;

    // Create test project
    const projectResponse = await request(app.getHttpServer())
      .post('/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Test Project',
        description: 'Integration test project',
        repositoryUrl: 'https://github.com/test/repo',
        repositoryProvider: 'github',
        defaultBranch: 'main',
      });

    projectId = projectResponse.body.id;
  });

  afterAll(async () => {
    await orm.close();
    await app.close();
  });

  describe('Full Analysis Pipeline', () => {
    it('should complete a full analysis cycle', async () => {
      // 1. Trigger analysis
      const analysisResponse = await request(app.getHttpServer())
        .post(`/analyze/${projectId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          branch: 'main',
          commitSha: 'abc123',
        })
        .expect(202);

      const analysisRunId = analysisResponse.body.analysisRunId;
      expect(analysisRunId).toBeDefined();

      // 2. Wait for analysis to complete (polling)
      let analysisComplete = false;
      let attempts = 0;
      const maxAttempts = 30;

      while (!analysisComplete && attempts < maxAttempts) {
        const statusResponse = await request(app.getHttpServer())
          .get(`/analyze/status/${analysisRunId}`)
          .set('Authorization', `Bearer ${authToken}`);

        if (statusResponse.body.status === 'completed') {
          analysisComplete = true;
        } else if (statusResponse.body.status === 'failed') {
          throw new Error('Analysis failed');
        }

        if (!analysisComplete) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        attempts++;
      }

      expect(analysisComplete).toBe(true);

      // 3. Verify analysis results
      const resultsResponse = await request(app.getHttpServer())
        .get(`/analyze/results/${analysisRunId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(resultsResponse.body).toMatchObject({
        id: analysisRunId,
        status: 'completed',
        blueprint: expect.any(Object),
        components: expect.any(Array),
      });

      // 4. Verify components were created
      const componentsResponse = await request(app.getHttpServer())
        .get(`/projects/${projectId}/components`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(componentsResponse.body.length).toBeGreaterThan(0);

      // 5. Verify analysis result entity
      const analysisResultRepo = orm.em.getRepository(AnalysisResult);
      const analysisResults = await analysisResultRepo.find({
        analysisRun: analysisRunId,
      });

      expect(analysisResults.length).toBeGreaterThan(0);
      expect(analysisResults[0].data).toBeDefined();
    });

    it('should detect issues during analysis', async () => {
      // Create a project with known issues
      const projectWithIssuesResponse = await request(app.getHttpServer())
        .post('/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Project with Issues',
          description: 'Project containing known issues',
          repositoryUrl: 'https://github.com/test/issues-repo',
        });

      const projectWithIssuesId = projectWithIssuesResponse.body.id;

      // Trigger analysis
      const analysisResponse = await request(app.getHttpServer())
        .post(`/analyze/${projectWithIssuesId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          enableIssueDetection: true,
        })
        .expect(202);

      // Wait for completion
      // ... (similar polling logic)

      // Check for detected issues
      const issuesResponse = await request(app.getHttpServer())
        .get(`/projects/${projectWithIssuesId}/issues`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(issuesResponse.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: expect.any(String),
            severity: expect.any(String),
            title: expect.any(String),
          }),
        ]),
      );
    });

    it('should track analysis history', async () => {
      // Run multiple analyses
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post(`/analyze/${projectId}`)
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            branch: 'main',
            commitSha: `commit${i}`,
          })
          .expect(202);

        // Wait a bit between analyses
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Get project history
      const historyResponse = await request(app.getHttpServer())
        .get(`/projects/${projectId}/history`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(historyResponse.body.results).toHaveLength(3);
      expect(historyResponse.body.trends).toBeDefined();
      expect(historyResponse.body.trends.complexity).toBeInstanceOf(Array);
    });

    it('should compare analysis versions', async () => {
      // Get two analysis results
      const historyResponse = await request(app.getHttpServer())
        .get(`/projects/${projectId}/history`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      if (historyResponse.body.results.length >= 2) {
        const fromVersion = historyResponse.body.results[0].version;
        const toVersion = historyResponse.body.results[1].version;

        const comparisonResponse = await request(app.getHttpServer())
          .get(`/projects/${projectId}/compare`)
          .query({ from: fromVersion, to: toVersion })
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200);

        expect(comparisonResponse.body).toMatchObject({
          from: expect.any(Object),
          to: expect.any(Object),
          changes: {
            added: expect.any(Array),
            removed: expect.any(Array),
            modified: expect.any(Array),
          },
          metrics: expect.any(Object),
        });
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle analysis failure gracefully', async () => {
      // Create a project with invalid repository
      const invalidProjectResponse = await request(app.getHttpServer())
        .post('/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Invalid Project',
          repositoryUrl: 'https://invalid-url/repo',
        });

      const invalidProjectId = invalidProjectResponse.body.id;

      // Trigger analysis
      const analysisResponse = await request(app.getHttpServer())
        .post(`/analyze/${invalidProjectId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(202);

      const analysisRunId = analysisResponse.body.analysisRunId;

      // Wait and check for failure
      await new Promise(resolve => setTimeout(resolve, 2000));

      const statusResponse = await request(app.getHttpServer())
        .get(`/analyze/status/${analysisRunId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(statusResponse.body.status).toBe('failed');
      expect(statusResponse.body.errorMessage).toBeDefined();
    });

    it('should handle concurrent analyses', async () => {
      // Trigger multiple analyses simultaneously
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          request(app.getHttpServer())
            .post(`/analyze/${projectId}`)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
              branch: 'main',
              commitSha: `concurrent${i}`,
            }),
        );
      }

      const responses = await Promise.all(promises);

      // All should be accepted
      responses.forEach(response => {
        expect(response.status).toBe(202);
        expect(response.body.analysisRunId).toBeDefined();
      });

      // Verify all are tracked
      const analysisRunRepo = orm.em.getRepository(AnalysisRun);
      const runs = await analysisRunRepo.find({ project: projectId });
      expect(runs.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('Performance', () => {
    it('should handle large codebases efficiently', async () => {
      const startTime = Date.now();

      // Create project for large codebase test
      const largeProjectResponse = await request(app.getHttpServer())
        .post('/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Large Project',
          repositoryUrl: 'https://github.com/microsoft/vscode', // Large repo
        });

      const largeProjectId = largeProjectResponse.body.id;

      // Trigger analysis
      const analysisResponse = await request(app.getHttpServer())
        .post(`/analyze/${largeProjectId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(202);

      // Analysis should be accepted quickly
      const acceptTime = Date.now() - startTime;
      expect(acceptTime).toBeLessThan(1000); // Should accept within 1 second

      // Check that analysis is queued
      const statusResponse = await request(app.getHttpServer())
        .get(`/analyze/status/${analysisResponse.body.analysisRunId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(['pending', 'running']).toContain(statusResponse.body.status);
    });

    it('should cache analysis results', async () => {
      // First analysis
      const firstAnalysisResponse = await request(app.getHttpServer())
        .post(`/analyze/${projectId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          branch: 'main',
          commitSha: 'cached123',
        })
        .expect(202);

      // Wait for completion
      // ... (polling logic)

      // Same analysis again (should use cache)
      const startTime = Date.now();
      const cachedAnalysisResponse = await request(app.getHttpServer())
        .post(`/analyze/${projectId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          branch: 'main',
          commitSha: 'cached123', // Same commit
        })
        .expect(202);

      const cacheTime = Date.now() - startTime;

      // Should be much faster due to caching
      expect(cacheTime).toBeLessThan(100);

      // Verify it used cached results
      const statusResponse = await request(app.getHttpServer())
        .get(`/analyze/status/${cachedAnalysisResponse.body.analysisRunId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(statusResponse.body.metadata?.cached).toBe(true);
    });
  });
});
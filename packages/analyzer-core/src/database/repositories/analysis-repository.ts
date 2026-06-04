import { EntityRepository, EntityManager } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { Injectable } from '@nestjs/common';
import { AnalysisResult, AnalysisResultType } from '../entities/analysis-result.entity';
import { Project } from '../entities/project.entity';

export interface ComparisonResult {
  from: AnalysisResult;
  to: AnalysisResult;
  changes: {
    added: string[];
    removed: string[];
    modified: Array<{
      component: string;
      changes: Record<string, any>;
    }>;
  };
  metrics: {
    componentsAdded: number;
    componentsRemoved: number;
    componentsModified: number;
    complexityChange: number;
    healthScoreChange: number;
    issuesChange: number;
  };
}

@Injectable()
export class AnalysisRepository {
  constructor(
    @InjectRepository(AnalysisResult)
    private readonly repository: EntityRepository<AnalysisResult>,
    private readonly em: EntityManager,
  ) {}

  async create(data: Partial<AnalysisResult>): Promise<AnalysisResult> {
    const result = this.repository.create(data as any);
    await this.em.persistAndFlush(result);
    return result;
  }

  async findById(id: string): Promise<AnalysisResult | null> {
    return this.repository.findOne({ id }, {
      populate: ['project', 'analysisRun', 'patterns'],
    });
  }

  async findByProject(
    projectId: string,
    type?: AnalysisResultType,
    limit: number = 10,
  ): Promise<AnalysisResult[]> {
    const where: any = { project: projectId };
    if (type) {
      where.type = type;
    }

    return this.repository.find(where, {
      orderBy: { createdAt: 'DESC' },
      limit,
      populate: ['analysisRun'],
    });
  }

  async findLatestByProject(
    projectId: string,
    type?: AnalysisResultType,
  ): Promise<AnalysisResult | null> {
    const where: any = { project: projectId };
    if (type) {
      where.type = type;
    }

    return this.repository.findOne(where, {
      orderBy: { createdAt: 'DESC' },
      populate: ['analysisRun', 'patterns'],
    });
  }

  async findByVersion(
    projectId: string,
    version: string,
  ): Promise<AnalysisResult | null> {
    return this.repository.findOne({
      project: projectId,
      version,
    }, {
      populate: ['analysisRun', 'patterns'],
    });
  }

  async findByCommit(
    projectId: string,
    commitSha: string,
  ): Promise<AnalysisResult[]> {
    return this.repository.find({
      project: projectId,
      commitSha,
    }, {
      populate: ['analysisRun'],
    });
  }

  async findByBranch(
    projectId: string,
    branch: string,
    limit: number = 10,
  ): Promise<AnalysisResult[]> {
    return this.repository.find({
      project: projectId,
      branch,
    }, {
      orderBy: { createdAt: 'DESC' },
      limit,
      populate: ['analysisRun'],
    });
  }

  async compareVersions(
    projectId: string,
    fromVersion: string,
    toVersion: string,
  ): Promise<ComparisonResult | null> {
    const fromResult = await this.findByVersion(projectId, fromVersion);
    const toResult = await this.findByVersion(projectId, toVersion);

    if (!fromResult || !toResult) {
      return null;
    }

    return this.generateComparison(fromResult, toResult);
  }

  async compareWithLatest(
    projectId: string,
    version: string,
  ): Promise<ComparisonResult | null> {
    const versionResult = await this.findByVersion(projectId, version);
    const latestResult = await this.findLatestByProject(projectId);

    if (!versionResult || !latestResult) {
      return null;
    }

    return this.generateComparison(versionResult, latestResult);
  }

  async getProjectHistory(
    projectId: string,
    days: number = 30,
  ): Promise<{
    results: AnalysisResult[];
    trends: {
      complexity: Array<{ date: Date; value: number }>;
      health: Array<{ date: Date; value: number }>;
      issues: Array<{ date: Date; value: number }>;
      components: Array<{ date: Date; value: number }>;
    };
  }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const results = await this.repository.find({
      project: projectId,
      createdAt: { $gte: since },
    }, {
      orderBy: { createdAt: 'ASC' },
    });

    const trends = {
      complexity: [] as Array<{ date: Date; value: number }>,
      health: [] as Array<{ date: Date; value: number }>,
      issues: [] as Array<{ date: Date; value: number }>,
      components: [] as Array<{ date: Date; value: number }>,
    };

    results.forEach(result => {
      const date = result.createdAt;
      trends.complexity.push({
        date,
        value: result.summary?.complexityScore || 0,
      });
      trends.health.push({
        date,
        value: result.summary?.healthScore || 0,
      });
      trends.issues.push({
        date,
        value: result.summary?.totalIssues || 0,
      });
      trends.components.push({
        date,
        value: result.summary?.totalComponents || 0,
      });
    });

    return { results, trends };
  }

  async updateSummary(
    id: string,
    summary: Partial<AnalysisResult['summary']>,
  ): Promise<AnalysisResult | null> {
    const result = await this.repository.findOne({ id });
    if (!result) {
      return null;
    }

    result.updateSummary(summary);
    await this.em.flush();
    return result;
  }

  async updateMetadata(
    id: string,
    metadata: Partial<AnalysisResult['metadata']>,
  ): Promise<AnalysisResult | null> {
    const result = await this.repository.findOne({ id });
    if (!result) {
      return null;
    }

    result.updateMetadata(metadata);
    await this.em.flush();
    return result;
  }

  async addNotes(
    id: string,
    notes: string,
  ): Promise<AnalysisResult | null> {
    const result = await this.repository.findOne({ id });
    if (!result) {
      return null;
    }

    result.notes = notes;
    await this.em.flush();
    return result;
  }

  async deleteOldResults(
    projectId: string,
    keepCount: number = 10,
  ): Promise<number> {
    const results = await this.repository.find(
      { project: projectId },
      { orderBy: { createdAt: 'DESC' } },
    );

    if (results.length <= keepCount) {
      return 0;
    }

    const toDelete = results.slice(keepCount);
    await this.em.removeAndFlush(toDelete);
    return toDelete.length;
  }

  private generateComparison(
    from: AnalysisResult,
    to: AnalysisResult,
  ): ComparisonResult {
    const fromComponents = new Set(
      Object.keys(from.data.components || {}),
    );
    const toComponents = new Set(
      Object.keys(to.data.components || {}),
    );

    const added = Array.from(toComponents).filter(c => !fromComponents.has(c));
    const removed = Array.from(fromComponents).filter(c => !toComponents.has(c));
    const common = Array.from(fromComponents).filter(c => toComponents.has(c));

    const modified = common
      .map(component => {
        const fromComp = from.data.components[component];
        const toComp = to.data.components[component];
        const changes: Record<string, any> = {};

        Object.keys(toComp).forEach(key => {
          if (JSON.stringify(fromComp[key]) !== JSON.stringify(toComp[key])) {
            changes[key] = {
              from: fromComp[key],
              to: toComp[key],
            };
          }
        });

        return Object.keys(changes).length > 0
          ? { component, changes }
          : null;
      })
      .filter(Boolean) as Array<{ component: string; changes: Record<string, any> }>;

    return {
      from,
      to,
      changes: {
        added,
        removed,
        modified,
      },
      metrics: {
        componentsAdded: added.length,
        componentsRemoved: removed.length,
        componentsModified: modified.length,
        complexityChange: (to.summary?.complexityScore || 0) - (from.summary?.complexityScore || 0),
        healthScoreChange: (to.summary?.healthScore || 0) - (from.summary?.healthScore || 0),
        issuesChange: (to.summary?.totalIssues || 0) - (from.summary?.totalIssues || 0),
      },
    };
  }

  async getStatsByType(
    projectId: string,
  ): Promise<Record<AnalysisResultType, number>> {
    const results = await this.repository.find({ project: projectId });
    
    const stats: Record<AnalysisResultType, number> = {
      [AnalysisResultType.ARCHITECTURE]: 0,
      [AnalysisResultType.DEPENDENCIES]: 0,
      [AnalysisResultType.PATTERNS]: 0,
      [AnalysisResultType.METRICS]: 0,
      [AnalysisResultType.SECURITY]: 0,
      [AnalysisResultType.PERFORMANCE]: 0,
    };

    results.forEach(result => {
      stats[result.type]++;
    });

    return stats;
  }
}
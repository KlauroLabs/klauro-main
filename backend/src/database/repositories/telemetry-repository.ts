import { EntityRepository, EntityManager } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { Injectable } from '@nestjs/common';
import { 
  TelemetrySnapshot, 
  TelemetryType, 
  AggregationInterval 
} from '../entities/telemetry-snapshot.entity';
import { Project } from '../entities/project.entity';
import { Component } from '../entities/component.entity';

export interface TelemetryQuery {
  projectId: string;
  componentId?: string;
  type?: TelemetryType;
  name?: string;
  environment?: string;
  service?: string;
  startTime: Date;
  endTime: Date;
  interval?: AggregationInterval;
}

export interface TelemetryAggregation {
  timestamp: Date;
  value: number;
  count: number;
  min?: number;
  max?: number;
  avg?: number;
  p50?: number;
  p95?: number;
  p99?: number;
}

export interface TelemetryMetrics {
  responseTime: TelemetryAggregation[];
  errorRate: TelemetryAggregation[];
  throughput: TelemetryAggregation[];
  availability: number;
  healthScore: number;
}

@Injectable()
export class TelemetryRepository {
  constructor(
    @InjectRepository(TelemetrySnapshot)
    private readonly repository: EntityRepository<TelemetrySnapshot>,
    private readonly em: EntityManager,
  ) {}

  async create(data: Partial<TelemetrySnapshot>): Promise<TelemetrySnapshot> {
    const snapshot = this.repository.create(data as any);
    await this.em.persistAndFlush(snapshot);
    return snapshot;
  }

  async createBatch(data: Partial<TelemetrySnapshot>[]): Promise<TelemetrySnapshot[]> {
    const snapshots = data.map(d => this.repository.create(d as any));
    await this.em.persistAndFlush(snapshots);
    return snapshots;
  }

  async findById(id: string): Promise<TelemetrySnapshot | null> {
    return this.repository.findOne({ id }, {
      populate: ['project', 'component'],
    });
  }

  async query(params: TelemetryQuery): Promise<TelemetrySnapshot[]> {
    const qb = this.repository.createQueryBuilder();
    
    qb.where({ project: params.projectId });
    qb.andWhere({ 
      timestamp: { 
        $gte: params.startTime,
        $lte: params.endTime,
      },
    });

    if (params.componentId) {
      qb.andWhere({ component: params.componentId });
    }
    if (params.type) {
      qb.andWhere({ type: params.type });
    }
    if (params.name) {
      qb.andWhere({ name: params.name });
    }
    if (params.environment) {
      qb.andWhere({ environment: params.environment });
    }
    if (params.service) {
      qb.andWhere({ service: params.service });
    }
    if (params.interval) {
      qb.andWhere({ interval: params.interval });
    }

    qb.orderBy({ timestamp: 'ASC' });

    return qb.getResult();
  }

  async aggregate(
    params: TelemetryQuery,
    aggregationInterval?: AggregationInterval,
  ): Promise<TelemetryAggregation[]> {
    const interval = aggregationInterval || params.interval || AggregationInterval.HOUR;
    const snapshots = await this.query(params);

    const buckets = new Map<string, TelemetrySnapshot[]>();

    // Group snapshots by time bucket
    snapshots.forEach(snapshot => {
      const bucketTime = TelemetrySnapshot.roundToInterval(snapshot.timestamp, interval);
      const key = bucketTime.toISOString();
      
      if (!buckets.has(key)) {
        buckets.set(key, []);
      }
      buckets.get(key)!.push(snapshot);
    });

    // Aggregate each bucket
    const aggregations: TelemetryAggregation[] = [];
    
    buckets.forEach((snapshots, timestamp) => {
      const values = snapshots.map(s => s.data.avg || s.data.value || 0);
      const counts = snapshots.map(s => s.data.count || s.sampleCount || 1);
      const totalCount = counts.reduce((a, b) => a + b, 0);
      
      const aggregation: TelemetryAggregation = {
        timestamp: new Date(timestamp),
        value: values.reduce((a, b) => a + b, 0) / values.length,
        count: totalCount,
      };

      // Add percentiles if available
      const p50Values = snapshots.map(s => s.data.p50).filter(Boolean) as number[];
      const p95Values = snapshots.map(s => s.data.p95).filter(Boolean) as number[];
      const p99Values = snapshots.map(s => s.data.p99).filter(Boolean) as number[];

      if (p50Values.length > 0) {
        aggregation.p50 = p50Values.reduce((a, b) => a + b, 0) / p50Values.length;
      }
      if (p95Values.length > 0) {
        aggregation.p95 = p95Values.reduce((a, b) => a + b, 0) / p95Values.length;
      }
      if (p99Values.length > 0) {
        aggregation.p99 = p99Values.reduce((a, b) => a + b, 0) / p99Values.length;
      }

      // Calculate min/max
      if (values.length > 0) {
        aggregation.min = Math.min(...values);
        aggregation.max = Math.max(...values);
        aggregation.avg = aggregation.value;
      }

      aggregations.push(aggregation);
    });

    return aggregations.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  async getMetrics(
    projectId: string,
    startTime: Date,
    endTime: Date,
    componentId?: string,
  ): Promise<TelemetryMetrics> {
    const baseQuery: TelemetryQuery = {
      projectId,
      startTime,
      endTime,
      componentId,
    };

    // Get response time metrics
    const responseTimeQuery = { ...baseQuery, type: TelemetryType.TRACE, name: 'http.request' };
    const responseTime = await this.aggregate(responseTimeQuery);

    // Get error metrics
    const errorQuery = { ...baseQuery, type: TelemetryType.ERROR };
    const errors = await this.aggregate(errorQuery);

    // Calculate error rate
    const errorRate = responseTime.map((rt, index) => {
      const errorCount = errors[index]?.count || 0;
      const totalRequests = rt.count || 1;
      return {
        timestamp: rt.timestamp,
        value: (errorCount / totalRequests) * 100,
        count: errorCount,
      };
    });

    // Calculate throughput (requests per minute)
    const throughput = responseTime.map(rt => ({
      timestamp: rt.timestamp,
      value: rt.count / 60, // Convert to per minute
      count: rt.count,
    }));

    // Calculate availability (percentage of time without errors)
    const totalPeriods = responseTime.length;
    const periodsWithErrors = errors.filter(e => e.count > 0).length;
    const availability = totalPeriods > 0 
      ? ((totalPeriods - periodsWithErrors) / totalPeriods) * 100 
      : 100;

    // Calculate health score
    const avgResponseTime = responseTime.reduce((sum, rt) => sum + rt.value, 0) / (responseTime.length || 1);
    const avgErrorRate = errorRate.reduce((sum, er) => sum + er.value, 0) / (errorRate.length || 1);
    
    let healthScore = 100;
    // Deduct for slow response times
    if (avgResponseTime > 1000) healthScore -= 20;
    else if (avgResponseTime > 500) healthScore -= 10;
    
    // Deduct for error rate
    healthScore -= Math.min(50, avgErrorRate * 5);
    
    // Deduct for low availability
    healthScore -= Math.min(30, (100 - availability) * 3);

    return {
      responseTime,
      errorRate,
      throughput,
      availability,
      healthScore: Math.max(0, healthScore),
    };
  }

  async getTopErrors(
    projectId: string,
    limit: number = 10,
    startTime?: Date,
    endTime?: Date,
  ): Promise<Array<{
    name: string;
    count: number;
    lastSeen: Date;
    component?: string;
  }>> {
    const qb = this.repository.createQueryBuilder();
    
    qb.select(['name', 'SUM(data->>\'occurrences\') as count', 'MAX(timestamp) as last_seen'])
      .where({ project: projectId, type: TelemetryType.ERROR });

    if (startTime && endTime) {
      qb.andWhere({ 
        timestamp: { 
          $gte: startTime,
          $lte: endTime,
        },
      });
    }

    qb.groupBy(['name'])
      .orderBy({ count: 'DESC' })
      .limit(limit);

    const results = await qb.execute();

    return results.map((r: any) => ({
      name: r.name,
      count: parseInt(r.count),
      lastSeen: new Date(r.last_seen),
    }));
  }

  async getSlowEndpoints(
    projectId: string,
    limit: number = 10,
    startTime?: Date,
    endTime?: Date,
  ): Promise<Array<{
    name: string;
    avgDuration: number;
    p95Duration: number;
    count: number;
    component?: string;
  }>> {
    const qb = this.repository.createQueryBuilder();
    
    qb.select([
      'name',
      'AVG(data->>\'duration\') as avg_duration',
      'PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY data->>\'duration\') as p95_duration',
      'SUM(sample_count) as count',
    ])
      .where({ project: projectId, type: TelemetryType.TRACE });

    if (startTime && endTime) {
      qb.andWhere({ 
        timestamp: { 
          $gte: startTime,
          $lte: endTime,
        },
      });
    }

    qb.groupBy(['name'])
      .having('AVG(data->>\'duration\') > 500') // Only show slow endpoints
      .orderBy({ avg_duration: 'DESC' })
      .limit(limit);

    const results = await qb.execute();

    return results.map((r: any) => ({
      name: r.name,
      avgDuration: parseFloat(r.avg_duration),
      p95Duration: parseFloat(r.p95_duration),
      count: parseInt(r.count),
    }));
  }

  async cleanup(
    olderThan: Date,
    interval?: AggregationInterval,
  ): Promise<number> {
    const qb = this.repository.createQueryBuilder();
    
    qb.delete()
      .where({ timestamp: { $lt: olderThan } });

    if (interval) {
      qb.andWhere({ interval });
    }

    const result = await qb.execute();
    return result.affectedRows || 0;
  }

  async compactData(
    projectId: string,
    beforeDate: Date,
    fromInterval: AggregationInterval,
    toInterval: AggregationInterval,
  ): Promise<number> {
    // Get data to compact
    const snapshots = await this.repository.find({
      project: projectId,
      timestamp: { $lt: beforeDate },
      interval: fromInterval,
    });

    if (snapshots.length === 0) {
      return 0;
    }

    // Group by time bucket and aggregate
    const buckets = new Map<string, TelemetrySnapshot[]>();
    
    snapshots.forEach(snapshot => {
      const bucketTime = TelemetrySnapshot.roundToInterval(snapshot.timestamp, toInterval);
      const key = `${bucketTime.toISOString()}-${snapshot.type}-${snapshot.name}`;
      
      if (!buckets.has(key)) {
        buckets.set(key, []);
      }
      buckets.get(key)!.push(snapshot);
    });

    // Create aggregated snapshots
    const newSnapshots: Partial<TelemetrySnapshot>[] = [];
    
    buckets.forEach((snapshots, key) => {
      const first = snapshots[0];
      const aggregated = this.repository.create({
        project: first.project,
        component: first.component,
        type: first.type,
        timestamp: TelemetrySnapshot.roundToInterval(first.timestamp, toInterval),
        interval: toInterval,
        name: first.name,
        data: this.mergeData(snapshots.map(s => s.data)),
        dimensions: first.dimensions,
        environment: first.environment,
        service: first.service,
        sampleCount: snapshots.reduce((sum, s) => sum + s.sampleCount, 0),
      });

      newSnapshots.push(aggregated);
    });

    // Save new aggregated data
    await this.createBatch(newSnapshots);

    // Delete old data
    await this.em.removeAndFlush(snapshots);

    return snapshots.length;
  }

  private mergeData(dataArray: Array<TelemetrySnapshot['data']>): TelemetrySnapshot['data'] {
    const merged: TelemetrySnapshot['data'] = {
      count: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
    };

    dataArray.forEach(data => {
      merged.count = (merged.count || 0) + (data.count || 0);
      merged.sum = (merged.sum || 0) + (data.sum || 0);
      merged.min = Math.min(merged.min || Infinity, data.min || Infinity);
      merged.max = Math.max(merged.max || -Infinity, data.max || -Infinity);

      // Merge other fields
      if (data.spanCount) {
        merged.spanCount = (merged.spanCount || 0) + data.spanCount;
      }
      if (data.errorCount) {
        merged.errorCount = (merged.errorCount || 0) + data.errorCount;
      }
      if (data.occurrences) {
        merged.occurrences = (merged.occurrences || 0) + data.occurrences;
      }
      if (data.affectedUsers) {
        merged.affectedUsers = Math.max(merged.affectedUsers || 0, data.affectedUsers);
      }
    });

    // Calculate average
    if (merged.count && merged.count > 0) {
      merged.avg = merged.sum / merged.count;
    }

    return merged;
  }

  async getHealthTrend(
    projectId: string,
    days: number = 7,
  ): Promise<Array<{ date: Date; score: number }>> {
    const endTime = new Date();
    const startTime = new Date();
    startTime.setDate(startTime.getDate() - days);

    const snapshots = await this.query({
      projectId,
      startTime,
      endTime: endTime,
    });

    const dailyScores = new Map<string, number[]>();

    snapshots.forEach(snapshot => {
      const dateKey = snapshot.timestamp.toISOString().split('T')[0];
      const score = snapshot.getHealthScore();
      
      if (!dailyScores.has(dateKey)) {
        dailyScores.set(dateKey, []);
      }
      dailyScores.get(dateKey)!.push(score);
    });

    const trend: Array<{ date: Date; score: number }> = [];

    dailyScores.forEach((scores, dateKey) => {
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      trend.push({
        date: new Date(dateKey),
        score: avgScore,
      });
    });

    return trend.sort((a, b) => a.date.getTime() - b.date.getTime());
  }
}
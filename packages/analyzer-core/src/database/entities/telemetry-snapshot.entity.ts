import {
  Entity,
  Property,
  ManyToOne,
  Index,
  Enum,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Codebase } from './codebase.entity';
import { Component } from './component.entity';

export enum TelemetryType {
  TRACE = 'trace',
  METRIC = 'metric',
  ERROR = 'error',
  LOG = 'log',
  EVENT = 'event',
}

export enum AggregationInterval {
  MINUTE = 'minute',
  FIVE_MINUTES = '5min',
  FIFTEEN_MINUTES = '15min',
  HOUR = 'hour',
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

@Entity({ tableName: 'telemetry_snapshots' })
@Index({ properties: ['codebase', 'timestamp'] })
@Index({ properties: ['component', 'timestamp'] })
@Index({ properties: ['type', 'timestamp'] })
export class TelemetrySnapshot extends BaseEntity {
  @ManyToOne(() => Codebase, { deleteRule: 'cascade' })
  @Index()
  codebase!: Codebase;

  @ManyToOne(() => Component, { nullable: true, deleteRule: 'set null' })
  component?: Component;

  @Enum(() => TelemetryType)
  @Index()
  type!: TelemetryType;

  @Property({ type: 'timestamptz' })
  @Index()
  timestamp!: Date;

  @Enum(() => AggregationInterval)
  interval!: AggregationInterval;

  @Property({ type: 'varchar', length: 255 })
  @Index()
  name!: string; // Metric/trace/error name

  @Property({ type: 'jsonb' })
  data!: {
    // For metrics
    count?: number;
    sum?: number;
    min?: number;
    max?: number;
    avg?: number;
    p50?: number;
    p75?: number;
    p90?: number;
    p95?: number;
    p99?: number;
    
    // For traces
    duration?: number;
    spanCount?: number;
    errorCount?: number;
    
    // For errors
    occurrences?: number;
    affectedUsers?: number;
    stackTrace?: string;
    
    // Generic
    tags?: Record<string, string>;
    attributes?: Record<string, any>;
    [key: string]: any;
  };

  @Property({ type: 'jsonb', nullable: true })
  dimensions?: {
    environment?: string;
    service?: string;
    version?: string;
    host?: string;
    region?: string;
    [key: string]: string | undefined;
  };

  @Property({ type: 'varchar', length: 100, nullable: true })
  @Index()
  environment?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  @Index()
  service?: string;

  @Property({ type: 'integer', default: 1 })
  sampleCount: number = 1;

  // Query helpers
  get isError(): boolean {
    return this.type === TelemetryType.ERROR;
  }

  get isMetric(): boolean {
    return this.type === TelemetryType.METRIC;
  }

  get isTrace(): boolean {
    return this.type === TelemetryType.TRACE;
  }

  get hasHighLatency(): boolean {
    const duration = this.data.duration || this.data.p95 || 0;
    return duration > 1000; // Over 1 second
  }

  get errorRate(): number {
    if (this.data.errorCount && this.data.spanCount) {
      return (this.data.errorCount / this.data.spanCount) * 100;
    }
    return 0;
  }

  // Aggregation methods
  aggregate(other: TelemetrySnapshot): void {
    if (this.type !== other.type || this.name !== other.name) {
      throw new Error('Cannot aggregate different telemetry types or names');
    }

    this.sampleCount += other.sampleCount;

    switch (this.type) {
      case TelemetryType.METRIC:
        this.aggregateMetric(other);
        break;
      case TelemetryType.TRACE:
        this.aggregateTrace(other);
        break;
      case TelemetryType.ERROR:
        this.aggregateError(other);
        break;
    }
  }

  private aggregateMetric(other: TelemetrySnapshot): void {
    const data = this.data;
    const otherData = other.data;

    data.count = (data.count || 0) + (otherData.count || 0);
    data.sum = (data.sum || 0) + (otherData.sum || 0);
    data.min = Math.min(data.min || Infinity, otherData.min || Infinity);
    data.max = Math.max(data.max || -Infinity, otherData.max || -Infinity);
    
    // Recalculate average
    if (data.count > 0) {
      data.avg = data.sum / data.count;
    }

    // Note: Percentiles would need special handling with sketch algorithms
    // For simplicity, we'll keep the latest values
    if (otherData.p50) data.p50 = otherData.p50;
    if (otherData.p75) data.p75 = otherData.p75;
    if (otherData.p90) data.p90 = otherData.p90;
    if (otherData.p95) data.p95 = otherData.p95;
    if (otherData.p99) data.p99 = otherData.p99;
  }

  private aggregateTrace(other: TelemetrySnapshot): void {
    const data = this.data;
    const otherData = other.data;

    data.spanCount = (data.spanCount || 0) + (otherData.spanCount || 0);
    data.errorCount = (data.errorCount || 0) + (otherData.errorCount || 0);
    
    // Average duration
    const totalDuration = (data.duration || 0) * (this.sampleCount - other.sampleCount) +
                         (otherData.duration || 0) * other.sampleCount;
    data.duration = totalDuration / this.sampleCount;
  }

  private aggregateError(other: TelemetrySnapshot): void {
    const data = this.data;
    const otherData = other.data;

    data.occurrences = (data.occurrences || 0) + (otherData.occurrences || 0);
    data.affectedUsers = (data.affectedUsers || 0) + (otherData.affectedUsers || 0);
    
    // Keep the latest stack trace
    if (otherData.stackTrace) {
      data.stackTrace = otherData.stackTrace;
    }
  }

  // Time series helpers
  static getIntervalDuration(interval: AggregationInterval): number {
    switch (interval) {
      case AggregationInterval.MINUTE:
        return 60 * 1000;
      case AggregationInterval.FIVE_MINUTES:
        return 5 * 60 * 1000;
      case AggregationInterval.FIFTEEN_MINUTES:
        return 15 * 60 * 1000;
      case AggregationInterval.HOUR:
        return 60 * 60 * 1000;
      case AggregationInterval.DAY:
        return 24 * 60 * 60 * 1000;
      case AggregationInterval.WEEK:
        return 7 * 24 * 60 * 60 * 1000;
      case AggregationInterval.MONTH:
        return 30 * 24 * 60 * 60 * 1000;
      default:
        return 60 * 1000;
    }
  }

  static roundToInterval(date: Date, interval: AggregationInterval): Date {
    const duration = TelemetrySnapshot.getIntervalDuration(interval);
    const timestamp = Math.floor(date.getTime() / duration) * duration;
    return new Date(timestamp);
  }

  // Analysis helpers
  getHealthScore(): number {
    let score = 100;

    // Deduct for errors
    if (this.isError) {
      score -= Math.min(30, (this.data.occurrences || 0) * 2);
    }

    // Deduct for high latency
    if (this.hasHighLatency) {
      score -= 20;
    }

    // Deduct for high error rate
    const errorRate = this.errorRate;
    if (errorRate > 5) {
      score -= Math.min(30, errorRate * 2);
    }

    return Math.max(0, score);
  }
}
import {
  Entity,
  Property,
  ManyToOne,
  OneToMany,
  Collection,
  Index,
  Enum,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Project } from './project.entity';
import { AnalysisRun } from './analysis-run.entity';
import { PatternDetection } from './pattern-detection.entity';

export enum AnalysisResultType {
  ARCHITECTURE = 'architecture',
  DEPENDENCIES = 'dependencies',
  PATTERNS = 'patterns',
  METRICS = 'metrics',
  SECURITY = 'security',
  PERFORMANCE = 'performance',
}

@Entity({ tableName: 'analysis_results' })
export class AnalysisResult extends BaseEntity {
  @ManyToOne(() => Project, { deleteRule: 'cascade' })
  @Index()
  project!: Project;

  @ManyToOne(() => AnalysisRun, { deleteRule: 'cascade' })
  @Index()
  analysisRun!: AnalysisRun;

  @Enum(() => AnalysisResultType)
  type!: AnalysisResultType;

  @Property({ type: 'varchar', length: 20 })
  @Index()
  version!: string; // Semantic versioning

  @Property({ type: 'jsonb' })
  data!: Record<string, any>;

  @Property({ type: 'jsonb', nullable: true })
  summary?: {
    totalComponents?: number;
    totalConnections?: number;
    totalIssues?: number;
    complexityScore?: number;
    healthScore?: number;
    [key: string]: any;
  };

  @Property({ type: 'jsonb', nullable: true })
  metadata?: {
    analyzedFiles?: number;
    analyzedLines?: number;
    languages?: string[];
    frameworks?: string[];
    [key: string]: any;
  };

  @Property({ type: 'jsonb', nullable: true })
  diff?: Record<string, any>; // Diff from previous version

  @Property({ type: 'varchar', length: 40, nullable: true })
  commitSha?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  branch?: string;

  @Property({ type: 'text', nullable: true })
  notes?: string;

  @OneToMany(() => PatternDetection, pattern => pattern.analysisResult)
  patterns = new Collection<PatternDetection>(this);

  // Comparison methods
  compareWith(other: AnalysisResult): Record<string, any> {
    const diff: Record<string, any> = {
      version: { from: other.version, to: this.version },
      changes: [],
    };

    // Compare summaries
    if (this.summary && other.summary) {
      Object.keys(this.summary).forEach(key => {
        const oldValue = other.summary![key];
        const newValue = this.summary![key];
        if (oldValue !== newValue) {
          diff.changes.push({
            field: key,
            oldValue,
            newValue,
            change: this.calculateChange(oldValue, newValue),
          });
        }
      });
    }

    return diff;
  }

  private calculateChange(oldValue: any, newValue: any): string {
    if (typeof oldValue === 'number' && typeof newValue === 'number') {
      const change = newValue - oldValue;
      const percentChange = oldValue !== 0 ? (change / oldValue) * 100 : 0;
      return `${change > 0 ? '+' : ''}${change} (${percentChange.toFixed(1)}%)`;
    }
    return 'changed';
  }

  // Query helpers
  get hasIssues(): boolean {
    return (this.summary?.totalIssues || 0) > 0;
  }

  get isHealthy(): boolean {
    return (this.summary?.healthScore || 0) >= 70;
  }

  get complexity(): 'low' | 'medium' | 'high' | 'critical' {
    const score = this.summary?.complexityScore || 0;
    if (score < 30) return 'low';
    if (score < 60) return 'medium';
    if (score < 80) return 'high';
    return 'critical';
  }

  // Data access methods
  getData<T = any>(path: string, defaultValue?: T): T {
    const keys = path.split('.');
    let value: any = this.data;
    
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return defaultValue as T;
      }
    }
    
    return value as T;
  }

  setData(path: string, value: any): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    let obj = this.data;
    
    for (const key of keys) {
      if (!obj[key] || typeof obj[key] !== 'object') {
        obj[key] = {};
      }
      obj = obj[key];
    }
    
    obj[lastKey] = value;
  }

  // Summary helpers
  updateSummary(updates: Partial<typeof this.summary>): void {
    this.summary = {
      ...this.summary,
      ...updates,
    };
  }

  // Metadata helpers
  updateMetadata(updates: Partial<typeof this.metadata>): void {
    this.metadata = {
      ...this.metadata,
      ...updates,
    };
  }
}
import {
  Entity,
  Property,
  ManyToOne,
  Index,
  Enum,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Project } from './project.entity';
import { AnalysisResult } from './analysis-result.entity';
import { Component } from './component.entity';

export enum PatternType {
  DESIGN_PATTERN = 'design_pattern',
  ANTI_PATTERN = 'anti_pattern',
  CODE_SMELL = 'code_smell',
  SECURITY_ISSUE = 'security_issue',
  PERFORMANCE_ISSUE = 'performance_issue',
  ARCHITECTURE_VIOLATION = 'architecture_violation',
  BEST_PRACTICE = 'best_practice',
  DEPENDENCY_ISSUE = 'dependency_issue',
}

export enum PatternSeverity {
  INFO = 'info',
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum PatternStatus {
  ACTIVE = 'active',
  RESOLVED = 'resolved',
  IGNORED = 'ignored',
  FALSE_POSITIVE = 'false_positive',
}

@Entity({ tableName: 'pattern_detections' })
@Index({ properties: ['project', 'type', 'status'] })
@Index({ properties: ['component', 'type'] })
@Index({ properties: ['firstDetected', 'lastSeen'] })
export class PatternDetection extends BaseEntity {
  @ManyToOne(() => Project, { deleteRule: 'cascade' })
  @Index()
  project!: Project;

  @ManyToOne(() => AnalysisResult, { deleteRule: 'cascade' })
  analysisResult!: AnalysisResult;

  @ManyToOne(() => Component, { nullable: true, deleteRule: 'set null' })
  component?: Component;

  @Enum(() => PatternType)
  @Index()
  type!: PatternType;

  @Enum(() => PatternSeverity)
  @Index()
  severity!: PatternSeverity;

  @Enum(() => PatternStatus)
  @Index()
  status: PatternStatus = PatternStatus.ACTIVE;

  @Property({ type: 'varchar', length: 255 })
  @Index()
  patternId!: string; // Unique identifier for the specific pattern

  @Property({ type: 'varchar', length: 255 })
  title!: string;

  @Property({ type: 'text' })
  description!: string;

  @Property({ type: 'jsonb', nullable: true })
  location?: {
    file?: string;
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
    codeSnippet?: string;
  };

  @Property({ type: 'jsonb', nullable: true })
  metadata?: {
    category?: string;
    tags?: string[];
    references?: string[];
    examples?: string[];
    impact?: string;
    effort?: 'low' | 'medium' | 'high';
    [key: string]: any;
  };

  @Property({ type: 'text', nullable: true })
  suggestedFix?: string;

  @Property({ type: 'jsonb', nullable: true })
  autoFix?: {
    available: boolean;
    patch?: string;
    confidence?: number;
  };

  @Property({ type: 'timestamptz' })
  @Index()
  firstDetected!: Date;

  @Property({ type: 'timestamptz' })
  @Index()
  lastSeen!: Date;

  @Property({ type: 'integer', default: 1 })
  occurrences: number = 1;

  @Property({ type: 'jsonb', nullable: true })
  trendData?: Array<{
    date: string;
    count: number;
    severity?: PatternSeverity;
  }>;

  @Property({ type: 'text', nullable: true })
  resolvedBy?: string;

  @Property({ type: 'timestamptz', nullable: true })
  resolvedAt?: Date;

  @Property({ type: 'text', nullable: true })
  ignoreReason?: string;

  @Property({ type: 'timestamptz', nullable: true })
  ignoredUntil?: Date;

  // Pattern management
  markAsResolved(resolvedBy?: string): void {
    this.status = PatternStatus.RESOLVED;
    this.resolvedAt = new Date();
    this.resolvedBy = resolvedBy;
  }

  markAsIgnored(reason?: string, until?: Date): void {
    this.status = PatternStatus.IGNORED;
    this.ignoreReason = reason;
    this.ignoredUntil = until;
  }

  markAsFalsePositive(): void {
    this.status = PatternStatus.FALSE_POSITIVE;
  }

  reactivate(): void {
    this.status = PatternStatus.ACTIVE;
    this.resolvedAt = undefined;
    this.resolvedBy = undefined;
    this.ignoreReason = undefined;
    this.ignoredUntil = undefined;
  }

  incrementOccurrences(): void {
    this.occurrences++;
    this.lastSeen = new Date();
  }

  updateTrend(date: Date, count: number): void {
    if (!this.trendData) {
      this.trendData = [];
    }

    const dateStr = date.toISOString().split('T')[0];
    const existing = this.trendData.find(t => t.date === dateStr);
    
    if (existing) {
      existing.count = count;
      existing.severity = this.severity;
    } else {
      this.trendData.push({
        date: dateStr,
        count,
        severity: this.severity,
      });
    }

    // Keep only last 30 days of trend data
    if (this.trendData.length > 30) {
      this.trendData = this.trendData.slice(-30);
    }
  }

  // Query helpers
  get isActive(): boolean {
    return this.status === PatternStatus.ACTIVE;
  }

  get isResolved(): boolean {
    return this.status === PatternStatus.RESOLVED;
  }

  get isIgnored(): boolean {
    if (this.status !== PatternStatus.IGNORED) {
      return false;
    }
    
    if (this.ignoredUntil && this.ignoredUntil < new Date()) {
      // Auto-reactivate if ignore period has expired
      this.reactivate();
      return false;
    }
    
    return true;
  }

  get isCritical(): boolean {
    return this.severity === PatternSeverity.CRITICAL;
  }

  get isSecurityIssue(): boolean {
    return this.type === PatternType.SECURITY_ISSUE;
  }

  get isPerformanceIssue(): boolean {
    return this.type === PatternType.PERFORMANCE_ISSUE;
  }

  get isAntiPattern(): boolean {
    return this.type === PatternType.ANTI_PATTERN;
  }

  get hasAutoFix(): boolean {
    return this.autoFix?.available === true;
  }

  get age(): number {
    return Date.now() - this.firstDetected.getTime();
  }

  get ageInDays(): number {
    return Math.floor(this.age / (1000 * 60 * 60 * 24));
  }

  get frequency(): number {
    const ageInHours = this.age / (1000 * 60 * 60);
    return ageInHours > 0 ? this.occurrences / ageInHours : 0;
  }

  // Scoring and prioritization
  getPriorityScore(): number {
    let score = 0;

    // Severity weight
    switch (this.severity) {
      case PatternSeverity.CRITICAL:
        score += 100;
        break;
      case PatternSeverity.HIGH:
        score += 70;
        break;
      case PatternSeverity.MEDIUM:
        score += 40;
        break;
      case PatternSeverity.LOW:
        score += 20;
        break;
      case PatternSeverity.INFO:
        score += 10;
        break;
    }

    // Type weight
    switch (this.type) {
      case PatternType.SECURITY_ISSUE:
        score += 50;
        break;
      case PatternType.PERFORMANCE_ISSUE:
        score += 30;
        break;
      case PatternType.ANTI_PATTERN:
        score += 25;
        break;
      case PatternType.ARCHITECTURE_VIOLATION:
        score += 20;
        break;
      case PatternType.CODE_SMELL:
        score += 15;
        break;
      case PatternType.DEPENDENCY_ISSUE:
        score += 15;
        break;
      case PatternType.DESIGN_PATTERN:
        score -= 10; // Positive patterns have lower priority
        break;
      case PatternType.BEST_PRACTICE:
        score -= 10;
        break;
    }

    // Frequency weight
    score += Math.min(20, this.frequency * 5);

    // Age weight (older issues get slight priority)
    score += Math.min(10, this.ageInDays / 10);

    // Auto-fix availability reduces priority slightly
    if (this.hasAutoFix) {
      score -= 5;
    }

    return Math.max(0, score);
  }

  getImpactLevel(): 'low' | 'medium' | 'high' {
    const score = this.getPriorityScore();
    if (score >= 100) return 'high';
    if (score >= 50) return 'medium';
    return 'low';
  }
}
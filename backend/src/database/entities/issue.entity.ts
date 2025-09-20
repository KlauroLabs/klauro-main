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
import { Component } from './component.entity';
import { User } from './user.entity';

export enum IssueType {
  BUG = 'bug',
  PERFORMANCE = 'performance',
  SECURITY = 'security',
  QUALITY = 'quality',
  DEPENDENCY = 'dependency',
  CONFIGURATION = 'configuration',
  ARCHITECTURE = 'architecture',
}

export enum IssueSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum IssueStatus {
  OPEN = 'open',
  ACKNOWLEDGED = 'acknowledged',
  IN_PROGRESS = 'in_progress',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
  WONT_FIX = 'wont_fix',
}

export enum IssueSource {
  STATIC_ANALYSIS = 'static_analysis',
  RUNTIME_TELEMETRY = 'runtime_telemetry',
  MANUAL_REPORT = 'manual_report',
  AUTOMATED_SCAN = 'automated_scan',
  PATTERN_DETECTION = 'pattern_detection',
}

@Entity({ tableName: 'issues' })
@Index({ properties: ['project', 'status', 'severity'] })
@Index({ properties: ['component', 'type'] })
@Index({ properties: ['firstDetected', 'lastSeen'] })
export class Issue extends BaseEntity {
  @ManyToOne(() => Project, { deleteRule: 'cascade' })
  @Index()
  project!: Project;

  @ManyToOne(() => Component, { nullable: true, deleteRule: 'set null' })
  component?: Component;

  @ManyToOne(() => User, { nullable: true })
  assignedTo?: User;

  @ManyToOne(() => User, { nullable: true })
  reportedBy?: User;

  @Enum(() => IssueType)
  @Index()
  type!: IssueType;

  @Enum(() => IssueSeverity)
  @Index()
  severity!: IssueSeverity;

  @Enum(() => IssueStatus)
  @Index()
  status: IssueStatus = IssueStatus.OPEN;

  @Enum(() => IssueSource)
  source!: IssueSource;

  @Property({ type: 'varchar', length: 255 })
  title!: string;

  @Property({ type: 'text' })
  description!: string;

  @Property({ type: 'varchar', length: 255, unique: true })
  @Index()
  fingerprint!: string; // Unique identifier for deduplication

  @Property({ type: 'timestamptz' })
  @Index()
  firstDetected!: Date;

  @Property({ type: 'timestamptz' })
  @Index()
  lastSeen!: Date;

  @Property({ type: 'integer', default: 1 })
  occurrences: number = 1;

  @Property({ type: 'integer', default: 0 })
  affectedUsers: number = 0;

  @Property({ type: 'jsonb', nullable: true })
  location?: {
    file?: string;
    method?: string;
    line?: number;
    column?: number;
    url?: string;
    service?: string;
  };

  @Property({ type: 'text', nullable: true })
  stackTrace?: string;

  @Property({ type: 'jsonb', nullable: true })
  metadata?: {
    environment?: string;
    version?: string;
    browser?: string;
    os?: string;
    tags?: string[];
    labels?: string[];
    customFields?: Record<string, any>;
    [key: string]: any;
  };

  @Property({ type: 'text', nullable: true })
  suggestedFix?: string;

  @Property({ type: 'jsonb', nullable: true })
  reproductionSteps?: Array<{
    step: number;
    description: string;
    expectedResult?: string;
    actualResult?: string;
  }>;

  @Property({ type: 'jsonb', nullable: true })
  performanceMetrics?: {
    responseTime?: number;
    cpuUsage?: number;
    memoryUsage?: number;
    errorRate?: number;
    throughput?: number;
    [key: string]: number | undefined;
  };

  @Property({ type: 'jsonb', nullable: true })
  securityDetails?: {
    cveId?: string;
    cweName?: string;
    owaspCategory?: string;
    exploitability?: 'low' | 'medium' | 'high';
    impact?: 'low' | 'medium' | 'high';
    references?: string[];
  };

  @Property({ type: 'jsonb', nullable: true })
  timeline?: Array<{
    timestamp: string;
    event: string;
    user?: string;
    details?: any;
  }>;

  @Property({ type: 'timestamptz', nullable: true })
  acknowledgedAt?: Date;

  @Property({ type: 'timestamptz', nullable: true })
  resolvedAt?: Date;

  @Property({ type: 'text', nullable: true })
  resolution?: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  externalId?: string; // ID from external issue tracker

  @Property({ type: 'varchar', length: 500, nullable: true })
  externalUrl?: string; // URL to external issue tracker

  @Property({ type: 'integer', default: 0 })
  priority: number = 0; // Calculated priority score

  // @OneToMany('IssueComment', 'issue')
  // comments = new Collection<any>(this);

  // @OneToMany('IssueAttachment', 'issue')
  // attachments = new Collection<any>(this);

  // Issue management methods
  acknowledge(user?: User): void {
    if (this.status === IssueStatus.OPEN) {
      this.status = IssueStatus.ACKNOWLEDGED;
      this.acknowledgedAt = new Date();
      if (user) {
        this.assignedTo = user;
      }
      this.addTimelineEvent('acknowledged', user?.id);
    }
  }

  startProgress(user?: User): void {
    this.status = IssueStatus.IN_PROGRESS;
    if (user) {
      this.assignedTo = user;
    }
    this.addTimelineEvent('started_progress', user?.id);
  }

  resolve(resolution?: string, user?: User): void {
    this.status = IssueStatus.RESOLVED;
    this.resolvedAt = new Date();
    this.resolution = resolution;
    this.addTimelineEvent('resolved', user?.id, { resolution });
  }

  close(user?: User): void {
    this.status = IssueStatus.CLOSED;
    this.addTimelineEvent('closed', user?.id);
  }

  reopen(user?: User): void {
    this.status = IssueStatus.OPEN;
    this.resolvedAt = undefined;
    this.resolution = undefined;
    this.addTimelineEvent('reopened', user?.id);
  }

  markAsWontFix(reason?: string, user?: User): void {
    this.status = IssueStatus.WONT_FIX;
    this.resolution = reason;
    this.addTimelineEvent('marked_wont_fix', user?.id, { reason });
  }

  incrementOccurrences(count: number = 1): void {
    this.occurrences += count;
    this.lastSeen = new Date();
    this.updatePriority();
  }

  updateAffectedUsers(count: number): void {
    this.affectedUsers = Math.max(this.affectedUsers, count);
    this.updatePriority();
  }

  addTimelineEvent(event: string, userId?: string, details?: any): void {
    if (!this.timeline) {
      this.timeline = [];
    }

    this.timeline.push({
      timestamp: new Date().toISOString(),
      event,
      user: userId,
      details,
    });
  }

  // Priority calculation
  updatePriority(): void {
    let score = 0;

    // Severity weight (0-40 points)
    switch (this.severity) {
      case IssueSeverity.CRITICAL:
        score += 40;
        break;
      case IssueSeverity.HIGH:
        score += 30;
        break;
      case IssueSeverity.MEDIUM:
        score += 20;
        break;
      case IssueSeverity.LOW:
        score += 10;
        break;
    }

    // Type weight (0-20 points)
    switch (this.type) {
      case IssueType.SECURITY:
        score += 20;
        break;
      case IssueType.BUG:
        score += 15;
        break;
      case IssueType.PERFORMANCE:
        score += 12;
        break;
      case IssueType.ARCHITECTURE:
        score += 10;
        break;
      case IssueType.DEPENDENCY:
        score += 8;
        break;
      case IssueType.QUALITY:
        score += 5;
        break;
      case IssueType.CONFIGURATION:
        score += 3;
        break;
    }

    // Occurrence weight (0-20 points)
    if (this.occurrences > 1000) score += 20;
    else if (this.occurrences > 100) score += 15;
    else if (this.occurrences > 10) score += 10;
    else if (this.occurrences > 1) score += 5;

    // Affected users weight (0-20 points)
    if (this.affectedUsers > 1000) score += 20;
    else if (this.affectedUsers > 100) score += 15;
    else if (this.affectedUsers > 10) score += 10;
    else if (this.affectedUsers > 0) score += 5;

    this.priority = score;
  }

  // Fingerprint generation
  static generateFingerprint(
    type: IssueType,
    title: string,
    location?: any,
    stackTrace?: string
  ): string {
    const parts = [
      type,
      title.toLowerCase().replace(/[^a-z0-9]/g, ''),
    ];

    if (location?.file) {
      parts.push(location.file);
      if (location.line) {
        parts.push(location.line.toString());
      }
    }

    if (stackTrace) {
      // Extract key parts of stack trace for fingerprinting
      const lines = stackTrace.split('\n').slice(0, 3);
      const key = lines.join('|').replace(/[^a-z0-9|]/gi, '');
      parts.push(key);
    }

    // Create a simple hash
    const str = parts.join('-');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }

    return `issue-${Math.abs(hash).toString(36)}`;
  }

  // Query helpers
  get isOpen(): boolean {
    return this.status === IssueStatus.OPEN;
  }

  get isResolved(): boolean {
    return this.status === IssueStatus.RESOLVED || this.status === IssueStatus.CLOSED;
  }

  get isInProgress(): boolean {
    return this.status === IssueStatus.IN_PROGRESS;
  }

  get isCritical(): boolean {
    return this.severity === IssueSeverity.CRITICAL;
  }

  get isSecurityIssue(): boolean {
    return this.type === IssueType.SECURITY;
  }

  get isPerformanceIssue(): boolean {
    return this.type === IssueType.PERFORMANCE;
  }

  get age(): number {
    return Date.now() - this.firstDetected.getTime();
  }

  get ageInDays(): number {
    return Math.floor(this.age / (1000 * 60 * 60 * 24));
  }

  get resolutionTime(): number | undefined {
    if (this.resolvedAt) {
      return this.resolvedAt.getTime() - this.firstDetected.getTime();
    }
    return undefined;
  }

  get resolutionTimeInHours(): number | undefined {
    const time = this.resolutionTime;
    return time ? Math.floor(time / (1000 * 60 * 60)) : undefined;
  }

  get errorRate(): number {
    const ageInHours = this.age / (1000 * 60 * 60);
    return ageInHours > 0 ? this.occurrences / ageInHours : 0;
  }

  get impactScore(): number {
    return (this.priority * this.affectedUsers) / 100;
  }
}
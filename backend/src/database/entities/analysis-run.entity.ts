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
import { User } from './user.entity';
import { Component } from './component.entity';

export enum AnalysisStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum AnalysisType {
  FULL = 'full',
  INCREMENTAL = 'incremental',
  MANUAL = 'manual',
  SCHEDULED = 'scheduled',
}

@Entity({ tableName: 'analysis_runs' })
export class AnalysisRun extends BaseEntity {
  @ManyToOne(() => Project, { deleteRule: 'cascade' })
  @Index()
  project!: Project;

  @ManyToOne(() => User, { nullable: true })
  triggeredBy?: User;

  @Enum(() => AnalysisStatus)
  status: AnalysisStatus = AnalysisStatus.PENDING;

  @Enum(() => AnalysisType)
  type: AnalysisType = AnalysisType.MANUAL;

  @Property({ type: 'varchar', length: 100, nullable: true })
  branch?: string;

  @Property({ type: 'varchar', length: 40, nullable: true })
  commitSha?: string;

  @Property({ type: 'timestamptz', nullable: true })
  startedAt?: Date;

  @Property({ type: 'timestamptz', nullable: true })
  completedAt?: Date;

  @Property({ type: 'integer', nullable: true })
  processingTimeMs?: number;

  @Property({ type: 'integer', nullable: true })
  progress?: number; // 0-100

  @Property({ type: 'varchar', length: 255, nullable: true })
  currentOperation?: string;

  @Property({ type: 'text', nullable: true })
  errorMessage?: string;

  @Property({ type: 'jsonb', nullable: true })
  configuration?: Record<string, any>;

  @Property({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Property({ type: 'jsonb', nullable: true })
  blueprint?: Record<string, any>; // Stored analysis result

  @Property({ type: 'varchar', length: 500, nullable: true })
  manifestPath?: string;

  @OneToMany(() => Component, component => component.analysisRun)
  components = new Collection<Component>(this);

  // Status management
  start(): void {
    this.status = AnalysisStatus.RUNNING;
    this.startedAt = new Date();
    this.progress = 0;
  }

  complete(blueprint?: Record<string, any>, manifestPath?: string): void {
    this.status = AnalysisStatus.COMPLETED;
    this.completedAt = new Date();
    this.progress = 100;
    this.currentOperation = 'Completed';
    
    if (blueprint) {
      this.blueprint = blueprint;
    }
    if (manifestPath) {
      this.manifestPath = manifestPath;
    }
    
    this.calculateProcessingTime();
  }

  fail(errorMessage: string): void {
    this.status = AnalysisStatus.FAILED;
    this.completedAt = new Date();
    this.errorMessage = errorMessage;
    this.calculateProcessingTime();
  }

  cancel(): void {
    this.status = AnalysisStatus.CANCELLED;
    this.completedAt = new Date();
    this.calculateProcessingTime();
  }

  updateProgress(progress: number, currentOperation?: string): void {
    this.progress = Math.max(0, Math.min(100, progress));
    if (currentOperation) {
      this.currentOperation = currentOperation;
    }
  }

  private calculateProcessingTime(): void {
    if (this.startedAt && this.completedAt) {
      this.processingTimeMs = this.completedAt.getTime() - this.startedAt.getTime();
    }
  }

  // Query helpers
  get isRunning(): boolean {
    return this.status === AnalysisStatus.RUNNING;
  }

  get isCompleted(): boolean {
    return this.status === AnalysisStatus.COMPLETED;
  }

  get isFailed(): boolean {
    return this.status === AnalysisStatus.FAILED;
  }

  get isCancelled(): boolean {
    return this.status === AnalysisStatus.CANCELLED;
  }

  get isFinished(): boolean {
    return [
      AnalysisStatus.COMPLETED,
      AnalysisStatus.FAILED,
      AnalysisStatus.CANCELLED,
    ].includes(this.status);
  }

  get duration(): number | undefined {
    if (this.processingTimeMs) {
      return this.processingTimeMs;
    }
    
    if (this.startedAt) {
      const endTime = this.completedAt || new Date();
      return endTime.getTime() - this.startedAt.getTime();
    }
    
    return undefined;
  }

  get durationSeconds(): number | undefined {
    const duration = this.duration;
    return duration ? Math.round(duration / 1000) : undefined;
  }

  // Component statistics
  get componentCount(): number {
    return this.components.length;
  }

  // Metadata helpers
  getMetadata<T = any>(key: string, defaultValue?: T): T {
    return this.metadata?.[key] ?? defaultValue;
  }

  setMetadata(key: string, value: any): void {
    if (!this.metadata) {
      this.metadata = {};
    }
    this.metadata[key] = value;
  }

  // Configuration helpers
  getConfig<T = any>(key: string, defaultValue?: T): T {
    return this.configuration?.[key] ?? defaultValue;
  }

  setConfig(key: string, value: any): void {
    if (!this.configuration) {
      this.configuration = {};
    }
    this.configuration[key] = value;
  }
}
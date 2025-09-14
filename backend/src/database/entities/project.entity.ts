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
import { Organization } from './organization.entity';
import { User } from './user.entity';
import { AnalysisRun } from './analysis-run.entity';

export enum ProjectStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  ANALYZING = 'analyzing',
  ERROR = 'error',
}

export enum RepositoryProvider {
  GITHUB = 'github',
  GITLAB = 'gitlab',
  BITBUCKET = 'bitbucket',
  AZURE_DEVOPS = 'azure_devops',
  CUSTOM = 'custom',
}

@Entity({ tableName: 'projects' })
export class Project extends BaseEntity {
  @ManyToOne(() => Organization, { deleteRule: 'cascade' })
  @Index()
  organization!: Organization;

  @ManyToOne(() => User, { nullable: true })
  owner?: User;

  @Property({ type: 'varchar', length: 255 })
  name!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ type: 'varchar', length: 500, nullable: true })
  repositoryUrl?: string;

  @Enum(() => RepositoryProvider)
  @Property({ nullable: true })
  repositoryProvider?: RepositoryProvider;

  @Property({ type: 'varchar', length: 255, nullable: true })
  repositoryId?: string;

  @Property({ type: 'varchar', length: 100 })
  defaultBranch: string = 'main';

  @Property({ type: 'varchar', length: 100, nullable: true })
  language?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  framework?: string;

  @Enum(() => ProjectStatus)
  status: ProjectStatus = ProjectStatus.ACTIVE;

  @Property({ type: 'jsonb', nullable: true })
  settings?: Record<string, any>;

  @Property({ type: 'timestamptz', nullable: true })
  lastAnalyzedAt?: Date;

  @OneToMany(() => AnalysisRun, analysisRun => analysisRun.project)
  analysisRuns = new Collection<AnalysisRun>(this);

  // Helper methods for settings
  getSetting<T = any>(key: string, defaultValue?: T): T {
    return this.settings?.[key] ?? defaultValue;
  }

  setSetting(key: string, value: any): void {
    if (!this.settings) {
      this.settings = {};
    }
    this.settings[key] = value;
  }

  // Status methods
  markAsAnalyzing(): void {
    this.status = ProjectStatus.ANALYZING;
  }

  markAsAnalyzed(): void {
    this.status = ProjectStatus.ACTIVE;
    this.lastAnalyzedAt = new Date();
  }

  markAsError(): void {
    this.status = ProjectStatus.ERROR;
  }

  archive(): void {
    this.status = ProjectStatus.ARCHIVED;
    this.softDelete();
  }

  restore(): void {
    this.status = ProjectStatus.ACTIVE;
    this.deletedAt = undefined;
  }

  // Query helpers
  get isActive(): boolean {
    return this.status === ProjectStatus.ACTIVE;
  }

  get isAnalyzing(): boolean {
    return this.status === ProjectStatus.ANALYZING;
  }

  get hasError(): boolean {
    return this.status === ProjectStatus.ERROR;
  }

  get isArchived(): boolean {
    return this.status === ProjectStatus.ARCHIVED;
  }

  // Analysis tracking
  get totalAnalysisRuns(): number {
    return this.analysisRuns.length;
  }

  getLatestAnalysisRun(): AnalysisRun | undefined {
    if (this.analysisRuns.length === 0) return undefined;
    return this.analysisRuns.getItems()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  }

  // Repository helpers
  get hasRepository(): boolean {
    return !!this.repositoryUrl;
  }

  get repositoryName(): string | undefined {
    if (!this.repositoryUrl) return undefined;
    try {
      const url = new URL(this.repositoryUrl);
      const pathParts = url.pathname.split('/').filter(Boolean);
      return pathParts.length >= 2 ? pathParts.slice(-2).join('/') : undefined;
    } catch {
      return undefined;
    }
  }
}
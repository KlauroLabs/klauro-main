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
import { Workspace } from './workspace.entity';
import { User } from './user.entity';
import { AnalysisRun } from './analysis-run.entity';
import { CodebaseConnection } from './codebase-connection.entity';

export enum CodebaseStatus {
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

@Entity({ tableName: 'codebases' })
export class Codebase extends BaseEntity {
  @ManyToOne(() => Workspace, { deleteRule: 'cascade' })
  @Index()
  workspace!: Workspace;

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

  @Enum(() => CodebaseStatus)
  status: CodebaseStatus = CodebaseStatus.ACTIVE;

  @Property({ type: 'jsonb', nullable: true })
  settings?: Record<string, any>;

  @Property({ type: 'timestamptz', nullable: true })
  lastAnalyzedAt?: Date;

  @Property({ type: 'jsonb', nullable: true })
  analysisMetadata?: Record<string, any>;

  @Property({ type: 'integer', default: 0 })
  analysisCount: number = 0;

  @OneToMany(() => AnalysisRun, analysisRun => analysisRun.codebase)
  analysisRuns = new Collection<AnalysisRun>(this);

  @OneToMany(() => CodebaseConnection, connection => connection.sourceCodebase)
  outgoingConnections = new Collection<CodebaseConnection>(this);

  @OneToMany(() => CodebaseConnection, connection => connection.targetCodebase)
  incomingConnections = new Collection<CodebaseConnection>(this);

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

  // Analysis metadata methods
  getAnalysisMetadata<T = any>(key: string, defaultValue?: T): T {
    return this.analysisMetadata?.[key] ?? defaultValue;
  }

  setAnalysisMetadata(key: string, value: any): void {
    if (!this.analysisMetadata) {
      this.analysisMetadata = {};
    }
    this.analysisMetadata[key] = value;
  }

  // Status methods
  markAsAnalyzing(): void {
    this.status = CodebaseStatus.ANALYZING;
  }

  markAsAnalyzed(): void {
    this.status = CodebaseStatus.ACTIVE;
    this.lastAnalyzedAt = new Date();
    this.analysisCount++;
  }

  markAsError(): void {
    this.status = CodebaseStatus.ERROR;
  }

  archive(): void {
    this.status = CodebaseStatus.ARCHIVED;
    this.softDelete();
  }

  restore(): void {
    this.status = CodebaseStatus.ACTIVE;
    this.deletedAt = undefined;
  }

  // Query helpers
  get isActive(): boolean {
    return this.status === CodebaseStatus.ACTIVE;
  }

  get isAnalyzing(): boolean {
    return this.status === CodebaseStatus.ANALYZING;
  }

  get hasError(): boolean {
    return this.status === CodebaseStatus.ERROR;
  }

  get isArchived(): boolean {
    return this.status === CodebaseStatus.ARCHIVED;
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

  // Connection helpers
  get totalConnections(): number {
    return this.outgoingConnections.length + this.incomingConnections.length;
  }

  get connectedCodebases(): Codebase[] {
    const outgoing = this.outgoingConnections.getItems().map(conn => conn.targetCodebase);
    const incoming = this.incomingConnections.getItems().map(conn => conn.sourceCodebase);
    return [...outgoing, ...incoming];
  }

  get outgoingConnectionCount(): number {
    return this.outgoingConnections.length;
  }

  get incomingConnectionCount(): number {
    return this.incomingConnections.length;
  }

  // Technology stack helpers
  get technologyStack(): string[] {
    const stack: string[] = [];
    if (this.language) stack.push(this.language);
    if (this.framework) stack.push(this.framework);

    const additionalTech = this.getAnalysisMetadata<string[]>('detectedTechnologies', []);
    stack.push(...additionalTech);

    return [...new Set(stack)];
  }

  get primaryTechnology(): string | undefined {
    if (this.framework) return this.framework;
    if (this.language) return this.language;
    return this.technologyStack[0];
  }

  // Workspace helpers
  get workspaceId(): string {
    return this.workspace.id;
  }

  get workspaceName(): string {
    return this.workspace.name;
  }

  // Health and quality metrics
  get analysisHealth(): 'healthy' | 'warning' | 'error' | 'unknown' {
    if (this.hasError) return 'error';
    if (!this.lastAnalyzedAt) return 'unknown';

    const daysSinceLastAnalysis = (Date.now() - this.lastAnalyzedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceLastAnalysis > 30) return 'warning';

    return 'healthy';
  }

  get needsAnalysis(): boolean {
    if (!this.lastAnalyzedAt) return true;
    if (this.hasError) return true;

    const daysSinceLastAnalysis = (Date.now() - this.lastAnalyzedAt.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceLastAnalysis > 7;
  }

  // Validation helpers
  validateRepositoryUrl(): boolean {
    if (!this.repositoryUrl) return true;

    try {
      const url = new URL(this.repositoryUrl);
      return ['http:', 'https:', 'git:', 'ssh:'].includes(url.protocol);
    } catch {
      return false;
    }
  }
}
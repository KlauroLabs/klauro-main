import {
  Entity,
  Property,
  ManyToOne,
  Index,
  Enum,
  Unique,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Codebase } from './codebase.entity';
import { User } from './user.entity';

export enum ConnectionType {
  API_CALL = 'api_call',
  DATABASE_SHARED = 'database_shared',
  MESSAGE_QUEUE = 'message_queue',
  EVENT_STREAM = 'event_stream',
  FILE_DEPENDENCY = 'file_dependency',
  PACKAGE_DEPENDENCY = 'package_dependency',
  SERVICE_MESH = 'service_mesh',
  MICROSERVICE = 'microservice',
  MONOREPO = 'monorepo',
  CUSTOM = 'custom',
}

export enum ConnectionStrength {
  WEAK = 'weak',
  MODERATE = 'moderate',
  STRONG = 'strong',
  CRITICAL = 'critical',
}

export enum ConnectionStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  DEPRECATED = 'deprecated',
  BROKEN = 'broken',
}

@Entity({ tableName: 'codebase_connections' })
@Unique({ properties: ['sourceCodebase', 'targetCodebase', 'type'] })
export class CodebaseConnection extends BaseEntity {
  @ManyToOne(() => Codebase, { deleteRule: 'cascade' })
  @Index()
  sourceCodebase!: Codebase;

  @ManyToOne(() => Codebase, { deleteRule: 'cascade' })
  @Index()
  targetCodebase!: Codebase;

  @Enum(() => ConnectionType)
  type!: ConnectionType;

  @Enum(() => ConnectionStrength)
  strength: ConnectionStrength = ConnectionStrength.MODERATE;

  @Enum(() => ConnectionStatus)
  status: ConnectionStatus = ConnectionStatus.ACTIVE;

  @Property({ type: 'varchar', length: 255, nullable: true })
  name?: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ type: 'varchar', length: 500, nullable: true })
  endpoint?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  protocol?: string;

  @Property({ type: 'varchar', length: 50, nullable: true })
  method?: string;

  @Property({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Property({ type: 'jsonb', nullable: true })
  configuration?: Record<string, any>;

  @ManyToOne(() => User, { nullable: true })
  discoveredBy?: User;

  @Property({ type: 'timestamptz', nullable: true })
  discoveredAt?: Date;

  @Property({ type: 'timestamptz', nullable: true })
  lastVerifiedAt?: Date;

  @Property({ type: 'integer', default: 0 })
  usageCount: number = 0;

  @Property({ type: 'timestamptz', nullable: true })
  lastUsedAt?: Date;

  @Property({ type: 'boolean', default: false })
  isAutoDiscovered: boolean = false;

  @Property({ type: 'float', nullable: true })
  confidenceScore?: number;

  // Connection type helpers
  get isApiConnection(): boolean {
    return this.type === ConnectionType.API_CALL;
  }

  get isDatabaseConnection(): boolean {
    return this.type === ConnectionType.DATABASE_SHARED;
  }

  get isMessagingConnection(): boolean {
    return [
      ConnectionType.MESSAGE_QUEUE,
      ConnectionType.EVENT_STREAM
    ].includes(this.type);
  }

  get isDependencyConnection(): boolean {
    return [
      ConnectionType.FILE_DEPENDENCY,
      ConnectionType.PACKAGE_DEPENDENCY
    ].includes(this.type);
  }

  get isArchitecturalConnection(): boolean {
    return [
      ConnectionType.SERVICE_MESH,
      ConnectionType.MICROSERVICE,
      ConnectionType.MONOREPO
    ].includes(this.type);
  }

  // Strength helpers
  get isCritical(): boolean {
    return this.strength === ConnectionStrength.CRITICAL;
  }

  get isStrong(): boolean {
    return this.strength === ConnectionStrength.STRONG;
  }

  get isWeak(): boolean {
    return this.strength === ConnectionStrength.WEAK;
  }

  // Status helpers
  get isActive(): boolean {
    return this.status === ConnectionStatus.ACTIVE && !this.isDeleted;
  }

  get isBroken(): boolean {
    return this.status === ConnectionStatus.BROKEN;
  }

  get isDeprecated(): boolean {
    return this.status === ConnectionStatus.DEPRECATED;
  }

  // Usage tracking
  recordUsage(): void {
    this.usageCount++;
    this.lastUsedAt = new Date();
  }

  updateVerification(): void {
    this.lastVerifiedAt = new Date();
  }

  // Status management
  markAsActive(): void {
    this.status = ConnectionStatus.ACTIVE;
  }

  markAsInactive(): void {
    this.status = ConnectionStatus.INACTIVE;
  }

  markAsDeprecated(): void {
    this.status = ConnectionStatus.DEPRECATED;
  }

  markAsBroken(): void {
    this.status = ConnectionStatus.BROKEN;
  }

  // Strength management
  upgradeStrength(): void {
    switch (this.strength) {
      case ConnectionStrength.WEAK:
        this.strength = ConnectionStrength.MODERATE;
        break;
      case ConnectionStrength.MODERATE:
        this.strength = ConnectionStrength.STRONG;
        break;
      case ConnectionStrength.STRONG:
        this.strength = ConnectionStrength.CRITICAL;
        break;
    }
  }

  downgradeStrength(): void {
    switch (this.strength) {
      case ConnectionStrength.CRITICAL:
        this.strength = ConnectionStrength.STRONG;
        break;
      case ConnectionStrength.STRONG:
        this.strength = ConnectionStrength.MODERATE;
        break;
      case ConnectionStrength.MODERATE:
        this.strength = ConnectionStrength.WEAK;
        break;
    }
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
  getConfiguration<T = any>(key: string, defaultValue?: T): T {
    return this.configuration?.[key] ?? defaultValue;
  }

  setConfiguration(key: string, value: any): void {
    if (!this.configuration) {
      this.configuration = {};
    }
    this.configuration[key] = value;
  }

  // Confidence scoring
  updateConfidenceScore(score: number): void {
    this.confidenceScore = Math.max(0, Math.min(1, score));
  }

  get isHighConfidence(): boolean {
    return (this.confidenceScore ?? 0) >= 0.8;
  }

  get isLowConfidence(): boolean {
    return (this.confidenceScore ?? 0) < 0.5;
  }

  // Connection analysis
  get connectionSummary(): string {
    const source = this.sourceCodebase.name;
    const target = this.targetCodebase.name;
    const typeLabel = this.type.replace('_', ' ');

    return `${source} → ${target} (${typeLabel})`;
  }

  get isValidConnection(): boolean {
    return this.sourceCodebase.id !== this.targetCodebase.id;
  }

  get isBidirectional(): boolean {
    return [
      ConnectionType.DATABASE_SHARED,
      ConnectionType.SERVICE_MESH,
      ConnectionType.MONOREPO
    ].includes(this.type);
  }

  // Health assessment
  get healthStatus(): 'healthy' | 'warning' | 'error' | 'unknown' {
    if (this.isBroken) return 'error';
    if (this.isDeprecated) return 'warning';
    if (!this.isActive) return 'warning';

    if (this.lastVerifiedAt) {
      const daysSinceVerification = (Date.now() - this.lastVerifiedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceVerification > 30) return 'warning';
    } else {
      return 'unknown';
    }

    return 'healthy';
  }

  get needsVerification(): boolean {
    if (!this.lastVerifiedAt) return true;
    const daysSinceVerification = (Date.now() - this.lastVerifiedAt.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceVerification > 14;
  }
}
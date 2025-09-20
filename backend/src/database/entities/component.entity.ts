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
import { AnalysisRun } from './analysis-run.entity';
import { ComponentConnection } from './component-connection.entity';

export enum ComponentType {
  ROUTE = 'route',
  CONTROLLER = 'controller',
  MIDDLEWARE = 'middleware',
  MODEL = 'model',
  SERVICE = 'service',
  UTILITY = 'utility',
  CONFIG = 'config',
  DATABASE = 'database',
  EXTERNAL_API = 'external_api',
  ORPHANED = 'orphaned',
  MODULE = 'module',
  COMPONENT = 'component',
  GUARD = 'guard',
  INTERCEPTOR = 'interceptor',
  PIPE = 'pipe',
  FILTER = 'filter',
  REPOSITORY = 'repository',
  PROVIDER = 'provider',
  HOOK = 'hook',
  HOC = 'hoc',
  STORE = 'store',
}

export enum ArchitecturalLayer {
  PRESENTATION = 'presentation',
  BUSINESS = 'business',
  DATA = 'data',
  INFRASTRUCTURE = 'infrastructure',
  EXTERNAL = 'external',
}

@Entity({ tableName: 'components' })
export class Component extends BaseEntity {
  @ManyToOne(() => AnalysisRun, { deleteRule: 'cascade' })
  @Index()
  analysisRun!: AnalysisRun;

  @Property({ type: 'varchar', length: 255 })
  name!: string;

  @Enum(() => ComponentType)
  type!: ComponentType;

  @Property({ type: 'varchar', length: 500 })
  path!: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  language?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  framework?: string;

  @Enum(() => ArchitecturalLayer)
  layer!: ArchitecturalLayer;

  @Property({ type: 'integer' })
  lineCount: number = 0;

  @Property({ type: 'integer' })
  complexity: number = 0;

  @Property({ type: 'json', nullable: true })
  exports?: string[];

  @Property({ type: 'json', nullable: true })
  imports?: string[];

  @Property({ type: 'json', nullable: true })
  httpMethods?: string[];

  @Property({ type: 'json', nullable: true })
  dbQueries?: string[];

  @Property({ type: 'json', nullable: true })
  externalCalls?: string[];

  @Property({ type: 'boolean' })
  isEntry: boolean = false;

  @Property({ type: 'boolean' })
  isOrphaned: boolean = false;

  @Property({ type: 'json', nullable: true })
  responsibilities?: string[];

  @Property({ type: 'text', nullable: true })
  aiDescription?: string;

  @Property({ type: 'jsonb', nullable: true })
  functions?: Array<{
    name: string;
    signature: string;
    parameters: Array<{
      name: string;
      type: string;
      isOptional: boolean;
    }>;
    returnType: string;
    complexity: number;
    lineCount: number;
    isPublic: boolean;
    isAsync: boolean;
  }>;

  @Property({ type: 'float', nullable: true })
  testCoverage?: number;

  @Property({ type: 'jsonb', nullable: true })
  performanceMetrics?: {
    avgResponseTime?: number;
    throughput?: number;
    errorRate?: number;
    memoryUsage?: number;
    cpuUsage?: number;
    lastUpdated: Date;
  };

  @Property({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  // Position for visualization
  @Property({ type: 'float', nullable: true })
  positionX?: number;

  @Property({ type: 'float', nullable: true })
  positionY?: number;

  // Connections
  @OneToMany(() => ComponentConnection, connection => connection.fromComponent)
  outgoingConnections = new Collection<ComponentConnection>(this);

  @OneToMany(() => ComponentConnection, connection => connection.toComponent)
  incomingConnections = new Collection<ComponentConnection>(this);

  // Computed properties
  get fullPath(): string {
    return this.path;
  }

  get fileName(): string {
    const parts = this.path.split('/');
    return parts[parts.length - 1] || this.name;
  }

  get directory(): string {
    const parts = this.path.split('/');
    return parts.slice(0, -1).join('/');
  }

  get position(): { x: number; y: number } | undefined {
    if (this.positionX !== undefined && this.positionY !== undefined) {
      return { x: this.positionX, y: this.positionY };
    }
    return undefined;
  }

  setPosition(x: number, y: number): void {
    this.positionX = x;
    this.positionY = y;
  }

  // Metrics helpers
  get metrics(): {
    linesOfCode: number;
    complexity: number;
    maintainability: number;
    testCoverage?: number;
    duplicateCode?: number;
    technicalDebt?: number;
  } {
    return {
      linesOfCode: this.lineCount,
      complexity: this.complexity,
      maintainability: Math.max(0, 100 - (this.complexity * 2)),
      testCoverage: this.testCoverage,
      duplicateCode: this.getMetadata('duplicateCode'),
      technicalDebt: this.getMetadata('technicalDebt'),
    };
  }

  // Connection helpers
  get dependencies(): string[] {
    return this.outgoingConnections.getItems().map(conn => conn.toComponent.id);
  }

  get dependents(): string[] {
    return this.incomingConnections.getItems().map(conn => conn.fromComponent.id);
  }

  get connectionCount(): number {
    return this.outgoingConnections.length + this.incomingConnections.length;
  }

  // Function analysis
  get functionCount(): number {
    return this.functions?.length || 0;
  }

  get averageFunctionComplexity(): number {
    if (!this.functions || this.functions.length === 0) return 0;
    const total = this.functions.reduce((sum, fn) => sum + fn.complexity, 0);
    return total / this.functions.length;
  }

  get publicFunctionCount(): number {
    return this.functions?.filter(fn => fn.isPublic).length || 0;
  }

  get asyncFunctionCount(): number {
    return this.functions?.filter(fn => fn.isAsync).length || 0;
  }

  // Risk assessment
  get riskLevel(): 'low' | 'medium' | 'high' | 'critical' {
    let riskScore = 0;
    
    // High complexity
    if (this.complexity > 10) riskScore += 3;
    else if (this.complexity > 5) riskScore += 1;
    
    // Large file
    if (this.lineCount > 1000) riskScore += 2;
    else if (this.lineCount > 500) riskScore += 1;
    
    // Low test coverage
    if (this.testCoverage !== undefined) {
      if (this.testCoverage < 50) riskScore += 2;
      else if (this.testCoverage < 80) riskScore += 1;
    }
    
    // High connection count
    if (this.connectionCount > 10) riskScore += 2;
    else if (this.connectionCount > 5) riskScore += 1;
    
    // Orphaned components
    if (this.isOrphaned) riskScore += 1;
    
    if (riskScore >= 6) return 'critical';
    if (riskScore >= 4) return 'high';
    if (riskScore >= 2) return 'medium';
    return 'low';
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

  // Business logic helpers
  isWebRoute(): boolean {
    return this.type === ComponentType.ROUTE && 
           (this.httpMethods?.length || 0) > 0;
  }

  isDatabaseConnected(): boolean {
    return (this.dbQueries?.length || 0) > 0;
  }

  hasExternalDependencies(): boolean {
    return (this.externalCalls?.length || 0) > 0;
  }

  isEntryPoint(): boolean {
    return this.isEntry;
  }

  isExitPoint(): boolean {
    return this.hasExternalDependencies() || this.isDatabaseConnected();
  }
}
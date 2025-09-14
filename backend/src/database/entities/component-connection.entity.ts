import {
  Entity,
  Property,
  ManyToOne,
  Index,
  Enum,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Component } from './component.entity';

export enum ConnectionType {
  IMPORT = 'import',
  HTTP_CALL = 'http_call',
  DATABASE = 'database',
  MIDDLEWARE_CHAIN = 'middleware_chain',
  FUNCTION_CALL = 'function_call',
  DATA_FLOW = 'data_flow',
  DEPENDENCY_INJECTION = 'dependency_injection',
  DATA_RELATIONSHIP = 'data_relationship',
  CONTAINS = 'contains',
  FORM_HANDLING = 'form_handling',
  TEMPLATE_INHERITANCE = 'template_inheritance',
  TEMPLATE_INCLUDE = 'template_include',
  USES_MIDDLEWARE = 'uses_middleware',
  USES_MODEL = 'uses_model',
  ROUTE_CONTROLLER = 'route_controller',
  MODULE_IMPORT = 'module_import',
  MODULE_CONTROLLER = 'module_controller',
  MODULE_PROVIDER = 'module_provider',
  DEPENDENCY = 'dependency',
  NAVIGATION = 'navigation',
  GUARDS = 'guards',
  INTERCEPTS = 'intercepts',
  API_CALL = 'api_call',
}

@Entity({ tableName: 'component_connections' })
@Index({ properties: ['fromComponent', 'toComponent', 'type'] })
export class ComponentConnection extends BaseEntity {
  @ManyToOne(() => Component, { deleteRule: 'cascade' })
  fromComponent!: Component;

  @ManyToOne(() => Component, { deleteRule: 'cascade' })
  toComponent!: Component;

  @Enum(() => ConnectionType)
  type!: ConnectionType;

  @Property({ type: 'integer', nullable: true })
  weight?: number; // Usage frequency/importance

  @Property({ type: 'varchar', length: 100, nullable: true })
  protocol?: string; // Protocol/framework used

  @Property({ type: 'integer', nullable: true })
  callSites?: number;

  @Property({ type: 'varchar', length: 100, nullable: true })
  dataFlow?: string;

  @Property({ type: 'varchar', length: 20, nullable: true })
  httpMethod?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  injectionType?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  relationship?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  importType?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  scope?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  relationType?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  middlewareName?: string;

  @Property({ type: 'varchar', length: 200, nullable: true })
  basePath?: string;

  @Property({ type: 'varchar', length: 200, nullable: true })
  routePath?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  formName?: string;

  @Property({ type: 'varchar', length: 200, nullable: true })
  path?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  guardType?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  layoutType?: string;

  @Property({ type: 'json', nullable: true })
  methods?: string[];

  @Property({ type: 'varchar', length: 100, nullable: true })
  pageType?: string;

  @Property({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  // Helper methods for connection analysis
  get strength(): 'weak' | 'medium' | 'strong' {
    if (this.weight) {
      if (this.weight >= 10) return 'strong';
      if (this.weight >= 5) return 'medium';
    }
    
    // Determine strength based on connection type
    switch (this.type) {
      case ConnectionType.DEPENDENCY_INJECTION:
      case ConnectionType.ROUTE_CONTROLLER:
      case ConnectionType.MODULE_PROVIDER:
        return 'strong';
      
      case ConnectionType.FUNCTION_CALL:
      case ConnectionType.DATABASE:
      case ConnectionType.HTTP_CALL:
        return 'medium';
      
      default:
        return 'weak';
    }
  }

  get isDirectional(): boolean {
    // Some connections are bidirectional
    return ![
      ConnectionType.DATA_RELATIONSHIP,
      ConnectionType.TEMPLATE_INHERITANCE,
    ].includes(this.type);
  }

  get isCritical(): boolean {
    return [
      ConnectionType.DATABASE,
      ConnectionType.HTTP_CALL,
      ConnectionType.DEPENDENCY_INJECTION,
      ConnectionType.ROUTE_CONTROLLER,
    ].includes(this.type);
  }

  get isDataFlow(): boolean {
    return [
      ConnectionType.DATA_FLOW,
      ConnectionType.DATA_RELATIONSHIP,
      ConnectionType.DATABASE,
      ConnectionType.API_CALL,
    ].includes(this.type);
  }

  get isControlFlow(): boolean {
    return [
      ConnectionType.FUNCTION_CALL,
      ConnectionType.MIDDLEWARE_CHAIN,
      ConnectionType.ROUTE_CONTROLLER,
      ConnectionType.GUARDS,
      ConnectionType.INTERCEPTS,
    ].includes(this.type);
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

  // Connection description for visualization
  get description(): string {
    switch (this.type) {
      case ConnectionType.IMPORT:
        return `Imports from ${this.toComponent.name}`;
      case ConnectionType.HTTP_CALL:
        return `Makes ${this.httpMethod || 'HTTP'} request to ${this.toComponent.name}`;
      case ConnectionType.DATABASE:
        return `Queries ${this.toComponent.name} database`;
      case ConnectionType.FUNCTION_CALL:
        return `Calls ${this.toComponent.name}`;
      case ConnectionType.DEPENDENCY_INJECTION:
        return `Injects ${this.toComponent.name}`;
      case ConnectionType.ROUTE_CONTROLLER:
        return `Routes to ${this.toComponent.name}`;
      case ConnectionType.MIDDLEWARE_CHAIN:
        return `Processes through ${this.toComponent.name} middleware`;
      default:
        return `Connected to ${this.toComponent.name}`;
    }
  }

  // Weight calculation based on usage patterns
  calculateWeight(): number {
    let weight = 1;
    
    // Increase weight based on call sites
    if (this.callSites) {
      weight += Math.min(this.callSites, 10);
    }
    
    // Critical connections get higher weight
    if (this.isCritical) {
      weight += 5;
    }
    
    // Data flow connections are important
    if (this.isDataFlow) {
      weight += 3;
    }
    
    return Math.min(weight, 20); // Cap at 20
  }

  updateWeight(): void {
    this.weight = this.calculateWeight();
  }
}
import {
  Entity,
  Property,
  ManyToOne,
  ManyToMany,
  Collection,
  Index,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Component } from './component.entity';
import { FunctionCall } from './function-call.entity';
import { AnalysisRun } from './analysis-run.entity';

@Entity({ tableName: 'call_chains' })
export class CallChain extends BaseEntity {
  @ManyToOne(() => AnalysisRun, { deleteRule: 'cascade' })
  @Index()
  analysisRun!: AnalysisRun;

  @Property({ type: 'varchar', length: 255 })
  @Index()
  chainId!: string; // Unique identifier for this chain

  @Property({ type: 'varchar', length: 50 })
  chainType!: 'entry-to-exit' | 'circular' | 'recursive' | 'dead-end' | 'hot-path' | 'critical-path';

  // Entry point of the chain
  @ManyToOne(() => Component)
  @Index()
  entryComponent!: Component;

  @Property({ type: 'varchar', length: 255 })
  entryFunction!: string;

  // Exit point of the chain (if applicable)
  @ManyToOne(() => Component, { nullable: true })
  exitComponent?: Component;

  @Property({ type: 'varchar', length: 255, nullable: true })
  exitFunction?: string;

  // The complete call path
  @Property({ type: 'jsonb' })
  path!: Array<{
    componentId: string;
    componentName: string;
    functionName: string;
    line: number;
    callType: string;
    depth: number;
  }>;

  @Property({ type: 'integer' })
  length: number = 0; // Number of calls in the chain

  @Property({ type: 'integer' })
  maxDepth: number = 0; // Maximum call depth

  @Property({ type: 'integer' })
  frequency: number = 1; // How often this chain is executed

  @Property({ type: 'float', nullable: true })
  averageExecutionTime?: number; // In milliseconds

  @Property({ type: 'float', nullable: true })
  totalExecutionTime?: number; // In milliseconds

  // Chain characteristics
  @Property({ type: 'boolean' })
  isCircular: boolean = false;

  @Property({ type: 'boolean' })
  isRecursive: boolean = false;

  @Property({ type: 'boolean' })
  isCritical: boolean = false;

  @Property({ type: 'boolean' })
  isHotPath: boolean = false;

  @Property({ type: 'boolean' })
  hasExternalCalls: boolean = false;

  @Property({ type: 'boolean' })
  hasDatabaseCalls: boolean = false;

  @Property({ type: 'boolean' })
  hasAsyncCalls: boolean = false;

  // Components involved in this chain
  @Property({ type: 'json' })
  componentIds!: string[];

  @Property({ type: 'integer' })
  componentCount: number = 0;

  // Functions involved
  @Property({ type: 'json' })
  functionNames!: string[];

  @Property({ type: 'integer' })
  uniqueFunctionCount: number = 0;

  // Performance and risk metrics
  @Property({ type: 'integer' })
  complexity: number = 0; // Overall complexity score

  @Property({ type: 'varchar', length: 20 })
  riskLevel!: 'low' | 'medium' | 'high' | 'critical';

  @Property({ type: 'json', nullable: true })
  riskFactors?: string[];

  @Property({ type: 'json', nullable: true })
  bottlenecks?: Array<{
    componentId: string;
    functionName: string;
    reason: string;
    impact: 'low' | 'medium' | 'high';
  }>;

  // Business context
  @Property({ type: 'varchar', length: 500, nullable: true })
  businessProcess?: string;

  @Property({ type: 'varchar', length: 500, nullable: true })
  userAction?: string;

  @Property({ type: 'json', nullable: true })
  tags?: string[];

  @Property({ type: 'text', nullable: true })
  aiDescription?: string;

  @Property({ type: 'jsonb', nullable: true })
  metadata?: {
    frameworks?: string[];
    libraries?: string[];
    patterns?: string[];
    antiPatterns?: string[];
    recommendations?: string[];
    documentation?: string;
  };

  // Related function calls
  @ManyToMany(() => FunctionCall)
  functionCalls = new Collection<FunctionCall>(this);

  // Helpers
  get isComplete(): boolean {
    return this.entryComponent !== undefined && this.exitComponent !== undefined;
  }

  get averageDepth(): number {
    if (this.length === 0) return 0;
    const totalDepth = this.path.reduce((sum, node) => sum + node.depth, 0);
    return totalDepth / this.length;
  }

  get criticalityScore(): number {
    let score = this.complexity;
    if (this.isCritical) score += 10;
    if (this.isHotPath) score += 5;
    if (this.isCircular) score += 8;
    if (this.hasExternalCalls) score += 3;
    if (this.hasDatabaseCalls) score += 3;
    if (this.bottlenecks && this.bottlenecks.length > 0) {
      score += this.bottlenecks.length * 2;
    }
    return score;
  }

  hasComponent(componentId: string): boolean {
    return this.componentIds.includes(componentId);
  }

  hasFunction(functionName: string): boolean {
    return this.functionNames.includes(functionName);
  }

  getPathSegment(startIndex: number, endIndex?: number): typeof this.path {
    return this.path.slice(startIndex, endIndex);
  }

  getComponentSequence(): string[] {
    return this.path.map(node => node.componentId);
  }

  getFunctionSequence(): string[] {
    return this.path.map(node => node.functionName);
  }
}
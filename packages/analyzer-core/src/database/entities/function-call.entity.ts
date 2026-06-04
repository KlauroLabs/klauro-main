import {
  Entity,
  Property,
  ManyToOne,
  Index,
  Unique,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Component } from './component.entity';
import { AnalysisRun } from './analysis-run.entity';

@Entity({ tableName: 'function_calls' })
@Unique({ properties: ['callerComponent', 'callerFunction', 'targetComponent', 'targetFunction', 'callLocation'] })
export class FunctionCall extends BaseEntity {
  @ManyToOne(() => AnalysisRun, { deleteRule: 'cascade' })
  @Index()
  analysisRun!: AnalysisRun;

  // Caller information
  @ManyToOne(() => Component)
  @Index()
  callerComponent!: Component;

  @Property({ type: 'varchar', length: 255 })
  @Index()
  callerFunction!: string;

  @Property({ type: 'varchar', length: 500 })
  callerSignature!: string;

  // Target information
  @ManyToOne(() => Component, { nullable: true })
  @Index()
  targetComponent?: Component;

  @Property({ type: 'varchar', length: 255 })
  @Index()
  targetFunction!: string;

  @Property({ type: 'varchar', length: 500, nullable: true })
  targetSignature?: string;

  // Call details
  @Property({ type: 'integer' })
  line!: number;

  @Property({ type: 'integer' })
  column!: number;

  @Property({ type: 'varchar', length: 100 })
  callLocation!: string; // line:column for uniqueness

  @Property({ type: 'varchar', length: 50 })
  callType!: 'direct' | 'method' | 'callback' | 'async' | 'hook' | 'dynamic' | 'recursive';

  @Property({ type: 'integer' })
  argumentCount: number = 0;

  @Property({ type: 'boolean' })
  isAsync: boolean = false;

  @Property({ type: 'boolean' })
  isConditional: boolean = false;

  @Property({ type: 'boolean' })
  isInLoop: boolean = false;

  @Property({ type: 'boolean' })
  isRecursive: boolean = false;

  @Property({ type: 'json', nullable: true })
  arguments?: Array<{
    position: number;
    type?: string;
    value?: string;
    isLiteral: boolean;
  }>;

  @Property({ type: 'varchar', length: 500, nullable: true })
  context?: string; // The context or reason for the call

  @Property({ type: 'integer' })
  depth: number = 0; // Call depth in the chain

  @Property({ type: 'integer' })
  frequency: number = 1; // How many times this call appears

  @Property({ type: 'jsonb', nullable: true })
  metadata?: {
    parentFunction?: string;
    enclosingClass?: string;
    enclosingModule?: string;
    isEventHandler?: boolean;
    isLifecycleHook?: boolean;
    isUtilityCall?: boolean;
    framework?: string;
    tags?: string[];
  };

  // Performance hints
  @Property({ type: 'boolean' })
  isPotentialBottleneck: boolean = false;

  @Property({ type: 'boolean' })
  isHotPath: boolean = false;

  // Helpers
  get callerId(): string {
    return `${this.callerComponent.id}::${this.callerFunction}`;
  }

  get targetId(): string {
    return this.targetComponent
      ? `${this.targetComponent.id}::${this.targetFunction}`
      : `external::${this.targetFunction}`;
  }

  get isExternal(): boolean {
    return !this.targetComponent;
  }

  get isFrameworkCall(): boolean {
    return this.metadata?.framework !== undefined;
  }

  get complexity(): number {
    let score = 1;
    if (this.isAsync) score++;
    if (this.isConditional) score++;
    if (this.isInLoop) score += 2;
    if (this.isRecursive) score += 3;
    if (this.argumentCount > 3) score++;
    return score;
  }
}
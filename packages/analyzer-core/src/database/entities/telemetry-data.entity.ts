import { Entity, Property, Index, JsonType } from '@mikro-orm/core';
import { BaseEntity } from './base.entity';

export enum TelemetryPayloadType {
  METRIC = 'metric',
  TRACE = 'trace', 
  EVENT = 'event',
  HEARTBEAT = 'heartbeat',
}

@Entity({ tableName: 'telemetry_data' })
@Index({ properties: ['projectId', 'timestamp'] })
@Index({ properties: ['type', 'timestamp'] })
@Index({ properties: ['projectId', 'type', 'timestamp'] })
export class TelemetryData extends BaseEntity {
  @Property({ type: 'varchar', length: 36 })
  @Index()
  projectId!: string;

  @Property({ type: 'varchar', length: 36 })
  organizationId!: string;

  @Property({ type: 'varchar', length: 20 })
  @Index()
  type!: TelemetryPayloadType;

  @Property({ type: 'timestamptz' })
  @Index()
  timestamp!: Date;

  @Property({ type: JsonType })
  data: any;

  @Property({ type: JsonType, nullable: true })
  metadata?: {
    sdkVersion?: string;
    runtime?: string;
    hostname?: string;
    environment?: string;
  };

  @Property({ nullable: true })
  componentId?: string;

  @Property({ type: 'text[]', nullable: true })
  tags?: string[];

  @Property({ type: JsonType, nullable: true })
  attributes?: Record<string, any>;

  @Property({ default: false })
  processed: boolean = false;

  @Property({ nullable: true })
  processedAt?: Date;

  @Property({ nullable: true })
  aggregationWindow?: string;

  @Property({ type: 'float', nullable: true })
  @Index()
  score?: number; // For hotspot detection

  constructor(partial?: Partial<TelemetryData>) {
    super();
    Object.assign(this, partial);
  }
}
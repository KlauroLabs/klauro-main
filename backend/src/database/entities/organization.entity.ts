import {
  Entity,
  Property,
  OneToMany,
  Collection,
  Index,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Membership } from './membership.entity';
import { Project } from './project.entity';

@Entity({ tableName: 'organizations' })
export class Organization extends BaseEntity {
  @Property({ type: 'varchar', length: 255 })
  name!: string;

  @Property({ type: 'varchar', length: 100, unique: true })
  slug!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  websiteUrl?: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  logoUrl?: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  billingEmail?: string;

  @Property({ type: 'jsonb', nullable: true })
  settings?: Record<string, any>;

  @OneToMany(() => Membership, membership => membership.organization)
  memberships = new Collection<Membership>(this);

  @OneToMany(() => Project, project => project.organization)
  projects = new Collection<Project>(this);

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

  // Business logic helpers
  get memberCount(): number {
    return this.memberships.length;
  }

  get projectCount(): number {
    return this.projects.length;
  }
}
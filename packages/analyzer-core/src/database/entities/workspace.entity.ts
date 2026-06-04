import {
  Entity,
  Property,
  ManyToOne,
  OneToMany,
  Collection,
  Index,
  Enum,
  Check,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { User } from './user.entity';
import { WorkspaceAccess } from './workspace-access.entity';

export enum WorkspaceVisibility {
  PRIVATE = 'private',
  PUBLIC = 'public',
  INTERNAL = 'internal',
}

@Entity({ tableName: 'workspaces' })
@Check({ expression: '(user_id IS NOT NULL AND organization_id IS NULL) OR (user_id IS NULL AND organization_id IS NOT NULL)' })
export class Workspace extends BaseEntity {
  @Property({ type: 'varchar', length: 255 })
  name!: string;

  @Property({ type: 'varchar', length: 100, unique: true })
  @Index()
  slug!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  @Enum(() => WorkspaceVisibility)
  visibility: WorkspaceVisibility = WorkspaceVisibility.PRIVATE;

  @ManyToOne(() => User, { nullable: true, deleteRule: 'cascade' })
  @Index()
  user?: User;

  @ManyToOne(() => Organization, { nullable: true, deleteRule: 'cascade' })
  @Index()
  organization?: Organization;

  @Property({ type: 'jsonb', nullable: true })
  settings?: Record<string, any>;

  @OneToMany(() => WorkspaceAccess, access => access.workspace)
  accessGrants = new Collection<WorkspaceAccess>(this);

  @Property({ type: 'boolean', default: true })
  isActive: boolean = true;

  // Virtual properties
  get owner(): User | Organization {
    if (this.user) return this.user;
    if (this.organization) return this.organization;
    throw new Error('Workspace must have either user or organization owner');
  }

  get ownerType(): 'user' | 'organization' {
    return this.user ? 'user' : 'organization';
  }

  get ownerId(): string {
    return this.owner.id;
  }

  get isUserOwned(): boolean {
    return this.user !== undefined;
  }

  get isOrganizationOwned(): boolean {
    return this.organization !== undefined;
  }

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

  // Visibility methods
  get isPublic(): boolean {
    return this.visibility === WorkspaceVisibility.PUBLIC;
  }

  get isPrivate(): boolean {
    return this.visibility === WorkspaceVisibility.PRIVATE;
  }

  get isInternal(): boolean {
    return this.visibility === WorkspaceVisibility.INTERNAL;
  }

  makePublic(): void {
    this.visibility = WorkspaceVisibility.PUBLIC;
  }

  makePrivate(): void {
    this.visibility = WorkspaceVisibility.PRIVATE;
  }

  makeInternal(): void {
    this.visibility = WorkspaceVisibility.INTERNAL;
  }

  // Status methods
  archive(): void {
    this.isActive = false;
    this.softDelete();
  }

  restore(): void {
    this.isActive = true;
    this.deletedAt = undefined;
  }

  get isArchived(): boolean {
    return !this.isActive || this.isDeleted;
  }

  // Access control helpers
  get accessGrantCount(): number {
    return this.accessGrants.length;
  }

  // Validation
  validateOwnership(): void {
    const hasUser = this.user !== undefined;
    const hasOrganization = this.organization !== undefined;

    if (hasUser && hasOrganization) {
      throw new Error('Workspace cannot be owned by both user and organization');
    }

    if (!hasUser && !hasOrganization) {
      throw new Error('Workspace must be owned by either user or organization');
    }
  }
}
import {
  Entity,
  Property,
  ManyToOne,
  Index,
  Enum,
  Unique,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Workspace } from './workspace.entity';
import { User } from './user.entity';

export enum WorkspaceRole {
  ADMIN = 'admin',
  EDITOR = 'editor',
  VIEWER = 'viewer',
}

export enum AccessStatus {
  ACTIVE = 'active',
  PENDING = 'pending',
  REVOKED = 'revoked',
}

@Entity({ tableName: 'workspace_access' })
@Unique({ properties: ['workspace', 'user'] })
export class WorkspaceAccess extends BaseEntity {
  @ManyToOne(() => Workspace, { deleteRule: 'cascade' })
  @Index()
  workspace!: Workspace;

  @ManyToOne(() => User, { deleteRule: 'cascade' })
  @Index()
  user!: User;

  @Enum(() => WorkspaceRole)
  role!: WorkspaceRole;

  @Enum(() => AccessStatus)
  status: AccessStatus = AccessStatus.ACTIVE;

  @ManyToOne(() => User, { nullable: true })
  grantedBy?: User;

  @Property({ type: 'timestamptz', nullable: true })
  grantedAt?: Date;

  @Property({ type: 'timestamptz', nullable: true })
  revokedAt?: Date;

  @ManyToOne(() => User, { nullable: true })
  revokedBy?: User;

  @Property({ type: 'timestamptz', nullable: true })
  expiresAt?: Date;

  @Property({ type: 'text', nullable: true })
  notes?: string;

  @Property({ type: 'jsonb', nullable: true })
  permissions?: Record<string, boolean>;

  // Role checking methods
  get isAdmin(): boolean {
    return this.role === WorkspaceRole.ADMIN && this.isActive;
  }

  get isEditor(): boolean {
    return (this.role === WorkspaceRole.EDITOR || this.isAdmin) && this.isActive;
  }

  get isViewer(): boolean {
    return this.isActive;
  }

  get canRead(): boolean {
    return this.isActive;
  }

  get canWrite(): boolean {
    return this.isEditor || this.isAdmin;
  }

  get canAdmin(): boolean {
    return this.isAdmin;
  }

  // Status checking methods
  get isActive(): boolean {
    return this.status === AccessStatus.ACTIVE && !this.isExpired && !this.isDeleted;
  }

  get isPending(): boolean {
    return this.status === AccessStatus.PENDING;
  }

  get isRevoked(): boolean {
    return this.status === AccessStatus.REVOKED;
  }

  get isExpired(): boolean {
    return this.expiresAt ? this.expiresAt < new Date() : false;
  }

  // Permission methods
  hasPermission(permission: string): boolean {
    if (!this.isActive) return false;
    return this.permissions?.[permission] ?? false;
  }

  grantPermission(permission: string): void {
    if (!this.permissions) {
      this.permissions = {};
    }
    this.permissions[permission] = true;
  }

  revokePermission(permission: string): void {
    if (!this.permissions) {
      this.permissions = {};
    }
    this.permissions[permission] = false;
  }

  // Access management methods
  activate(grantedBy?: User): void {
    this.status = AccessStatus.ACTIVE;
    this.grantedAt = new Date();
    this.grantedBy = grantedBy;
    this.revokedAt = undefined;
    this.revokedBy = undefined;
  }

  revoke(revokedBy?: User, reason?: string): void {
    this.status = AccessStatus.REVOKED;
    this.revokedAt = new Date();
    this.revokedBy = revokedBy;
    if (reason) {
      this.notes = reason;
    }
  }

  setExpiration(expiresAt: Date): void {
    this.expiresAt = expiresAt;
  }

  removeExpiration(): void {
    this.expiresAt = undefined;
  }

  // Role management methods
  promoteToAdmin(): void {
    this.role = WorkspaceRole.ADMIN;
  }

  promoteToEditor(): void {
    this.role = WorkspaceRole.EDITOR;
  }

  demoteToViewer(): void {
    this.role = WorkspaceRole.VIEWER;
  }

  // Helper methods
  get roleHierarchyLevel(): number {
    switch (this.role) {
      case WorkspaceRole.ADMIN:
        return 3;
      case WorkspaceRole.EDITOR:
        return 2;
      case WorkspaceRole.VIEWER:
        return 1;
      default:
        return 0;
    }
  }

  canGrantRole(targetRole: WorkspaceRole): boolean {
    if (!this.isAdmin) return false;

    const targetLevel = this.getRoleHierarchyLevel(targetRole);
    return this.roleHierarchyLevel >= targetLevel;
  }

  private getRoleHierarchyLevel(role: WorkspaceRole): number {
    switch (role) {
      case WorkspaceRole.ADMIN:
        return 3;
      case WorkspaceRole.EDITOR:
        return 2;
      case WorkspaceRole.VIEWER:
        return 1;
      default:
        return 0;
    }
  }
}
import {
  Entity,
  Property,
  ManyToOne,
  Index,
  Unique,
  Enum,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';
import { Organization } from './organization.entity';

export enum MembershipRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MEMBER = 'member',
  VIEWER = 'viewer',
}

@Entity({ tableName: 'memberships' })
@Index({ properties: ['user', 'organization'] })
@Unique({ properties: ['user', 'organization'] })
export class Membership extends BaseEntity {
  @ManyToOne(() => User, { deleteRule: 'cascade' })
  user!: User;

  @ManyToOne(() => Organization, { deleteRule: 'cascade' })
  organization!: Organization;

  @Enum(() => MembershipRole)
  role!: MembershipRole;

  @Property({ type: 'json', nullable: true })
  permissions?: string[];

  @Property({ type: 'uuid', nullable: true })
  invitedBy?: string;

  @Property({ type: 'timestamptz', nullable: true })
  invitedAt?: Date;

  @Property({ type: 'timestamptz', nullable: true })
  joinedAt?: Date;

  // Helper methods
  get isOwner(): boolean {
    return this.role === MembershipRole.OWNER;
  }

  get isAdmin(): boolean {
    return this.role === MembershipRole.ADMIN || this.isOwner;
  }

  get canManage(): boolean {
    return this.isAdmin;
  }

  get canView(): boolean {
    return Object.values(MembershipRole).includes(this.role);
  }

  hasPermission(permission: string): boolean {
    if (this.isOwner) return true;
    return this.permissions?.includes(permission) ?? false;
  }

  addPermission(permission: string): void {
    if (!this.permissions) {
      this.permissions = [];
    }
    if (!this.permissions.includes(permission)) {
      this.permissions.push(permission);
    }
  }

  removePermission(permission: string): void {
    if (this.permissions) {
      this.permissions = this.permissions.filter(p => p !== permission);
    }
  }

  // Invitation methods
  markAsInvited(invitedBy: string): void {
    this.invitedBy = invitedBy;
    this.invitedAt = new Date();
  }

  acceptInvitation(): void {
    this.joinedAt = new Date();
  }

  get isInvitationPending(): boolean {
    return this.invitedAt !== undefined && this.joinedAt === undefined;
  }

  get isActive(): boolean {
    return this.joinedAt !== undefined;
  }
}
import {
  Entity,
  Property,
  OneToMany,
  Collection,
  Index,
  BeforeCreate,
  BeforeUpdate,
  Enum,
} from '@mikro-orm/core';
import * as bcrypt from 'bcrypt';
import { BaseEntity } from './base.entity';
import { Membership } from './membership.entity';
import { Codebase } from './codebase.entity';
import { Workspace } from './workspace.entity';
import { WorkspaceAccess } from './workspace-access.entity';

export enum BillingTier {
  FREE = 'free',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}

@Entity({ tableName: 'users' })
export class User extends BaseEntity {
  @Property({ type: 'varchar', length: 255 })
  @Index()
  email!: string;

  @Property({ type: 'timestamptz', nullable: true })
  emailVerifiedAt?: Date;

  @Property({ type: 'varchar', length: 255, nullable: true, hidden: true })
  passwordHash?: string;

  @Property({ type: 'varchar', length: 200 })
  name!: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  firstName?: string;

  @Property({ type: 'varchar', length: 100, nullable: true })
  lastName?: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  avatarUrl?: string;

  @Property({ type: 'varchar', length: 50, nullable: true })
  timezone?: string;

  @Property({ type: 'varchar', length: 10, nullable: true })
  locale?: string;

  @Property({ type: 'timestamptz', nullable: true })
  lastLoginAt?: Date;

  @Property({ type: 'jsonb', nullable: true })
  settings?: Record<string, any>;

  @Property({ type: 'boolean', default: false })
  onboardingCompleted: boolean = false;

  @Enum(() => BillingTier)
  billingTier: BillingTier = BillingTier.FREE;

  @OneToMany(() => Membership, membership => membership.user)
  memberships = new Collection<Membership>(this);

  @OneToMany(() => Codebase, codebase => codebase.owner)
  ownedCodebases = new Collection<Codebase>(this);

  @OneToMany(() => Workspace, workspace => workspace.user)
  ownedWorkspaces = new Collection<Workspace>(this);

  @OneToMany(() => WorkspaceAccess, access => access.user)
  workspaceAccess = new Collection<WorkspaceAccess>(this);

  // Virtual properties
  get fullName(): string {
    if (this.firstName && this.lastName) {
      return `${this.firstName} ${this.lastName}`;
    }
    if (this.firstName) return this.firstName;
    if (this.lastName) return this.lastName;
    return this.email;
  }

  get displayName(): string {
    return this.fullName;
  }

  // Password methods
  async setPassword(password: string): Promise<void> {
    if (password) {
      this.passwordHash = await bcrypt.hash(password, 12);
    }
  }

  async verifyPassword(password: string): Promise<boolean> {
    if (!this.passwordHash) return false;
    return bcrypt.compare(password, this.passwordHash);
  }

  // Verification methods
  markEmailAsVerified(): void {
    this.emailVerifiedAt = new Date();
  }

  get isEmailVerified(): boolean {
    return this.emailVerifiedAt !== undefined;
  }

  // Login tracking
  updateLastLogin(): void {
    this.lastLoginAt = new Date();
  }

  @BeforeCreate()
  @BeforeUpdate()
  async hashPassword() {
    // This will be handled by setPassword method explicitly
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

  // Onboarding methods
  completeOnboarding(): void {
    this.onboardingCompleted = true;
  }

  get needsOnboarding(): boolean {
    return !this.onboardingCompleted;
  }

  // Billing methods
  upgradeBillingTier(tier: BillingTier): void {
    this.billingTier = tier;
  }

  get isFreeUser(): boolean {
    return this.billingTier === BillingTier.FREE;
  }

  get isStarterUser(): boolean {
    return this.billingTier === BillingTier.STARTER;
  }

  get isProfessionalUser(): boolean {
    return this.billingTier === BillingTier.PROFESSIONAL;
  }

  get isEnterpriseUser(): boolean {
    return this.billingTier === BillingTier.ENTERPRISE;
  }

  get isPaidUser(): boolean {
    return this.billingTier !== BillingTier.FREE;
  }

  // Workspace helpers
  get totalWorkspaces(): number {
    return this.ownedWorkspaces.length;
  }

  get totalCodebases(): number {
    return this.ownedCodebases.length;
  }

  get accessibleWorkspaces(): Workspace[] {
    const ownedWorkspaces = this.ownedWorkspaces.getItems();
    const accessedWorkspaces = this.workspaceAccess.getItems()
      .filter(access => access.isActive)
      .map(access => access.workspace);

    return [...ownedWorkspaces, ...accessedWorkspaces];
  }

  // Permission helpers
  canCreateWorkspace(): boolean {
    if (this.isEnterpriseUser) return true;
    if (this.isProfessionalUser && this.totalWorkspaces < 10) return true;
    if (this.isStarterUser && this.totalWorkspaces < 3) return true;
    if (this.isFreeUser && this.totalWorkspaces < 1) return true;
    return false;
  }

  canCreateCodebase(): boolean {
    if (this.isEnterpriseUser) return true;
    if (this.isProfessionalUser && this.totalCodebases < 50) return true;
    if (this.isStarterUser && this.totalCodebases < 10) return true;
    if (this.isFreeUser && this.totalCodebases < 3) return true;
    return false;
  }

  getWorkspaceLimit(): number {
    switch (this.billingTier) {
      case BillingTier.FREE:
        return 1;
      case BillingTier.STARTER:
        return 3;
      case BillingTier.PROFESSIONAL:
        return 10;
      case BillingTier.ENTERPRISE:
        return -1; // unlimited
      default:
        return 0;
    }
  }

  getCodebaseLimit(): number {
    switch (this.billingTier) {
      case BillingTier.FREE:
        return 3;
      case BillingTier.STARTER:
        return 10;
      case BillingTier.PROFESSIONAL:
        return 50;
      case BillingTier.ENTERPRISE:
        return -1; // unlimited
      default:
        return 0;
    }
  }
}
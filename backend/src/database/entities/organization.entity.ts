import {
  Entity,
  Property,
  OneToMany,
  ManyToOne,
  Collection,
  Index,
  Enum,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Membership } from './membership.entity';
import { User } from './user.entity';
import { Workspace } from './workspace.entity';

export enum OrganizationBillingTier {
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}

export enum BillingStatus {
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELLED = 'cancelled',
  SUSPENDED = 'suspended',
  TRIAL = 'trial',
}

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

  @ManyToOne(() => User)
  @Index()
  owner!: User;

  @Enum(() => OrganizationBillingTier)
  billingTier: OrganizationBillingTier = OrganizationBillingTier.STARTER;

  @Enum(() => BillingStatus)
  billingStatus: BillingStatus = BillingStatus.TRIAL;

  @Property({ type: 'varchar', length: 255, nullable: true })
  billingCustomerId?: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  billingSubscriptionId?: string;

  @Property({ type: 'timestamptz', nullable: true })
  trialEndsAt?: Date;

  @Property({ type: 'timestamptz', nullable: true })
  billingPeriodStartsAt?: Date;

  @Property({ type: 'timestamptz', nullable: true })
  billingPeriodEndsAt?: Date;

  @OneToMany(() => Membership, membership => membership.organization)
  memberships = new Collection<Membership>(this);

  @OneToMany(() => Workspace, workspace => workspace.organization)
  workspaces = new Collection<Workspace>(this);

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

  get workspaceCount(): number {
    return this.workspaces.length;
  }

  // Ownership helpers
  get ownerId(): string {
    return this.owner.id;
  }

  get ownerName(): string {
    return this.owner.displayName;
  }

  // Billing helpers
  get isStarterTier(): boolean {
    return this.billingTier === OrganizationBillingTier.STARTER;
  }

  get isProfessionalTier(): boolean {
    return this.billingTier === OrganizationBillingTier.PROFESSIONAL;
  }

  get isEnterpriseTier(): boolean {
    return this.billingTier === OrganizationBillingTier.ENTERPRISE;
  }

  get isBillingActive(): boolean {
    return this.billingStatus === BillingStatus.ACTIVE;
  }

  get isPastDue(): boolean {
    return this.billingStatus === BillingStatus.PAST_DUE;
  }

  get isCancelled(): boolean {
    return this.billingStatus === BillingStatus.CANCELLED;
  }

  get isSuspended(): boolean {
    return this.billingStatus === BillingStatus.SUSPENDED;
  }

  get isInTrial(): boolean {
    return this.billingStatus === BillingStatus.TRIAL;
  }

  get isTrialExpired(): boolean {
    if (!this.isInTrial || !this.trialEndsAt) return false;
    return this.trialEndsAt < new Date();
  }

  get trialDaysRemaining(): number {
    if (!this.isInTrial || !this.trialEndsAt) return 0;
    const daysRemaining = Math.ceil(
      (this.trialEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
    return Math.max(0, daysRemaining);
  }

  get canAccess(): boolean {
    return this.isBillingActive || (this.isInTrial && !this.isTrialExpired);
  }

  // Billing management methods
  upgradeTier(tier: OrganizationBillingTier): void {
    this.billingTier = tier;
  }

  updateBillingStatus(status: BillingStatus): void {
    this.billingStatus = status;
  }

  setBillingCustomer(customerId: string): void {
    this.billingCustomerId = customerId;
  }

  setBillingSubscription(subscriptionId: string): void {
    this.billingSubscriptionId = subscriptionId;
  }

  startTrial(trialDays: number = 14): void {
    this.billingStatus = BillingStatus.TRIAL;
    this.trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
  }

  endTrial(): void {
    this.trialEndsAt = new Date();
  }

  setBillingPeriod(startsAt: Date, endsAt: Date): void {
    this.billingPeriodStartsAt = startsAt;
    this.billingPeriodEndsAt = endsAt;
  }

  // Resource limits based on billing tier
  getWorkspaceLimit(): number {
    switch (this.billingTier) {
      case OrganizationBillingTier.STARTER:
        return 5;
      case OrganizationBillingTier.PROFESSIONAL:
        return 25;
      case OrganizationBillingTier.ENTERPRISE:
        return -1; // unlimited
      default:
        return 0;
    }
  }

  getCodebaseLimit(): number {
    switch (this.billingTier) {
      case OrganizationBillingTier.STARTER:
        return 25;
      case OrganizationBillingTier.PROFESSIONAL:
        return 100;
      case OrganizationBillingTier.ENTERPRISE:
        return -1; // unlimited
      default:
        return 0;
    }
  }

  getMemberLimit(): number {
    switch (this.billingTier) {
      case OrganizationBillingTier.STARTER:
        return 10;
      case OrganizationBillingTier.PROFESSIONAL:
        return 50;
      case OrganizationBillingTier.ENTERPRISE:
        return -1; // unlimited
      default:
        return 0;
    }
  }

  // Permission helpers
  canCreateWorkspace(): boolean {
    if (!this.canAccess) return false;
    const limit = this.getWorkspaceLimit();
    return limit === -1 || this.workspaceCount < limit;
  }

  canCreateCodebase(): boolean {
    if (!this.canAccess) return false;
    const limit = this.getCodebaseLimit();
    // TODO: Implement proper codebase counting across all workspaces
    return limit === -1;
  }

  canAddMember(): boolean {
    if (!this.canAccess) return false;
    const limit = this.getMemberLimit();
    return limit === -1 || this.memberCount < limit;
  }

  // Transfer ownership
  transferOwnership(newOwner: User): void {
    this.owner = newOwner;
  }

  // Organization status
  suspend(): void {
    this.billingStatus = BillingStatus.SUSPENDED;
  }

  reactivate(): void {
    this.billingStatus = BillingStatus.ACTIVE;
  }

  cancel(): void {
    this.billingStatus = BillingStatus.CANCELLED;
  }
}
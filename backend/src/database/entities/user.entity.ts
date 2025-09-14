import {
  Entity,
  Property,
  OneToMany,
  Collection,
  Index,
  BeforeCreate,
  BeforeUpdate,
} from '@mikro-orm/core';
import * as bcrypt from 'bcrypt';
import { BaseEntity } from './base.entity';
import { Membership } from './membership.entity';
import { Project } from './project.entity';

@Entity({ tableName: 'users' })
export class User extends BaseEntity {
  @Property({ type: 'varchar', length: 255 })
  @Index()
  email!: string;

  @Property({ type: 'timestamptz', nullable: true })
  emailVerifiedAt?: Date;

  @Property({ type: 'varchar', length: 255, nullable: true, hidden: true })
  passwordHash?: string;

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

  @OneToMany(() => Membership, membership => membership.user)
  memberships = new Collection<Membership>(this);

  @OneToMany(() => Project, project => project.owner)
  ownedProjects = new Collection<Project>(this);

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
}
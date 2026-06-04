import {
  Entity,
  Property,
  ManyToOne,
  Index,
  Unique,
  Enum,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Workspace } from './workspace.entity';

export enum TagType {
  WORKSPACE = 'workspace',
  CODEBASE = 'codebase',
}

export enum TagColor {
  RED = 'red',
  ORANGE = 'orange',
  YELLOW = 'yellow',
  GREEN = 'green',
  BLUE = 'blue',
  INDIGO = 'indigo',
  PURPLE = 'purple',
  PINK = 'pink',
  GRAY = 'gray',
}

@Entity({ tableName: 'tags' })
@Unique({ properties: ['name', 'workspace', 'type'] })
export class Tag extends BaseEntity {
  @Property({ type: 'varchar', length: 100 })
  @Index()
  name!: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  description?: string;

  @Enum(() => TagColor)
  color: TagColor = TagColor.BLUE;

  @Enum(() => TagType)
  type!: TagType;

  @ManyToOne(() => Workspace, { deleteRule: 'cascade' })
  @Index()
  workspace!: Workspace;

  @Property({ type: 'uuid', nullable: true })
  @Index()
  entityId?: string;

  @Property({ type: 'boolean', default: true })
  isActive: boolean = true;

  @Property({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  // Helper methods
  get isWorkspaceTag(): boolean {
    return this.type === TagType.WORKSPACE;
  }

  get isCodebaseTag(): boolean {
    return this.type === TagType.CODEBASE;
  }

  // Tag management methods
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

  // Color methods
  setColor(color: TagColor): void {
    this.color = color;
  }

  get colorHex(): string {
    switch (this.color) {
      case TagColor.RED:
        return '#ef4444';
      case TagColor.ORANGE:
        return '#f97316';
      case TagColor.YELLOW:
        return '#eab308';
      case TagColor.GREEN:
        return '#22c55e';
      case TagColor.BLUE:
        return '#3b82f6';
      case TagColor.INDIGO:
        return '#6366f1';
      case TagColor.PURPLE:
        return '#a855f7';
      case TagColor.PINK:
        return '#ec4899';
      case TagColor.GRAY:
        return '#6b7280';
      default:
        return '#3b82f6';
    }
  }

  // Metadata methods
  getMetadata<T = any>(key: string, defaultValue?: T): T {
    return this.metadata?.[key] ?? defaultValue;
  }

  setMetadata(key: string, value: any): void {
    if (!this.metadata) {
      this.metadata = {};
    }
    this.metadata[key] = value;
  }

  removeMetadata(key: string): void {
    if (this.metadata) {
      delete this.metadata[key];
    }
  }

  // Validation
  validateEntityAssociation(): void {
    if (this.type === TagType.WORKSPACE && this.entityId) {
      throw new Error('Workspace tags should not have entityId');
    }

    if (this.type === TagType.CODEBASE && !this.entityId) {
      throw new Error('Codebase tags must have entityId');
    }
  }

  // Query helpers
  static createWorkspaceTag(name: string, workspace: Workspace, color?: TagColor): Tag {
    const tag = new Tag();
    tag.name = name;
    tag.type = TagType.WORKSPACE;
    tag.workspace = workspace;
    tag.entityId = undefined;
    if (color) tag.color = color;
    return tag;
  }

  static createCodebaseTag(name: string, workspace: Workspace, codebaseId: string, color?: TagColor): Tag {
    const tag = new Tag();
    tag.name = name;
    tag.type = TagType.CODEBASE;
    tag.workspace = workspace;
    tag.entityId = codebaseId;
    if (color) tag.color = color;
    return tag;
  }
}
import { Injectable, Optional } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { Component } from '../database/entities/component.entity';

@Injectable()
export class ComponentRepository {
  constructor(
    @Optional() private readonly em?: EntityManager,
    @Optional() @InjectRepository(Component)
    private readonly componentRepo?: EntityRepository<Component>
  ) {}

  async findAll(): Promise<Component[]> {
    if (!this.componentRepo) {
      return [];
    }
    return this.componentRepo.findAll();
  }

  async findById(id: string): Promise<Component | null> {
    if (!this.componentRepo) {
      return null;
    }
    return this.componentRepo.findOne({ id });
  }

  async create(data: Partial<Component>): Promise<Component> {
    if (!this.componentRepo) {
      throw new Error('Database is disabled');
    }
    const component = this.componentRepo.create(data as any);
    await this.em!.persistAndFlush(component);
    return component;
  }

  async update(id: string, data: Partial<Component>): Promise<Component | null> {
    if (!this.componentRepo) {
      throw new Error('Database is disabled');
    }
    const component = await this.componentRepo.findOne({ id });
    if (!component) {
      return null;
    }
    this.componentRepo.assign(component, data);
    await this.em!.flush();
    return component;
  }

  async delete(id: string): Promise<boolean> {
    if (!this.componentRepo) {
      throw new Error('Database is disabled');
    }
    const component = await this.componentRepo.findOne({ id });
    if (!component) {
      return false;
    }
    await this.em!.removeAndFlush(component);
    return true;
  }
}
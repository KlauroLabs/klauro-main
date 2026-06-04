import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';

import { Component } from '../database/entities/component.entity';
import { ComponentConnection } from '../database/entities/component-connection.entity';

@Injectable()
export class ComponentsService {
  constructor(
    @InjectRepository(Component)
    private readonly componentRepository: EntityRepository<Component>,
    @InjectRepository(ComponentConnection)
    private readonly connectionRepository: EntityRepository<ComponentConnection>,
  ) {}

  async findAll(): Promise<Component[]> {
    return this.componentRepository.findAll();
  }

  async findOne(id: string): Promise<Component | null> {
    return this.componentRepository.findOne(id);
  }

  async findByAnalysisRun(analysisRunId: string): Promise<Component[]> {
    return this.componentRepository.find({ analysisRun: analysisRunId });
  }

  async getConnections(componentId: string): Promise<ComponentConnection[]> {
    return this.connectionRepository.find({
      $or: [
        { fromComponent: componentId },
        { toComponent: componentId },
      ],
    });
  }
}
import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';

import { ComponentsService } from './components.service';
import { Component } from '../database/entities/component.entity';
import { ComponentConnection } from '../database/entities/component-connection.entity';

@ApiTags('components')
@Controller('components')
export class ComponentsController {
  constructor(private readonly componentsService: ComponentsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all components' })
  async findAll(): Promise<Component[]> {
    return this.componentsService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a component by ID' })
  @ApiParam({ name: 'id', description: 'Component ID' })
  async findOne(@Param('id') id: string): Promise<Component | null> {
    return this.componentsService.findOne(id);
  }

  @Get(':id/connections')
  @ApiOperation({ summary: 'Get connections for a component' })
  @ApiParam({ name: 'id', description: 'Component ID' })
  async getConnections(@Param('id') id: string): Promise<ComponentConnection[]> {
    return this.componentsService.getConnections(id);
  }
}
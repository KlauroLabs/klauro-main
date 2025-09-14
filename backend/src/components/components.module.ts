import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { ComponentsService } from './components.service';
import { ComponentsController } from './components.controller';
import { Component } from '../database/entities/component.entity';
import { ComponentConnection } from '../database/entities/component-connection.entity';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      Component,
      ComponentConnection,
    ]),
  ],
  controllers: [ComponentsController],
  providers: [ComponentsService],
  exports: [ComponentsService],
})
export class ComponentsModule {}
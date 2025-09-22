import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { Workspace } from '../database/entities/workspace.entity';
import { WorkspaceAccess } from '../database/entities/workspace-access.entity';
import { Organization } from '../database/entities/organization.entity';
import { User } from '../database/entities/user.entity';
import { Tag } from '../database/entities/tag.entity';
import { Membership } from '../database/entities/membership.entity';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      Workspace,
      WorkspaceAccess,
      Organization,
      User,
      Tag,
      Membership,
    ]),
  ],
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
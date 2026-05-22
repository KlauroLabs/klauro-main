import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(TenantGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  async create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }
}

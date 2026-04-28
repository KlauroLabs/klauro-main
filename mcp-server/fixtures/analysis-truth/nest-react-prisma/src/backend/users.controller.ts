import { Body, CanActivate, Controller, ExecutionContext, Get, Param, Post, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';

interface CreateUserDto {
  email: string;
  name: string;
}

export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    return Boolean(context.switchToHttp().getRequest().headers.authorization);
  }
}

@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get(':id')
  getUser(@Param('id') id: string) {
    return this.usersService.findUser(id);
  }

  @Post()
  createUser(@Body() input: CreateUserDto) {
    return this.usersService.createUser(input);
  }
}

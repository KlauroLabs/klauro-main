import { Controller, Get, Post } from '@nestjs/common';
import { UserService } from './user.service';

@Controller('users')
export class UserController {
  constructor(private readonly service: UserService) {}
  @Get(':id')
  get(id: string) { return this.service.getUser(id); }
  @Post()
  post(u: any) { return this.service.createUser(u); }
}

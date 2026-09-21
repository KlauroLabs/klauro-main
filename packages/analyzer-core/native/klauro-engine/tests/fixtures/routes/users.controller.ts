import { Controller, Get, Delete } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get()
  list(): string[] {
    return [];
  }

  @Delete(':id')
  remove(id: string): void {}
}

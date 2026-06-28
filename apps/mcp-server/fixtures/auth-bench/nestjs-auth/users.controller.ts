import { Controller, Get, Post, Delete, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from './auth.guard';

@Controller('users')
export class UsersController {
  @Get()
  findAll() { return []; }

  @Post()
  @UseGuards(AuthGuard)
  create() { return { id: 1 }; }

  @Delete(':id')
  @UseGuards(AuthGuard)
  remove(@Param('id') id: string) { return id; }
}

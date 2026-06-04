import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

interface CreateUserInput {
  email: string;
  name: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaClient) {}

  findUser(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  createUser(input: CreateUserInput) {
    return this.prisma.user.create({ data: input });
  }
}

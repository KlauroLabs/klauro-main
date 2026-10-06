import { Injectable } from '@nestjs/common';
import { UserRepository } from './user.repository';

@Injectable()
export class UserService {
  constructor(private readonly repo: UserRepository) {}
  findAll() { return this.repo.all(); }
}

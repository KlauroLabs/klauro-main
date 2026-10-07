import { Injectable } from '@nestjs/common';
import { UserRepository } from './user.repository';

@Injectable()
export class UserService {
  constructor(private readonly repo: UserRepository) {}
  getUser(id: string) { return this.repo.findById(id); }
  createUser(u: any) { return this.repo.save(u); }
}

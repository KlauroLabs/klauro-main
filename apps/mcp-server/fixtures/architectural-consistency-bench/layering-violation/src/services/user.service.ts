import { UserRepository } from '../repositories/user.repository';
import { User } from '../entities/user';

export class UserService {
  constructor(private repo: UserRepository) {}

  getUser(id: string): User | undefined {
    return this.repo.findById(id);
  }

  createUser(user: User): User {
    return this.repo.save(user);
  }

  removeUser(id: string): void {
    this.repo.delete(id);
  }
}

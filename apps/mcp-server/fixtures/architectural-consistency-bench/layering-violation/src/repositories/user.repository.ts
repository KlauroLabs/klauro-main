import { User } from '../entities/user';

export class UserRepository {
  private users: User[] = [];

  findById(id: string): User | undefined {
    return this.users.find(u => u.id === id);
  }

  save(user: User): User {
    this.users.push(user);
    return user;
  }

  delete(id: string): void {
    this.users = this.users.filter(u => u.id !== id);
  }
}

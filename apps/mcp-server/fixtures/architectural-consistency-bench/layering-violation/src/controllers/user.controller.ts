import { UserService } from '../services/user.service';
import { User } from '../entities/user';

export class UserController {
  constructor(private service: UserService) {}

  getUser(id: string): User | undefined {
    return this.service.getUser(id);
  }

  createUser(user: User): User {
    return this.service.createUser(user);
  }
}

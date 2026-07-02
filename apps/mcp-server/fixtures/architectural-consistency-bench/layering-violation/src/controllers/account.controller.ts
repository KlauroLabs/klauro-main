import { UserService } from '../services/user.service';
import { User } from '../entities/user';

export class AccountController {
  constructor(private service: UserService) {}

  viewAccount(id: string): User | undefined {
    return this.service.getUser(id);
  }
}

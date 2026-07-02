import { UserService } from '../services/user.service';
import { User } from '../entities/user';

export class SettingsController {
  constructor(private service: UserService) {}

  updateSettings(user: User): User {
    return this.service.createUser(user);
  }
}

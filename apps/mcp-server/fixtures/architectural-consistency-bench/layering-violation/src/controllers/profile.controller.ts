import { UserService } from '../services/user.service';
import { User } from '../entities/user';

export class ProfileController {
  constructor(private service: UserService) {}

  showProfile(id: string): User | undefined {
    return this.service.getUser(id);
  }
}

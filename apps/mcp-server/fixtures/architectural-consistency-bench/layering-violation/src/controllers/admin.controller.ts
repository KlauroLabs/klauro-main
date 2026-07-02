import { UserRepository } from '../repositories/user.repository';
import { User } from '../entities/user';

// PLANTED VIOLATION: this handler calls the repository directly, skipping the
// service layer every other controller in this fixture goes through.
export class AdminController {
  constructor(private repo: UserRepository) {}

  forceDeleteUser(id: string): void {
    this.repo.delete(id);
  }

  forceGetUser(id: string): User | undefined {
    return this.repo.findById(id);
  }
}

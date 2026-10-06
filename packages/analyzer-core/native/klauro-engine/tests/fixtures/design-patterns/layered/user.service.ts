import { UserRepository } from './user.repository';
export class UserService {
  constructor(private readonly repo: UserRepository) {}
  getUser(id: string) { return this.repo.findById(id); }
  createUser(u: any) { return this.repo.save(u); }
}

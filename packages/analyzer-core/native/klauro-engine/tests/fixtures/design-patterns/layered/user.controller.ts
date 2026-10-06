import { UserService } from './user.service';
export class UserController {
  constructor(private readonly service: UserService) {}
  get(id: string) { return this.service.getUser(id); }
  post(u: any) { return this.service.createUser(u); }
}

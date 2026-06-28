import { Injectable } from '@angular/core';
import { UserRepository } from './user.repository';

@Injectable({ providedIn: 'root' })
export class UserService {
  constructor(private readonly repo: UserRepository) {}
  findAll() { return this.repo.all(); }
}

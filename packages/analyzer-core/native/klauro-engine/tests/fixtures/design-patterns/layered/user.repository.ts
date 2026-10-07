import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class UserRepository {
  constructor(private readonly pool: Pool) {}
  findById(id: string) { return this.pool.query('select * from users where id = $1', [id]); }
  save(u: any) { return this.pool.query('insert into users (name) values ($1)', [u.name]); }
}

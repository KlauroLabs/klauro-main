export class UserRepository {
  private rows: any[] = [];
  findById(id: string) { return this.rows.find(r => r.id === id); }
  save(u: any) { this.rows.push(u); return u; }
}

export class AddUsers20240501000000 {
  async up(): Promise<void> {
    this.addSql('create table users (id text primary key, tenant_id text not null, email text not null)');
  }

  private addSql(_sql: string): void {}
}

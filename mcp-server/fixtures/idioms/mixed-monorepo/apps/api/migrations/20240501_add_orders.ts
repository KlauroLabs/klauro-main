export async function up(): Promise<void> {
  await sql('create table orders (id text primary key, tenant_id text not null)');
}

async function sql(_statement: string): Promise<void> {}

export class Records {
  constructor(private readonly pool: { query: (text: string, held: unknown[]) => Promise<unknown> }) {}

  async load(id: string) {
    const statement = 'SELECT id, name FROM b_table WHERE id = $1';
    return this.pool.query(statement, [id]);
  }
}

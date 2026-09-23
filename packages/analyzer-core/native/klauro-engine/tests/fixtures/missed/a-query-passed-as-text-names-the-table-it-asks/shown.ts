export class Records {
  constructor(private readonly pool: { query: (text: string, held: unknown[]) => Promise<unknown> }) {}

  async load(id: string) {
    return this.pool.query('SELECT id, name FROM a_table WHERE id = $1', [id]);
  }
}

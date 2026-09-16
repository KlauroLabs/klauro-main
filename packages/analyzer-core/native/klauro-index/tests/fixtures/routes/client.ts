export async function loadAccount(api: Client, id: string): Promise<unknown> {
  return api.get('/api/v1/accounts', { id });
}

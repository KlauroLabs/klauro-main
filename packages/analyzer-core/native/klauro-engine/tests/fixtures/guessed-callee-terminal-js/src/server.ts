import * as http from 'node:http';
import * as fs from 'node:fs/promises';

class Store {
  async save(path: string): Promise<void> {
    await fs.unlink(path);
  }
}

function pick() {
  return new Store();
}

export function start() {
  return http.createServer(async (request, response) => {
    const route = request.url ?? '/';

    if (request.method === 'POST' && route === '/api/session') {
      const handler = pick();
      await handler.save(route);
      response.end(JSON.stringify({ ok: true }));
      return;
    }
  });
}

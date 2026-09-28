import * as http from 'node:http';
import * as fs from 'node:fs/promises';

class Store {
  async replaceAll(pattern: string): Promise<void> {
    await fs.unlink(pattern);
  }
}

export function start() {
  return http.createServer(async (request, response) => {
    const route: string = request.url ?? '/';

    if (request.method === 'GET' && route === '/about') {
      const label: string = route.replaceAll('/', '-');
      response.end(label);
      return;
    }
  });
}

import { createServer } from 'http';

export function start() {
  return createServer(async (request, response) => {
    const route = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && route === '/health') {
      response.end('ok');
      return;
    }
    if (request.method === 'POST' && route === '/v1/analyze') {
      await analyze(request);
      response.end();
      return;
    }
  });
}

async function analyze(request: unknown) {
  return request;
}

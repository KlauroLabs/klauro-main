import * as http from 'node:http';

export function start() {
  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const route = requestUrl.pathname;

    if (request.method === 'GET' && route === '/health') {
      response.end('ok');
      return;
    }

    if (request.method === 'POST' && route === '/api/auth/login') {
      await login(request);
      response.end();
      return;
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && route.startsWith('/dist/')) {
      await serveTarball(response);
      return;
    }

    if (route.startsWith('/api/')) {
      await handleApi(route, request, response);
      return;
    }
  });
}

async function handleApi(route: string, request: http.IncomingMessage, response: http.ServerResponse) {
  if (request.method === 'GET' && route === '/api/me') {
    response.end('me');
    return;
  }

  if (request.method === 'POST' && route === '/api/auth/change-password') {
    response.end('changed');
    return;
  }
}

async function login(request: unknown) {
  return request;
}

async function serveTarball(response: http.ServerResponse) {
  response.end('tarball');
}

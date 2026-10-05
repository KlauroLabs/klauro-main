import http from 'node:http';

export const REPORT_ROUTE = '/api/reports/daily';

function listProjects(request: http.IncomingMessage, response: http.ServerResponse) {
  response.end('[]');
}

const routeTable = [
  { method: 'GET', path: '/api/projects', handler: listProjects },
  { method: 'DELETE', path: '/api/projects/:id', handler: removeProject },
];

function removeProject(request: http.IncomingMessage, response: http.ServerResponse) {
  response.end('{}');
}

export function createGateway() {
  return http.createServer((request, response) => {
    const route = new URL(request.url ?? '/', 'http://localhost').pathname;
    switch (route) {
      case '/health':
        return response.end('ok');
      case '/version':
        return response.end('1');
    }
    if (request.method === 'GET' && route === REPORT_ROUTE) {
      return response.end('report');
    }
    if (request.method === 'GET' && route.startsWith('/api/engine/')) {
      return response.end('engine');
    }
    const queryMatch = route.match(/^\/api\/projects\/([^/]+)\/query$/);
    if (request.method === 'POST' && queryMatch) {
      return response.end(queryMatch[1]);
    }
    if (route === '/status') {
      return response.end('up');
    }
    if (route.startsWith('/internal/')) {
      return response.end('guarded');
    }
    response.statusCode = 404;
    response.end();
  });
}

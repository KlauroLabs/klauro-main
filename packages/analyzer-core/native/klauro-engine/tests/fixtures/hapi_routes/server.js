const Hapi = require('@hapi/hapi');

async function listUsers(request, h) {
  return [];
}

async function createUser(request, h) {
  return h.response({}).code(201);
}

async function health(request, h) {
  return 'ok';
}

async function boot() {
  const server = Hapi.server({ port: 3000 });
  server.route({ method: 'GET', path: '/users', handler: listUsers });
  server.route({ method: 'POST', path: '/users', handler: createUser });
  server.route([{ method: 'GET', path: '/health', handler: health }]);
  await server.start();
}

boot();

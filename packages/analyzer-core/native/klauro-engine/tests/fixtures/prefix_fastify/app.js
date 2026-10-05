const fastify = require('fastify')()

fastify.register(require('./routes/users'), { prefix: '/users' })

fastify.register(async function (instance) {
  instance.get('/ping', async () => 'pong')
}, { prefix: '/v1' })

fastify.get('/health', async () => 'ok')

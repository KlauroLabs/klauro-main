module.exports = async function (fastify) {
  fastify.get('/:id', async (request) => request.params.id)
  fastify.post('/', async () => ({}))
}

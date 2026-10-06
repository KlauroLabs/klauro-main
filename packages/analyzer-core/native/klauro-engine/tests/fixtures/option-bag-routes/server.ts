import Fastify from 'fastify'

const fastify = Fastify()
const schema = { schema: { response: { 200: { type: 'object' } } } }

fastify.get('/await', schema, async function (req, reply) {
  return { hello: 'world' }
})

interface Router {
  handle(method: string, url: string): unknown
}

export function resolveMock(router: Router, method: string, url: string): unknown {
  const r = router.handle(method, url)
  return r
}

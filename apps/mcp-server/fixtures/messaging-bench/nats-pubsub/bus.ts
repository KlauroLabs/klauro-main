import { connect, NatsConnection } from 'nats';

export async function start() {
  const nc: NatsConnection = await connect({ servers: 'localhost:4222' });
  nc.publish('orders', new TextEncoder().encode('hi'));
  const sub = nc.subscribe('shipments');
  for await (const m of sub) {}
}

import amqp from 'amqplib';

export async function publishOrder(ch: amqp.Channel, order: any) {
  await ch.sendToQueue('orders', Buffer.from(JSON.stringify(order)));
}

export async function consumeShipments(ch: amqp.Channel) {
  await ch.consume('shipments', (msg) => {});
}

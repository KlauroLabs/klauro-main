import { Kafka } from 'kafkajs';
const kafka = new Kafka({ brokers: ['localhost:9092'] });
const producer = kafka.producer();
export async function publishOrder(order: any) {
  await producer.send({ topic: 'orders', messages: [{ value: JSON.stringify(order) }] });
}
const consumer = kafka.consumer({ groupId: 'inventory' });
export async function consumeShipments() {
  await consumer.subscribe({ topic: 'shipments' });
  await consumer.run({ eachMessage: async ({ message }) => {} });
}

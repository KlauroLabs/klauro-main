import { Queue, Worker } from 'bullmq';

const emailQueue = new Queue('emails');

export async function enqueueEmail(data: any) {
  await emailQueue.add('send', data);
}

new Worker('notifications', async (job) => {
  return job.data;
});

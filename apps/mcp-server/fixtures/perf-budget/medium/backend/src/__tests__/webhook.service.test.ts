import { webhookService } from '../services/webhook.service';

describe('WebhookService', () => {
  it('creates and retrieves a webhook', async () => {
    const created = await webhookService.create({ name: 'sample-webhook', status: 'webhook_active' });
    const fetched = await webhookService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

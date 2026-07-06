import { subscriptionService } from '../services/subscription.service';

describe('SubscriptionService', () => {
  it('creates and retrieves a subscription', async () => {
    const created = await subscriptionService.create({ name: 'sample-subscription', status: 'subscription_active' });
    const fetched = await subscriptionService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

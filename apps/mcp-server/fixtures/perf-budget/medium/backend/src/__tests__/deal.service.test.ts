import { dealService } from '../services/deal.service';

describe('DealService', () => {
  it('creates and retrieves a deal', async () => {
    const created = await dealService.create({ name: 'sample-deal', status: 'deal_active' });
    const fetched = await dealService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

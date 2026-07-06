import { refundService } from '../services/refund.service';

describe('RefundService', () => {
  it('creates and retrieves a refund', async () => {
    const created = await refundService.create({ name: 'sample-refund', status: 'refund_active' });
    const fetched = await refundService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

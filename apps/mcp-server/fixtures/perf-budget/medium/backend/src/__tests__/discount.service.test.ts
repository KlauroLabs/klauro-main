import { discountService } from '../services/discount.service';

describe('DiscountService', () => {
  it('creates and retrieves a discount', async () => {
    const created = await discountService.create({ name: 'sample-discount', status: 'discount_active' });
    const fetched = await discountService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

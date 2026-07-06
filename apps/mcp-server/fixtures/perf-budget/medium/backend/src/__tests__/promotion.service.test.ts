import { promotionService } from '../services/promotion.service';

describe('PromotionService', () => {
  it('creates and retrieves a promotion', async () => {
    const created = await promotionService.create({ name: 'sample-promotion', status: 'promotion_active' });
    const fetched = await promotionService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

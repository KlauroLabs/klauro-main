import { couponService } from '../services/coupon.service';

describe('CouponService', () => {
  it('creates and retrieves a coupon', async () => {
    const created = await couponService.create({ name: 'sample-coupon', status: 'coupon_active' });
    const fetched = await couponService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

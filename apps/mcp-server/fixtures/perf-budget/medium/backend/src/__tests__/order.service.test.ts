import { orderService } from '../services/order.service';

describe('OrderService', () => {
  it('creates and retrieves a order', async () => {
    const created = await orderService.create({ name: 'sample-order', status: 'order_active' });
    const fetched = await orderService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

import { cartService } from '../services/cart.service';

describe('CartService', () => {
  it('creates and retrieves a cart', async () => {
    const created = await cartService.create({ name: 'sample-cart', status: 'cart_active' });
    const fetched = await cartService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

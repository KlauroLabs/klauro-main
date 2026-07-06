import { productService } from '../services/product.service';

describe('ProductService', () => {
  it('creates and retrieves a product', async () => {
    const created = await productService.create({ name: 'sample-product', status: 'product_active' });
    const fetched = await productService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

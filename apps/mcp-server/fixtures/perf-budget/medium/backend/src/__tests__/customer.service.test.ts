import { customerService } from '../services/customer.service';

describe('CustomerService', () => {
  it('creates and retrieves a customer', async () => {
    const created = await customerService.create({ name: 'sample-customer', status: 'customer_active' });
    const fetched = await customerService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

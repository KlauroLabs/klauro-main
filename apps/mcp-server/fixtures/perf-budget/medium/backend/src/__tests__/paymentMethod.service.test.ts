import { paymentMethodService } from '../services/paymentMethod.service';

describe('PaymentMethodService', () => {
  it('creates and retrieves a paymentMethod', async () => {
    const created = await paymentMethodService.create({ name: 'sample-paymentMethod', status: 'paymentMethod_active' });
    const fetched = await paymentMethodService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

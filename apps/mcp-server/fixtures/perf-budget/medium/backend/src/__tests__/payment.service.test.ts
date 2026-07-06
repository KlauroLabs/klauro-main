import { paymentService } from '../services/payment.service';

describe('PaymentService', () => {
  it('creates and retrieves a payment', async () => {
    const created = await paymentService.create({ name: 'sample-payment', status: 'payment_active' });
    const fetched = await paymentService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

import { invoiceService } from '../services/invoice.service';

describe('InvoiceService', () => {
  it('creates and retrieves a invoice', async () => {
    const created = await invoiceService.create({ name: 'sample-invoice', status: 'invoice_active' });
    const fetched = await invoiceService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

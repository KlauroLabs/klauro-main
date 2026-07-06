import { invoiceLineService } from '../services/invoiceLine.service';

describe('InvoiceLineService', () => {
  it('creates and retrieves a invoiceLine', async () => {
    const created = await invoiceLineService.create({ name: 'sample-invoiceLine', status: 'invoiceLine_active' });
    const fetched = await invoiceLineService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

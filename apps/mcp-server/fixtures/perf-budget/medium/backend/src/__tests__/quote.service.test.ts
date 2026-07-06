import { quoteService } from '../services/quote.service';

describe('QuoteService', () => {
  it('creates and retrieves a quote', async () => {
    const created = await quoteService.create({ name: 'sample-quote', status: 'quote_active' });
    const fetched = await quoteService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

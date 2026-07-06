import { renewalService } from '../services/renewal.service';

describe('RenewalService', () => {
  it('creates and retrieves a renewal', async () => {
    const created = await renewalService.create({ name: 'sample-renewal', status: 'renewal_active' });
    const fetched = await renewalService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

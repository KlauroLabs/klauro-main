import { leadService } from '../services/lead.service';

describe('LeadService', () => {
  it('creates and retrieves a lead', async () => {
    const created = await leadService.create({ name: 'sample-lead', status: 'lead_active' });
    const fetched = await leadService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

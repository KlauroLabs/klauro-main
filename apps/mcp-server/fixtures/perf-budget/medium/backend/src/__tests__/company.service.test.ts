import { companyService } from '../services/company.service';

describe('CompanyService', () => {
  it('creates and retrieves a company', async () => {
    const created = await companyService.create({ name: 'sample-company', status: 'company_active' });
    const fetched = await companyService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

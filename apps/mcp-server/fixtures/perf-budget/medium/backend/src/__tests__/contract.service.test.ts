import { contractService } from '../services/contract.service';

describe('ContractService', () => {
  it('creates and retrieves a contract', async () => {
    const created = await contractService.create({ name: 'sample-contract', status: 'contract_active' });
    const fetched = await contractService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

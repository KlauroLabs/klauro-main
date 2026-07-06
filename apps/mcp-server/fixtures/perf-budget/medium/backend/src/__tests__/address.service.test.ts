import { addressService } from '../services/address.service';

describe('AddressService', () => {
  it('creates and retrieves a address', async () => {
    const created = await addressService.create({ name: 'sample-address', status: 'address_active' });
    const fetched = await addressService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

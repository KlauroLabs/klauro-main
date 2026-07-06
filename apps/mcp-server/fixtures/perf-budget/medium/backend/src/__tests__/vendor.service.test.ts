import { vendorService } from '../services/vendor.service';

describe('VendorService', () => {
  it('creates and retrieves a vendor', async () => {
    const created = await vendorService.create({ name: 'sample-vendor', status: 'vendor_active' });
    const fetched = await vendorService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

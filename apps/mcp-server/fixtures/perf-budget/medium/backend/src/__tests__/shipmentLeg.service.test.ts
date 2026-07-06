import { shipmentLegService } from '../services/shipmentLeg.service';

describe('ShipmentLegService', () => {
  it('creates and retrieves a shipmentLeg', async () => {
    const created = await shipmentLegService.create({ name: 'sample-shipmentLeg', status: 'shipmentLeg_active' });
    const fetched = await shipmentLegService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

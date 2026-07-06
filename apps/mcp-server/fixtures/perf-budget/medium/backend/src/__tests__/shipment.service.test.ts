import { shipmentService } from '../services/shipment.service';

describe('ShipmentService', () => {
  it('creates and retrieves a shipment', async () => {
    const created = await shipmentService.create({ name: 'sample-shipment', status: 'shipment_active' });
    const fetched = await shipmentService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

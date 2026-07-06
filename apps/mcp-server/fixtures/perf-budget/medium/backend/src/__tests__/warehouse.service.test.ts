import { warehouseService } from '../services/warehouse.service';

describe('WarehouseService', () => {
  it('creates and retrieves a warehouse', async () => {
    const created = await warehouseService.create({ name: 'sample-warehouse', status: 'warehouse_active' });
    const fetched = await warehouseService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

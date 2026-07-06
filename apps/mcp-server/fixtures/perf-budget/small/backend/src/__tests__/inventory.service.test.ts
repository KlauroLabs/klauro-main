import { inventoryService } from '../services/inventory.service';

describe('InventoryService', () => {
  it('creates and retrieves a inventory', async () => {
    const created = await inventoryService.create({ name: 'sample-inventory', status: 'inventory_active' });
    const fetched = await inventoryService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

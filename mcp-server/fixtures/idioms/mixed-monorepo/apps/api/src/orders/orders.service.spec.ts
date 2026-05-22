import { OrdersService } from './orders.service';

it('creates tenant-scoped orders', async () => {
  const service = new OrdersService();
  await expect(service.create({ tenantId: 'tenant-1', totalCents: 1200 })).resolves.toMatchObject({
    tenantId: 'tenant-1',
  });
});

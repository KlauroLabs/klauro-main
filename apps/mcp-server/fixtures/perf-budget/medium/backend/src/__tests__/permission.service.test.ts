import { permissionService } from '../services/permission.service';

describe('PermissionService', () => {
  it('creates and retrieves a permission', async () => {
    const created = await permissionService.create({ name: 'sample-permission', status: 'permission_active' });
    const fetched = await permissionService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

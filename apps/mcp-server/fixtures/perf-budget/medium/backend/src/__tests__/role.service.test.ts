import { roleService } from '../services/role.service';

describe('RoleService', () => {
  it('creates and retrieves a role', async () => {
    const created = await roleService.create({ name: 'sample-role', status: 'role_active' });
    const fetched = await roleService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

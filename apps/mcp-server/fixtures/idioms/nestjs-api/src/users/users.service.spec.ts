import { UsersService } from './users.service';

describe('UsersService', () => {
  it('keeps user creation tenant scoped', async () => {
    const repository = { findByTenantAndEmail: jest.fn().mockResolvedValue(null) };
    const logger = { info: jest.fn() };
    const service = new UsersService(repository as any, logger as any);

    await expect(service.create({ email: 'person@example.com', name: 'Ada' })).resolves.toMatchObject({
      tenantId: 'tenant-1',
    });
  });
});

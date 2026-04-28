import { UsersService } from './users.service';

describe('UsersService', () => {
  it('creates a user through Prisma', async () => {
    const prisma = {
      user: {
        create: jest.fn().mockResolvedValue({ id: 'user-1', email: 'a@example.com', name: 'A' })
      }
    };
    const service = new UsersService(prisma as never);

    await expect(service.createUser({ email: 'a@example.com', name: 'A' })).resolves.toEqual({
      id: 'user-1',
      email: 'a@example.com',
      name: 'A'
    });
  });
});

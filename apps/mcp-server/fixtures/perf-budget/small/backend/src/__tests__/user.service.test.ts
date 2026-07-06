import { userService } from '../services/user.service';

describe('UserService', () => {
  it('creates and retrieves a user', async () => {
    const created = await userService.create({ name: 'sample-user', status: 'user_active' });
    const fetched = await userService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

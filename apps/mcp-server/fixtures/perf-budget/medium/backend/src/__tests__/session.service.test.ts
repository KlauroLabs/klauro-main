import { sessionService } from '../services/session.service';

describe('SessionService', () => {
  it('creates and retrieves a session', async () => {
    const created = await sessionService.create({ name: 'sample-session', status: 'session_active' });
    const fetched = await sessionService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

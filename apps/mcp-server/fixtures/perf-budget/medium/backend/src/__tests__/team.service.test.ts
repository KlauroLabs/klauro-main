import { teamService } from '../services/team.service';

describe('TeamService', () => {
  it('creates and retrieves a team', async () => {
    const created = await teamService.create({ name: 'sample-team', status: 'team_active' });
    const fetched = await teamService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

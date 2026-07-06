import { projectService } from '../services/project.service';

describe('ProjectService', () => {
  it('creates and retrieves a project', async () => {
    const created = await projectService.create({ name: 'sample-project', status: 'project_active' });
    const fetched = await projectService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

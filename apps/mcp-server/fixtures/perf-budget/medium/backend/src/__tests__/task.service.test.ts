import { taskService } from '../services/task.service';

describe('TaskService', () => {
  it('creates and retrieves a task', async () => {
    const created = await taskService.create({ name: 'sample-task', status: 'task_active' });
    const fetched = await taskService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

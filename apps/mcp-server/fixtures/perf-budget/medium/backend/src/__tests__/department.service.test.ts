import { departmentService } from '../services/department.service';

describe('DepartmentService', () => {
  it('creates and retrieves a department', async () => {
    const created = await departmentService.create({ name: 'sample-department', status: 'department_active' });
    const fetched = await departmentService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

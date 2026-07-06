import { employeeService } from '../services/employee.service';

describe('EmployeeService', () => {
  it('creates and retrieves a employee', async () => {
    const created = await employeeService.create({ name: 'sample-employee', status: 'employee_active' });
    const fetched = await employeeService.get(created.id);
    expect(fetched).toEqual(created);
  });
});

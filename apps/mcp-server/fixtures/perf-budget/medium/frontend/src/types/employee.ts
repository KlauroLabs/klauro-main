export interface Employee {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'employee_active' | 'employee_inactive';
}

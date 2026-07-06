export interface Employee {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'employee_active' | 'employee_inactive';
}

export function isEmployee(value: unknown): value is Employee {
  return typeof value === 'object' && value !== null && 'id' in value;
}

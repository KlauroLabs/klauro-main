export interface Department {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'department_active' | 'department_inactive';
}

export function isDepartment(value: unknown): value is Department {
  return typeof value === 'object' && value !== null && 'id' in value;
}

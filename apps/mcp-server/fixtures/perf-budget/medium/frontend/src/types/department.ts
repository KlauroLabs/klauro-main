export interface Department {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'department_active' | 'department_inactive';
}

export interface Role {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'role_active' | 'role_inactive';
}

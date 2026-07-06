export interface Permission {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'permission_active' | 'permission_inactive';
}

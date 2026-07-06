export interface Role {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'role_active' | 'role_inactive';
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'object' && value !== null && 'id' in value;
}

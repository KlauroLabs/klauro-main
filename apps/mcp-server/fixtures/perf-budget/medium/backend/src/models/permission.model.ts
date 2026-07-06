export interface Permission {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'permission_active' | 'permission_inactive';
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'object' && value !== null && 'id' in value;
}

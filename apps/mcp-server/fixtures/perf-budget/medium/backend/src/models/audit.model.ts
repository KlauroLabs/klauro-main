export interface Audit {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'audit_active' | 'audit_inactive';
}

export function isAudit(value: unknown): value is Audit {
  return typeof value === 'object' && value !== null && 'id' in value;
}

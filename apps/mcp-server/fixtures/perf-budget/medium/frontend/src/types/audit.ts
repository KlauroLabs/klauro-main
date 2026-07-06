export interface Audit {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'audit_active' | 'audit_inactive';
}

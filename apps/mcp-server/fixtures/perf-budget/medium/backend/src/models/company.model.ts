export interface Company {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'company_active' | 'company_inactive';
}

export function isCompany(value: unknown): value is Company {
  return typeof value === 'object' && value !== null && 'id' in value;
}

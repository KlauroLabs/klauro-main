export interface Renewal {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'renewal_active' | 'renewal_inactive';
}

export function isRenewal(value: unknown): value is Renewal {
  return typeof value === 'object' && value !== null && 'id' in value;
}

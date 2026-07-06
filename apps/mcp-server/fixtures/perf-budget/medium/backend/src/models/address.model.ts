export interface Address {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'address_active' | 'address_inactive';
}

export function isAddress(value: unknown): value is Address {
  return typeof value === 'object' && value !== null && 'id' in value;
}

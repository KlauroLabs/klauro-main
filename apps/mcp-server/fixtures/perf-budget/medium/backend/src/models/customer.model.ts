export interface Customer {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'customer_active' | 'customer_inactive';
}

export function isCustomer(value: unknown): value is Customer {
  return typeof value === 'object' && value !== null && 'id' in value;
}

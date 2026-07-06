export interface Order {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'order_active' | 'order_inactive';
}

export function isOrder(value: unknown): value is Order {
  return typeof value === 'object' && value !== null && 'id' in value;
}

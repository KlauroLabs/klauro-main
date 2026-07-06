export interface Refund {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'refund_active' | 'refund_inactive';
}

export function isRefund(value: unknown): value is Refund {
  return typeof value === 'object' && value !== null && 'id' in value;
}

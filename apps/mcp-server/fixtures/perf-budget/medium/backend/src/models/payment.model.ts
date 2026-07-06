export interface Payment {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'payment_active' | 'payment_inactive';
}

export function isPayment(value: unknown): value is Payment {
  return typeof value === 'object' && value !== null && 'id' in value;
}

export interface PaymentMethod {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'paymentMethod_active' | 'paymentMethod_inactive';
}

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'object' && value !== null && 'id' in value;
}

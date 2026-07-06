export interface PaymentMethod {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'paymentMethod_active' | 'paymentMethod_inactive';
}

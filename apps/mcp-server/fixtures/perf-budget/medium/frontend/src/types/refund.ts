export interface Refund {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'refund_active' | 'refund_inactive';
}

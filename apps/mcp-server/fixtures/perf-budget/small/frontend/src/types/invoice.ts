export interface Invoice {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'invoice_active' | 'invoice_inactive';
}

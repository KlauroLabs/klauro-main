export interface InvoiceLine {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'invoiceLine_active' | 'invoiceLine_inactive';
}

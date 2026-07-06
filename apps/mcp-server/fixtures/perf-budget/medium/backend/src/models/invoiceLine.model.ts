export interface InvoiceLine {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'invoiceLine_active' | 'invoiceLine_inactive';
}

export function isInvoiceLine(value: unknown): value is InvoiceLine {
  return typeof value === 'object' && value !== null && 'id' in value;
}

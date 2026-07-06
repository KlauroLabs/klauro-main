export interface Invoice {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'invoice_active' | 'invoice_inactive';
}

export function isInvoice(value: unknown): value is Invoice {
  return typeof value === 'object' && value !== null && 'id' in value;
}

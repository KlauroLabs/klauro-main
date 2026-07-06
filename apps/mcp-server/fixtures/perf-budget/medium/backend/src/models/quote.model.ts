export interface Quote {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'quote_active' | 'quote_inactive';
}

export function isQuote(value: unknown): value is Quote {
  return typeof value === 'object' && value !== null && 'id' in value;
}

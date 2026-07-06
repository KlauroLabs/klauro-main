export interface Quote {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'quote_active' | 'quote_inactive';
}

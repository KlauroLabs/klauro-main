export interface Company {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'company_active' | 'company_inactive';
}

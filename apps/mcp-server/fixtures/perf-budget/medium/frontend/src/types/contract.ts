export interface Contract {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'contract_active' | 'contract_inactive';
}

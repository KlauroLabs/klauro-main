export interface Contract {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'contract_active' | 'contract_inactive';
}

export function isContract(value: unknown): value is Contract {
  return typeof value === 'object' && value !== null && 'id' in value;
}

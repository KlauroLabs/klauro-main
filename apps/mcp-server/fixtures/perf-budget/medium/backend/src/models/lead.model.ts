export interface Lead {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'lead_active' | 'lead_inactive';
}

export function isLead(value: unknown): value is Lead {
  return typeof value === 'object' && value !== null && 'id' in value;
}

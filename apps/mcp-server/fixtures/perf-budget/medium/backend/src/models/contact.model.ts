export interface Contact {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'contact_active' | 'contact_inactive';
}

export function isContact(value: unknown): value is Contact {
  return typeof value === 'object' && value !== null && 'id' in value;
}

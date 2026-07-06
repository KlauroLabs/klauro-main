export interface Contact {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'contact_active' | 'contact_inactive';
}

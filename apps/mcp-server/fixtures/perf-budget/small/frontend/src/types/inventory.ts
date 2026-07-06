export interface Inventory {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'inventory_active' | 'inventory_inactive';
}
